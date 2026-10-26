'use strict';
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

/**
 * @typedef {'error' | 'warn' | 'info' | 'debug'} LogLevel
 */

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const COLOR_CODES = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

const LEVEL_COLORS = {
  error: COLOR_CODES.red,
  warn: COLOR_CODES.yellow,
  info: COLOR_CODES.green,
  debug: COLOR_CODES.magenta
};

/**
 * Sanitize strings or error messages by masking sensitive tokens and passwords.
 * @param {any} value
 * @returns {any}
 */
function redact(value) {
  if (typeof value === 'string') {
    let result = value;
    result = result.replace(
      /((?:x-plex-token|token|password|entry_password|client_secret|bot_token)\s*[:=]\s*['"]?)([^'"&\s,;]+)(['"]?)/gi,
      (match, p1, p2, p3) => p1 + '[REDACTED]' + (typeof p3 === 'string' ? p3 : '')
    );
    result = result.replace(/(uburoom=)([^;,\s]+)/gi, '$1[REDACTED]');
    result = result.replace(/(Bearer\s+)([a-zA-Z0-9_\-\.]+)/gi, '$1[REDACTED]');
    return result;
  }
  if (value instanceof Error) {
    const copy = new Error(redact(value.message));
    if (value.stack) copy.stack = redact(value.stack);
    if (value.code) copy.code = value.code;
    return copy;
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === 'object') {
    const sanitized = {};
    for (const [k, v] of Object.entries(value)) {
      if (/token|secret|password|credential|cookie/i.test(k) && typeof v === 'string') {
        sanitized[k] = '[REDACTED]';
      } else {
        sanitized[k] = redact(v);
      }
    }
    return sanitized;
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
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

class Logger {
  /**
   * @param {{
   *   level?: LogLevel,
   *   file?: string,
   *   requests?: boolean,
   *   isTTY?: boolean
   * }} [options]
   */
  constructor(options = {}) {
    this.level = this._validLevel(options.level) ? options.level.toLowerCase() : 'info';
    this.requests = options.requests !== false;
    this.isTTY = options.isTTY !== undefined ? options.isTTY : (process.stdout.isTTY && !process.env.NO_COLOR);
    this.fileStream = null;
    this.filePath = null;

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

  setFile(filePath) {
    if (this.fileStream) {
      try {
        this.fileStream.end();
      } catch (err) {
        process.stderr.write(`[uburoom:logger] Could not close previous log file stream: ${err.message}\n`);
      } finally {
        this.fileStream = null;
      }
    }
    if (!filePath) {
      this.filePath = null;
      return;
    }
    try {
      const resolved = path.resolve(filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.closeSync(fs.openSync(resolved, 'a'));
      this.fileStream = fs.createWriteStream(resolved, { flags: 'a', encoding: 'utf8' });
      this.fileStream.on('error', (err) => {
        process.stderr.write(`[uburoom:logger] File stream error (${err.message}). Falling back to console only.\n`);
        this.fileStream = null;
      });
      this.filePath = resolved;
    } catch (err) {
      process.stderr.write(`[uburoom:logger] Could not open log file ${filePath}: ${err.message}\n`);
    }
  }

  async close() {
    if (!this.fileStream) return;
    const stream = this.fileStream;
    this.fileStream = null;
    await new Promise((resolve) => {
      stream.end(resolve);
    });
  }

  _write(level, tag, args) {
    if (!this.isLevelEnabled(level)) return;

    const time = formatTimestamp();
    const cleanTag = tag ? `[${tag}]` : '';
    const levelUpper = level.toUpperCase().padEnd(5);

    // Sanitize parameters
    const sanitizedArgs = args.map(redact);
    const formattedMsg = util.format(...sanitizedArgs);

    // Format console output
    let consoleMsg;
    if (this.isTTY) {
      const color = LEVEL_COLORS[level] || COLOR_CODES.reset;
      consoleMsg = `${COLOR_CODES.dim}${time}${COLOR_CODES.reset} ${color}${levelUpper}${COLOR_CODES.reset} ` +
        (cleanTag ? `${COLOR_CODES.cyan}${cleanTag}${COLOR_CODES.reset} ` : '') +
        formattedMsg + '\n';
    } else {
      consoleMsg = `${time} ${levelUpper} ${cleanTag ? cleanTag + ' ' : ''}${formattedMsg}\n`;
    }

    if (level === 'error') {
      process.stderr.write(consoleMsg);
    } else {
      process.stdout.write(consoleMsg);
    }

    // Write to log file if configured
    if (this.fileStream && this.fileStream.writable) {
      const plainMsg = `${time} ${levelUpper} ${cleanTag ? cleanTag + ' ' : ''}${stripAnsi(formattedMsg)}\n`;
      this.fileStream.write(plainMsg);
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
      child: (subTag) => this.child(`${tag}:${subTag}`)
    };
  }
}

const defaultLogger = new Logger();

module.exports = {
  Logger,
  defaultLogger,
  redact,
  stripAnsi,
  formatTimestamp,
  LEVELS
};
