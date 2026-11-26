/* First-run setup wizard (docs/first-run-setup.md), served by setup mode (server/setup/). Every choice
 * is checked and kept by the server; this page shows the steps and never sees a token, key or password
 * once it has sent it. Step 3 drives each source type's own setup steps, as Server settings → Sources does. */
import { icon } from '/icons.js';
import { spriteMarkup } from '/shared/icons-data.mjs';

const POLL_MS = 2000;
const TYPE_LABEL = { plex: 'Plex', jellyfin: 'Jellyfin', folders: 'Folder', youtube: 'YouTube' };
const TYPE_PICTURE = { plex: '/assets/plex-icon.png', jellyfin: '/assets/jellyfin-icon.svg' };
const MEMBER_RULE = {
  plex: name => ['People with access to ', name, ' (Plex)'],
  jellyfin: name => ['People with an account on ', name, ' (Jellyfin)'],
};
const MEMBER_HINT = { plex: 'They sign in with Plex.', jellyfin: 'They sign in with Jellyfin.' };

const parsed = new DOMParser().parseFromString(spriteMarkup(), 'text/html');
document.getElementById('icon-sprite').replaceWith(document.importNode(parsed.body.firstElementChild, true));
for (const slot of document.querySelectorAll('[data-icon]')) {
  const svg = icon(document, slot.dataset.icon);
  if (slot.dataset.class) svg.setAttribute('class', slot.dataset.class);
  slot.replaceWith(svg);
}

const $ = id => document.getElementById(id);
/** An element with properties and children (strings become text). */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter(child => child !== undefined && child !== null && child !== false));
  return node;
}
const picture = (type, size) =>
  TYPE_PICTURE[type]
    ? el('img', { src: TYPE_PICTURE[type], alt: '', width: String(size), height: String(size) })
    : icon(document, type === 'youtube' ? 'brand-youtube' : 'folder');

// ----- Screens, errors and requests -----

let current = 'code',
  resume = 'account';
const card = name => document.querySelector(`[data-screen="${name}"]`);
function show(name, { focus = true } = {}) {
  current = name;
  for (const section of document.querySelectorAll('[data-screen]')) section.hidden = section.dataset.screen !== name;
  setError(name, '');
  if (focus) card(name).querySelector('h1').focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}
/** Shows the parts of a card whose `data-part` lists `part`. */
function parts(name, part) {
  for (const node of card(name).querySelectorAll('[data-part]'))
    node.hidden = !node.dataset.part.split(' ').includes(part);
}
function setError(name, message) {
  const line = card(name).querySelector('.setup-error');
  if (!line) return;
  line.lastElementChild.textContent = message || '';
  line.hidden = !message;
}

class SessionEnded extends Error {}
/** A setup API call: JSON in and out. An ended setup session goes back to the code, then returns here. */
async function api(path, data) {
  let response;
  try {
    response = await fetch(path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error('uburoom didn’t answer. Check that the uburoom window is still open.');
  }
  const value = await response.json().catch(() => ({}));
  if (response.status === 401 && value.code === 'session') {
    if (current !== 'code') resume = current;
    stopPolls();
    show('code');
    setError('code', value.error);
    throw new SessionEnded(value.error);
  }
  if (!response.ok)
    throw Object.assign(new Error(value.error || 'Request failed; try again'), {
      status: response.status,
      body: value,
    });
  return value;
}
/** Runs an action with its button disabled, showing any error on the card. */
async function run(name, button, action) {
  if (button) button.disabled = true;
  setError(name, '');
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof SessionEnded)) setError(name, error.message);
  } finally {
    if (button) button.disabled = false;
  }
}
const polls = new Set();
function poll(action) {
  const timer = setTimeout(() => {
    polls.delete(timer);
    void action();
  }, POLL_MS);
  polls.add(timer);
}
function stopPolls() {
  for (const timer of polls) clearTimeout(timer);
  polls.clear();
}
function popup() {
  return window.open('', 'uburoom-sign-in', 'popup,width=600,height=720');
}

// ----- 1. Setup code -----

const fromLink = new URLSearchParams(location.hash.slice(1)).get('code');
if (fromLink) {
  // The code arrives in the fragment, which never reaches a server or log; keep it out of the address bar.
  history.replaceState(null, '', location.pathname);
  $('setup-code').value = fromLink;
  $('code-filled').hidden = false;
  $('code-where').hidden = true;
}
$('code-form').addEventListener('submit', event => {
  event.preventDefault();
  void run('code', $('code-next'), async () => {
    const input = $('setup-code');
    try {
      await api('/setup/api/code', { code: input.value });
    } catch (error) {
      input.setAttribute('aria-invalid', 'true');
      if (error.body?.code === 'locked') input.value = '';
      $('code-filled').hidden = true;
      $('code-where').hidden = false;
      throw error;
    }
    input.setAttribute('aria-invalid', 'false');
    const state = await api('/setup/api/state');
    renderAccount(state.account);
    renderSources(state.sources);
    await open(resume);
  });
});
$('setup-code').addEventListener('input', () => $('setup-code').setAttribute('aria-invalid', 'false'));

// ----- 2. Your account -----

let account,
  plexUrl = '';
function renderAccount(value) {
  account = value;
  $('account-next').disabled = !account;
  if (!account) return parts('account', 'choose');
  parts('account', 'done');
  $('account-name').textContent = account.name;
  $('account-kind').textContent = account.provider === 'plex' ? 'Signed in with Plex' : 'uburoom account';
  $('account-picture').replaceChildren(
    account.provider === 'plex'
      ? el('img', { src: TYPE_PICTURE.plex, alt: '', width: '32', height: '32' })
      : icon(document, 'user'),
  );
}
function pollAccount() {
  poll(async () => {
    try {
      const answer = await api('/setup/api/account/plex', { poll: true });
      if (answer.waiting) return pollAccount();
      renderAccount(answer.account);
      $('account-next').focus();
    } catch (error) {
      if (error instanceof SessionEnded) return;
      setError('account', error.message);
      parts('account', 'choose');
    }
  });
}
$('account-plex').addEventListener('click', () => {
  const window = popup();
  void run('account', $('account-plex'), async () => {
    try {
      ({ url: plexUrl } = await api('/setup/api/account/plex', {}));
    } catch (error) {
      window?.close();
      throw error;
    }
    if (window) window.location.href = plexUrl;
    parts('account', 'plex-waiting');
    pollAccount();
  });
});
$('account-plex-again').addEventListener('click', () => {
  const window = popup();
  if (window) window.location.href = plexUrl;
});
$('account-plex-cancel').addEventListener('click', () => {
  stopPolls();
  parts('account', 'choose');
});
$('account-create-open').addEventListener('click', () => {
  parts('account', 'create');
  $('acct-user').focus();
});
$('account-create-back').addEventListener('click', () => parts('account', 'choose'));
$('account-create').addEventListener('submit', event => {
  event.preventDefault();
  void run('account', $('account-create-submit'), async () => {
    const answer = await api('/setup/api/account/create', {
      username: $('acct-user').value,
      password: $('acct-pass').value,
    });
    $('acct-pass').value = '';
    renderAccount(answer.account);
    $('account-next').focus();
  });
});
$('account-change').addEventListener('click', () =>
  run('account', $('account-change'), async () => {
    await api('/setup/api/account/clear', {});
    renderAccount(undefined);
  }),
);

