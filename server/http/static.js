'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const zlib = require('node:zlib');
const { hash } = require('../core');
const { spriteMarkup } = require('../../web/icons');

const ROOT = path.join(__dirname, '../..');
const WEB = path.join(ROOT, 'web');
const SHARED = path.join(ROOT, 'shared');
const DIAGNOSTICS = path.join(ROOT, 'diagnostics');

/** What a static directory may serve, by extension. Anything else (HTML documents, notices, manifests) is never a file. */
const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/vnd.microsoft.icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};
/**
 * What each directory keeps back, by path inside it. `web/` serves everything its types allow except these:
 * files with a route of their own and the subtitle vendor directory, which has its own strict route.
 */
const DENIED = {
  web: rel => rel === 'theme.js' || /^dev-gallery\./.test(rel) || rel.startsWith('vendor/subtitles/'),
  shared: rel => rel === 'sync/index.js' || rel === 'sync/server-clock.mjs',
};
/** Fixed addresses for files that live elsewhere or under another name. */
const ALIASES = {
  '/assets/branding/uburoom-wordmark-brand.svg': path.join(WEB, 'assets/uburoom-wordmark-brand.svg'),
  '/assets/branding/uburoom-oomark-brand.svg': path.join(WEB, 'assets/uburoom-oomark-brand.svg'),
  '/favicon.svg': path.join(WEB, 'assets/uburoom-oomark-brand.svg'),
  '/favicon.ico': path.join(WEB, 'assets/uburoom-favicon.ico'),
  '/vendor/hls.js': path.join(ROOT, 'node_modules/hls.js/dist/hls.min.js'),
  '/__diagnostics/codec': path.join(DIAGNOSTICS, 'codec.html'),
  '/__diagnostics/codec.js': path.join(DIAGNOSTICS, 'codec.js'),
  '/__diagnostics/codec.css': path.join(DIAGNOSTICS, 'codec.css'),
};
const ALIAS_TYPES = { '.html': 'text/html; charset=utf-8' };
/** Pages that are a single HTML document (route to file inside web/). */
const DOCUMENTS = {
  '/auth/error': 'auth-error.html',
  '/demo-discord': 'demo-discord.html',
  '/demo-plex': 'demo-plex.html',
};
const SUBTITLE_VENDOR =
  /^\/vendor\/subtitles\/(jassub(?:-worker(?:-modern)?)?\.(?:js|wasm)|libbitsub(?:-renderer)?\.js|libbitsub_bg\.wasm|default\.woff2)$/;

