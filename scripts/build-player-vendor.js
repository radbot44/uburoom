'use strict';
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const result = require('esbuild').buildSync({ stdin: { contents: 'export { DiscordSDK } from "@discord/embedded-app-sdk";', resolveDir: root },
  bundle: true, minify: true, format: 'iife', globalName: 'RadTVDiscord', platform: 'browser',
  outfile: path.resolve(__dirname, '../web/vendor/discord-sdk.js'), legalComments: 'eof', metafile: true });
const packages = new Set(Object.keys(result.metafile.inputs).map(input => /node_modules\/(\@[^/]+\/[^/]+|[^/]+)\//.exec(input)?.[1]).filter(Boolean));
const notices = [];
for (const name of [...packages, 'hls.js']) {
  const directory = path.join(root, 'node_modules', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md'].map(file => path.join(directory, file)).find(file => fs.existsSync(file));
  notices.push(`${name} ${pkg.version} (${pkg.license})\n${license ? fs.readFileSync(license, 'utf8') : JSON.stringify(pkg.repository)}\n`);
}
fs.writeFileSync(path.join(root, 'web/vendor/THIRD_PARTY_NOTICES.txt'), notices.join('\n-----\n\n').trimEnd() + '\n');
console.log('Bundled Discord Activity SDK.');