// ----- 3. Media sources -----

let sources = [],
  flow;
const totals = new Map();
const libraries = count => count + (count === 1 ? ' library' : ' libraries');
function librariesHint(source) {
  if (!source.selectLibraries) return source.address;
  const total = totals.get(source.id);
  if (source.offered === null) return total === undefined ? 'All libraries' : `${total} of ${libraries(total)}`;
  return total === undefined ? libraries(source.offered.length) : `${source.offered.length} of ${libraries(total)}`;
}
function renderSources(list) {
  sources = list;
  $('source-list').replaceChildren(
    ...list.map(source =>
      el(
        'li',
        { class: 'setup-source' },
        picture(source.type, 28),
        el(
          'div',
          {},
          el('strong', {}, source.name || source.id),
          el(
            'span',
            { class: 'hint', 'data-hint': source.id },
            TYPE_LABEL[source.type] + ' · ' + librariesHint(source),
          ),
        ),
        el(
          'div',
          { class: 'setup-source-actions' },
          el('button', { class: 'quiet', type: 'button', onclick: () => editSource(source) }, 'Edit'),
          el(
            'button',
            {
              class: 'icon-button',
              type: 'button',
              'aria-label': 'Remove ' + (source.name || source.id),
              title: 'Remove',
              onclick: event => removeSource(source, event.currentTarget),
            },
            icon(document, 'trash'),
          ),
        ),
      ),
    ),
  );
  closePanel();
  updateAddButtons(list);
  // How many libraries each server has, for "3 of 4 libraries".
  for (const source of list)
    if (source.selectLibraries && !totals.has(source.id))
      api('/setup/api/sources/details?id=' + encodeURIComponent(source.id)).then(
        details => {
          if (!details.libraries) return;
          totals.set(source.id, details.libraries.length);
          const hint = document.querySelector(`[data-hint="${CSS.escape(source.id)}"]`);
          if (hint) hint.textContent = TYPE_LABEL[source.type] + ' · ' + librariesHint(source);
        },
        () => {},
      );
}
function closePanel() {
  stopPolls();
  flow = undefined;
  parts('sources', sources.length ? 'list' : 'empty');
  $('sources-next').disabled = !sources.length;
}
const step = (name, data = {}) => api('/setup/api/sources/setup/step', { flow, step: name, ...data });
async function start(type) {
  ({ flow } = await api('/setup/api/sources/setup', { type }));
}
async function add(data) {
  const answer = await api('/setup/api/sources', { action: 'add', flow, ...data });
  renderSources(answer.sources);
  card('sources').querySelector('[data-add]').focus();
}
function updateAddButtons(list) {
  const ytButton = card('sources').querySelector('[data-add="youtube"]');
  if (ytButton) ytButton.disabled = list.some(source => source.type === 'youtube');
}
for (const panel of card('sources').querySelectorAll('[data-cancel]')) panel.addEventListener('click', closePanel);

/** Library checkboxes, all on for a new source. */
function libraryChoices(fieldset, libraries, offered = () => true) {
  fieldset.hidden = false;
  fieldset.replaceChildren(
    el('legend', {}, 'Libraries to offer'),
    ...libraries.map(library =>
      el(
        'label',
        { class: 'form-checkbox' },
        el('input', { type: 'checkbox', value: library.id, checked: offered(library) }),
        el('span', {}, library.name),
        library.count === undefined ? undefined : el('span', { class: 'hint' }, library.count.toLocaleString()),
      ),
    ),
    el('p', { class: 'hint setup-flush' }, 'Libraries added to this server later start off.'),
  );
}
const chosenLibraries = fieldset => [...fieldset.querySelectorAll('input:checked')].map(input => input.value);
function serverChoice(name, server, { value = server.id, disabled = false, detail, onchoose }) {
  return el(
    'label',
    { class: 'setup-server', 'aria-disabled': disabled ? 'true' : undefined },
    el('input', { type: 'radio', name, value, disabled, onchange: onchoose }),
    el('div', {}, el('strong', {}, server.name), el('span', { class: 'hint' }, detail)),
  );
}

// Add Plex: a plex.tv sign-in (or the one from step 2), the account's servers, then libraries.
function plexWaiting(waiting) {
  $('plex-waiting').hidden = !waiting;
  $('plex-again').hidden = !waiting;
}
async function plexServers(answer) {
  plexWaiting(false);
  $('plex-chooser').hidden = false;
  $('plex-account').textContent = `Signed in as ${answer.account}. Choose a server.`;
  $('plex-servers').replaceChildren(
    ...answer.servers.map(server =>
      serverChoice('plex-server', server, {
        disabled: !server.reachable,
        detail: server.reachable ? 'Reachable at ' + server.address : server.reason,
        onchoose: () => choosePlex(server.id),
      }),
    ),
  );
  const reachable = answer.servers.filter(server => server.reachable);
  if (reachable.length === 1) {
    $('plex-servers').querySelector('input:not(:disabled)').checked = true;
    await choosePlex(reachable[0].id);
  }
}
function pollPlex() {
  poll(() =>
    run('sources', undefined, async () => {
      const answer = await step('servers');
      if (answer.waiting) return pollPlex();
      await plexServers(answer);
    }),
  );
}
async function choosePlex(id) {
  $('plex-add').disabled = true;
  await run('sources', undefined, async () => {
    const ready = await step('choose', { server: id });
    libraryChoices($('plex-libraries'), ready.libraries);
    $('plex-add').disabled = false;
  });
}
let plexSignIn = '';
async function addPlex() {
  parts('sources', 'add-plex');
  $('plex-chooser').hidden = true;
  $('plex-libraries').hidden = true;
  $('plex-add').disabled = true;
  $('setup-plex-url').value = '';
  plexWaiting(false);
  // A sign-in window must open on the click; the Plex account from step 2 needs none.
  const window = account?.provider === 'plex' ? null : popup();
  await start('plex');
  const started = await step('start');
  if (started.url) {
    plexSignIn = started.url;
    if (window) window.location.href = started.url;
    plexWaiting(true);
    pollPlex();
  } else {
    window?.close();
    await plexServers(await step('servers'));
  }
}
$('plex-again').addEventListener('click', () => {
  const window = popup();
  if (window) window.location.href = plexSignIn;
});
$('plex-test').addEventListener('click', () =>
  run('sources', $('plex-test'), async () => {
    const { server } = await step('address', { url: $('setup-plex-url').value });
    const existing = $('plex-servers').querySelector(`input[value="${CSS.escape(server.id)}"]`);
    if (existing) existing.closest('label').remove();
    const choice = serverChoice('plex-server', server, {
      detail: 'Reachable at ' + server.address,
      onchoose: () => choosePlex(server.id),
    });
    $('plex-servers').append(choice);
    choice.querySelector('input').checked = true;
    await choosePlex(server.id);
  }),
);
$('plex-add').addEventListener('click', () =>
  run('sources', $('plex-add'), () => add({ libraries: chosenLibraries($('plex-libraries')) })),
);

