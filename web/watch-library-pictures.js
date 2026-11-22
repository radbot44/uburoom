// Provider pictures for Media: each fetched once and kept as an object URL. Posters load as they scroll
// near, a few at a time; a details page's backdrop and title logo load at once, ahead of that queue.

// A details page's backdrop and title logo: they load at once, ahead of the poster queue.
const PRIORITY_ART = ['backdrop', 'logo'];
const KEEP = 160,
  AT_ONCE = 4;

/**
 * Fits a wide thumbnail (such as a 16:9 YouTube thumbnail) inside a portrait poster box
 * on top of a darkened, blurred copy of itself instead of cropping its sides.
 * @param {HTMLElement} box
 * @param {HTMLImageElement} img
 * @param {{enabled?: boolean, fillClass?: string}} [options]
 */
export function syncPosterFill(box, img, { enabled = true, fillClass = 'library-art-fill' } = {}) {
  const wide = enabled && !!img.src && img.complete && img.naturalWidth > img.naturalHeight;
  box.classList.toggle('poster-fill', wide);
  const existing = [...box.children].find(child => child.classList.contains(fillClass));
  if (!wide) {
    existing?.remove();
    return;
  }
  const fill = existing || box.ownerDocument.createElement('span');
  if (!existing) {
    fill.className = fillClass;
    fill.setAttribute('aria-hidden', 'true');
    const layer = box.ownerDocument.createElement('span');
    layer.className = fillClass + '-image';
    fill.append(layer);
    box.insertBefore(fill, img);
  }
  const layer = /** @type {HTMLElement|null} */ (fill.firstElementChild);
  if (layer) layer.style.backgroundImage = 'url(' + img.src + ')';
}

/**
 * @param {{doc: Document,
 *   serverFor: (item: {serverId?: string}) => string | undefined,
 *   fetchArt: (server: string, item: string, kind: string, type: string, signal: AbortSignal) => Promise<Blob>}} options
 */
export function pictureLoader({ doc, serverFor, fetchArt }) {
  const images = new Map(),
    pending = new Map();
  /** @type {AbortController|null} */
  let controller = null;
  /** @type {IntersectionObserver|null} */
  let observer = null;
  let queue = [],
    active = 0,
    reusable;
  const keyFor = (server, item, kind, type) => JSON.stringify([server, item, kind, type]);

  /** Forget every picture: a new room starts with none, and loads still running for the old one are dropped. */
  function reset() {
    controller?.abort();
    observer?.disconnect();
    queue = [];
    active = 0;
    for (const value of images.values()) URL.revokeObjectURL(value);
    images.clear();
    pending.clear();
    controller = new AbortController();
    observer = new IntersectionObserver(
      entries => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            observer.unobserve(entry.target);
            queue.push(entry.target);
          }
        pump();
      },
      { rootMargin: '180px' },
    );
  }
  /**
   * One provider picture as an object URL, cached and fetched once however many places ask for it at a time.
   * Resolves to undefined when the room changed meanwhile.
   */
  function load(server, item, kind, type) {
    const key = keyFor(server, item, kind, type);
    if (images.has(key)) return Promise.resolve(images.get(key));
    if (pending.has(key)) return pending.get(key);
    const signal = controller.signal;
    const promise = fetchArt(server, item, kind, type, signal)
      .then(blob => {
        if (signal.aborted) return undefined;
        const url = URL.createObjectURL(blob),
          old = images.get(key);
        if (old) URL.revokeObjectURL(old);
        images.set(key, url);
        while (images.size > KEEP) {
          const first = images.keys().next().value;
          URL.revokeObjectURL(images.get(first));
          images.delete(first);
        }
        return url;
      })
      .finally(() => {
        if (pending.get(key) === promise) pending.delete(key);
      });
    pending.set(key, promise);
    return promise;
  }
  function pump() {
    const owner = controller;
    while (active < AT_ONCE && queue.length) {
      const img = queue.shift();
      if (!img.isConnected || img.src) continue;
      const { server, item, kind, type } = img.dataset;
      const key = keyFor(server, item, kind, type);
      if (images.has(key)) {
        img.src = images.get(key);
        continue;
      }
      active++;
      load(server, item, kind, type)
        .then(url => {
          if (url && img.isConnected) img.src = url;
        })
        .catch(() => {})
        .finally(() => {
          // A reset already zeroed the count for the room this load belonged to.
          if (owner === controller) {
            active--;
            pump();
          }
        });
    }
  }
  /** Start fetching an item's details pictures before its page needs them (on click, or hover on a mouse). */
  function prefetch(item) {
    if (!item || item.id === 'demo' || !controller) return;
    const server = serverFor(item) || '';
    if (item.hasBackdrop) load(server, item.id, 'backdrop', item.type).catch(() => {});
    if (item.hasLogo) load(server, item.id, 'logo', item.type).catch(() => {});
  }
  /** One provider picture in `box`, loaded through the shared image queue; the box gets `loaded` once shown. */
  function picture(box, item, kind) {
    const server = serverFor(item) || '';
    const key = keyFor(server, item.id, kind, item.type);
    const img = reusable?.get(key) || doc.createElement('img');
    reusable?.delete(key);
    box.append(img);
    img.alt = '';
    img.decoding = 'async';
    img.dataset.server = server;
    img.dataset.item = item.id;
    img.dataset.kind = kind;
    img.dataset.type = item.type;
    img.onload = () => {
      const currentBox = img.parentElement;
      if (!currentBox) return;
      currentBox.classList.add('loaded');
      syncPosterFill(currentBox, img, {
        enabled: img.dataset.kind === 'poster' && !currentBox.classList.contains('landscape'),
      });
    };
    if (img.src) {
      box.classList.toggle('loaded', img.complete && img.naturalWidth > 0);
      syncPosterFill(box, img, { enabled: kind === 'poster' && !box.classList.contains('landscape') });
    } else if (images.has(key)) {
      img.src = images.get(key);
      // A details picture already fetched (a prefetch, or the page's first render) shows at once: no text
      // title first and no fade. Only one that arrives while the page is open fades in.
      if (PRIORITY_ART.includes(kind)) box.classList.add('loaded', 'instant');
    } else if (PRIORITY_ART.includes(kind))
      load(server, item.id, kind, item.type)
        .then(url => {
          if (url && img.isConnected && !img.src) img.src = url;
        })
        .catch(() => {});
    else observer.observe(img);
    return img;
  }
  /** While a page re-renders, its pictures already on screen are moved into the new markup instead of reloaded. */
  function reuse(imgs) {
    reusable = new Map(
      [...imgs].map(img => {
        const { server, item, kind, type } = img.dataset;
        return [keyFor(server, item, kind, type), img];
      }),
    );
  }
  function endReuse() {
    reusable = undefined;
  }
  return { reset, load, prefetch, picture, reuse, endReuse };
}
