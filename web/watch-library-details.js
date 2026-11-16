// A Media details page: backdrop, artwork, the show and season line with episode steps, title or logo,
// actions, summary, facts, media info and other editions. Pieces shared with library tiles (artwork, action
// buttons, the metadata and extras lines) and navigation come from watch-library.js.
import * as uburoomIcons from './icons.js';

/**
 * @param {{doc: Document, overview: HTMLElement, node: Function, button: Function, picture: Function, art: Function,
 *   metadata: Function, extras: Function, runtime: Function, playable: Function,
 *   actions: {play: Function, resume: Function, queue: Function, suggest: Function, bulk: Function, auto: Function},
 *   can: () => {queue: boolean, suggest: boolean, bulk: boolean, auto: boolean, durable: boolean},
 *   openItem: Function, openParent: Function}} ui
 */
export function libraryDetails(ui) {
  const { doc, overview, node, button, picture, art, metadata, extras, runtime, playable, actions, can } = ui;
  const { openItem, openParent } = ui;
  function render(item) {
    overview.replaceChildren();
    overview.hidden = !item;
    if (!item) return;
    const episode = item.type === 'episode';
    // The provider's background art fades in behind the top of the page; without one the page stays plain.
    overview.classList.toggle('has-backdrop', !!item.hasBackdrop);
    if (item.hasBackdrop) picture(node('div', overview, undefined, 'library-detail-backdrop'), item, 'backdrop');
    const top = node(
      'div',
      overview,
      undefined,
      'library-detail-top' + (episode ? ' episode-detail' : item.type === 'movie' ? ' movie-detail' : ''),
    );
    const pictures = node('div', top, undefined, 'library-detail-art');
    art(pictures, item, episode);
    const copy = node('div', top, undefined, 'library-detail-copy');
    parentLine(copy, item);
    const heading = node('h3', copy);
    // A movie or show with a title logo shows it in place of the text once it loads; the logo carries the title.
    if (item.hasLogo) picture(node('span', heading, undefined, 'library-detail-logo'), item, 'logo').alt = item.title;
    node('span', heading, item.title, 'library-detail-title');
    node('p', copy, metadata(item), 'library-meta');
    extras(copy, item, true);
    if (playable(item)) {
      const actionRow = node('div', copy, undefined, 'library-detail-actions');
      actions.play(actionRow, item, true);
      if (item.viewOffset > 0) actions.resume(actionRow, item);
      if (can().queue) actions.queue(actionRow, item, true);
      if (can().suggest && item.id !== 'demo') actions.suggest(actionRow, item, true);
    } else if (can().durable) {
      const actionRow = node('div', copy, undefined, 'library-detail-actions');
      if (can().bulk && ['show', 'season'].includes(item.type)) actions.bulk(actionRow, item);
      if (can().auto && ['show', 'collection'].includes(item.type))
        actions.auto(
          actionRow,
          { type: item.type, id: item.id, ...(item.serverId ? { serverId: item.serverId } : {}) },
          item.title,
        );
    }
    const body = node('div', copy, undefined, 'library-detail-body');
    if (item.summary) node('p', body, item.summary, 'library-summary');
    const rows = [];
    if (item.directors?.length) rows.push(['Director', item.directors.join(', ')]);
    if (item.cast?.length) rows.push(['Cast', item.cast.join(', ')]);
    if (item.ratings?.length)
      rows.push([
        'Ratings',
        item.ratings
          .map(
            r =>
              r.source +
              ' ' +
              (r.source.startsWith('Rotten Tomatoes') ? Math.round(r.value * 10) + '%' : r.value.toFixed(1) + '/10'),
          )
          .join(' · '),
      ]);
    if (rows.length) {
      const facts = node('dl', body, undefined, 'library-facts');
      for (const [label, value] of rows) {
        node('dt', facts, label);
        node('dd', facts, value);
      }
    }
    if (item.mediaInfo?.length) {
      const info = node('details', body, undefined, 'library-media-info');
      node('summary', info, 'Media info');
      node('p', info, item.mediaInfo.join(' · '), 'library-credit');
    }
    if (item.otherEditions?.length) {
      const editionsSection = node('div', body, undefined, 'library-editions-section');
      node('h4', editionsSection, 'Other editions', 'library-editions-heading');
      const editionsList = node('div', editionsSection, undefined, 'library-editions-list');
      for (const ed of item.otherEditions) {
        const edBtn = button(editionsList, 'Switch to ' + (ed.edition || ed.title), undefined, 'library-edition-row');
        const edInfo = node('div', edBtn, undefined, 'library-edition-info');
        node('strong', edInfo, ed.edition || ed.title, 'library-edition-title');
        if (ed.mediaInfo?.length) {
          node('span', edInfo, ed.mediaInfo.slice(0, 3).join(' · '), 'library-edition-meta hint');
        } else if (ed.subtitle) {
          node('span', edInfo, ed.subtitle, 'library-edition-meta hint');
        }
        if (ed.duration) {
          node('span', edBtn, runtime(ed.duration), 'library-edition-duration hint');
        }
        edBtn.addEventListener('click', () => {
          void openItem(ed);
        });
      }
    }
  }
  // An episode names its show and season above its title, and a season its show, each a link there. At the
  // line's end an episode steps to the episodes either side of it in the show.
  function parentLine(parent, item) {
    const links =
      item.type === 'episode'
        ? [
            { id: item.showId, type: 'show', title: item.showTitle },
            { id: item.parentId, type: 'season', title: item.parentTitle },
          ]
        : item.type === 'season'
          ? [{ id: item.parentId, type: 'show', title: item.parentTitle }]
          : [];
    const targets = links.filter(link => link.id && link.title);
    const steps = item.type === 'episode' ? [item.previous, item.next] : [];
    if (!targets.length && !steps.some(step => step?.id)) return;
    const line = node('div', parent, undefined, 'library-detail-parent');
    const crumbs = node('p', line, undefined, 'library-detail-parent-links');
    targets.forEach((target, index) => {
      if (index) node('span', crumbs, '·', 'library-detail-parent-divider');
      const link = node('button', crumbs, target.title, 'library-detail-parent-link');
      link.type = 'button';
      link.onclick = () => openParent({ ...target, ...(item.serverId ? { serverId: item.serverId } : {}) });
    });
    if (!steps.some(step => step?.id)) return;
    const pager = node('div', line, undefined, 'library-episode-steps');
    pager.setAttribute('role', 'group');
    pager.setAttribute('aria-label', 'Episodes');
    steps.forEach((step, index) => {
      const later = index === 1;
      if (!step?.id) return;
      // "E5" within the season, "S2 · E1" across a season boundary.
      const where =
        (step.seasonIndex !== undefined && step.seasonIndex !== item.seasonIndex
          ? 'S' + step.seasonIndex + ' · '
          : '') + (step.index !== undefined ? 'E' + step.index : later ? 'Next' : 'Previous');
      const b = button(
        pager,
        (later ? 'Next episode: ' : 'Previous episode: ') + where + ' · ' + step.title,
        later ? undefined : 'left',
        'library-key library-episode-step',
      );
      node('span', b, where);
      if (later) b.append(uburoomIcons.icon(doc, 'right'));
      b.onclick = () =>
        void openItem({
          id: step.id,
          type: 'episode',
          title: step.title,
          ...(item.serverId ? { serverId: item.serverId } : {}),
        });
    });
  }
  return { render };
}