// Add Jellyfin: a server found or typed, an administrator's sign-in, then the user whose libraries are offered.
let jellyfinServer;
async function addJellyfin() {
  parts('sources', 'add-jellyfin');
  $('jf-next').disabled = true;
  $('jf-servers').replaceChildren();
  $('jf-none').hidden = true;
  $('setup-jf-url').value = '';
  await start('jellyfin');
  const { servers } = await step('discover');
  $('jf-servers').replaceChildren(
    ...servers.map(server =>
      serverChoice('jf-server', server, {
        value: server.address,
        detail: 'Found at ' + new URL(server.address).host,
        onchoose: () => ($('jf-next').disabled = false),
      }),
    ),
  );
  $('jf-none').hidden = servers.length > 0;
  $('jf-manual').open = !servers.length;
  if (servers.length === 1) {
    $('jf-servers').querySelector('input').checked = true;
    $('jf-next').disabled = false;
  }
}
async function jellyfinChosen(url) {
  jellyfinServer = await step('server', { url });
  $('jf-sign-in-title').textContent = 'Sign in to ' + jellyfinServer.name;
  $('jf-pass').value = '';
  $('jf-qc').hidden = true;
  parts('sources', 'add-jellyfin-sign-in');
  $('jf-user').focus();
  if (jellyfinServer.quickConnect) {
    const started = await step('quickConnect');
    $('jf-qc-code').textContent = String(started.code).replace(/^(\d{3})(\d{3})$/, '$1 $2');
    $('jf-qc').hidden = false;
    pollQuickConnect();
  }
}
function pollQuickConnect() {
  poll(() =>
    run('sources', undefined, async () => {
      const answer = await step('quickConnectPoll');
      if (answer.waiting) return pollQuickConnect();
      await jellyfinUsers(answer.users);
    }),
  );
}
$('jf-next').addEventListener('click', () =>
  run('sources', $('jf-next'), () => jellyfinChosen($('jf-servers').querySelector('input:checked')?.value || '')),
);
$('jf-test').addEventListener('click', () =>
  run('sources', $('jf-test'), () => jellyfinChosen($('setup-jf-url').value)),
);
$('jf-sign-in-back').addEventListener('click', () => {
  stopPolls();
  parts('sources', 'add-jellyfin');
});
$('jf-sign-in').addEventListener('submit', event => {
  event.preventDefault();
  void run('sources', event.submitter, async () => {
    const { users } = await step('password', { username: $('jf-user').value, password: $('jf-pass').value });
    $('jf-pass').value = '';
    await jellyfinUsers(users);
  });
});
async function jellyfinUsers(users) {
  stopPolls();
  parts('sources', 'add-jellyfin-user');
  $('jf-user-title').textContent = jellyfinServer.name;
  $('jf-lib-user').replaceChildren(
    ...users.map(user => el('option', { value: user.id, disabled: user.disabled }, user.name)),
  );
  const first = users.find(user => !user.disabled);
  if (first) {
    $('jf-lib-user').value = first.id;
    await jellyfinUser(first.id);
  }
}
async function jellyfinUser(id) {
  $('jf-add').disabled = true;
  const ready = await step('user', { user: id });
  libraryChoices($('jf-libraries'), ready.libraries);
  $('jf-add').disabled = false;
}
$('jf-lib-user').addEventListener('change', () =>
  run('sources', undefined, () => jellyfinUser($('jf-lib-user').value)),
);
$('jf-add').addEventListener('click', () =>
  run('sources', $('jf-add'), () => add({ libraries: chosenLibraries($('jf-libraries')) })),
);

// Add a folder: browse this computer's folders, then a name and Movies or Shows.
let listing,
  folderKind = 'movies',
  folderNamed = false;
function segmented(group, value) {
  for (const button of group.querySelectorAll('.group-button'))
    button.setAttribute('aria-pressed', String(button.dataset.kind === value));
}
async function browse(path) {
  listing = await step('browse', { path });
  $('folder-path').textContent = listing.path || 'This computer';
  $('folder-path-input').value = listing.path || '';
  const videoHint = $('folder-video-hint');
  if (!listing.path) {
    videoHint.hidden = true;
  } else if (listing.videoCount > 0) {
    videoHint.textContent =
      listing.videoCount === 1
        ? '1 video found in this folder.'
        : `${listing.videoCount.toLocaleString()} videos found in this folder.`;
    videoHint.hidden = false;
  } else {
    videoHint.textContent = listing.folders.length
      ? 'No videos directly in this folder (subfolders are scanned too).'
      : 'No videos found in this folder yet.';
    videoHint.hidden = false;
  }
  $('folder-list').replaceChildren(
    ...(listing.parent !== null
      ? [
          el(
            'li',
            {},
            el(
              'button',
              { type: 'button', onclick: () => run('sources', undefined, () => browse(listing.parent)) },
              icon(document, 'arrow-back-up'),
              'Up one level',
            ),
          ),
        ]
      : []),
    ...listing.folders.map(folder =>
      el(
        'li',
        {},
        el(
          'button',
          { type: 'button', onclick: () => run('sources', undefined, () => browse(folder.path)) },
          icon(document, 'folder'),
          folder.name,
        ),
      ),
    ),
  );
  if (!folderNamed)
    $('folder-name').value = listing.path ? listing.path.split(/[\\/]/).filter(Boolean).pop() || listing.path : '';
  $('folder-add').disabled = !listing.path;
}
async function addFolder() {
  parts('sources', 'add-folder');
  folderNamed = false;
  folderKind = 'movies';
  segmented($('folder-kind-group'), folderKind);
  $('folder-name').value = '';
  $('folder-path-input').value = '';
  $('folder-video-hint').hidden = true;
  await start('folders');
  await browse('');
}
$('folder-path-input').addEventListener('input', () => {
  const typed = $('folder-path-input').value.trim();
  if (!folderNamed && typed) $('folder-name').value = typed.split(/[\\/]/).filter(Boolean).pop() || typed;
  $('folder-add').disabled = !(typed || listing?.path);
});
$('folder-path-input').addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  void run('sources', $('folder-path-go'), () => browse($('folder-path-input').value.trim()));
});
$('folder-path-go').addEventListener('click', () =>
  run('sources', $('folder-path-go'), () => browse($('folder-path-input').value.trim())),
);
$('folder-name').addEventListener('input', () => (folderNamed = true));
$('folder-kind-group').addEventListener('click', event => {
  const button = event.target.closest('[data-kind]');
  if (!button) return;
  folderKind = button.dataset.kind;
  segmented($('folder-kind-group'), folderKind);
});
$('folder-form').addEventListener('submit', event => {
  event.preventDefault();
  void run('sources', $('folder-add'), async () => {
    const targetPath = $('folder-path-input').value.trim() || listing?.path || '';
    await step('choose', { path: targetPath, type: folderKind });
    await add({ name: $('folder-name').value });
  });
});

