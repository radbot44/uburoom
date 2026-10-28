'use strict';
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const result = require('esbuild').buildSync({ stdin: { contents: 'export { DiscordSDK } from "@discord/embedded-app-sdk";', resolveDir: root },
  bundle: true, minify: true, format: 'iife', globalName: 'uburoomDiscord', platform: 'browser',
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
notices.push(`Tabler Icons (MIT) — selected outline SVGs in web/icons.js
https://github.com/tabler/tabler-icons

MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`);
notices.push(`OverlayScrollbars 2.17.0 (MIT)
https://github.com/KingSora/OverlayScrollbars/releases/tag/v2.17.0

MIT License

Copyright (c) 2022 Rene Haas

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`);
fs.writeFileSync(path.join(root, 'web/vendor/THIRD_PARTY_NOTICES.txt'), notices.join('\n-----\n\n').replace(/\r\n?/g, '\n').trimEnd() + '\n');
console.log('Bundled Discord Activity SDK.');
