/* Prepare an isolated extension build for explicitly configured HTTPS origins. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function serverOrigin(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.hostname.includes('*') || url.hostname.includes('[')) throw new Error('Supply an HTTPS origin with a DNS name or IPv4 address, without credentials, path, query or wildcard.');
  return url.origin;
}
function configureRemote(inputs, destination = path.join(root, 'releases/remote')) {
  if (!inputs.length || inputs.length > 8) throw new Error('Supply between one and eight --server=https://watch.example origins.');
  const origins = [...new Set(inputs.map(serverOrigin))];
  const target = path.resolve(destination);
  // Never overwrite source, existing builds, profiles or installed extension data.
  const source = path.join(root, 'extension');
  const relative = path.relative(source, target);
  if (target.toLowerCase() === root.toLowerCase() || !relative || !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) || fs.existsSync(target)) throw new Error('Use a new output directory outside extension source.');
  const files = ['manifest.json', 'server-config.js', 'background.js', 'content.js', 'engine.js', 'popup.css', 'popup.html', 'popup.js', 'remote-ui.js'];
  files.push('assets/uburoom-wordmark-brand.svg', 'assets/uburoom-oomark-brand.svg', 'assets/uburoom-favicon.ico', ...[16,32,48,64,96,128,256,512].map(size => `assets/uburoom-icon-${size}.png`));
  // Never copy unrelated local files or credentials into the prepared build.
  for (const file of files) fs.accessSync(path.join(source, file), fs.constants.R_OK);
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    fs.copyFileSync(path.join(source, file), path.join(target, file), fs.constants.COPYFILE_EXCL);
  }
  const manifestFile = path.join(target, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.host_permissions = ['https://tv.youtube.com/*', ...new Set(origins.map(origin => 'https://' + new URL(origin).hostname + '/*'))];
  manifest.content_security_policy.extension_pages = "script-src 'self'; object-src 'none'; connect-src " + origins.flatMap(origin => [origin, origin.replace('https:', 'wss:')]).join(' ');
  fs.writeFileSync(path.join(target, 'server-config.js'), `/* Explicit per-installation origins; no credentials. */\nglobalThis.UBUROOM_REMOTE_SERVERS = Object.freeze(${JSON.stringify(origins)});\n`);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  return target;
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !arg.startsWith('--server=') && !arg.startsWith('--out='))) throw new Error('Use --server=https://watch.example (repeat for additional permitted servers) and optional --out=new-directory.');
    const output = args.filter(arg => arg.startsWith('--out='));
    if (output.length > 1) throw new Error('Supply at most one output directory.');
    console.log('Prepared extension: ' + configureRemote(args.filter(arg => arg.startsWith('--server=')).map(arg => arg.slice(9)), output[0]?.slice(6)));
    console.log('No installation, pairing, signing or publication occurred. Existing profiles require their stored server origin in this build.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { serverOrigin, configureRemote };