// Add YouTube & shared YouTube fields (also used by Edit).
function renderYouTubeFields(container, draft, { editing = false, source = null, onModeChange } = {}) {
  const mode = draft.delivery || 'auto';
  const deliveryFieldset = el(
    'fieldset',
    { class: 'setup-servers setup-gap' },
    el('legend', {}, 'Delivery mode'),
    ...[
      [
        'auto',
        'Auto — yt-dlp cache with IFrame fallback (recommended)',
        'Uses built-in yt-dlp cache when available, and falls back to YouTube’s IFrame player otherwise.',
      ],
      [
        'ytdlp',
        'Built-in yt-dlp cache only',
        'Always downloads to disk on this server. Keeps YouTube scripts and iframes blocked by CSP.',
      ],
      [
        'embed',
        'IFrame embed only',
        'Streams directly from YouTube in each viewer’s browser with zero server downloads or disk cache.',
      ],
    ].map(([value, title, hint]) =>
      el(
        'label',
        { class: 'setup-server' },
        el('input', {
          type: 'radio',
          name: editing ? 'edit-yt-delivery' : 'add-yt-delivery',
          value,
          checked: mode === value,
          onchange: () => {
            draft.delivery = value;
            // Keep the focused radio and its group in place during keyboard navigation.
            while (deliveryFieldset.nextElementSibling) deliveryFieldset.nextElementSibling.remove();
            deliveryFieldset.after(...youTubeOptions(draft, value, { editing, source }));
            onModeChange?.();
          },
        }),
        el('div', {}, el('strong', {}, title), el('span', { class: 'hint' }, hint)),
      ),
    ),
  );
  container.replaceChildren(deliveryFieldset, ...youTubeOptions(draft, mode, { editing, source }));
}

function youTubeOptions(draft, mode, { editing, source }) {
  const field = (label, type, id, value, placeholder, onInput, extraHint, autocomplete = 'off') =>
    el(
      'div',
      { class: 'setup-field' },
      el('label', { for: id }, label),
      el('input', {
        id,
        class: 'setup-text-input',
        type,
        autocomplete,
        value: value ?? '',
        placeholder,
        oninput: event => onInput(event.target.value),
      }),
      extraHint ? el('span', { class: 'hint' }, extraHint) : undefined,
    );
  const usesCache = mode === 'auto' || mode === 'ytdlp';
  const nodes = [];
  if (usesCache) {
    const cacheLimit = field(
      'Cache limit (GB)',
      'number',
      editing ? 'edit-yt-max-cache-gb' : 'yt-max-cache-gb',
      draft.maxCacheGb ?? '20',
      '20',
      v => (draft.maxCacheGb = v),
      'Oldest downloaded videos are evicted automatically above this disk limit.',
    );
    const input = cacheLimit.querySelector('input');
    input.min = '0.1';
    input.max = '2000';
    // The server accepts any finite fractional size within these bounds.
    input.step = 'any';
    nodes.push(cacheLimit);
  }
  nodes.push(
    field(
      'YouTube Data API v3 key (optional)',
      'password',
      editing ? 'edit-yt-api-key' : 'yt-api-key',
      draft.apiKey || '',
      editing && source?.hasApiKey ? 'Saved — leave blank to keep existing' : 'AIza...',
      v => (draft.apiKey = v),
      mode === 'embed'
        ? 'Optional: enables playlists and upfront duration/embeddable checks. Without a key, single videos use oEmbed.'
        : 'Optional: fast metadata & playlist lookup without spawning yt-dlp.',
      'new-password',
    ),
  );
  if (editing && source?.hasApiKey) {
    nodes.push(
      el(
        'label',
        { class: 'form-checkbox setup-gap' },
        el('input', {
          type: 'checkbox',
          checked: !!draft.clearApiKey,
          onchange: event => (draft.clearApiKey = event.target.checked),
        }),
        el('span', {}, 'Remove saved API key'),
      ),
    );
  }
  if (usesCache) {
    const advanced = el(
      'details',
      {
        class: 'setup-manual',
        open: !!draft.advancedOpen,
        ontoggle: event => (draft.advancedOpen = event.target.open),
      },
      el('summary', {}, 'Advanced options'),
      field(
        'yt-dlp executable (optional)',
        'text',
        editing ? 'edit-yt-ytdlp' : 'yt-ytdlp',
        draft.ytDlp || '',
        'Searches PATH when blank',
        v => (draft.ytDlp = v),
      ),
      field(
        'Cache directory (optional)',
        'text',
        editing ? 'edit-yt-cache-dir' : 'yt-cache-dir',
        draft.cacheDirectory || '',
        'Defaults to data/youtube-cache',
        v => (draft.cacheDirectory = v),
      ),
      field(
        'Cookies file (optional)',
        'text',
        editing ? 'edit-yt-cookies-file' : 'yt-cookies-file',
        draft.cookiesFile || '',
        'Path to Netscape cookies.txt',
        v => (draft.cookiesFile = v),
      ),
      field(
        'PO token provider URL (optional)',
        'url',
        editing ? 'edit-yt-po-token-url' : 'yt-po-token-url',
        draft.poTokenUrl || '',
        'http://127.0.0.1:4416',
        v => (draft.poTokenUrl = v),
      ),
    );
    nodes.push(advanced);
  }
  return nodes;
}

let ytDraft;

function renderYouTubeProbe(draft) {
  const probe = draft.probe;
  const status = $('yt-probe-status');
  if (!probe) {
    status.hidden = true;
    return;
  }
  status.textContent =
    draft.delivery === 'embed'
      ? 'IFrame embed mode does not use yt-dlp.'
      : probe.ok
        ? `Detected yt-dlp ${probe.ytdlp}` +
          (probe.ffmpeg ? ' · FFmpeg ready.' : ' · FFmpeg not found (single-stream fallback).')
        : draft.delivery === 'ytdlp'
          ? 'yt-dlp was not found on PATH. Cache-only playback needs yt-dlp. Install it or set its path under Advanced options.'
          : 'yt-dlp was not found on PATH. Auto mode uses IFrame playback when yt-dlp is unavailable.';
  status.hidden = false;
}
async function addYouTube() {
  parts('sources', 'add-youtube');
  const draft = {
    delivery: 'auto',
    maxCacheGb: '20',
    ytDlp: '',
    cacheDirectory: '',
    cookiesFile: '',
    poTokenUrl: '',
    apiKey: '',
    advancedOpen: false,
    probe: null,
  };
  ytDraft = draft;
  $('yt-name').value = 'YouTube';
  const updateProbe = () => renderYouTubeProbe(draft);
  updateProbe();
  renderYouTubeFields($('yt-fields'), draft, { onModeChange: updateProbe });
  await start('youtube');
  draft.probe = await step('probe').catch(() => null);
  if (ytDraft === draft) updateProbe();
}
$('yt-form').addEventListener('submit', event => {
  event.preventDefault();
  void run('sources', $('yt-add'), async () => {
    await step('configure', {
      delivery: ytDraft.delivery || 'auto',
      maxCacheGb: ytDraft.maxCacheGb === '' ? 20 : Number(ytDraft.maxCacheGb),
      ytDlp: ytDraft.ytDlp || '',
      cacheDirectory: ytDraft.cacheDirectory || '',
      cookiesFile: ytDraft.cookiesFile || '',
      poTokenUrl: ytDraft.poTokenUrl || '',
      apiKey: ytDraft.apiKey || '',
    });
    await add({ name: $('yt-name').value.trim() || 'YouTube' });
  });
});

