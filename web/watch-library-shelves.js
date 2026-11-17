// Home shelves own their DOM and scroll state. Account refreshes only fetch data; unchanged titles
// keep their pictures, focus and controls when that data arrives again.
export function libraryShelves({ host, node, button, tile }) {
  const shelves = new Map();
  const key = item => JSON.stringify([item.serverId || '', item.id]);
  function create(title, shape) {
    const section = node('section', host, undefined, 'library-shelf');
    section.setAttribute('aria-label', title);
    node('h3', section, title, 'library-shelf-title');
    const viewport = node('div', section, undefined, 'library-shelf-viewport');
    const strip = node('div', viewport, undefined, 'library-shelf-row ' + shape);
    strip.dataset.view = shape === 'landscape' ? 'cards' : 'posters';
    strip.tabIndex = 0;
    strip.setAttribute('role', 'group');
    strip.setAttribute('aria-label', title);
    const previous = button(
      viewport,
      'Scroll ' + title.toLowerCase() + ' left',
      'left',
      'library-shelf-arrow previous',
    );
    const next = button(viewport, 'Scroll ' + title.toLowerCase() + ' right', 'right', 'library-shelf-arrow next');
    const update = () => {
      const left = strip.scrollLeft > 1;
      const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
      viewport.dataset.left = String(left);
      viewport.dataset.right = String(right);
      previous.disabled = !left;
      next.disabled = !right;
      previous.hidden = next.hidden = strip.scrollWidth <= strip.clientWidth + 1;
    };
    const scroll = direction =>
      strip.scrollBy({
        left: direction * strip.clientWidth * 0.8,
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      });
    previous.onclick = () => scroll(-1);
    next.onclick = () => scroll(1);
    strip.addEventListener('scroll', update, { passive: true });
    strip.addEventListener('keydown', event => {
      if (event.target !== strip || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home' || event.key === 'End')
        strip.scrollTo({ left: event.key === 'Home' ? 0 : strip.scrollWidth });
      else scroll(event.key === 'ArrowLeft' ? -1 : 1);
    });
    const observer = new ResizeObserver(update);
    observer.observe(strip);
    return { section, strip, update, observer, items: new Map() };
  }
  function render(rows) {
    for (const [title, shelf] of shelves) {
      if (rows.some(row => row.title === title && row.items?.length)) continue;
      shelf.observer.disconnect();
      shelf.section.remove();
      shelves.delete(title);
    }
    let sectionCursor = host.firstChild;
    for (const { title, items, shape } of rows) {
      if (!items?.length) continue;
      let shelf = shelves.get(title);
      if (!shelf) {
        shelf = create(title, shape);
        shelves.set(title, shelf);
      }
      if (shelf.section !== sectionCursor) host.insertBefore(shelf.section, sectionCursor);
      sectionCursor = shelf.section.nextSibling;
      const edge = shelf.strip.getBoundingClientRect().left;
      const visible =
        shelf.strip.scrollLeft > 0 && [...shelf.strip.children].find(card => card.getBoundingClientRect().right > edge);
      const anchor = visible ? [...shelf.items].find(([, entry]) => entry.card === visible) : undefined;
      const anchorLeft = anchor?.[1].card.getBoundingClientRect().left;
      const wanted = new Set(items.map(key));
      for (const [id, entry] of shelf.items) {
        if (wanted.has(id)) continue;
        entry.card.remove();
        shelf.items.delete(id);
      }
      let cursor = shelf.strip.firstChild;
      for (const item of items) {
        const id = key(item);
        const signature = JSON.stringify(item);
        let entry = shelf.items.get(id);
        if (entry?.signature !== signature) {
          const card = tile(item, { parent: null, shape });
          if (entry) {
            if (cursor === entry.card) cursor = card;
            entry.card.replaceWith(card);
          }
          entry = { card, signature };
          shelf.items.set(id, entry);
        }
        if (entry.card !== cursor) shelf.strip.insertBefore(entry.card, cursor);
        cursor = entry.card.nextSibling;
      }
      // New additions ahead of the visible title do not push the reader back through the row.
      const retained = anchor && shelf.items.get(anchor[0]);
      if (retained) {
        const delta = retained.card.getBoundingClientRect().left - anchorLeft;
        if (Math.abs(delta) > 1) shelf.strip.scrollLeft += delta;
      }
      shelf.update();
    }
    return shelves.size > 0;
  }
  function clear() {
    for (const shelf of shelves.values()) shelf.observer.disconnect();
    shelves.clear();
    host.replaceChildren();
  }
  return { render, clear };
}
