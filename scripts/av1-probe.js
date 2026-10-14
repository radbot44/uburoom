/* Run ON the server: node scripts/av1-probe.js --ffmpeg=C:/ffmpeg/bin/ffmpeg.exe
   Synthetic only. No .env, Plex credentials, installations, or service changes. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { probeEncoder, run } = require('../server/av1');

// Only this synthetic, credential-free CLI prints FFmpeg diagnostics. The
// server's media runner must continue suppressing stderr and private inputs.
async function diagnosticRun(binary, args, signal, timeout = 15000, maxOutput = 1024 * 1024) {
  let details = '';
  try { return await run(binary, args, signal, timeout, maxOutput, (code, stderr) => {
    details = `FFmpeg exited with code ${code}\n${stderr.trim() || '(no FFmpeg diagnostic output)'}`;
  }); }
  catch (error) { throw new Error(details || error.message); }
}
async function main() {
  const ffmpeg = process.argv.find(a => a.startsWith('--ffmpeg='))?.slice(9) || process.env.FFMPEG_PATH;
  if (!ffmpeg) throw new Error('Supply the existing the server FFmpeg path with --ffmpeg=...');
  const version = await diagnosticRun(ffmpeg, ['-version']);
  console.log(version.toString().split(/\r?\n/)[0]);
  console.log('Testing the exact uburoom av1_qsv settings with synthetic video/audio.');
  const bytes = await probeEncoder(ffmpeg, undefined, diagnosticRun);
  const out = path.resolve(__dirname, '../artifacts/av1-qsv-probe.webm');
  fs.mkdirSync(path.dirname(out), {recursive:true}); fs.writeFileSync(out, bytes);
  console.log('PASS: Intel av1_qsv + Opus encoded synthetic WebM on this machine.');
  console.log('Probe output: ' + out);
  console.log('This does not verify Plex access, HDR tone mapping, live Discord streaming, or high-resolution performance.');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { diagnosticRun };