for (const button of card('sources').querySelectorAll('[data-add]'))
  button.addEventListener('click', () => {
    const type = button.dataset.add;
    void run('sources', button, () =>
      (type === 'plex'
        ? addPlex()
        : type === 'jellyfin'
          ? addJellyfin()
          : type === 'folders'
            ? addFolder()
            : type === 'youtube'
              ? addYouTube()
              : Promise.reject(new Error('Unsupported source type'))
      ).catch(error => {
        closePanel();
        throw error;
      }),
    );
  });

// Edit: rename, and switch libraries on or off (a folder: Movies or Shows).
let editing,
  editKind = 'movies',
  editYoutubeDraft;
function editSource(source) {
  editing = source;
  parts('sources', 'edit');
  setError('sources', '');
  $('edit-title').textContent = 'Edit ' + (source.name || source.id);
  $('edit-name').value = source.name;
  $('edit-name').placeholder = source.id;
  $('edit-where').textContent = TYPE_LABEL[source.type] + ' · ' + source.address;
  const single = source.folders?.length === 1 ? source.folders[0] : undefined;
  $('edit-kind-field').hidden = !single;
  if (single) {
    editKind = single.type || 'movies';
    segmented($('edit-kind-group'), editKind);
  }
  const isYoutube = source.type === 'youtube';
  $('edit-youtube').hidden = !isYoutube;
  if (isYoutube) {
    editYoutubeDraft = {
      delivery: source.delivery || 'auto',
      maxCacheGb: String(source.maxCacheGb ?? 20),
      ytDlp: source.ytDlp || '',
      cacheDirectory: source.cacheDirectory || '',
      cookiesFile: source.cookiesFile || '',
      poTokenUrl: source.poTokenUrl || '',
      apiKey: '',
      clearApiKey: false,
      advancedOpen: false,
    };
    renderYouTubeFields($('edit-youtube'), editYoutubeDraft, { editing: true, source });
  } else {
    editYoutubeDraft = undefined;
    $('edit-youtube').replaceChildren();
  }
  $('edit-libraries').hidden = true;
  $('edit-loading').hidden = !source.selectLibraries;
  $('edit-name').focus();
  if (!source.selectLibraries) return;
  void run('sources', undefined, async () => {
    const details = await api('/setup/api/sources/details?id=' + encodeURIComponent(source.id));
    if (editing !== source) return;
    $('edit-loading').hidden = true;
    if (!details.libraries) throw new Error(details.librariesError);
    totals.set(source.id, details.libraries.length);
    libraryChoices($('edit-libraries'), details.libraries, library => library.offered);
  });
}
$('edit-kind-group').addEventListener('click', event => {
  const button = event.target.closest('[data-kind]');
  if (!button) return;
  editKind = button.dataset.kind;
  segmented($('edit-kind-group'), editKind);
});
$('edit-form').addEventListener('submit', event => {
  event.preventDefault();
  const source = editing;
  void run('sources', event.submitter, async () => {
    const data = { action: 'update', id: source.id, name: $('edit-name').value };
    if (source.selectLibraries && !$('edit-libraries').hidden) data.libraries = chosenLibraries($('edit-libraries'));
    const single = source.folders?.length === 1 ? source.folders[0] : undefined;
    if (single)
      data.settings = {
        libraries: [
          {
            id: single.id,
            // A library named after its source follows a rename.
            name: single.name === (source.name || source.id) ? $('edit-name').value.trim() || single.name : single.name,
            type: editKind,
            paths: single.paths,
          },
        ],
      };
    if (source.type === 'youtube' && editYoutubeDraft)
      data.settings = {
        delivery: editYoutubeDraft.delivery || 'auto',
        maxCacheGb: editYoutubeDraft.maxCacheGb === '' ? 20 : Number(editYoutubeDraft.maxCacheGb),
        ytDlp: editYoutubeDraft.ytDlp || '',
        cacheDirectory: editYoutubeDraft.cacheDirectory || '',
        cookiesFile: editYoutubeDraft.cookiesFile || '',
        poTokenUrl: editYoutubeDraft.poTokenUrl || '',
        ...(editYoutubeDraft.apiKey ? { apiKey: editYoutubeDraft.apiKey } : {}),
        ...(editYoutubeDraft.clearApiKey ? { clearApiKey: true } : {}),
      };
    const answer = await api('/setup/api/sources', data);
    renderSources(answer.sources);
  });
});
async function removeSource(source, button) {
  await run('sources', button, async () => {
    const answer = await api('/setup/api/sources', { action: 'remove', id: source.id });
    totals.delete(source.id);
    renderSources(answer.sources);
  });
}

// ----- 4. Who can get in -----

