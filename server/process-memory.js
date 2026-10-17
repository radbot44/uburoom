'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');

// Sample both resident and private committed memory on Windows. No synchronous
// process inspection on the playback event loop. Helpers have their own timeout.
async function processMemory(pid) {
  if (process.platform === 'linux') {
    const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
    return Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] || 0) * 1024;
  }
  const binary = process.platform === 'win32' ? 'powershell.exe' : 'ps';
  const args = process.platform === 'win32' ? ['-NoProfile','-NonInteractive','-Command',
    `$taskProcess=Get-Process -Id ${Number(pid)} -ErrorAction Stop; [Math]::Max($taskProcess.WorkingSet64,$taskProcess.PrivateMemorySize64)`] : ['-o','rss=','-p',String(pid)];
  return new Promise((resolve, reject) => execFile(binary, args, { windowsHide: true, timeout: 2000, maxBuffer: 1024 }, (error, stdout) => {
    if (error) return reject(error);
    const bytes = Number(stdout.trim()) * (process.platform === 'win32' ? 1 : 1024);
    Number.isFinite(bytes) ? resolve(bytes) : reject(new Error('Process memory unavailable'));
  }));
}
module.exports = { processMemory };
