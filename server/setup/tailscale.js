'use strict';
// @ts-check
/**
 * Bounded Tailscale CLI probe and Funnel helper for first-run setup (docs/remote-access.md).
 * Invokes `tailscale` directly with an argument array (never through a shell) and short timeouts
 * so missing, logged-out, or unresponsive daemons degrade cleanly.
 */
const { execFile } = require('node:child_process');

const PROBE_TIMEOUT_MS = 2000;
const ENABLE_TIMEOUT_MS = 8000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const FUNNEL_URL_PATTERN = /https:\/\/login\.tailscale\.com\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/;

/**
 * @typedef {{ code: number|null, stdout: string, stderr: string, errorCode?: string, timedOut?: boolean }} TailscaleRunResult
 * @typedef {(args: string[], options?: { timeoutMs?: number }) => Promise<TailscaleRunResult>} TailscaleRunner
 * @typedef {{
 *   installed: boolean,
 *   loggedIn: boolean,
 *   dnsName: string,
 *   funnelEnabled: boolean,
 *   funnelActive: boolean,
 *   funnelPort: number|null,
 * }} TailscaleStatus
 */

/**
 * Runs the `tailscale` binary directly without shell interpolation.
 * @type {TailscaleRunner}
 */
function runTailscale(args, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    execFile(
      'tailscale',
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout = '', stderr = '') => {
        if (!error) {
          resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const err = /** @type {any} */ (error);
        const timedOut = Boolean(err.killed && (err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT'));
        const code = typeof err.code === 'number' ? err.code : null;
        const errorCode = typeof err.code === 'string' ? err.code : undefined;
        resolve({
          code,
          stdout: String(stdout),
          stderr: String(stderr),
          ...(errorCode ? { errorCode } : {}),
          ...(timedOut ? { timedOut: true } : {}),
        });
      },
    );
  });
}

/**
 * Converts a Tailscale `Self.DNSName` (often ending in `.`) into an HTTPS origin, or `''` if invalid.
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeDnsOrigin(raw) {
  if (typeof raw !== 'string') return '';
  const host = raw.trim().replace(/\.+$/, '').toLowerCase();
  if (!host || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes('.')) return '';
  try {
    const parsed = new URL('https://' + host);
    if (parsed.protocol !== 'https:' || parsed.hostname !== host || parsed.pathname !== '/') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

/**
 * Whether `Self` capabilities from `tailscale status --json` indicate Funnel permission.
 * @param {any} self
 * @returns {boolean}
 */
function hasFunnelCapability(self) {
  if (!self || typeof self !== 'object') return false;
  const isFunnelCap = key =>
    typeof key === 'string' &&
    (key === 'funnel' ||
      key === 'https://tailscale.com/cap/funnel' ||
      key.startsWith('https://tailscale.com/cap/funnel'));
  if (Array.isArray(self.Capabilities) && self.Capabilities.some(isFunnelCap)) return true;
  if (self.CapMap && typeof self.CapMap === 'object' && Object.keys(self.CapMap).some(isFunnelCap)) return true;
  return false;
}

/**
 * Parses `tailscale funnel status --json` to detect whether Funnel is actively forwarding and to which local port.
 * @param {unknown} text
 * @returns {{ active: boolean, port: number|null }}
 */
function parseFunnelStatus(text) {
  if (typeof text !== 'string' || !text.trim()) return { active: false, port: null };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { active: false, port: null };
  }
  if (!data || typeof data !== 'object') return { active: false, port: null };
  const allowFunnel = data.AllowFunnel && typeof data.AllowFunnel === 'object' ? data.AllowFunnel : {};
  const activeKeys = Object.entries(allowFunnel)
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => key);
  const active = activeKeys.length > 0;
  /** @type {number|null} */
  let port = null;
  if (active && data.Web && typeof data.Web === 'object') {
    for (const key of activeKeys) {
      const handlers = data.Web[key]?.Handlers;
      if (!handlers || typeof handlers !== 'object') continue;
      for (const handler of Object.values(handlers)) {
        const proxy = typeof handler?.Proxy === 'string' ? handler.Proxy : '';
        const match = proxy.match(/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})(?:\/|$)/i);
        if (match) {
          const parsedPort = Number(match[1]);
          if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
            port = parsedPort;
            break;
          }
        }
      }
      if (port !== null) break;
    }
  }
  return { active, port };
}

/**
 * Extracts a safe `https://login.tailscale.com/...` URL from Tailscale CLI output, if present.
 * @param {string} output
 * @returns {string}
 */
function extractEnableUrl(output) {
  const match = String(output || '').match(FUNNEL_URL_PATTERN);
  if (!match) return '';
  const candidate = match[0].replace(/[).,;]+$/, '');
  try {
    const parsed = new URL(candidate);
    return parsed.origin === 'https://login.tailscale.com' ? parsed.href : '';
  } catch {
    return '';
  }
}

/**
 * Extracts a concise, sanitized error summary from Tailscale CLI output.
 * @param {string} stderr
 * @param {string} stdout
 * @returns {string}
 */