let accessView;
function ruleRow(source, view) {
  const locked =
    !view.operator.accounts && view.operator.sources.length === 1 && view.operator.sources[0] === source.id;
  const label = (MEMBER_RULE[source.type] || (name => ['Members of ', name]))(el('strong', {}, source.name));
  return el(
    'div',
    { class: 'setup-rule' },
    el(
      'label',
      { class: 'form-checkbox' },
      el('input', {
        type: 'checkbox',
        value: source.id,
        'data-source': true,
        checked: locked || view.sourceMembers.includes(source.id),
        disabled: locked,
      }),
      el('span', {}, ...label),
    ),
    el('p', { class: 'hint' }, locked ? 'Your account gets in this way.' : MEMBER_HINT[source.type] || ''),
  );
}
let excludedDiscord = new Set();
function renderDiscord(setup) {
  $('discord-servers-field').hidden = !setup;
  if (!setup) return;
  $('discord-invite').href = setup.inviteUrl;
  const list = $('discord-servers');
  const byId = new Map([...list.children].map(row => [row.dataset.guild, row]));
  const ids = new Set(setup.servers.map(server => server.id));
  for (const [id, row] of byId) if (!ids.has(id) && (id || ids.size)) row.remove();
  if (!ids.size && !list.firstElementChild)
    list.append(el('li', { class: 'hint' }, 'The bot hasn’t joined a server yet.'));
  setup.servers.forEach(({ id, name, memberCount }, index) => {
    let row = byId.get(id);
    if (!row) {
      const input = el('input', { type: 'checkbox' });
      input.addEventListener('change', () => {
        if (input.checked) excludedDiscord.delete(id);
        else excludedDiscord.add(id);
      });
      row = el(
        'li',
        { 'data-guild': id },
        el('label', { class: 'form-checkbox' }, input, el('span')),
        el('p', { class: 'hint' }),
      );
    }
    row.querySelector('input').checked = !excludedDiscord.has(id);
    const title = row.querySelector('span'),
      warning = row.querySelector('p');
    if (title.textContent !== name) title.textContent = name;
    warning.hidden = !(memberCount > 500);
    if (!warning.hidden) {
      const detail = `About ${memberCount.toLocaleString()} members. Leave checked only if you want them to have access.`;
      if (warning.textContent !== detail) warning.textContent = detail;
    }
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
  });
}
function toggles() {
  const password = $('rule-password').checked,
    discord = $('rule-discord').checked;
  $('rule-password-field').hidden = !password;
  $('rule-password-hint').hidden = password;
  $('rule-discord-setup').hidden = !discord;
  $('rule-discord-hint').hidden = discord;
}
async function loadAccess() {
  accessView = await api('/setup/api/access');
  $('access-sources').replaceChildren(...accessView.sources.map(source => ruleRow(source, accessView)));
  $('rule-password').checked = accessView.password || !$('rule-password-field').hidden;
  $('server-pass').placeholder = accessView.password ? 'Saved; type to change' : 'Server password';
  $('rule-accounts').checked = accessView.accounts || accessView.operator.accounts;
  $('rule-accounts').disabled = accessView.operator.accounts;
  $('rule-accounts-hint').textContent = accessView.operator.accounts
    ? 'Your account gets in this way.'
    : 'Create them in Server settings.';
  $('rule-guests').checked = accessView.guests;
  $('rule-discord').checked = accessView.discord || !$('rule-discord-setup').hidden;
  $('discord-redirect').textContent = accessView.redirectUrl;
  excludedDiscord = new Set(accessView.excludedGuildIds);
  renderDiscord(accessView.discordSetup);
  toggles();
}
for (const id of ['rule-password', 'rule-discord']) $(id).addEventListener('change', toggles);
let discordCheck = 0;
async function verifyDiscord() {
  const values = { clientId: $('dc-app').value, clientSecret: $('dc-secret').value, botToken: $('dc-bot').value };
  if (!values.clientId.trim() || !values.clientSecret.trim() || !values.botToken.trim()) return;
  const mine = ++discordCheck;
  $('discord-checking').hidden = false;
  try {
    await run('access', undefined, async () => {
      const answer = await api('/setup/api/access/discord', values);
      if (mine === discordCheck) renderDiscord(answer.discordSetup);
    });
  } finally {
    if (mine === discordCheck) $('discord-checking').hidden = true;
  }
}
for (const id of ['dc-app', 'dc-secret', 'dc-bot']) $(id).addEventListener('change', () => void verifyDiscord());
// After adding the bot to a server in another tab, coming back shows it.
window.addEventListener('focus', () => {
  if (current === 'access' && $('rule-discord').checked) void verifyDiscord();
});
$('access-next').addEventListener('click', () =>
  run('access', $('access-next'), async () => {
    const password = $('server-pass').value;
    await api('/setup/api/access', {
      sourceMembers: [...$('access-sources').querySelectorAll('input[data-source]:checked')].map(input => input.value),
      password: $('rule-password').checked && password ? password : null,
      keepPassword: $('rule-password').checked && !password,
      accounts: $('rule-accounts').checked,
      guests: $('rule-guests').checked,
      discord: $('rule-discord').checked,
      excludedGuildIds: [...excludedDiscord],
    });
    $('server-pass').value = '';
    await open('network');
  }),
);

// ----- 5. Where people watch -----

let networkView,
  where = 'computer',
  remoteRoute = 'cloudflare',
  tailscaleStatus = null,
  tailscaleProbeSeq = 0,
  tailscaleFunnelResult = null,
  tailscaleAutoFilled = '';