function etagMatches(clientEtag, serverEtag) {
  if (!clientEtag) return false;
  if (clientEtag === '*') return true;
  const target = serverEtag.replace(/^W\//, '');
  return clientEtag.split(',').some(tag => tag.trim().replace(/^W\//, '') === target);
}

/**
 * Static files: cached, compressed and tagged. Any file under `web/` whose type is allowed is served at its
 * path, so adding a file needs no server change; `shared/` is served at `/shared/`.
 * @param {{config: any}} services
 */
function createStaticFiles({ config }) {
  const assetCache = new Map();
  const staticCache = new Map();
  let themeScript;
  async function readAsset(file, encoding) {
    const key = file + (encoding ? ':' + encoding : '');
    const hit = assetCache.get(key);
    if (hit !== undefined) return hit;
    const data = await fsp.readFile(file, encoding);
    if (assetCache.size < 128) assetCache.set(key, data);
    return data;
  }
  function send(req, res, content, type, key) {
    const cacheKey = key || content;
    let entry = staticCache.get(cacheKey);
    if (!entry) {
      const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
      const etag = 'W/"' + hash(raw).slice(0, 16) + '"';
      const compressible = /^(text\/|image\/svg\+xml|application\/(javascript|wasm))/.test(type) && raw.length >= 256;
      entry = {
        raw,
        etag,
        gzip: compressible ? zlib.gzipSync(raw, { level: 6 }) : null,
        brotli: compressible
          ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } })
          : null,
      };
      if (staticCache.size < 128) staticCache.set(cacheKey, entry);
    }
    if (etagMatches(req.headers['if-none-match'], entry.etag)) {
      res.writeHead(304, { ETag: entry.etag, 'Cache-Control': 'public, no-cache', Vary: 'Accept-Encoding' });
      return res.end();
    }
    const accept = req.headers['accept-encoding'] || '';
    let body = entry.raw,
      encoding;
    if (entry.brotli && /\bbr\b/.test(accept)) {
      body = entry.brotli;
      encoding = 'br';
    } else if (entry.gzip && /\bgzip\b/.test(accept)) {
      body = entry.gzip;
      encoding = 'gzip';
    }
    const headers = {
      'Content-Type': type,
      'Content-Length': body.length,
      ETag: entry.etag,
      'Cache-Control': 'public, no-cache',
      Vary: 'Accept-Encoding',
    };
    if (encoding) headers['Content-Encoding'] = encoding;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  }
  /** The file a path names inside a served directory, or undefined. */
  async function inside(root, rel, denied) {
    if (!rel || rel.includes('\\') || rel.includes('\0') || rel.split('/').some(part => !part || part === '..')) return;
    const type = TYPES[path.extname(rel)];
    if (!type || denied(rel)) return;
    const file = path.join(root, rel);
    try {
      if ((await fsp.stat(file)).isFile()) return { file, type };
    } catch {
      /* Not a file. */
    }
  }
  /** The file served at a route, or undefined. Documents with routes of their own are not files. */
  async function lookup(route) {
    if (Object.hasOwn(ALIASES, route)) {
      const file = ALIASES[route];
      return { file, type: TYPES[path.extname(file)] || ALIAS_TYPES[path.extname(file)] };
    }
    if (route.startsWith('/shared/')) return inside(SHARED, route.slice('/shared/'.length), DENIED.shared);
    return inside(WEB, route.slice(1), DENIED.web);
  }
  /** Whether a route is a static file or document, which request throttling leaves alone. */
  const isStatic = ({ route, asset }) =>
    !!asset || route === '/theme.js' || SUBTITLE_VENDOR.test(route) || Object.hasOwn(DOCUMENTS, route);
  /** The static files' entries for the route table. */
  function routes() {
    return [
      {
        name: 'subtitle vendor files',
        methods: ['GET', 'HEAD'],
        path: SUBTITLE_VENDOR,
        async handle({ req, res, route }, match) {
          const name = match[1],
            type = name.endsWith('.wasm')
              ? 'application/wasm'
              : name.endsWith('.woff2')
                ? 'font/woff2'
                : 'text/javascript; charset=utf-8';
          if (name.endsWith('.js'))
            res.setHeader(
              'Content-Security-Policy',
              "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self' blob:",
            );
          send(req, res, await readAsset(path.join(WEB, 'vendor/subtitles', name)), type, route);
        },
      },
      {
        name: 'documents',
        methods: ['GET', 'HEAD'],
        path: route => Object.hasOwn(DOCUMENTS, route),
        async handle({ req, res, route, json }) {
          // The demo pages exist only on isolated demo servers.
          if (!config.demo && route !== '/auth/error') return json(res, 404, { error: 'Not found' });
          send(req, res, await readAsset(path.join(WEB, DOCUMENTS[route])), 'text/html; charset=utf-8', route);
        },
      },
      {
        // Development-only control gallery: exists only on isolated demo servers (scripts set
        // `demo: true`; private YAML cannot), which are themselves restricted to localhost.
        name: 'development gallery',
        methods: ['GET', 'HEAD'],
        path: /^\/__dev\/gallery(\.js|\.css)?$/,
        async handle({ req, res, route, json }, match) {
          if (!config.demo) return json(res, 404, { error: 'Not found' });
          const [file, type] = {
            '': ['dev-gallery.html', 'text/html'],
            '.js': ['dev-gallery.js', 'text/javascript'],
            '.css': ['dev-gallery.css', 'text/css'],
          }[match[1] || ''];
          let content = await readAsset(path.join(WEB, file), 'utf8');
          if (route === '/__dev/gallery')
            content = content.replace(
              '<svg id="icon-sprite" hidden aria-hidden="true" width="0" height="0"></svg>',
              spriteMarkup(),
            );
          send(req, res, content, type + '; charset=utf-8', route);
        },
      },
      {
        // The page's theme script carries the branding SVGs it draws, inlined.
        name: 'theme script',
        methods: ['GET', 'HEAD'],
        path: '/theme.js',
        async handle({ req, res, route }) {
          if (!themeScript) {
            const [wordmark, favicon, script] = await Promise.all([
              readAsset(ALIASES['/assets/branding/uburoom-wordmark-brand.svg'], 'utf8'),
              readAsset(ALIASES['/favicon.svg'], 'utf8'),
              readAsset(path.join(WEB, 'theme.js'), 'utf8'),
            ]);
            const sources = { '/assets/branding/uburoom-wordmark-brand.svg': wordmark, '/favicon.svg': favicon };
            themeScript = 'window.uburoomBrandAssets=' + JSON.stringify(sources) + ';\n' + script;
          }
          send(req, res, themeScript, 'text/javascript; charset=utf-8', route);
        },
      },
      {
        name: 'static files',
        methods: ['GET', 'HEAD'],
        match: ctx => ctx.asset,
        async handle({ req, res, route }, asset) {
          send(req, res, await readAsset(asset.file), asset.type, route);
        },
      },
    ];
  }
  return { readAsset, send, lookup, isStatic, routes, close: () => assetCache.clear() };
}
module.exports = { createStaticFiles, DOCUMENTS, SUBTITLE_VENDOR, WEB };
