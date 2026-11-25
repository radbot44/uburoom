'use strict';
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { privateFile, writePrivateFileSync, ensurePrivateDirectorySync } = require('./local-tls');

const DEFAULT_MAX_LOG_BYTES = 25 * 1024 * 1024;

/**
 * @typedef {'error' | 'warn' | 'info' | 'debug'} LogLevel
 */

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const COLOR_CODES = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

const LEVEL_COLORS = {
  error: COLOR_CODES.red,
  warn: COLOR_CODES.yellow,
  info: COLOR_CODES.green,
  debug: COLOR_CODES.magenta,
};

/**
 * Sanitize strings or error messages by masking sensitive tokens and passwords.
 * @param {any} value
 * @param {WeakSet<object>} [ancestors]
 * @returns {any}
 */
function redact(value, ancestors) {
  if (typeof value === 'string') {
    let result = value;
    result = result.replace(
      /((?:x-plex-token|x-emby-token|x-mediabrowser-token|api_key|apiKey|token|password|entry_password|client_secret|bot_token)\s*[:=]\s*['"]?)([^'"&\s,;]+)(['"]?)/gi,
      (match, p1, p2, p3) => p1 + '[REDACTED]' + (typeof p3 === 'string' ? p3 : ''),
    );
    result = result.replace(/((?:__Host-)?uburoom(?:_[a-z0-9_]+)?=)([^;,\s"']+)/gi, '$1[REDACTED]');
    result = result.replace(/(Bearer\s+)([a-zA-Z0-9_\-\.]+)/gi, '$1[REDACTED]');
    return result;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  }
  if (value instanceof URL) {
    return redact(value.href, ancestors);
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[Binary ${value.byteLength}B]`;
  }
  if (value instanceof Error) {
    ancestors ||= new WeakSet();
    if (ancestors.has(value)) return '[Circular]';
    ancestors.add(value);
    try {
      const copy = new Error(redact(value.message, ancestors));
      copy.name = value.name;
      if (value.stack) copy.stack = redact(value.stack, ancestors);
      if (value.code) copy.code = value.code;
      if ('cause' in value && value.cause !== undefined) {
        copy.cause = redact(value.cause, ancestors);
      }
      return copy;
    } finally {
      ancestors.delete(value);
    }
  }
  if (Array.isArray(value)) {
    ancestors ||= new WeakSet();
    if (ancestors.has(value)) return '[Circular]';
    ancestors.add(value);
    try {
      return value.map(v => redact(v, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  if (value && typeof value === 'object') {
    ancestors ||= new WeakSet();
    if (ancestors.has(value)) return '[Circular]';
    ancestors.add(value);
    try {
      const sanitized = {};
      for (const [k, v] of Object.entries(value)) {
        if (/token|secret|password|credential|cookie|authorization|csrf|api_?key/i.test(k) && typeof v !== 'boolean') {
          sanitized[k] = '[REDACTED]';
        } else {
          sanitized[k] = redact(v, ancestors);
        }
      }
      return sanitized;
    } finally {
      ancestors.delete(value);
    }
  }
  return value;
}

/**
 * Strips ANSI color codes from strings for file logging.
 * @param {string} str
 * @returns {string}
 */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Format current timestamp as YYYY-MM-DD HH:mm:ss.SSS.
 * @param {Date} [date]
 * @returns {string}
 */
function formatTimestamp(date = new Date()) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const d = date;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

class Logger {
  /**
   * @param {{
   *   level?: LogLevel,
   *   file?: string,
   *   requests?: boolean,
   *   isTTY?: boolean,
   *   maxFileBytes?: number
   * }} [options]
   */
  constructor(options = {}) {
    this.level = this._validLevel(options.level) ? options.level.toLowerCase() : 'info';
    this.requests = options.requests !== false;
    this.isTTY = options.isTTY !== undefined ? options.isTTY : process.stdout.isTTY && !process.env.NO_COLOR;
    this.maxFileBytes =
      Number.isFinite(options.maxFileBytes) && options.maxFileBytes > 0 ? options.maxFileBytes : DEFAULT_MAX_LOG_BYTES;
    this.fileFd = null;
    this.fileBytes = 0;
    this.filePath = null;
    /** @type {Set<(level:string, tag:string, message:string) => void>} */
    this.taps = new Set();

    if (options.file) {
      this.setFile(options.file);
    }
  }

  _validLevel(lvl) {
    return typeof lvl === 'string' && Object.prototype.hasOwnProperty.call(LEVELS, lvl.toLowerCase());
  }

  setLevel(lvl) {
    if (this._validLevel(lvl)) {
      this.level = lvl.toLowerCase();
    }
  }

  isLevelEnabled(lvl) {
    const target = LEVELS[lvl.toLowerCase()] ?? 99;
    const current = LEVELS[this.level] ?? 2;
    return target <= current;
  }

  _closeFd() {
    if (this.fileFd === null) return;
    const fd = this.fileFd;
    this.fileFd = null;
    fs.closeSync(fd);
  }

  _rotateIfNeeded(incomingBytes) {
    if (this.fileFd === null || !this.filePath) return;
    if (this.fileBytes === 0 || this.fileBytes + incomingBytes <= this.maxFileBytes) return;
    const target = this.filePath;
    const backup = target + '.1';
    this._closeFd();
    fs.rmSync(backup, { force: true });
    fs.renameSync(target, backup);
    privateFile(backup);
    writePrivateFileSync(target, '');
    this.fileFd = fs.openSync(target, 'a', 0o600);
    this.fileBytes = 0;
  }

  setFile(filePath) {
    try {
      this._closeFd();
    } catch (err) {
      process.stderr.write(`[uburoom:logger] Could not close previous log file: ${err.message}\n`);
    }
    this.fileBytes = 0;
    if (!filePath) {
      this.filePath = null;
      return;
    }
    try {
      const resolved = path.resolve(filePath);
      ensurePrivateDirectorySync(path.dirname(resolved));
      if (!fs.existsSync(resolved)) writePrivateFileSync(resolved, '');
      else privateFile(resolved);
      this.fileFd = fs.openSync(resolved, 'a', 0o600);
      this.fileBytes = fs.statSync(resolved).size;
      this.filePath = resolved;
      if (this.fileBytes >= this.maxFileBytes) this._rotateIfNeeded(1);
    } catch (err) {
      try {
        this._closeFd();
      } catch {}
      this.filePath = null;
      process.stderr.write(`[uburoom:logger] Could not open log file ${filePath}: ${err.message}\n`);
    }
  }

  async close() {
    try {
      this._closeFd();
    } catch {}
  }

  /**
   * Receive every redacted line at info or above, whatever the console level.
   * @param {(level:string, tag:string, message:string) => void} listener
   */
  tap(listener) {
    this.taps.add(listener);
    return () => this.taps.delete(listener);
  }

  _write(level, tag, args) {
    const tapped = level !== 'debug' && this.taps.size > 0;
    if (!tapped && !this.isLevelEnabled(level)) return;

    const time = formatTimestamp();
    const cleanTag = tag ? `[${tag}]` : '';
    const levelUpper = level.toUpperCase().padEnd(5);

    // Sanitize parameters
    const sanitizedArgs = args.map(arg => redact(arg));
    const formattedMsg = util.format(...sanitizedArgs);
    if (tapped)
      for (const listener of this.taps) {
        try {
          listener(level, tag, stripAnsi(formattedMsg));
        } catch {}
      }
    if (!this.isLevelEnabled(level)) return;

    // Format console output
    let consoleMsg;
    if (this.isTTY) {
      const color = LEVEL_COLORS[level] || COLOR_CODES.reset;
      consoleMsg =
        `${COLOR_CODES.dim}${time}${COLOR_CODES.reset} ${color}${levelUpper}${COLOR_CODES.reset} ` +
        (cleanTag ? `${COLOR_CODES.cyan}${cleanTag}${COLOR_CODES.reset} ` : '') +
        formattedMsg +
        '\n';
    } else {
      consoleMsg = `${time} ${levelUpper} ${cleanTag ? cleanTag + ' ' : ''}${formattedMsg}\n`;
    }

    if (level === 'error') {
      process.stderr.write(consoleMsg);
    } else {
      process.stdout.write(consoleMsg);
    }

    // Write to log file if configured
    if (this.fileFd !== null) {
      const plainMsg = `${time} ${levelUpper} ${cleanTag ? cleanTag + ' ' : ''}${stripAnsi(formattedMsg)}\n`;
      const byteLength = Buffer.byteLength(plainMsg, 'utf8');
      try {
        this._rotateIfNeeded(byteLength);
        fs.writeSync(this.fileFd, plainMsg, null, 'utf8');
        this.fileBytes += byteLength;
      } catch (err) {
        process.stderr.write(`[uburoom:logger] File write error (${err.message}). Falling back to console only.\n`);
        try {
          this._closeFd();
        } catch {}
      }
    }
  }

  error(tag, ...args) {
    this._write('error', tag, args);
  }

  warn(tag, ...args) {
    this._write('warn', tag, args);
  }

  info(tag, ...args) {
    this._write('info', tag, args);
  }

  debug(tag, ...args) {
    this._write('debug', tag, args);
  }

  /**
   * Create a scoped logger with a fixed subsystem tag.
   * @param {string} tag
   */
  child(tag) {
    return {
      error: (...args) => this.error(tag, ...args),
      warn: (...args) => this.warn(tag, ...args),
      info: (...args) => this.info(tag, ...args),
      debug: (...args) => this.debug(tag, ...args),
      child: subTag => this.child(`${tag}:${subTag}`),
    };
  }
}

const defaultLogger = new Logger();

/** A logger that discards everything: the default where nothing configured one (tests, tools). */
const silentLogger = Object.freeze({
  error() {},
  warn() {},
  info() {},
  debug() {},
  isLevelEnabled: () => false,
  tap: () => () => {},
  child: () => silentLogger,
});

module.exports = {
  Logger,
  defaultLogger,
  silentLogger,
  redact,
  stripAnsi,
  formatTimestamp,
  LEVELS,
};