const ROUTE_HINTS = {
  cloudflare: 'Uses http-proxy mode with cf-connecting-ip. Point your Cloudflare Tunnel at HTTP on this port.',
  tailscale:
    'Uses http-proxy mode with x-forwarded-for. Use Tailscale Funnel to share with friends over the internet (no Tailscale needed on their device), or Tailscale Serve for your tailnet only.',
  caddy: 'Uses http-proxy mode with x-forwarded-for. Point Caddy or nginx at HTTP on this port.',
  https: 'uburoom serves HTTPS itself with its own certificate and can also accept direct LAN connections.',
};
function currentNetworkPort() {
  const raw = $('setup-port').value.trim();
  return /^\d{1,5}$/.test(raw) ? raw : String(networkView?.port ?? 5756);
}
function applyTailscaleAutofill() {
  if (where !== 'internet' || remoteRoute !== 'tailscale') return;
  if (!tailscaleStatus || tailscaleStatus === 'loading' || !tailscaleStatus.loggedIn || !tailscaleStatus.dnsName)
    return;
  const input = $('setup-public-url');
  const currentValue = input.value.trim();
  if (!currentValue || currentValue === tailscaleAutoFilled) {
    input.value = tailscaleStatus.dnsName;
    tailscaleAutoFilled = tailscaleStatus.dnsName;
  }
}
function renderTailscalePanel(port) {
  const panel = $('network-tailscale-panel');
  const visible = where === 'internet' && remoteRoute === 'tailscale';
  panel.hidden = !visible;
  if (!visible) return;
  const statusEl = $('tailscale-status');
  const detailEl = $('tailscale-detail');
  const linkRow = $('tailscale-enable-link-row');
  const linkEl = $('tailscale-enable-link');
  const cmdRow = $('tailscale-command-row');
  const cmdEl = $('tailscale-command');
  const enableButton = $('tailscale-enable-funnel');
  const refreshButton = $('tailscale-refresh');
  const numericPort = Number(port);
  const command = tailscaleFunnelResult?.command || `tailscale funnel --bg ${port}`;
  cmdEl.textContent = command;
  linkRow.hidden = true;
  if (tailscaleStatus === 'loading' || tailscaleStatus === null) {
    statusEl.textContent = 'Checking Tailscale on this computer…';
    detailEl.hidden = true;
    cmdRow.hidden = true;
    enableButton.hidden = true;
    refreshButton.disabled = true;
    return;
  }
  refreshButton.disabled = false;
  const ts = tailscaleStatus;
  if (tailscaleFunnelResult && !tailscaleFunnelResult.ok) {
    statusEl.textContent = 'Could not enable Tailscale Funnel automatically.';
    detailEl.textContent = tailscaleFunnelResult.error || 'Run the command below in a terminal instead.';
    detailEl.hidden = false;
    if (tailscaleFunnelResult.enableUrl) {
      linkEl.href = tailscaleFunnelResult.enableUrl;
      linkRow.hidden = false;
    }
    cmdRow.hidden = false;
    enableButton.hidden = !(ts.installed && ts.loggedIn && ts.dnsName && !networkView?.published);
    return;
  }
  if (!ts.installed) {
    statusEl.textContent = 'Tailscale was not detected on this computer.';
    detailEl.textContent =
      'Install Tailscale and sign in to auto-fill your https://*.ts.net address, or enter your Tailscale HTTPS address above.';
    detailEl.hidden = false;
    cmdRow.hidden = false;
    enableButton.hidden = true;
    return;
  }
  if (!ts.loggedIn) {
    statusEl.textContent = 'Tailscale is installed, but not signed in.';
    detailEl.textContent = 'Sign in to Tailscale on this computer, then click Recheck to detect your HTTPS address.';
    detailEl.hidden = false;
    cmdRow.hidden = false;
    enableButton.hidden = true;
    return;
  }
  if (!ts.dnsName) {
    statusEl.textContent = 'Tailscale is running, but MagicDNS / HTTPS is not enabled yet.';
    detailEl.textContent = 'Enable MagicDNS and HTTPS certificates in the Tailscale admin console, then click Recheck.';
    detailEl.hidden = false;
    cmdRow.hidden = false;
    enableButton.hidden = true;
    return;
  }
  if (ts.funnelActive && (ts.funnelPort === null || ts.funnelPort === numericPort)) {
    statusEl.textContent = `Tailscale Funnel is active at ${ts.dnsName} (port ${port}).`;
    detailEl.textContent = 'Friends can open this HTTPS address in any browser—no Tailscale needed on their device.';
    detailEl.hidden = false;
    cmdRow.hidden = true;
    enableButton.hidden = true;
    return;
  }
  if (ts.funnelActive && ts.funnelPort && ts.funnelPort !== numericPort) {
    statusEl.textContent = `Tailscale detected (${ts.dnsName}). Funnel currently points to port ${ts.funnelPort}.`;
    detailEl.textContent = `Enable Funnel on port ${port} below, or run the command in a terminal.`;
    detailEl.hidden = false;
    cmdRow.hidden = false;
    enableButton.hidden = !!networkView?.published;
    return;
  }
  statusEl.textContent = `Tailscale detected: ${ts.dnsName}`;
  detailEl.textContent = ts.funnelEnabled
    ? 'Funnel is available. Click below to publish this port over HTTPS, or run tailscale serve for your tailnet only.'
    : 'Click below to enable Tailscale Funnel for friends over the internet, or use tailscale serve for your tailnet only.';
  detailEl.hidden = false;
  cmdRow.hidden = !!networkView?.published ? false : true;
  enableButton.hidden = !!networkView?.published;
}
async function refreshTailscale() {
  const mine = ++tailscaleProbeSeq;
  tailscaleStatus = 'loading';
  tailscaleFunnelResult = null;
  if (networkView) renderWhere();
  try {
    const result = await api('/setup/api/network/tailscale');
    if (mine !== tailscaleProbeSeq) return;
    tailscaleStatus = result;
    applyTailscaleAutofill();
  } catch (error) {
    if (error instanceof SessionEnded || mine !== tailscaleProbeSeq) return;
    tailscaleStatus = {
      installed: false,
      loggedIn: false,
      dnsName: '',
      funnelEnabled: false,
      funnelActive: false,
      funnelPort: null,
    };
  }
  if (networkView) renderWhere();
}
function renderWhere() {
  for (const button of $('network-where').querySelectorAll('[data-where]'))
    button.setAttribute('aria-pressed', String(button.dataset.where === where));
  for (const button of $('setup-route').querySelectorAll('[data-route]'))
    button.setAttribute('aria-pressed', String(button.dataset.route === remoteRoute));
  const port = currentNetworkPort();
  const address = host => 'https://' + (host.includes(':') ? `[${host}]` : host) + ':' + port;
  const isInternet = where === 'internet';
  $('network-internet').hidden = !isInternet;
  $('network-local-panel').hidden = isInternet;
  $('network-proxies-field').hidden = !isInternet || remoteRoute === 'https';
  $('network-lan-field').hidden = !isInternet || remoteRoute !== 'https' || networkView.published;
  $('network-route-hint').textContent = ROUTE_HINTS[remoteRoute] || '';
  renderTailscalePanel(port);
  $('network-computer').hidden = where !== 'computer';
  $('network-computer-hint').hidden = where !== 'computer';
  $('network-home').hidden = where !== 'home' || !networkView.homeAddress;
  $('network-home-hint').hidden = $('network-home').hidden;
  $('network-home-missing').hidden = where !== 'home' || !!networkView.homeAddress;
  $('network-home-missing').textContent = networkView.published
    ? 'Open setup using the Docker host’s LAN address and published port to set up home network access.'
    : 'uburoom couldn’t find a LAN address. Choose This computer.';
  $('network-computer').querySelector('strong').textContent = networkView.published
    ? networkView.computer
    : address(networkView.computerAddress);
  $('network-home').querySelector('strong').textContent = networkView.homeAddress
    ? networkView.published
      ? networkView.home
      : address(networkView.homeAddress)
    : '';
}
async function loadNetwork() {
  networkView = await api('/setup/api/network');
  where = networkView.where;
  remoteRoute = networkView.route || 'cloudflare';
  tailscaleFunnelResult = null;
  tailscaleAutoFilled = '';
  $('setup-port').value = String(networkView.port);
  $('setup-port').readOnly = networkView.published;
  $('setup-public-url').value = networkView.publicUrl || '';
  $('setup-trusted-proxies').value = (networkView.trustedProxies || []).join(', ');
  $('setup-allow-lan').checked = networkView.allowLan !== false;
  $('network-port-hint').textContent = networkView.published
    ? 'Docker’s container port. The address below uses the published port.'
    : 'Use the setup port unless something else needs it.';
  if (where === 'internet' && tailscaleStatus === null) void refreshTailscale();
  else applyTailscaleAutofill();
  renderWhere();
}
$('network-where').addEventListener('click', event => {
  const button = event.target.closest('[data-where]');
  if (!button) return;
  where = button.dataset.where;
  if (where === 'internet' && tailscaleStatus === null) void refreshTailscale();
  else applyTailscaleAutofill();
  renderWhere();
});
$('setup-route').addEventListener('click', event => {
  const button = event.target.closest('[data-route]');
  if (!button) return;
  const previous = remoteRoute;
  remoteRoute = button.dataset.route;
  if (previous === 'tailscale' && remoteRoute !== 'tailscale' && tailscaleAutoFilled) {
    if ($('setup-public-url').value.trim() === tailscaleAutoFilled) $('setup-public-url').value = '';
    tailscaleAutoFilled = '';
  }
  if (remoteRoute === 'tailscale') {
    if (tailscaleStatus === null) void refreshTailscale();
    else applyTailscaleAutofill();
  }
  renderWhere();
});
$('setup-public-url').addEventListener('input', () => {
  if ($('setup-public-url').value.trim() !== tailscaleAutoFilled) tailscaleAutoFilled = '';
});
$('setup-port').addEventListener('input', () => {
  tailscaleFunnelResult = null;
  renderWhere();
});
$('tailscale-refresh').addEventListener('click', () => void refreshTailscale());
$('tailscale-enable-funnel').addEventListener('click', () => {
  const button = $('tailscale-enable-funnel');
  const label = button.textContent;
  button.textContent = 'Enabling Funnel…';
  void run('network', button, async () => {
    try {
      const result = await api('/setup/api/network/tailscale/funnel', { port: $('setup-port').value.trim() });
      tailscaleFunnelResult = result;
      if (result.ok && result.status) {
        tailscaleStatus = result.status;
        applyTailscaleAutofill();
      }
      renderWhere();
    } finally {
      button.textContent = label;
    }
  });
});
$('network-next').addEventListener('click', () =>
  run('network', $('network-next'), async () => {
    const payload = { where, port: $('setup-port').value.trim() };
    if (where === 'internet') {
      payload.publicUrl = $('setup-public-url').value.trim();
      payload.route = remoteRoute;
      if (remoteRoute === 'https') payload.allowLan = $('setup-allow-lan').checked;
      else payload.trustedProxies = $('setup-trusted-proxies').value.trim();
    }
    await api('/setup/api/network', payload);
    await open('check');
  }),
);

