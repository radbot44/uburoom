// Provider pictures for Media: each fetched once and kept as an object URL. Posters load as they scroll
// near, a few at a time; a details page's backdrop and title logo load at once, ahead of that queue.

// A details page's backdrop and title logo: they load at once, ahead of the poster queue.
const PRIORITY_ART = ['backdrop', 'logo'];
const KEEP = 160,
  AT_ONCE = 4;

/**
 * @param {{doc: Document, fetchArt: (item: string, kind: string, type: string, signal: AbortSignal) => Promise<Blob>}} options
 */
export function pictureLoader({ doc, fetchArt }) {
  const images = new Map(),
    pending = new Map();
  /** @type {AbortController|null} */
  let controller = null;
  /** @type {IntersectionObserver|null} */
  let observer = null;
  let queue = [],
    active = 0,
    reusable;

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
  function load(item, kind, type) {
    const key = item + ':' + kind;
    if (images.has(key)) return Promise.resolve(images.get(key));
    if (pending.has(key)) return pending.get(key);
    const signal = controller.signal;
    const promise = fetchArt(item, kind, type, signal)
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
      const key = img.dataset.item + ':' + img.dataset.kind;
      if (images.has(key)) {
        img.src = images.get(key);
        continue;
      }
      active++;
      load(img.dataset.item, img.dataset.kind, img.dataset.type)
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
    if (item.hasBackdrop) load(item.id, 'backdrop', item.type).catch(() => {});
    if (item.hasLogo) load(item.id, 'logo', item.type).catch(() => {});
  }
  /** One provider picture in `box`, loaded through the shared image queue; the box gets `loaded` once shown. */
  function picture(box, item, kind) {
    const key = item.id + ':' + kind;
    const img = reusable?.get(key) || doc.createElement('img');
    reusable?.delete(key);
    box.append(img);
    img.alt = '';
    img.decoding = 'async';
    img.dataset.item = item.id;
    img.dataset.kind = kind;
    img.dataset.type = item.type;
    img.onload = () => {
      img.parentElement?.classList.add('loaded');
    };
    if (img.src) box.classList.toggle('loaded', img.complete && img.naturalWidth > 0);
    else if (images.has(key)) {
      img.src = images.get(key);
      // A details picture already fetched (a prefetch, or the page's first render) shows at once: no text
      // title first and no fade. Only one that arrives while the page is open fades in.
      if (PRIORITY_ART.includes(kind)) box.classList.add('loaded', 'instant');
    } else if (PRIORITY_ART.includes(kind))
      load(item.id, kind, item.type)
        .then(url => {
          if (url && img.isConnected && !img.src) img.src = url;
        })
        .catch(() => {});
    else observer.observe(img);
    return img;
  }
  /** While a page re-renders, its pictures already on screen are moved into the new markup instead of reloaded. */
  function reuse(imgs) {
    reusable = new Map([...imgs].map(img => [img.dataset.item + ':' + img.dataset.kind, img]));
  }
  function endReuse() {
    reusable = undefined;
  }
  return { reset, load, prefetch, picture, reuse, endReuse };
}
