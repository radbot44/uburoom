/* Run ON the server: node scripts/av1-probe.js --ffmpeg=C:/ffmpeg/bin/ffmpeg.exe
   Synthetic only. No .env, Plex credentials, installations, or service changes. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { AV1, probeEncoder, run } = require('../server/av1');

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
  const codec=process.argv.find(arg=>arg.startsWith('--codec='))?.slice(8)||'av1';
  if(!['av1','vp9','vp8'].includes(codec))throw new Error('Choose --codec=av1, vp9 or vp8');
  const encoder=process.argv.find(arg=>arg.startsWith('--encoder='))?.slice(10)||'auto';
  if(!['auto','hardware','qsv','nvenc','software'].includes(encoder))throw new Error('Choose --encoder=auto, qsv, nvenc or software');
  const version = await diagnosticRun(ffmpeg, ['-version']);
  console.log(version.toString().split(/\r?\n/)[0]);
  const manager=new AV1({}, {ffmpegPath:ffmpeg,transcoding:{encoder,cpuFallback:true}},diagnosticRun);
  let selected,bytes;
  try {selected=await manager.selectEncoder(codec);bytes=await probeEncoder(ffmpeg,undefined,diagnosticRun,selected,codec);}
  finally {await manager.close();}
  const out = path.resolve(__dirname, '../artifacts/'+codec+'-'+selected+'-probe.webm');
  fs.mkdirSync(path.dirname(out), {recursive:true}); fs.writeFileSync(out, bytes);
  console.log('PASS: '+codec.toUpperCase()+' / '+selected+' + Opus encoded synthetic WebM on this machine.');
  console.log('Probe output: ' + out);
  console.log('This does not verify Plex access, HDR tone mapping, live Discord streaming, or high-resolution performance.');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { diagnosticRun };
