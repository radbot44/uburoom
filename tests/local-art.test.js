'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { findOnPath } = require('../server/media-tools');
const { AV1 } = require('../server/av1');
const { run } = require('../server/media-tools');
const { LocalMedia } = require('../server/sources/folders/provider');
const { frameScore } = require('../server/sources/folders/art');

const ffmpeg = findOnPath('ffmpeg'),
  ffprobe = findOnPath('ffprobe');
const demo = path.join(__dirname, '..', 'assets', 'demo', 'sync-test.mp4');

function setup(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-art-'));
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
  // Pictures may still be in the making in the background: the folder goes once they have ended.
  t.after(async () => {
    await local.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
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
    // The chosen frame is kept too, so each kind is made from it without reading the video again.
    assert.equal(fs.readdirSync(art).length, 3);
    // Asked again, the saved picture is served as it is.
    assert.deepEqual((await local.artwork(item.id, 'poster')).bytes, poster.bytes);
    assert.equal(fs.readdirSync(art).length, 3);
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

// A 24-bit BMP whose rows are each one grey level.
function bmp(width, height, level) {
  const row = Math.ceil((width * 3) / 4) * 4,
    bytes = Buffer.alloc(54 + row * height);
  bytes.write('BM', 0, 'latin1');
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  for (let y = 0; y < height; y++) bytes.fill(level(y), 54 + y * row, 54 + y * row + width * 3);
  return bytes;
}

test('a lit frame with something in it scores above a black or a flat one', () => {
  const black = frameScore(bmp(64, 64, () => 0)),
    flat = frameScore(bmp(64, 64, () => 90)),
    lit = frameScore(bmp(64, 64, y => (Math.floor(y / 4) % 2 ? 200 : 40)));
  assert.ok(black < flat && flat < lit, [black, flat, lit].join(' < '));
  assert.equal(frameScore(Buffer.from('not a bitmap')), undefined);
});

test(
  'an early dark scene loses to a lit one, and no frame comes from past a fifth of the video',
  { skip: !ffmpeg || !ffprobe },
  async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-art-dark-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    // 40 seconds: black to 3 s (5% is 2 s), a lit test pattern to 8 s (10% and 15%), then plain dark red to the end.
    const clip = path.join(root, 'clip.mp4');
    const parts = [
      'color=c=black:s=320x180:r=24:d=3',
      'testsrc2=s=320x180:r=24:d=5',
      'color=c=0x400000:s=320x180:r=24:d=32',
    ];
    await run(
      ffmpeg,
      [
        '-v',
        'error',
        ...parts.flatMap(part => ['-f', 'lavfi', '-i', part]),
        '-filter_complex',
        '[0][1][2]concat=n=3:v=1:a=0',
        '-pix_fmt',
        'yuv420p',
        clip,
      ],
      undefined,
      60000,
    );
    const { local, art } = setup(t, { 'Clip.mp4': clip });
    const [item] = (await local.browse({ section: 'film' })).items;
    await local.artwork(item.id, 'landscape');
    // The busy frame is larger than a flat one. Concurrent writes only publish their JPEG after renaming the temp file.
    const sizes = fs
      .readdirSync(art)
      .filter(name => name.endsWith('.jpg'))
      .map(name => fs.statSync(path.join(art, name)).size);
    assert.ok(Math.max(...sizes) > 20000, 'saved sizes ' + sizes.join(', '));
  },
);

test('pictures are made ahead of time after a scan, one video at a time', { skip: !ffmpeg || !ffprobe }, async t => {
  const { local, art } = setup(t, { 'One.mp4': demo, 'Two.mp4': demo });
  await local.browse({ section: 'film' });
  // Nobody asks for a picture: each video's frame and poster are made in the background.
  const deadline = Date.now() + 20000;
  while ((fs.existsSync(art) ? fs.readdirSync(art).filter(name => !name.endsWith('.tmp')).length : 0) < 4) {
    assert.ok(Date.now() < deadline, 'pictures made in time');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  // Asked for now, a poster is already there.
  const [item] = (await local.browse({ section: 'film' })).items;
  const started = Date.now();
  await local.artwork(item.id, 'poster');
  assert.ok(Date.now() - started < 500, 'served from what was made ahead');
});
