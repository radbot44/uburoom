// The library buttons in the Media header. Libraries that do not fit beside the navigation go into one
// menu at the end of the row. The current library always stays visible; when even it and the menu button
// do not fit, the button alone names it. Past ten libraries the menu starts with a filter box.
import * as uburoomControls from './watch-controls.js';
import * as uburoomIcons from './icons.js';
import { sectionIcon } from '../shared/library-cards.mjs';

export { sectionIcon };

const MENU_FILTER_AT = 10;

/**
 * @param {{doc: Document, parent: Element, menuParent: Element, header?: Element|null, headerRight?: Element|null,
 *   node: Function, button: Function, onChoose: (sectionId: string) => void}} options
 */
export function libraryChoices({ doc, parent, menuParent, header, headerRight, node, button, onChoose }) {
  const controls = uburoomControls;
  const choices = node('div', parent, undefined, 'library-choices watch-control-group watch-header-actions');
  choices.setAttribute('role', 'group');
  choices.setAttribute('aria-label', 'Libraries');
  choices.hidden = true;
  const choiceMenu = node('div', menuParent, undefined, 'library-choice-menu');
  choiceMenu.id = 'library-choice-menu';
  choiceMenu.popover = 'auto';
  choiceMenu.setAttribute('role', 'menu');
  choiceMenu.setAttribute('aria-label', 'Libraries');
  const choiceFilter = node('input', choiceMenu, undefined, 'library-choice-filter');
  choiceFilter.type = 'search';
  choiceFilter.placeholder = 'Find a library';
  choiceFilter.setAttribute('aria-label', 'Find a library');
  const choiceList = node('div', choiceMenu, undefined, 'library-choice-list');
  let sections = [],
    current,
    choiceMore = null,
    overflowSections = [];

  function menuItems() {
    return [...choiceList.querySelectorAll('button:not([hidden])')];
  }
  function renderChoiceMenu() {
    choiceList.replaceChildren();
    const term = choiceFilter.value.trim().toLowerCase();
    for (const section of overflowSections) {
      const b = button(choiceList, section.title, undefined, 'library-choice-item');
      b.setAttribute('role', 'menuitem');
      controls.content(b, { label: section.title, icon: sectionIcon(section) });
      b.dataset.section = section.id;
      if (section.id === current) b.setAttribute('aria-current', 'page');
      b.hidden = !!term && !section.title.toLowerCase().includes(term);
      b.onclick = () => {
        choiceMenu.hidePopover();
        onChoose(section.id);
      };
    }
  }
  choiceMenu.addEventListener('beforetoggle', event => {
    if (event.newState !== 'open' || !choiceMore) return;
    choiceFilter.value = '';
    choiceFilter.hidden = sections.length <= MENU_FILTER_AT;
    renderChoiceMenu();
    placeChoiceMenu();
  });
  choiceMenu.addEventListener('toggle', event => {
    choiceMore?.setAttribute('aria-expanded', String(event.newState === 'open'));
    if (event.newState !== 'open') return;
    (choiceFilter.hidden
      ? menuItems().find(b => b.hasAttribute('aria-current')) || menuItems()[0]
      : choiceFilter
    )?.focus();
  });
  choiceFilter.addEventListener('input', renderChoiceMenu);
  choiceMenu.addEventListener('keydown', event => {
    const items = menuItems();
    if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = items.indexOf(doc.activeElement);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (index + 1) % items.length
            : index <= 0
              ? items.length - 1
              : index - 1;
    items[nextIndex].focus();
  });
  // Position goes to the stylesheet as --x and --y; the menu keeps a fixed width there.
  function placeChoiceMenu() {
    if (!choiceMore) return;
    const anchor = choiceMore.getBoundingClientRect(),
      width = parseFloat(getComputedStyle(choiceMenu).width) || 260;
    choiceMenu.style.setProperty('--x', Math.max(8, Math.min(innerWidth - width - 8, anchor.left)) + 'px');
    choiceMenu.style.setProperty('--y', anchor.bottom + 6 + 'px');
  }
  doc.addEventListener('scroll', () => choiceMenu.matches(':popover-open') && placeChoiceMenu(), {
    capture: true,
    passive: true,
  });
  addEventListener('resize', () => choiceMenu.matches(':popover-open') && choiceMenu.hidePopover());

  /** Show as many library buttons as fit before the header's right-hand controls; the rest go to the menu. */
  function fit() {
    if (!choiceMore || choices.hidden || !header || !choices.getClientRects().length) return;
    const items = [...choices.querySelectorAll('.library-choice:not(.library-more)')];
    const currentButton = items.find(b => b.getAttribute('aria-current') === 'page');
    const gap = parseFloat(getComputedStyle(header).columnGap) || 0;
    const fits = () =>
      [...choices.children]
        .filter(b => !b.hidden)
        .pop()
        .getBoundingClientRect().right <=
      (headerRight ? headerRight.getBoundingClientRect().left - gap : header.getBoundingClientRect().right) + 0.5;
    const label = compact => {
      const section = compact && sections.find(item => item.id === current);
      const text = section ? section.title : 'More';
      controls.content(choiceMore, {
        label: text,
        icon: section ? sectionIcon(section) : undefined,
      });
      // It keeps its name at every width (truncating when it must) rather than collapsing to an icon.
      choiceMore.classList.remove('watch-control-responsive');
      choiceMore.append(uburoomIcons.icon(doc, 'chevron'));
      choiceMore.setAttribute('aria-label', section ? 'Library: ' + section.title : 'More libraries');
      choiceMore.title = section ? 'Choose a library' : 'More libraries';
      choiceMore.toggleAttribute('data-current', !!section);
    };
    items.forEach(b => (b.hidden = false));
    choiceMore.hidden = true;
    if (!fits()) {
      label(false);
      choiceMore.hidden = false;
      for (const b of items.filter(b => b !== currentButton).reverse()) {
        b.hidden = true;
        if (fits()) break;
      }
      if (!fits()) {
        items.forEach(b => (b.hidden = true));
        label(true);
      }
    }
    overflowSections = sections.filter(section => items.some(b => b.hidden && b.dataset.section === section.id));
    if (choiceMore.hidden && choiceMenu.matches(':popover-open')) choiceMenu.hidePopover();
  }
  let fitFrame = 0;
  /** Fit once on the next frame, however many layout changes ask for it before then. */
  function scheduleFit() {
    if (!fitFrame)
      fitFrame = requestAnimationFrame(() => {
        fitFrame = 0;
        fit();
      });
  }
  void doc.fonts?.ready.then(scheduleFit);

  /** One button per library, the current one marked; `show` is false on Libraries home. */
  function render(list, currentSection, show) {
    sections = list;
    current = currentSection;
    const focusedSection = choices.contains(doc.activeElement) ? doc.activeElement.dataset.section : null;
    choices.replaceChildren();
    choices.hidden = !show;
    sections.forEach(section => {
      const b = button(choices, section.title, undefined, 'library-key library-choice');
      controls.content(b, { label: section.title, icon: sectionIcon(section) });
      // Library buttons keep their names at every width: what does not fit goes into the More menu.
      b.classList.remove('watch-control-responsive');
      b.dataset.section = section.id;
      if (section.id === current) b.setAttribute('aria-current', 'page');
      b.onclick = () => onChoose(section.id);
    });
    choiceMore = button(choices, 'More libraries', undefined, 'library-key library-choice library-more');
    choiceMore.setAttribute('aria-haspopup', 'menu');
    choiceMore.setAttribute('aria-expanded', 'false');
    choiceMore.popoverTargetElement = choiceMenu;
    choiceMore.hidden = true;
    fit();
    if (focusedSection)
      [...choices.querySelectorAll('button')].find(b => b.dataset.section === focusedSection)?.focus();
  }
  /** No libraries: a room change empties the row until the new room's libraries arrive. */
  function clear() {
    choices.replaceChildren();
    choices.hidden = true;
    choiceMore = null;
  }
  return { element: choices, render, clear, fit, scheduleFit };
}