function summarizeError(stderr, stdout) {
  const lines = `${stderr || ''}\n${stdout || ''}`
    .split(/\r?\n/)
    .map(line => line.replace(/[\x00-\x1f\x7f]/g, ' ').trim())
    .filter(Boolean);
  if (!lines.length) return '';
  const informative = lines.find(line => !/^to enable,\s*visit:/i.test(line)) || lines[0];
  return informative.slice(0, 200);
}

/**
 * Probes local Tailscale state via `tailscale status --json` (and `tailscale funnel status --json` when logged in).
 * Never throws; returns a clean status summary when Tailscale is missing, logged out, or timed out.
 * @param {{ runner?: TailscaleRunner, timeoutMs?: number }} [options]
 * @returns {Promise<TailscaleStatus>}
 */
async function probeTailscale({ runner = runTailscale, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  /** @type {TailscaleStatus} */
  const missing = {
    installed: false,
    loggedIn: false,
    dnsName: '',
    funnelEnabled: false,
    funnelActive: false,
    funnelPort: null,
  };
  let statusRes;
  try {
    statusRes = await runner(['status', '--json'], { timeoutMs });
  } catch {
    return missing;
  }
  if (!statusRes || statusRes.errorCode === 'ENOENT') return missing;

  /** @type {TailscaleStatus} */
  const base = {
    installed: true,
    loggedIn: false,
    dnsName: '',
    funnelEnabled: false,
    funnelActive: false,
    funnelPort: null,
  };
  if (statusRes.timedOut || !statusRes.stdout || !statusRes.stdout.trim()) return base;

  let parsed;
  try {
    parsed = JSON.parse(statusRes.stdout);
  } catch {
    return base;
  }
  if (!parsed || typeof parsed !== 'object') return base;

  const backendState = typeof parsed.BackendState === 'string' ? parsed.BackendState : '';
  const loggedIn = backendState === 'Running';
  if (!loggedIn) return base;

  const dnsName = normalizeDnsOrigin(parsed.Self?.DNSName);
  let funnelEnabled = hasFunnelCapability(parsed.Self);
  let funnelActive = false;
  /** @type {number|null} */
  let funnelPort = null;

  try {
    const funnelRes = await runner(['funnel', 'status', '--json'], { timeoutMs });
    if (funnelRes && funnelRes.code === 0 && !funnelRes.timedOut) {
      const funnel = parseFunnelStatus(funnelRes.stdout);
      funnelActive = funnel.active;
      funnelPort = funnel.port;
      if (funnelActive) funnelEnabled = true;
    }
  } catch {
    /* Funnel status is best-effort; status --json results still stand. */
  }

  return {
    installed: true,
    loggedIn: true,
    dnsName,
    funnelEnabled,
    funnelActive,
    funnelPort,
  };
}

/**
 * Runs `tailscale funnel --bg <port>` with a bounded timeout, falling back cleanly with the exact
 * one-line command to paste if permissions, ACLs, or Tailscale state block automatic setup.
 * @param {number} port
 * @param {{ runner?: TailscaleRunner, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, command: string, error?: string, enableUrl?: string, status?: TailscaleStatus }>}
 */
async function enableTailscaleFunnel(port, { runner = runTailscale, timeoutMs = ENABLE_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error('Use a port from 1 to 65535'), { status: 400, expose: true });
  }
  const command = `tailscale funnel --bg ${port}`;
  let res;
  try {
    res = await runner(['funnel', '--bg', String(port)], { timeoutMs });
  } catch {
    return {
      ok: false,
      command,
      error: 'Could not run Tailscale automatically. Run the command below in a terminal instead.',
    };
  }
  if (!res || res.errorCode === 'ENOENT') {
    return {
      ok: false,
      command,
      error: 'Tailscale was not found on this machine. Install Tailscale, then run the command below.',
    };
  }
  const combined = `${res.stdout || ''}\n${res.stderr || ''}`;
  const enableUrl = extractEnableUrl(combined);
  if (res.timedOut) {
    return {
      ok: false,
      command,
      ...(enableUrl ? { enableUrl } : {}),
      error: enableUrl
        ? 'Tailscale Funnel is not enabled on your tailnet yet. Enable it in the Tailscale admin console, then try again.'
        : 'Tailscale Funnel did not finish in time. Run the command below in a terminal instead.',
    };
  }
  if (res.code !== 0) {
    const detail = summarizeError(res.stderr, res.stdout);
    return {
      ok: false,
      command,
      ...(enableUrl ? { enableUrl } : {}),
      error: detail || 'Could not enable Tailscale Funnel automatically. Run the command below in a terminal instead.',
    };
  }
  const probed = await probeTailscale({ runner, timeoutMs: PROBE_TIMEOUT_MS });
  return {
    ok: true,
    command,
    status: {
      ...probed,
      installed: true,
      loggedIn: true,
      funnelEnabled: true,
      funnelActive: true,
      funnelPort: probed.funnelPort ?? port,
    },
  };
}

module.exports = {
  PROBE_TIMEOUT_MS,
  ENABLE_TIMEOUT_MS,
  runTailscale,
  normalizeDnsOrigin,
  parseFunnelStatus,
  probeTailscale,
  enableTailscaleFunnel,
};
