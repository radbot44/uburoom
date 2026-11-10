/* Minimal PNG decode/encode for comparing browser screenshots: 8-bit, non-interlaced, Node built-ins only. */
'use strict';
const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }; // grey, RGB, grey+alpha, RGBA

/** Decode a PNG into { width, height, data } with data as RGBA bytes. */
function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file');
  let offset = 8,
    header;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset),
      type = buffer.toString('latin1', offset + 4, offset + 8),
      body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR')
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!header) throw new Error('PNG has no header');
  const channels = CHANNELS[header.colorType];
  if (header.depth !== 8 || !channels || header.interlace)
    throw new Error('Only 8-bit non-interlaced grey/RGB/RGBA PNGs are supported');
  const { width, height } = header,
    stride = width * channels,
    raw = zlib.inflateSync(Buffer.concat(idat)),
    pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)],
      line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)),
      row = y * stride,
      prior = row - stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[row + x - channels] : 0,
        up = y ? pixels[prior + x] : 0,
        corner = y && x >= channels ? pixels[prior + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner,
          pa = Math.abs(p - left),
          pb = Math.abs(p - up),
          pc = Math.abs(p - corner);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      } else if (filter !== 0) throw new Error('Unknown PNG filter ' + filter);
      pixels[row + x] = value & 255;
    }
  }
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const grey = channels <= 2;
    data[i * 4] = pixels[j];
    data[i * 4 + 1] = grey ? pixels[j] : pixels[j + 1];
    data[i * 4 + 2] = grey ? pixels[j] : pixels[j + 2];
    data[i * 4 + 3] = channels === 4 ? pixels[j + 3] : channels === 2 ? pixels[j + 1] : 255;
  }
  return { width, height, data };
}

function chunk(type, body) {
  const length = Buffer.alloc(4),
    crc = Buffer.alloc(4),
    typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  length.writeUInt32BE(body.length);
  crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

/** Encode RGBA bytes as a PNG. */
function encodePng({ width, height, data }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { decodePng, encodePng };
