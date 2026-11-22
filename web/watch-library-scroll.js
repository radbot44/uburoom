// Scrolling in Media. Back to top appears once Media has scrolled past its top, and while browsing the
// catalog the search and sort/filter rows slide up behind the header on the way down and return on the way
// up. Returning to a list puts it back as it was left: the same tile at the same place, with the tool rows
// tucked or shown as they were.

const TUCK_DISTANCE = 24;

/**
 * @param {{doc: Document, host: HTMLElement, header?: HTMLElement|null, tools: HTMLElement, filters: HTMLElement,
 *   results: HTMLElement, ends: HTMLElement[], onScrolledChange: () => void}} options
 *   `ends`: the elements whose bottom is the end of the page (footer, landing, more-results sentinel).
 */
export function libraryScroll({ doc, host, header, tools, filters, results, ends, onScrolledChange }) {
  let frame = 0,
    turnY = 0,
    tucked = false;

  function tuck(value) {
    if (tucked === value) return;
    tucked = value;
    tools.classList.toggle('library-tools-tucked', value);
  }
  function toolsStuck(headerBottom) {
    let after = tools.nextElementSibling;
    while (after && (after.hidden || !after.getClientRects().length)) after = after.nextElementSibling;
    return !!after && after.getBoundingClientRect().top - tools.offsetHeight < headerBottom - 4;
  }
  function follow() {
    frame = 0;
    const panel = host.closest('#library-panel');
    if (!panel || !header) return;
    const root = scrollElement(),
      box = viewport(root),
      y = root.scrollTop;
    const scrolled = panel.getBoundingClientRect().top < box.top - 1;
    if (panel.classList.contains('library-scrolled') !== scrolled) {
      panel.classList.toggle('library-scrolled', scrolled);
      onScrolledChange();
    }
    const inUse = tools.contains(doc.activeElement) || !filters.hidden;
    if (!scrolled || tools.hidden || inUse || !toolsStuck(header.getBoundingClientRect().bottom)) {
      tuck(false);
      turnY = y;
      return;
    }
    if (tucked ? y > turnY : y < turnY) turnY = y;
    else if (Math.abs(y - turnY) > TUCK_DISTANCE) {
      tuck(!tucked);
      turnY = y;
    }
  }
  doc.addEventListener(
    'scroll',
    () => {
      if (!frame) frame = requestAnimationFrame(follow);
    },
    { capture: true, passive: true },
  );
  tools.addEventListener('focusin', () => tuck(false));

  function scrollElement() {
    const drawer = host.closest('#drawer');
    if (drawer) return drawer;
    const panel = host.closest('#library-panel');
    return panel && getComputedStyle(panel).overflowY === 'auto' ? panel : doc.scrollingElement;
  }
  function viewport(root = scrollElement()) {
    const top = root === doc.scrollingElement ? 0 : root.getBoundingClientRect().top + root.clientTop;
    return { top, bottom: top + root.clientHeight };
  }
  /**
   * Where the tool rows end once settled (shown, or tucked up behind the header), whatever their slide is
   * doing now: the edge the visible list starts below, which scroll positions are kept relative to.
   */
  function toolsEdge(tuckedState = tucked) {
    const transform = getComputedStyle(tools).transform;
    const shift = transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m42 : 0;
    return tools.getBoundingClientRect().bottom - shift - (tuckedState ? tools.offsetHeight : 0);
  }
  /** The first tile showing below the tool rows, where it sits, and whether the tools were tucked. */
  function captureAnchor() {
    const root = scrollElement(),
      box = viewport(root),
      top = Math.max(box.top, toolsEdge());
    const item = [...results.querySelectorAll('.library-tile')].find(n => {
      const b = n.getBoundingClientRect();
      return b.bottom > top && b.top < box.bottom;
    });
    return {
      id: item?.dataset.item,
      offset: item ? item.getBoundingClientRect().top - top : 0,
      scroll: root.scrollTop,
      tucked,
    };
  }
  /** Keep the page at least as tall as now while it re-renders, so the scroll position cannot collapse. */
  function reserveHeight() {
    host.style.minHeight = Math.max(host.getBoundingClientRect().height, scrollElement().clientHeight) + 'px';
  }
  /** Height enough to scroll to `desired`, and no more than the page needs beyond that. */
  function roomForScroll(desired) {
    const root = scrollElement(),
      box = viewport(root),
      rect = host.getBoundingClientRect(),
      hostTop = root.scrollTop + rect.top - box.top;
    const end = Math.max(...ends.map(element => (element.hidden ? 0 : element.getBoundingClientRect().bottom)));
    host.style.minHeight = Math.ceil(Math.max(0, end - rect.top + 8, desired + root.clientHeight - hostTop)) + 'px';
  }
  function restoreAnchor(anchor) {
    const root = scrollElement(),
      item = anchor.id && [...results.querySelectorAll('.library-tile')].find(n => n.dataset.item === anchor.id);
    tuck(!!anchor.tucked && !tools.hidden);
    let desired = anchor.scroll;
    if (item) {
      const b = item.getBoundingClientRect(),
        top = Math.max(viewport(root).top, toolsEdge());
      const offset = Math.max(anchor.offset, -Math.max(0, b.height - 44));
      desired = Math.max(0, root.scrollTop + b.top - top - offset);
    }
    roomForScroll(desired);
    root.scrollTop = desired;
    // This scroll is the restore itself, not someone browsing: it neither tucks nor shows the tools.
    turnY = root.scrollTop;
  }
  /** Keep a visible shelf or card in place when content above it changes in the live Home view. */
  function preserveVisible(elements, update) {
    const root = scrollElement();
    const { top, bottom } = viewport(root);
    const headerBounds = header?.getBoundingClientRect();
    const scrolled = host.closest('#library-panel')?.getBoundingClientRect().top < top;
    const anchors = scrolled
      ? [...elements].flatMap(element => {
          const bounds = element.getBoundingClientRect();
          return bounds.bottom > (headerBounds?.bottom ?? top) && bounds.top < bottom
            ? [{ element, top: bounds.top }]
            : [];
        })
      : [];
    const result = update();
    const retained = anchors.find(anchor => anchor.element.isConnected);
    if (retained) {
      const delta = retained.element.getBoundingClientRect().top - retained.top;
      if (Math.abs(delta) > 1) {
        root.scrollTop += delta;
        turnY = root.scrollTop;
      }
    }
    return result;
  }
  /** Bring the page's content into view under the header, unless some of it already shows. */
  function position(behavior = 'instant') {
    const root = scrollElement(),
      box = viewport(root),
      rect = host.getBoundingClientRect();
    const contentTop = Math.max(
      box.top,
      header?.getBoundingClientRect().bottom || box.top,
      tools.hidden ? box.top : toolsEdge(),
    );
    const visible = [...host.querySelectorAll('.library-tile,.library-home-card,.library-overview')].some(item => {
      const bounds = item.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && bounds.bottom > contentTop && bounds.top < box.bottom;
    });
    if (visible || (rect.top >= box.top && rect.top < box.bottom)) {
      // Nothing to scroll to: keep only the height the current scroll position needs.
      roomForScroll(root.scrollTop);
      return;
    }
    // The content host starts after the header. Aligning it to the viewport
    // would put the first row underneath that sticky header.
    const panel = host.closest('#library-panel') || host;
    const desired = Math.max(0, root.scrollTop + panel.getBoundingClientRect().top - box.top);
    roomForScroll(desired);
    root.scrollTo({ top: desired, behavior });
  }
  return { scrollElement, tuck, captureAnchor, reserveHeight, roomForScroll, restoreAnchor, preserveVisible, position };
}
