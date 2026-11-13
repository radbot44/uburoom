/* Compare two ui-capture folders pixel by pixel. Writes diff images and an HTML report into the evidence folder (scripts/lib/evidence.js).
 * Usage: node scripts/ui-compare.js <folderA> <folderB> [--tolerance=8] [--out=<folder>]
 * Exits 1 when any image differs beyond the per-channel tolerance or exists in only one folder.
 */
'use strict';
const { EVIDENCE } = require('./lib/evidence');
const fs = require('node:fs');
const path = require('node:path');
const { decodePng, encodePng } = require('./lib/png');

const root = path.resolve(__dirname, '..');

function pngs(folder) {
  const found = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.png')) found.push(path.relative(folder, full).split(path.sep).join('/'));
    }
  };
  walk(folder);
  return found.sort();
}

/** Count pixels where any channel differs by more than tolerance; return the count, bounding box and diff image. */
function compareImages(a, b, tolerance) {
  if (a.width !== b.width || a.height !== b.height)
    return { sizeMismatch: true, changed: Math.max(a.width * a.height, b.width * b.height), box: null, diff: null };
  const diff = Buffer.alloc(a.data.length);
  let changed = 0,
    left = Infinity,
    top = Infinity,
    right = -1,
    bottom = -1;
  for (let i = 0, p = 0; i < a.data.length; i += 4, p++) {
    const differs =
      Math.abs(a.data[i] - b.data[i]) > tolerance ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > tolerance ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > tolerance ||
      Math.abs(a.data[i + 3] - b.data[i + 3]) > tolerance;
    if (differs) {
      changed++;
      const x = p % a.width,
        y = (p - x) / a.width;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      diff[i] = 255;
      diff[i + 1] = 0;
      diff[i + 2] = 64;
    } else {
      // Faded greyscale of the first image, so changed pixels stand out in place.
      const grey = Math.round((a.data[i] * 0.3 + a.data[i + 1] * 0.59 + a.data[i + 2] * 0.11) * 0.35 + 140);
      diff[i] = diff[i + 1] = diff[i + 2] = grey;
    }
    diff[i + 3] = 255;
  }
  return {
    sizeMismatch: false,
    changed,
    box: changed ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null,
    diff: changed ? { width: a.width, height: a.height, data: diff } : null,
  };
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}

function main() {
  const args = process.argv.slice(2);
  const folders = args.filter(arg => !arg.startsWith('--'));
  const option = (name, fallback) =>
    args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3) ?? fallback;
  if (folders.length !== 2) {
    console.error('Usage: node scripts/ui-compare.js <folderA> <folderB> [--tolerance=8] [--out=<folder>]');
    process.exitCode = 2;
    return;
  }
  const [a, b] = folders.map(folder => path.resolve(root, folder));
  for (const folder of [a, b])
    if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Not a folder: ' + folder);
  const tolerance = Number(option('tolerance', '8'));
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) throw new Error('Tolerance must be 0-255');
  const out = path.resolve(
    root,
    option('out', path.join(EVIDENCE, 'ui-compare', path.basename(a) + '--' + path.basename(b))),
  );
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error('Report folder is not empty: ' + out);
  fs.mkdirSync(out, { recursive: true });

  const listA = pngs(a),
    listB = pngs(b),
    all = [...new Set([...listA, ...listB])].sort();
  const rows = [];
  for (const name of all) {
    if (!listA.includes(name) || !listB.includes(name)) {
      rows.push({ name, status: listA.includes(name) ? 'only in A' : 'only in B' });
      continue;
    }
    const imageA = decodePng(fs.readFileSync(path.join(a, name))),
      imageB = decodePng(fs.readFileSync(path.join(b, name)));
    const result = compareImages(imageA, imageB, tolerance);
    let diffFile;
    if (result.diff) {
      diffFile = 'diff/' + name;
      fs.mkdirSync(path.dirname(path.join(out, diffFile)), { recursive: true });
      fs.writeFileSync(path.join(out, diffFile), encodePng(result.diff));
    }
    rows.push({
      name,
      status: result.sizeMismatch
        ? 'size ' + imageA.width + 'x' + imageA.height + ' vs ' + imageB.width + 'x' + imageB.height
        : result.changed
          ? 'changed'
          : 'identical',
      changed: result.changed,
      total: imageA.width * imageA.height,
      box: result.box,
      diffFile,
    });
  }

  const differing = rows.filter(row => row.status !== 'identical');
  for (const row of rows) {
    const detail = row.box
      ? row.changed +
        ' px (' +
        ((row.changed / row.total) * 100).toFixed(3) +
        '%), box x=' +
        row.box.x +
        ' y=' +
        row.box.y +
        ' ' +
        row.box.width +
        'x' +
        row.box.height
      : row.status === 'identical'
        ? ''
        : '';
    console.log(row.status.padEnd(10) + ' ' + row.name + (detail ? '  ' + detail : ''));
  }

  // A static report: A, B and diff side by side for every differing image. Image paths are relative.
  const relative = file => htmlEscape(path.relative(out, file).split(path.sep).join('/'));
  const sections = differing
    .map(row => {
      const images = [
        fs.existsSync(path.join(a, row.name))
          ? '<figure><img src="' + relative(path.join(a, row.name)) + '"><figcaption>A</figcaption></figure>'
          : '',
        fs.existsSync(path.join(b, row.name))
          ? '<figure><img src="' + relative(path.join(b, row.name)) + '"><figcaption>B</figcaption></figure>'
          : '',
        row.diffFile
          ? '<figure><img src="' + htmlEscape(row.diffFile) + '"><figcaption>Changed pixels</figcaption></figure>'
          : '',
      ].join('');
      const box = row.box
        ? ' · ' + row.changed + ' px · box ' + row.box.x + ',' + row.box.y + ' ' + row.box.width + '×' + row.box.height
        : '';
      return (
        '<section><h2>' +
        htmlEscape(row.name) +
        '</h2><p>' +
        htmlEscape(row.status + box) +
        '</p><div class="row">' +
        images +
        '</div></section>'
      );
    })
    .join('\n');
  const report =
    '<!doctype html><meta charset="utf-8"><title>UI compare</title><style>body{font:14px system-ui;margin:24px;background:#fff;color:#111}.row{display:flex;gap:12px;align-items:flex-start}figure{margin:0;flex:1;min-width:0}img{width:100%;border:1px solid #ccc}</style>' +
    '<h1>UI compare</h1><p>A: ' +
    htmlEscape(a) +
    '<br>B: ' +
    htmlEscape(b) +
    '<br>Tolerance: ' +
    tolerance +
    ' per channel. ' +
    (rows.length - differing.length) +
    ' identical, ' +
    differing.length +
    ' differing of ' +
    rows.length +
    '.</p>\n' +
    sections +
    '\n';
  fs.writeFileSync(path.join(out, 'index.html'), report);
  console.log(
    (differing.length
      ? differing.length + ' of ' + rows.length + ' images differ'
      : 'All ' + rows.length + ' images identical') +
      ' (tolerance ' +
      tolerance +
      '). Report: ' +
      path.relative(root, path.join(out, 'index.html')),
  );
  if (differing.length) process.exitCode = 1;
}
try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
