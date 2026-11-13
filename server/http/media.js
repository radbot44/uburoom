'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const DEMO = path.join(__dirname, '../../assets/demo');
/** Synthetic samples only: the codec tester's media, by name. */
const TEST_SAMPLES = {
  'sample.mp4': 'sync-test.mp4',
  'h264-baseline.mp4': 'h264-baseline.mp4',
  'h264-main.mp4': 'h264-main.mp4',
  'vp8.webm': 'vp8.webm',
  'vp9.webm': 'vp9.webm',
  'av1.webm': 'av1.webm',
  'hevc.mp4': 'hevc.mp4',
};

/**
 * The codec tester's sample media, with byte ranges. Production requires current admission and active
 * Admin mode, including when requested with an Activity bearer identity.
 * @param {{config: any, hub: any, watchRoutes: () => any}} services
 * @returns {import('./router').Route[]}
 */
function mediaRoutes({ config, hub, watchRoutes }) {
  return [
    {
      name: 'codec tester media',
      methods: ['GET', 'HEAD'],
      path: route => route.startsWith('/__diagnostics/media/') && Object.hasOwn(TEST_SAMPLES, route.slice(21)),
      async handle({ req, res, route, json }) {
        const sampleName = route.slice('/__diagnostics/media/'.length);
        if (config.codecDiagnostics !== true) {
          const auth = await watchRoutes().authorized(req);
          if (!auth || !hub.isAdmin(auth.actor))
            return json(res, 403, { error: 'Turn on Admin mode to use the codec tester.' });
        }
        const sampleFile = path.join(DEMO, TEST_SAMPLES[sampleName]);
        let stat;
        try {
          stat = await fsp.stat(sampleFile);
        } catch {
          return json(res, 404, { error: 'Test sample is missing' });
        }
        const size = stat.size,
          range = req.headers.range;
        let start = 0,
          end = size - 1;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match || (!match[1] && !match[2])) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}` });
            return res.end();
          }
          if (!match[1]) start = Math.max(0, size - Number(match[2]));
          else {
            start = Number(match[1]);
            if (match[2]) end = Math.min(end, Number(match[2]));
          }
          if (!Number.isSafeInteger(start) || start > end || start >= size) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}` });
            return res.end();
          }
        }
        const headers = {
          'Content-Type': sampleName.endsWith('.webm') ? 'video/webm' : 'video/mp4',
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
        };
        if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        res.writeHead(range ? 206 : 200, headers);
        if (req.method === 'HEAD') return res.end();
        const source = fs.createReadStream(sampleFile, { start, end });
        source.on('error', () => res.destroy());
        res.on('close', () => source.destroy());
        source.pipe(res);
      },
    },
  ];
}
module.exports = { mediaRoutes };
