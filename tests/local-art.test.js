'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { findOnPath } = require('../server/media-tools');
const { AV1, run } = require('../server/av1');
const { LocalMedia } = require('../server/local-provider');

const ffmpeg = findOnPath('ffmpeg'),
  ffprobe = findOnPath('ffprobe');
const demo = path.join(__dirname, '..', 'assets', 'demo', 'sync-test.mp4');

function setup(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-art-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const media = path.join(root, 'media'),
    art = path.join(root, 'data', 'local-art');
  for (const [file, from] of Object.entries(files)) {
    fs.mkdirSync(path.join(media, path.dirname(file)), { recursive: true });
    fs.copyFileSync(from, path.join(media, file));
  }
  const av1 = new AV1({ ffmpegPath: ffmpeg });
  av1.ffprobe = ffprobe;
  const local = new LocalMedia([{ id: 'film', name: 'Film', paths: [media] }], {
    pipeline: { av1 },
    artDirectory: art,
  });
  t.after(() => local.close());
  return { local, media, art };
}

// The size of a baseline JPEG from its first start-of-frame marker.
function jpegSize(bytes) {
  for (let at = 2; at < bytes.length;) {
    const marker = bytes[at + 1];
    if (marker === 0xc0 || marker === 0xc2)
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    at += 2 + bytes.readUInt16BE(at + 2);
  }
}

test(
  'a local video without pictures gets a frame, made once and kept outside the media folder',
  { skip: !ffmpeg || !ffprobe },
  async t => {
    const { local, media, art } = setup(t, { 'Clip (2020)/Clip.mp4': demo });
    const [item] = (await local.browse({ section: 'film' })).items;
    assert.equal(item.hasPoster, true);
    assert.equal(item.hasLogo, false);
    const poster = await local.artwork(item.id, 'poster');
    assert.equal(poster.type, 'image/jpeg');
    // A wide frame fills the tall poster: it sits whole on a blurred copy of itself.
    assert.deepEqual(jpegSize(poster.bytes), { width: 300, height: 450 });
    assert.deepEqual(jpegSize((await local.artwork(item.id, 'landscape')).bytes), { width: 400, height: 225 });
    const saved = fs.readdirSync(art);
    assert.equal(saved.length, 2);
    // Asked again, the saved picture is served as it is.
    assert.deepEqual((await local.artwork(item.id, 'poster')).bytes, poster.bytes);
    assert.equal(fs.readdirSync(art).length, 2);
    assert.deepEqual(fs.readdirSync(path.join(media, 'Clip (2020)')), ['Clip.mp4']);
    await assert.rejects(local.artwork(item.id, 'logo'), /unavailable/);
    await assert.rejects(local.artwork(item.id, 'banner'), /Invalid artwork/);
  },
);

test(
  'a picture file beside the video is used before a frame, resized and never enlarged',
  { skip: !ffmpeg || !ffprobe },
  async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-art-src-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const poster = path.join(root, 'poster.png'),
      small = path.join(root, 'small.png');
    await run(
      ffmpeg,
      ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=600x900', '-frames:v', '1', poster],
      undefined,
      30000,
    );
    await run(
      ffmpeg,
      ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=200x100', '-frames:v', '1', small],
      undefined,
      30000,
    );
    const { local } = setup(t, {
      'Clip (2020)/Clip.mp4': demo,
      'Clip (2020)/poster.png': poster,
      'Clip (2020)/fanart.png': small,
      'Other.mp4': demo,
      'Other-poster.png': small,
    });
    const items = (await local.browse({ section: 'film' })).items;
    const clip = items.find(item => item.title === 'Clip'),
      other = items.find(item => item.title === 'Other');
    const picture = await local.artwork(clip.id, 'poster');
    assert.deepEqual(jpegSize(picture.bytes), { width: 300, height: 450 });
    // Red, not a frame of the video.
    assert.ok(picture.bytes.length < 4000);
    // A small backdrop stays its own size, and the wide tile uses it too.
    assert.deepEqual(jpegSize((await local.artwork(clip.id, 'backdrop')).bytes), { width: 200, height: 100 });
    assert.deepEqual(jpegSize((await local.artwork(clip.id, 'landscape')).bytes), { width: 200, height: 100 });
    // `Name-poster` belongs to its own video even at the top of a library; folder names like `poster` do not.
    assert.deepEqual(jpegSize((await local.artwork(other.id, 'poster')).bytes), { width: 200, height: 100 });
  },
);
