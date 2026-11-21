/* First-run setup wizard (docs/first-run-setup.md), served by setup mode (server/setup/). Every choice
 * is checked and kept by the server; this page shows the steps and never sees a token, key or password
 * once it has sent it. Step 3 drives each source type's own setup steps, as Server settings → Sources does. */
import { icon } from '/icons.js';
import { spriteMarkup } from '/shared/icons-data.mjs';

const POLL_MS = 2000;
const TYPE_LABEL = { plex: 'Plex', jellyfin: 'Jellyfin', folders: 'Folder' };
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
    : icon(document, 'folder');

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
  await start('folders');
  await browse('');
}
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
    await step('choose', { path: listing.path, type: folderKind });
    await add({ name: $('folder-name').value });
  });
});

for (const button of card('sources').querySelectorAll('[data-add]'))
  button.addEventListener('click', () => {
    const type = button.dataset.add;
    void run('sources', button, () =>
      (type === 'plex' ? addPlex() : type === 'jellyfin' ? addJellyfin() : addFolder()).catch(error => {
        closePanel();
        throw error;
      }),
    );
  });

// Edit: rename, and switch libraries on or off (a folder: Movies or Shows).
let editing,
  editKind = 'movies';
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
function renderDiscord(setup) {
  $('discord-servers-field').hidden = !setup;
  if (!setup) return;
  $('discord-invite').href = setup.inviteUrl;
  $('discord-servers').replaceChildren(
    ...(setup.servers.length
      ? setup.servers.map(name => el('li', {}, name))
      : [el('li', { class: 'hint' }, 'The bot hasn’t joined a server yet.')]),
  );
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
    });
    $('server-pass').value = '';
    await open('network');
  }),
);

// ----- 5. Where people watch -----

let networkView,
  where = 'computer';
function renderWhere() {
  for (const button of $('network-where').querySelectorAll('[data-where]'))
    button.setAttribute('aria-pressed', String(button.dataset.where === where));
  const port = /^\d{1,5}$/.test($('setup-port').value.trim()) ? $('setup-port').value.trim() : String(networkView.port);
  const address = host => 'https://' + (host.includes(':') ? `[${host}]` : host) + ':' + port;
  $('network-computer').hidden = where !== 'computer';
  $('network-home').hidden = where !== 'home';
  $('network-home-hint').hidden = where !== 'home';
  $('network-computer').querySelector('strong').textContent = address('localhost');
  $('network-home').querySelector('strong').textContent = networkView.homeAddress
    ? address(networkView.homeAddress)
    : 'this computer’s network address';
}
async function loadNetwork() {
  networkView = await api('/setup/api/network');
  where = networkView.where;
  $('setup-port').value = String(networkView.port);
  renderWhere();
}
$('network-where').addEventListener('click', event => {
  const button = event.target.closest('[data-where]');
  if (!button) return;
  where = button.dataset.where;
  renderWhere();
});
$('setup-port').addEventListener('input', renderWhere);
$('network-next').addEventListener('click', () =>
  run('network', $('network-next'), async () => {
    await api('/setup/api/network', { where, port: $('setup-port').value.trim() });
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
  await run('check', $('check-again'), async () => {
    try {
      renderChecks((await api('/setup/api/check', {})).checks);
    } catch (error) {
      $('check-running').hidden = true;
      $('check-again').hidden = false;
      throw error;
    }
  });
}
$('check-again').addEventListener('click', () => void runChecks());
$('check-finish').addEventListener('click', () => {
  const button = $('check-finish');
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Finishing…';
  void run('check', button, async () => {
    try {
      const { url } = await api('/setup/api/finish', {});
      $('ready-open').href = url;
      show('ready');
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