// ----- 6. Check and finish -----

function renderChecks(checks) {
  $('check-running').hidden = true;
  $('check-list').hidden = false;
  $('check-list').replaceChildren(
    ...checks.map(check =>
      el(
        'li',
        { class: 'setup-check', 'data-status': check.status },
        icon(document, check.status === 'pass' ? 'check' : 'x'),
        el(
          'div',
          {},
          el('strong', {}, check.title),
          el('span', { class: check.id === 'storage' ? 'hint setup-path' : 'hint' }, check.detail),
        ),
      ),
    ),
  );
  const passing = checks.every(check => check.status === 'pass');
  $('check-again').hidden = passing;
  $('check-finish').disabled = !passing;
}
async function runChecks() {
  $('check-running').hidden = false;
  $('check-list').hidden = true;
  $('check-finish').disabled = true;
  $('check-again').hidden = true;
  $('check-discord').hidden = true;
  $('check-proxy-note').hidden = true;
  await run('check', $('check-again'), async () => {
    try {
      const { checks, discordRedirect, httpProxy } = await api('/setup/api/check', {});
      renderChecks(checks);
      if (discordRedirect) {
        $('check-discord').querySelector('strong').textContent = discordRedirect;
        $('check-discord').hidden = false;
      }
      if (httpProxy) {
        $('check-proxy-note').textContent =
          httpProxy.route === 'tailscale'
            ? `uburoom will switch to proxy-only HTTP on ${httpProxy.host}:${httpProxy.port} after Finish. ` +
              `Make sure Tailscale Funnel (tailscale funnel --bg ${httpProxy.port}) or Tailscale Serve forwards HTTPS traffic ` +
              `to port ${httpProxy.port} before ${httpProxy.publicUrl} opens.`
            : `uburoom will switch to proxy-only HTTP on ${httpProxy.host}:${httpProxy.port} after Finish. ` +
              `Your Cloudflare Tunnel, Tailscale, or Caddy proxy must forward HTTPS traffic (with X-Forwarded-Proto: https) ` +
              `to port ${httpProxy.port} before ${httpProxy.publicUrl} opens.`;
        $('check-proxy-note').hidden = false;
      }
    } catch (error) {
      $('check-running').hidden = true;
      $('check-again').hidden = false;
      throw error;
    }
  });
}
let lastReadyResult;
async function probeReadyProxy() {
  const info = lastReadyResult;
  if (!info || info.listen !== 'http-proxy') return;
  const button = $('ready-retry');
  button.disabled = true;
  $('ready-proxy-status').textContent = `Checking whether your browser can reach ${info.publicUrl}…`;
  try {
    const res = await fetch(info.publicUrl + '/health', {
      mode: 'cors',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const health = await res.json();
    if (health?.ok !== true || health.service !== 'uburoom' || health.setup === true) {
      throw new Error('Expected a running uburoom');
    }
    $('ready-proxy-status').textContent = `Proxy handoff succeeded: your browser reached uburoom at ${info.publicUrl}.`;
    $('ready-proxy-guide').hidden = true;
    $('ready-open').textContent = 'Open uburoom';
  } catch {
    $('ready-proxy-status').textContent = `This browser could not verify uburoom at ${info.publicUrl} yet.`;
    $('ready-proxy-guide').textContent =
      info.route === 'tailscale'
        ? `Check that Tailscale Funnel is running on this computer (tailscale funnel --bg ${info.port}), ` +
          `then click Retry connection—or open ${info.publicUrl} and sign in normally once Funnel is live.`
        : `Check that your Cloudflare Tunnel, Tailscale, or Caddy proxy forwards to port ${info.port}. ` +
          `Start your tunnel now, then click Retry connection—or open ${info.publicUrl} and sign in normally once your tunnel is live.`;
    $('ready-proxy-guide').hidden = false;
    $('ready-open').textContent = 'Open ' + info.publicUrl;
  } finally {
    button.disabled = false;
  }
}
$('ready-retry').addEventListener('click', () => void probeReadyProxy());
$('check-again').addEventListener('click', () => void runChecks());
$('check-finish').addEventListener('click', () => {
  const button = $('check-finish');
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Finishing…';
  void run('check', button, async () => {
    try {
      const result = await api('/setup/api/finish', {});
      lastReadyResult = result;
      $('ready-open').href = result.url;
      $('ready-open').textContent = 'Open uburoom';
      $('ready-local').hidden = !result.localUrl;
      if (result.localUrl) $('ready-local').href = result.localUrl;
      $('ready-wan-note').hidden = result.where !== 'internet';
      $('ready-proxy-box').hidden = result.listen !== 'http-proxy';
      $('ready-cert-note').hidden = result.listen === 'http-proxy';
      show('ready');
      if (result.listen === 'http-proxy') void probeReadyProxy();
    } catch (error) {
      if (error.body?.checks) renderChecks(error.body.checks);
      throw error;
    } finally {
      button.setAttribute('aria-busy', 'false');
      button.textContent = 'Finish setup';
    }
  });
});

// ----- Moving between steps -----

/** Shows a step with what the server holds for it. */
async function open(name) {
  stopPolls();
  if (name === 'sources') renderSources((await api('/setup/api/sources')).sources);
  if (name === 'access') await loadAccess();
  if (name === 'network') await loadNetwork();
  show(name);
  if (name === 'check') await runChecks();
}
for (const button of document.querySelectorAll('[data-go]'))
  button.addEventListener('click', () =>
    run(current, button.classList.contains('primary') ? button : undefined, () => open(button.dataset.go)),
  );

show('code', { focus: false });
if (fromLink) $('code-form').requestSubmit();
else $('setup-code').focus();
