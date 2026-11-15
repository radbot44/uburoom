'use strict';
// Who a request really comes from, behind the proxies this server is told to trust.
const net = require('node:net');

let activeConfig;
let cachedKey;
let cachedBlockList;

function normalizeAddress(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  let ip = raw.trim();
  if (/^::ffff:/i.test(ip) && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return ip;
}

function compileTrustedProxies(trustedProxies) {
  if (!Array.isArray(trustedProxies) || !trustedProxies.length) return undefined;
  const key = trustedProxies.join('\0');
  if (cachedBlockList && key === cachedKey) return cachedBlockList;
  const blockList = new net.BlockList();
  for (const entry of trustedProxies) {
    if (typeof entry !== 'string' || !entry) continue;
    const slash = entry.indexOf('/');
    if (slash === -1) {
      const ip = normalizeAddress(entry);
      const version = net.isIP(ip);
      if (version === 4) blockList.addAddress(ip, 'ipv4');
      else if (version === 6) blockList.addAddress(ip, 'ipv6');
      continue;
    }
    const rawIp = entry.slice(0, slash);
    const prefixText = entry.slice(slash + 1);
    const prefix = /^(?:0|[1-9]\d*)$/.test(prefixText) ? Number(prefixText) : -1;
    if (/^::ffff:/i.test(rawIp) && net.isIP(rawIp.slice(7)) === 4 && prefix >= 96 && prefix <= 128) {
      blockList.addSubnet(rawIp.slice(7), prefix - 96, 'ipv4');
      continue;
    }
    const version = net.isIP(rawIp);
    if (version === 4 && prefix >= 0 && prefix <= 32) blockList.addSubnet(rawIp, prefix, 'ipv4');
    else if (version === 6 && prefix >= 0 && prefix <= 128) blockList.addSubnet(rawIp, prefix, 'ipv6');
  }
  cachedKey = key;
  cachedBlockList = blockList;
  return blockList;
}

function isTrustedAddress(blockList, ip) {
  const version = net.isIP(ip);
  if (version === 0) return false;
  return blockList.check(ip, version === 4 ? 'ipv4' : 'ipv6');
}

function isLocalAddress(raw) {
  const ip = normalizeAddress(raw);
  if (!ip) return false;
  if (ip === '::1' || ip === 'localhost') return true;
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  const lower = ip.toLowerCase();
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb'))
    return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  return false;
}

function clientAddress(req, config = activeConfig) {
  const peer = normalizeAddress(req?.socket?.remoteAddress ?? req?.remoteAddress);
  const blockList = compileTrustedProxies(config?.trustedProxies);
  if (!peer || !blockList || !isTrustedAddress(blockList, peer)) return peer;
  const headers = req?.headers;
  if (!headers || typeof headers !== 'object') return peer;
  const header = config?.trustedProxyHeader || 'x-forwarded-for';
  if (header === 'x-forwarded-for') {
    const raw = headers['x-forwarded-for'];
    if (typeof raw !== 'string') return peer;
    const parts = raw.split(',');
    for (let i = parts.length - 1; i >= 0; i--) {
      const hop = normalizeAddress(parts[i]);
      if (!hop || net.isIP(hop) === 0) return peer;
      if (!isTrustedAddress(blockList, hop)) return hop;
    }
    return normalizeAddress(parts[0]) || peer;
  }
  if (header === 'cf-connecting-ip' || header === 'x-real-ip') {
    const ip = normalizeAddress(headers[header]);
    return ip && net.isIP(ip) !== 0 ? ip : peer;
  }
  return peer;
}

/** The configuration requests are read against when a caller names none. */
function trustProxies(config) {
  activeConfig = config;
}

module.exports = { clientAddress, isLocalAddress, normalizeAddress, trustProxies };
