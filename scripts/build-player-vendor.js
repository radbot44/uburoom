'use strict';
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const result = require('esbuild').buildSync({ stdin: { contents: 'export { DiscordSDK } from "@discord/embedded-app-sdk";', resolveDir: root },
  bundle: true, minify: true, format: 'iife', globalName: 'RadTVDiscord', platform: 'browser',
  outfile: path.resolve(__dirname, '../web/vendor/discord-sdk.js'), legalComments: 'eof', metafile: true });
const packages = new Set(Object.keys(result.metafile.inputs).map(input => /node_modules\/(\@[^/]+\/[^/]+|[^/]+)\//.exec(input)?.[1]).filter(Boolean));
// Published SDK modules include libraries below output/lib, which the outer
// node_modules package match alone cannot identify.
const sdkLibraries = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const name = /@discord\/embedded-app-sdk\/output\/lib\/([^/]+)\//.exec(input)?.[1];
  if (name) {
    if (!sdkLibraries.has(name)) sdkLibraries.set(name, []);
    sdkLibraries.get(name).push(input);
  }
}
const notices = [];
for (const name of [...new Set([...packages, 'hls.js', ...[...sdkLibraries.keys()].sort()])]) {
  const directory = path.join(root, 'node_modules', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md'].map(file => path.join(directory, file)).find(file => fs.existsSync(file));
  if (!license) throw new Error('Missing upstream license text for ' + name);
  const scope = sdkLibraries.has(name) ? 'SDK-vendored copy; embedded version unspecified. Upstream notice from locked ' : '';
  const sourceNotices = new Set();
  for (const input of sdkLibraries.get(name) || []) {
    const source = fs.readFileSync(path.join(root, input), 'utf8');
    for (const comment of source.match(/\/\*[\s\S]*?\*\//g) || []) if (/copyright|licen[cs]e/i.test(comment)) sourceNotices.add(comment);
  }
  notices.push(`${scope}${name} ${pkg.version} (${pkg.license})\n${[...sourceNotices].join('\n')}\n${fs.readFileSync(license, 'utf8')}\n`);
}
fs.writeFileSync(path.join(root, 'web/vendor/THIRD_PARTY_NOTICES.txt'), notices.join('\n-----\n\n').replace(/\r\n?/g, '\n').trimEnd() + '\n');
console.log('Bundled Discord Activity SDK.');
