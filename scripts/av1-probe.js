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
  const ffmpeg = process.argv.find(a => a.startsWith('--ffmpeg='))?.slice(9) || require('../server/media-tools').findOnPath('ffmpeg');
  if (!ffmpeg) throw new Error('Install FFmpeg on the server PATH or supply its path with --ffmpeg=...');
  const encoder=process.argv.find(arg=>arg.startsWith('--encoder='))?.slice(10)||'hardware';
  if(!['hardware','software'].includes(encoder))throw new Error('Choose --encoder=hardware or --encoder=software');
  const version = await diagnosticRun(ffmpeg, ['-version']);
  console.log(version.toString().split(/\r?\n/)[0]);
  console.log('Testing uburoom '+(encoder==='hardware'?'av1_qsv':'libsvtav1')+' settings with synthetic video/audio.');
  const bytes = await probeEncoder(ffmpeg, undefined, diagnosticRun,encoder);
  const out = path.resolve(__dirname, '../artifacts/av1-'+(encoder==='hardware'?'qsv':'software')+'-probe.webm');
  fs.mkdirSync(path.dirname(out), {recursive:true}); fs.writeFileSync(out, bytes);
  console.log('PASS: '+(encoder==='hardware'?'Intel av1_qsv':'libsvtav1')+' + Opus encoded synthetic WebM on this machine.');
  console.log('Probe output: ' + out);
  console.log('This does not verify Plex access, HDR tone mapping, live Discord streaming, or high-resolution performance.');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { diagnosticRun };
