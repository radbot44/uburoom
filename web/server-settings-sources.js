/* Server settings → Sources: the media sources this server offers. Owned by web/server-settings.js,
 * which gives it a panel. Like Accounts it saves at once rather than through the dialog's Save, but
 * what it saves is config.yaml, so changes apply after restarting uburoom. Adding a source walks its
 * type's setup steps on the server (/api/operator/sources/setup/step); tokens and keys never reach
 * this page. */
import * as uburoomControls from './watch-controls.js';
import * as uburoomIcons from './icons.js';

const TYPE_LABEL = { plex: 'Plex', jellyfin: 'Jellyfin', folders: 'Folder', youtube: 'YouTube' };
const ADD_LABEL = { plex: 'Add Plex', jellyfin: 'Add Jellyfin', folders: 'Add a folder', youtube: 'Add YouTube' };
const POLL_MS = 2000,
  POLL_LIMIT = 150;
const STEP_TIMEOUT = 25000;

/**
 * @param {HTMLElement} panel
 * @param {{request: (path: string, data?: any, options?: any) => Promise<any>, onSaved?: () => void}} services
 * @returns {{load: () => Promise<void>, reset: () => void}}
 */
export function mount(panel, { request, onSaved }) {
  const doc = panel.ownerDocument;
  const node = (tag, parent, text, style) => {
    const value = doc.createElement(tag);
    if (text) value.textContent = text;
    if (style) value.className = style;
    parent?.append(value);
    return value;
  };
  const button = (parent, label, style, action) => {
    const value = node('button', parent, label, style);
    value.type = 'button';
    if (action) value.addEventListener('click', action);
    return value;
  };
  const typeIcon = (parent, type) => {
    const holder = node('span', parent, null, 'server-source-icon');
    if (type === 'folders') holder.append(uburoomIcons.icon(doc, 'folder'));
    else if (type === 'youtube') holder.append(uburoomIcons.icon(doc, 'brand-youtube'));
    else {
      const image = node('img', holder);
      Object.assign(image, {
        src: type === 'plex' ? '/assets/plex-icon.png' : '/assets/jellyfin-icon.svg',
        alt: '',
        width: 28,
        height: 28,
      });
    }
    return holder;
  };
  node(
    'p',
    panel,
    'Everyone you let in can watch every library you offer here. Changes apply after restarting uburoom.',
    'hint',
  );
  const status = node('p', panel, null, 'hint server-settings-status');
  status.id = 'server-sources-status';
  status.setAttribute('role', 'status');
  const error = node('p', panel, null, 'server-settings-error');
  error.id = 'server-sources-error';
  error.setAttribute('role', 'alert');
  const body = node('div', panel, null, 'server-sources');
  body.id = 'server-sources-body';

  let generation = 0,
    busy = false,
    revision,
    sources = [],
    removed = [],
    types = [],
    view = { name: 'list' };
  /** @type {Map<string, any>} Each source's status and libraries, as the server last told them. */
  const details = new Map();

  function setBusy(value) {
    busy = value;
    for (const control of body.querySelectorAll('input,button,select')) {
      if (control.dataset.keep === 'true') continue;
      control.disabled = busy || control.dataset.blocked === 'true';
    }
    panel.setAttribute('aria-busy', String(busy));
  }
  /** Runs one request for the current view; a newer view or a closed dialog discards its answer. */
  async function act(work, { keepError = false } = {}) {
    if (busy) return;
    const id = generation;
    setBusy(true);
    if (!keepError) error.textContent = '';
    try {
      await work(() => id === generation);
    } catch (failure) {
      if (id === generation) error.textContent = failure.message || 'Media source request failed';
    } finally {
      if (id === generation) setBusy(false);
    }
  }
  const step = (flow, name, data = {}) =>
    request('/api/operator/sources/setup/step', { flow, step: name, ...data }, { timeoutMs: STEP_TIMEOUT });
  function accept(result, saved = false) {
    revision = result.revision;
    sources = result.sources;
    removed = result.removed || [];
    types = result.types || types;
    if (saved) onSaved?.(result.revision);
  }
  function show(next) {
    generation++;
    busy = false;
    view = next;
    error.textContent = '';
    render();
  }
  const sourceLabel = source => source.name || source.id;

  // ----- List -----
  function libraryCount(source) {
    const known = details.get(source.id);
    if (!known) return 'Checking…';
    if (source.type === 'folders' || source.type === 'youtube') return source.address;
    if (!known.libraries) return 'Libraries unknown';
    const total = known.libraries.length,
      on = known.libraries.filter(library => library.offered).length;
    return `${on} of ${total} ${total === 1 ? 'library' : 'libraries'}`;
  }
  function statusText(source) {
    const known = details.get(source.id);
    if (!known) return '';
    return known.status.status === 'pass' ? '' : known.status.message;
  }
  function renderList() {
    if (!sources.length)
      node('p', body, 'No media sources yet. Add at least one so people have something to watch.', 'hint');
    const list = node('ul', body, null, 'server-sources-list');
    list.id = 'server-sources-list';
    for (const source of sources) {
      const row = node('li', list, null, 'server-source-row');
      row.dataset.source = source.id;
      typeIcon(row, source.type);
      const who = node('div', row, null, 'server-account-who');
      node('strong', who, sourceLabel(source), 'server-source-name');
      const line = node('span', who, null, 'hint server-source-summary');
      line.textContent = TYPE_LABEL[source.type] + ' · ' + libraryCount(source);
      const problem = node('span', who, statusText(source), 'server-source-problem');
      problem.hidden = !problem.textContent;
      if (source.pending) node('span', who, 'Saved · applies after restart', 'hint server-source-pending');
      const actions = node('div', row, null, 'server-account-actions');
      const edit = button(actions, 'Edit', 'quiet', () => editSource(source));
      edit.setAttribute('aria-label', 'Edit ' + sourceLabel(source));
      const remove = uburoomControls.button(doc, {
        label: 'Remove ' + sourceLabel(source),
        icon: 'trash',
        iconOnly: true,
        action: () => show({ name: 'remove', source }),
      });
      actions.append(remove);
    }
    if (removed.length)
      node(
        'p',
        body,
        'Removed, still running until restart: ' + removed.map(source => source.name || source.id).join(', '),
        'hint server-sources-removed',
      );
    const add = node('div', body, null, 'server-sources-add');
    add.setAttribute('role', 'group');
    add.setAttribute('aria-label', 'Add a media source');
    for (const type of types) {
      const control = button(add, null, 'quiet server-source-type', () => startAdd(type));
      control.id = 'server-source-add-' + type;
      typeIcon(control, type);
      node('span', control, ADD_LABEL[type]);
    }
  }
  /** Reads every source's status and libraries, updating rows in place as answers arrive. */
  function checkAll() {
    const id = generation;
    for (const source of sources)
      request('/api/operator/sources/details?id=' + encodeURIComponent(source.id), undefined, {
        timeoutMs: STEP_TIMEOUT,
      })
        .then(
          result => result,
          failure => ({ status: { status: 'warn', message: failure.message || 'Could not check this source' } }),
        )
        .then(result => {
          if (id !== generation) return;
          details.set(source.id, result);
          const row = body.querySelector(`[data-source="${CSS.escape(source.id)}"]`);
          if (!row || view.name !== 'list') return;
          row.querySelector('.server-source-summary').textContent =
            TYPE_LABEL[source.type] + ' · ' + libraryCount(source);
          const problem = row.querySelector('.server-source-problem');
          problem.textContent = statusText(source);
          problem.hidden = !problem.textContent;
        });
  }

  // ----- Libraries fieldset (edit and add) -----
  function librariesField(parent, libraries, offered) {
    const set = node('fieldset', parent, null, 'server-source-libraries');
    node('legend', set, 'Libraries to offer');
    const boxes = [];
    for (const library of libraries) {
      const row = node('label', set, null, 'form-checkbox');
      const input = node('input', row);
      input.type = 'checkbox';
      input.value = library.id;
      input.checked = offered(library);
      node('span', row, library.name);
      if (library.count !== undefined) node('span', row, library.count.toLocaleString(), 'hint');
      boxes.push(input);
    }
    if (!libraries.length) node('p', set, 'This server has no movie or show libraries.', 'hint');
    node('p', set, 'Libraries added to this server later start off.', 'hint');
    return () => boxes.filter(box => box.checked).map(box => box.value);
  }
  function nameField(parent, value, placeholder) {
    const wrapper = node('label', parent, null, 'server-settings-field');
    node('span', wrapper, 'Name');
    const input = node('input', wrapper);
    Object.assign(input, { type: 'text', id: 'server-source-name', maxLength: 60, autocomplete: 'off', value });
    if (placeholder) input.placeholder = placeholder;
    return input;
  }
  /** Cancel, back to the list, and the view's own action when it has one. */
  function inlineActions(parent, primary, onPrimary, style = 'primary') {
    const row = node('div', parent, null, 'server-source-actions');
    const cancel = button(row, 'Cancel', 'quiet', () => {
      void closeFlow();
      show({ name: 'list' });
      checkAll();
    });
    cancel.id = 'server-source-cancel';
    // Cancel stays usable while a sign-in waits; leaving the view ends that wait.
    cancel.dataset.keep = 'true';
    if (!primary) return undefined;
    const go = button(row, primary, style, onPrimary);
    go.id = 'server-source-confirm';
    return go;
  }

  // ----- Edit -----
  function editSource(source) {
    show({ name: 'edit', source });
    const known = details.get(source.id);
    if (!known)
      void act(async current => {
        const result = await request('/api/operator/sources/details?id=' + encodeURIComponent(source.id));
        if (!current()) return;
        details.set(source.id, result);
        render();
      });
  }
  function youtubeFormFields(parent, draft, { editing = false, source = null } = {}) {
    const name = nameField(parent, draft.sourceName ?? '', 'YouTube');
    name.addEventListener('input', () => (draft.sourceName = name.value));

    const mode = draft.delivery || 'auto';
    if (draft.probe && mode !== 'embed') {
      node(
        'p',
        parent,
        draft.probe.ok
          ? `Detected yt-dlp ${draft.probe.ytdlp}` +
              (draft.probe.ffmpeg
                ? ' · FFmpeg ready for high-bitrate downloads.'
                : ' · FFmpeg not found (will use single-stream MP4 fallback).')
          : mode === 'auto'
            ? 'yt-dlp was not found on PATH — Auto mode will use IFrame embed playback until yt-dlp is installed.'
            : draft.probe.error || 'yt-dlp was not found on PATH.',
        draft.probe.ok || mode === 'auto' ? 'hint' : 'server-source-problem',
      );
    }

    const deliverySet = node('fieldset', parent, null, 'server-source-servers');
    node('legend', deliverySet, 'Delivery mode');
    for (const [value, title, hint] of [
      [
        'auto',
        'Auto — yt-dlp cache with IFrame fallback (recommended)',
        'Uses built-in yt-dlp cache for full sync and Web Audio, and falls back to YouTube’s IFrame player if yt-dlp fails or isn’t installed.',
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
    ]) {
      const row = node('label', deliverySet, null, 'server-source-server');
      const radio = node('input', row);
      Object.assign(radio, {
        type: 'radio',
        name: 'youtube-delivery',
        value,
        checked: mode === value,
      });
      radio.addEventListener('change', () => {
        draft.delivery = value;
        render();
      });
      const text = node('span', row, null, 'server-account-who');
      node('strong', text, title);
      node('span', text, hint, 'hint');
    }

    const field = (target, label, type, id, value, placeholder, onInput, extraHint, autocomplete = 'off') => {
      const wrapper = node('label', target, null, 'server-settings-field');
      node('span', wrapper, label);
      const input = node('input', wrapper);
      Object.assign(input, { type, id, autocomplete, value: value ?? '' });
      if (placeholder) input.placeholder = placeholder;
      input.addEventListener('input', () => onInput(input.value));
      if (extraHint) node('span', wrapper, extraHint, 'hint');
      return input;
    };

    const usesCache = mode === 'auto' || mode === 'ytdlp';
    if (usesCache) {
      const limitInput = field(
        parent,
        'Cache limit (GB)',
        'number',
        'server-youtube-max-cache-gb',
        draft.maxCacheGb ?? '20',
        '20',
        v => (draft.maxCacheGb = v),
        'Oldest downloaded videos are evicted automatically above this disk limit.',
      );
      limitInput.min = '0.1';
      limitInput.max = '2000';
      limitInput.step = '0.5';
    }

    field(
      parent,
      'YouTube Data API v3 key (optional)',
      'password',
      'server-youtube-api-key',
      draft.apiKey,
      editing && source?.hasApiKey ? 'Saved — leave blank to keep existing' : 'AIza...',
      v => (draft.apiKey = v),
      mode === 'embed'
        ? 'Optional: enables playlists and upfront duration/embeddable checks. Without a key, single videos use YouTube oEmbed.'
        : 'Optional: fast metadata & playlist lookup without spawning yt-dlp.',
      'new-password',
    );
    if (editing && source?.hasApiKey) {
      const clearKeyRow = node('label', parent, null, 'form-checkbox');
      const box = node('input', clearKeyRow);
      box.type = 'checkbox';
      box.checked = !!draft.clearApiKey;
      box.addEventListener('change', () => (draft.clearApiKey = box.checked));
      node('span', clearKeyRow, 'Remove saved API key');
    }

    if (usesCache) {
      const advanced = node('details', parent, null, 'server-source-advanced');
      advanced.open = !!draft.advancedOpen;
      advanced.addEventListener('toggle', () => (draft.advancedOpen = advanced.open));
      node('summary', advanced, 'Advanced options');
      const inner = node('div', advanced, null, 'server-source-advanced-body');
      field(
        inner,
        'yt-dlp executable (optional)',
        'text',
        'server-youtube-ytdlp',
        draft.ytDlp,
        'Searches PATH when blank',
        v => (draft.ytDlp = v),
      );
      field(
        inner,
        'Cache directory (optional)',
        'text',
        'server-youtube-cache-dir',
        draft.cacheDirectory,
        'Defaults to data/youtube-cache',
        v => (draft.cacheDirectory = v),
      );
      field(
        inner,
        'Cookies file (optional)',
        'text',
        'server-youtube-cookies-file',
        draft.cookiesFile,
        'Path to Netscape cookies.txt',
        v => (draft.cookiesFile = v),
      );
      field(
        inner,
        'PO token provider URL (optional)',
        'url',
        'server-youtube-po-token-url',
        draft.poTokenUrl,
        'http://127.0.0.1:4416',
        v => (draft.poTokenUrl = v),
      );
    }
  }
  function renderEditYouTube(state) {
    const { source } = state;
    state.sourceName ??= source.name;
    state.delivery ??= source.delivery || 'auto';
    state.maxCacheGb ??= String(source.maxCacheGb ?? 20);
    state.ytDlp ??= source.ytDlp || '';
    state.cacheDirectory ??= source.cacheDirectory || '';
    state.cookiesFile ??= source.cookiesFile || '';
    state.poTokenUrl ??= source.poTokenUrl || '';
    state.apiKey ??= '';
    state.clearApiKey ??= false;
    node('h3', body, 'Edit ' + sourceLabel(source));
    youtubeFormFields(body, state, { editing: true, source });
    inlineActions(body, 'Save source', () =>
      act(async current => {
        const result = await request('/api/operator/sources', {
          revision,
          action: 'update',
          id: source.id,
          name: state.sourceName,
          settings: {
            delivery: state.delivery,
            maxCacheGb: state.maxCacheGb === '' ? 20 : Number(state.maxCacheGb),
            ytDlp: state.ytDlp,
            cacheDirectory: state.cacheDirectory,
            cookiesFile: state.cookiesFile,
            poTokenUrl: state.poTokenUrl,
            ...(state.apiKey ? { apiKey: state.apiKey } : {}),
            ...(state.clearApiKey ? { clearApiKey: true } : {}),
          },
        });
        if (!current()) return;
        accept(result, true);
        details.clear();
        status.textContent = 'Saved. Restart uburoom to apply it.';
        show({ name: 'list' });
        checkAll();
      }),
    );
  }
  function renderEdit({ source }) {
    if (source.folders) return renderEditFolders(view);
    if (source.type === 'youtube') return renderEditYouTube(view);
    const known = details.get(source.id);
    node('h3', body, 'Edit ' + sourceLabel(source));
    const name = nameField(body, source.name, source.id);
    node('p', body, TYPE_LABEL[source.type] + ' at ' + source.address, 'hint');
    let chosen;
    if (source.selectLibraries) {
      if (known?.libraries) chosen = librariesField(body, known.libraries, library => library.offered);
      else if (known) node('p', body, known.librariesError, 'server-source-problem');
      else node('p', body, 'Reading libraries…', 'hint');
    }
    const save = inlineActions(body, 'Save source', () =>
      act(async current => {
        const result = await request('/api/operator/sources', {
          revision,
          action: 'update',
          id: source.id,
          name: name.value,
          ...(chosen ? { libraries: chosen() } : {}),
        });
        if (!current()) return;
        accept(result, true);
        details.clear();
        status.textContent = 'Saved. Restart uburoom to apply it.';
        show({ name: 'list' });
        checkAll();
      }),
    );
    if (source.selectLibraries && !chosen && save) save.dataset.blocked = 'true';
  }

  // ----- Edit a folders source: its libraries, each with a name, Movies or Shows and its folders -----
  /** Opens the folder browser to pick a folder for library `index`, or for a new library ('new'). */
  function pickFolder(index) {
    view.picking = index;
    void act(async current => {
      if (!view.flow) view.flow = (await request('/api/operator/sources/setup', { type: 'folders' })).flow;
      if (!current()) return;
      view.listing = await step(view.flow, 'browse', { path: view.listing?.path || '' });
      if (current()) render();
    });
    render();
  }
  function renderPicker(libraries) {
    const forNew = view.picking === 'new';
    node(
      'h3',
      body,
      forNew ? 'Add a library: choose its first folder' : 'Add a folder to ' + libraries[view.picking].name,
    );
    if (!view.listing) node('p', body, 'Reading folders…', 'hint');
    else folderList(body, view.listing);
    const row = node('div', body, null, 'server-source-actions');
    const back = button(row, 'Back', 'quiet', () => {
      view.picking = undefined;
      render();
    });
    back.id = 'server-source-back';
    back.dataset.keep = 'true';
    const use = button(row, 'Use this folder', 'primary', () => {
      const at = view.listing.path;
      if (forNew) libraries.push({ name: folderName(at), type: 'movies', paths: [at] });
      else if (!libraries[view.picking].paths.includes(at)) libraries[view.picking].paths.push(at);
      view.picking = undefined;
      render();
    });
    use.id = 'server-source-use-folder';
    if (!view.listing?.path) use.dataset.blocked = 'true';
  }
  function renderEditFolders(state) {
    const { source } = state;
    state.libraries ||= source.folders.map(library => ({ ...library, paths: [...library.paths] }));
    const libraries = state.libraries;
    if (state.picking !== undefined) return renderPicker(libraries);
    node('h3', body, 'Edit ' + sourceLabel(source));
    state.sourceName ??= source.name;
    const name = nameField(body, state.sourceName, source.id);
    name.addEventListener('input', () => (state.sourceName = name.value));
    libraries.forEach((library, index) => {
      const box = node('fieldset', body, null, 'server-source-libraries server-source-library');
      box.dataset.library = library.id || 'new-' + index;
      node('legend', box, library.id ? 'Library' : 'New library');
      const head = node('div', box, null, 'server-source-library-head');
      const field = node('label', head, null, 'server-settings-field');
      node('span', field, 'Name');
      const input = node('input', field);
      Object.assign(input, { type: 'text', maxLength: 100, autocomplete: 'off', value: library.name });
      input.addEventListener('input', () => (library.name = input.value));
      kindPicker(head, null, library.type, value => (library.type = value)).setAttribute(
        'aria-label',
        'What ' + (library.name || 'this library') + ' contains',
      );
      const remove = uburoomControls.button(doc, {
        label: 'Remove library ' + library.name,
        icon: 'trash',
        iconOnly: true,
        action: () => {
          libraries.splice(index, 1);
          render();
        },
      });
      head.append(remove);
      if (libraries.length === 1) {
        remove.dataset.blocked = 'true';
        remove.title = 'A source keeps at least one library; remove the whole source instead';
      }
      const list = node('ul', box, null, 'server-source-paths');
      list.setAttribute('aria-label', 'Folders in ' + (library.name || 'this library'));
      library.paths.forEach((at, at_index) => {
        const item = node('li', list);
        item.append(uburoomIcons.icon(doc, 'folder'));
        node('span', item, at, 'server-source-path-text');
        const drop = uburoomControls.button(doc, {
          label: 'Remove folder ' + at,
          icon: 'x',
          iconOnly: true,
          action: () => {
            library.paths.splice(at_index, 1);
            render();
          },
        });
        if (library.paths.length === 1) {
          drop.dataset.blocked = 'true';
          drop.title = 'A library keeps at least one folder';
        }
        item.append(drop);
      });
      button(box, 'Add a folder', 'quiet', () => pickFolder(index)).classList.add('server-source-add-path');
    });
    const addLibrary = button(body, 'Add a library', 'quiet server-source-add-library', () => pickFolder('new'));
    addLibrary.id = 'server-source-add-library';
    node(
      'p',
      body,
      'Videos keep their history when a library is renamed or changes type. A removed library’s history stays, unavailable.',
      'hint',
    );
    inlineActions(body, 'Save source', () =>
      act(async current => {
        const result = await request('/api/operator/sources', {
          revision,
          action: 'update',
          id: source.id,
          name: state.sourceName,
          settings: {
            libraries: libraries.map(library => ({
              ...(library.id ? { id: library.id } : {}),
              name: library.name,
              type: library.type,
              paths: library.paths,
            })),
          },
        });
        if (!current()) return;
        accept(result, true);
        details.clear();
        status.textContent = 'Saved. Restart uburoom to apply it.';
        show({ name: 'list' });
        checkAll();
      }),
    );
  }

  // ----- Remove -----
  function renderRemove({ source }) {
    const box = node('div', body, null, 'server-source-confirm');
    node('h3', box, 'Remove ' + sourceLabel(source) + '?');
    if (source.operatorSignInRisk)
      node(
        'p',
        box,
        'This may remove a server operator’s last sign-in after restart. Before removing it, sign in another way in a private window and confirm Server settings opens. If you lose access, restore the saved configuration backup on the host and restart.',
      );
    node(
      'p',
      box,
      'After a restart its libraries are no longer offered. Queue history and resume positions from it are kept, and come back if you add ' +
        (source.type === 'folders' ? 'this folder again with the same name.' : 'this server again.'),
    );
    inlineActions(
      box,
      'Remove',
      () =>
        act(async current => {
          const result = await request('/api/operator/sources', { revision, action: 'remove', id: source.id });
          if (!current()) return;
          accept(result, true);
          status.textContent = result.recoveryBackup
            ? 'Removed. Before restarting, verify another operator sign-in. To recover, restore the configuration from ' +
              result.recoveryBackup +
              '.'
            : 'Removed. Restart uburoom to apply it.';
          show({ name: 'list' });
          checkAll();
        }),
      'danger-button',
    );
  }

  // ----- Add -----
  async function closeFlow() {
    if (view.popup && !view.popup.closed) view.popup.close();
  }
  function startAdd(type) {
    show({ name: 'add', type, phase: 'start' });
    void act(async current => {
      const { flow } = await request('/api/operator/sources/setup', { type });
      if (!current()) return;
      view.flow = flow;
      if (type === 'jellyfin') {
        view.phase = 'finding';
        render();
        setBusy(true);
        const found = await step(flow, 'discover');
        if (!current()) return;
        view.servers = found.servers;
        view.phase = 'server';
      } else if (type === 'folders') {
        view.listing = await step(flow, 'browse', { path: '' });
        if (!current()) return;
      } else if (type === 'youtube') {
        view.delivery = 'auto';
        view.maxCacheGb = '20';
        view.ytDlp = '';
        view.cacheDirectory = '';
        view.cookiesFile = '';
        view.poTokenUrl = '';
        view.apiKey = '';
        view.sourceName = 'YouTube';
        view.probe = await step(flow, 'probe').catch(() => null);
        if (!current()) return;
        view.phase = 'configure';
      }
      render();
    });
  }
  /** The libraries step every add flow ends with (folders skip it). */
  function renderReady(parent, label) {
    const name = nameField(parent, '', view.ready.name);
    node('p', parent, view.ready.address, 'hint');
    const chosen = librariesField(parent, view.ready.libraries, () => true);
    let allowMembers;
    if (view.type === 'plex' || view.type === 'jellyfin') {
      const row = node('label', parent, null, 'form-checkbox');
      allowMembers = node('input', row);
      allowMembers.type = 'checkbox';
      allowMembers.id = 'server-source-allow-members';
      node(
        'span',
        row,
        view.type === 'plex'
          ? 'Allow people with access to this Plex server to sign in'
          : 'Allow users of this Jellyfin server to sign in',
      );
    }
    inlineActions(parent, label, () =>
      act(current => add(current, name.value, chosen(), allowMembers ? allowMembers.checked : false)),
    );
  }
  /** Saves the ready flow as a new source, then shows the list. */
  async function add(current, name, libraries, allowMembers = false) {
    const result = await request('/api/operator/sources', {
      revision,
      action: 'add',
      flow: view.flow,
      name,
      libraries,
      ...(allowMembers ? { allowMembers: true } : {}),
    });
    if (!current()) return;
    accept(result, true);
    details.clear();
    status.textContent = 'Added. Restart uburoom to apply it.';
    void closeFlow();
    show({ name: 'list' });
    checkAll();
  }
  function radioList(parent, legend, items, chosen, onChoose) {
    const set = node('fieldset', parent, null, 'server-source-servers');
    set.setAttribute('aria-label', legend);
    for (const item of items) {
      const row = node('label', set, null, 'server-source-server');
      const input = node('input', row);
      Object.assign(input, {
        type: 'radio',
        name: 'server-source-server',
        value: item.id,
        checked: item.id === chosen,
      });
      if (item.reachable === false) {
        input.disabled = true;
        input.dataset.blocked = 'true';
        row.setAttribute('aria-disabled', 'true');
      }
      input.addEventListener('change', () => onChoose(item));
      const text = node('span', row, null, 'server-account-who');
      node('strong', text, item.name);
      node('span', text, item.reachable === false ? item.reason : item.address, 'hint');
    }
    return set;
  }
  function manualAddress(parent, label, placeholder, onTest) {
    const details = node('details', parent, null, 'server-source-manual');
    node('summary', details, 'Enter an address instead');
    const row = node('div', details, null, 'server-account-link-row');
    const input = node('input', row);
    Object.assign(input, {
      type: 'text',
      placeholder,
      id: 'server-source-address',
      autocomplete: 'off',
      spellcheck: false,
    });
    input.setAttribute('aria-label', label);
    button(row, 'Test', 'quiet', () => onTest(input.value));
    return details;
  }

  // Plex: PIN sign-in in its own window, then servers, then libraries.
  function signInPlex() {
    // Opened in the click so the browser allows it; pointed at plex.tv once the server has a PIN.
    const popup = window.open('', 'uburoom-plex-source', 'popup,width=600,height=720');
    view.popup = popup;
    void act(async current => {
      const started = await step(view.flow, 'start');
      if (!current()) return;
      if (popup && !popup.closed) popup.location.href = started.url;
      view.signInUrl = started.url;
      view.phase = 'waiting';
      render();
      setBusy(true);
      for (let tries = 0; tries < POLL_LIMIT; tries++) {
        const answer = await step(view.flow, 'servers');
        if (!current()) return;
        if (!answer.waiting) {
          void closeFlow();
          view.account = answer.account;
          view.servers = answer.servers;
          view.phase = 'servers';
          render();
          return;
        }
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
        if (!current()) return;
      }
      throw new Error('Plex sign-in timed out; start again');
    });
  }
  function choosePlex(server) {
    view.server = server.id;
    void act(async current => {
      const ready = await step(view.flow, 'choose', { server: server.id });
      if (!current()) return;
      view.ready = ready;
      render();
    });
  }
  function renderAddPlex() {
    node('h3', body, 'Add Plex');
    if (view.phase === 'start') {
      node('p', body, 'Sign in with the Plex account that can reach the server. It doesn’t have to own it.', 'hint');
      const signIn = button(body, null, 'quiet server-source-type', signInPlex);
      signIn.id = 'server-source-plex-sign-in';
      typeIcon(signIn, 'plex');
      node('span', signIn, 'Sign in with Plex');
      inlineActions(body);
      return;
    }
    if (view.phase === 'waiting') {
      const line = node('p', body, 'Waiting for you to approve uburoom in the Plex window… ', 'hint');
      const link = node('a', line, 'Open it again');
      Object.assign(link, { href: view.signInUrl, target: 'uburoom-plex-source', rel: 'noopener' });
      inlineActions(body);
      return;
    }
    node('p', body, `Signed in as ${view.account}. Choose a server.`, 'hint');
    if (!view.servers.length) node('p', body, 'This Plex account has no servers.', 'hint');
    radioList(body, 'Plex server', view.servers, view.server, choosePlex);
    manualAddress(body, 'Plex server address', 'http://192.168.1.20:32400', url =>
      act(async current => {
        const { server } = await step(view.flow, 'address', { url });
        if (!current()) return;
        view.servers = [...view.servers.filter(item => item.id !== server.id), server];
        view.server = server.id;
        const ready = await step(view.flow, 'choose', { server: server.id });
        if (!current()) return;
        view.ready = ready;
        render();
      }),
    );
    if (view.ready) renderReady(body, 'Add server');
    else inlineActions(body);
  }

  // Jellyfin: a server, an administrator's sign-in, then whose libraries.
  function chooseJellyfin(url) {
    void act(async current => {
      const server = await step(view.flow, 'server', { url });
      if (!current()) return;
      view.server = server;
      view.phase = 'sign-in';
      render();
    });
  }
  function signedInJellyfin(answer) {
    view.users = answer.users;
    view.phase = 'user';
    render();
  }
  function quickConnect() {
    void act(async current => {
      const started = await step(view.flow, 'quickConnect');
      if (!current()) return;
      view.code = started.code;
      render();
      setBusy(true);
      for (let tries = 0; tries < POLL_LIMIT; tries++) {
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
        if (!current()) return;
        const answer = await step(view.flow, 'quickConnectPoll');
        if (!current()) return;
        if (!answer.waiting) return signedInJellyfin(answer);
      }
      throw new Error('Quick Connect timed out; start again');
    });
  }
  function renderAddJellyfin() {
    if (view.phase === 'start' || view.phase === 'finding') {
      node('h3', body, 'Add Jellyfin');
      node('p', body, 'Looking for Jellyfin servers on your network…', 'hint');
      return;
    }
    if (view.phase === 'server') {
      node('h3', body, 'Add Jellyfin');
      if (!view.servers.length) node('p', body, 'No Jellyfin servers answered on your network.', 'hint');
      let chosen = view.servers[0]?.address;
      radioList(
        body,
        'Jellyfin server',
        view.servers.map(server => ({ ...server, id: server.address })),
        chosen,
        server => (chosen = server.address),
      );
      const manual = manualAddress(body, 'Jellyfin server address', 'http://192.168.1.30:8096', chooseJellyfin);
      if (!view.servers.length) manual.open = true;
      const next = inlineActions(body, 'Next', () => chosen && chooseJellyfin(chosen));
      if (!view.servers.length && next) next.dataset.blocked = 'true';
      return;
    }
    if (view.phase === 'sign-in') {
      node('h3', body, 'Sign in to ' + view.server.name);
      node(
        'p',
        body,
        'Use a Jellyfin administrator. uburoom creates its own API key and doesn’t keep the password.',
        'hint',
      );
      const form = node('form', body, null, 'server-source-form');
      const grid = node('div', form, null, 'server-settings-grid');
      const field = (label, id, type) => {
        const wrapper = node('label', grid, null, 'server-settings-field');
        node('span', wrapper, label);
        const input = node('input', wrapper);
        Object.assign(input, { id, type, autocomplete: 'off', required: true });
        return input;
      };
      const username = field('Username', 'server-source-jf-user', 'text');
      const password = field('Password', 'server-source-jf-password', 'password');
      password.required = false;
      if (view.server.quickConnect) {
        if (view.code) {
          node('p', form, 'Or open Jellyfin → Quick Connect and enter this code:', 'hint');
          node('p', form, view.code.replace(/^(\d{3})(\d+)$/, '$1 $2'), 'server-source-code').setAttribute(
            'aria-label',
            'Quick Connect code',
          );
        } else
          button(node('p', form), 'Use Quick Connect instead', 'quiet', quickConnect).id =
            'server-source-quick-connect';
      }
      form.addEventListener('submit', event => {
        event.preventDefault();
        void act(async current => {
          const answer = await step(view.flow, 'password', { username: username.value, password: password.value });
          password.value = '';
          if (current()) signedInJellyfin(answer);
        });
      });
      inlineActions(body, 'Sign in', () => form.requestSubmit());
      return;
    }
    node('h3', body, view.server.name);
    const wrapper = node('label', body, null, 'server-settings-field');
    node('span', wrapper, 'Offer the libraries of');
    const select = node('select', wrapper);
    select.id = 'server-source-jf-users';
    const none = node('option', select, 'Choose a user');
    none.value = '';
    for (const user of view.users) {
      const option = node('option', select, user.name + (user.disabled ? ' (disabled)' : ''));
      option.value = user.id;
      option.disabled = user.disabled;
    }
    select.value = view.user || '';
    node('span', wrapper, 'uburoom reads libraries as this Jellyfin user.', 'hint');
    select.addEventListener('change', () => {
      view.user = select.value;
      view.ready = undefined;
      if (!select.value) return render();
      void act(async current => {
        const ready = await step(view.flow, 'user', { user: select.value });
        if (!current()) return;
        view.ready = ready;
        render();
      });
    });
    if (view.ready) renderReady(body, 'Add server');
    else inlineActions(body);
  }

  // Folders: browse this machine, then a name and what it holds.
  function browse(path) {
    return act(async current => {
      const listing = await step(view.flow, 'browse', { path });
      if (!current()) return;
      view.listing = listing;
      view.phase = 'browse';
      render();
    });
  }
  const folderName = at => at.split(/[\\/]/).filter(Boolean).pop() || at;
  /** Where the browser is, and the folders inside it as buttons that open them. */
  function folderList(parent, listing) {
    node('p', parent, listing.path || 'This computer', 'server-source-path').id = 'server-source-path';
    const list = node('ul', parent, null, 'server-source-folders');
    list.setAttribute('aria-label', 'Folders in ' + (listing.path || 'this computer'));
    const entry = (label, icon, path) => {
      const item = node('li', list);
      const control = button(item, null, 'server-source-folder', () => browse(path));
      control.append(uburoomIcons.icon(doc, icon));
      node('span', control, label);
    };
    if (listing.parent !== null) entry('Up one level', 'arrow-back-up', listing.parent);
    for (const folder of listing.folders) entry(folder.name, 'folder', folder.path);
    if (!listing.folders.length) node('li', list, 'No folders here.', 'hint');
  }
  /** Movies or Shows, as a segmented selector. */
  function kindPicker(parent, labelledBy, value, onChange) {
    const group = node('div', parent, null, 'button-group watch-segmented');
    group.setAttribute('role', 'group');
    if (labelledBy) group.setAttribute('aria-labelledby', labelledBy);
    for (const [kind, text] of [
      ['movies', 'Movies'],
      ['shows', 'Shows'],
    ]) {
      const option = button(group, text, 'group-button', () => {
        onChange(kind);
        for (const other of group.children) other.setAttribute('aria-pressed', String(other === option));
      });
      option.setAttribute('aria-pressed', String(kind === value));
    }
    return group;
  }
  function renderAddFolder() {
    node('h3', body, 'Add a folder');
    if (!view.listing) {
      node('p', body, 'Reading folders…', 'hint');
      return;
    }
    const { listing } = view;
    folderList(body, listing);
    if (!listing.path) return void inlineActions(body);
    const name = nameField(body, '', folderName(listing.path));
    const kind = node('div', body, null, 'server-settings-field');
    const label = node('span', kind, 'Contains');
    label.id = 'server-source-kind';
    view.kind ||= 'movies';
    kindPicker(kind, label.id, view.kind, value => (view.kind = value));
    inlineActions(body, 'Add folder', () =>
      act(async current => {
        await step(view.flow, 'choose', { path: listing.path, type: view.kind });
        if (current()) await add(current, name.value || name.placeholder);
      }),
    );
  }

  function renderAddYouTube() {
    node('h3', body, 'Add YouTube');
    if (!view.flow) return node('p', body, 'Starting…', 'hint');
    node(
      'p',
      body,
      'Play pasted YouTube links with synced room playback and Web Audio using uburoom’s built-in yt-dlp cache.',
      'hint',
    );
    youtubeFormFields(body, view);
    inlineActions(body, 'Add YouTube', () =>
      act(async current => {
        await step(view.flow, 'configure', {
          delivery: view.delivery || 'auto',
          maxCacheGb: view.maxCacheGb === '' ? 20 : Number(view.maxCacheGb),
          ytDlp: view.ytDlp || '',
          cacheDirectory: view.cacheDirectory || '',
          cookiesFile: view.cookiesFile || '',
          poTokenUrl: view.poTokenUrl || '',
          apiKey: view.apiKey || '',
        });
        if (current()) await add(current, (view.sourceName || 'YouTube').trim() || 'YouTube', []);
      }),
    );
  }

  function render() {
    body.replaceChildren();
    body.dataset.view = view.name === 'add' ? 'add-' + view.type : view.name;
    if (view.name === 'list') renderList();
    else if (view.name === 'edit') renderEdit(view);
    else if (view.name === 'remove') renderRemove(view);
    else if (view.type === 'plex') renderAddPlex();
    else if (view.type === 'jellyfin') renderAddJellyfin();
    else if (view.type === 'youtube') renderAddYouTube();
    else renderAddFolder();
    setBusy(busy);
    if (view.name !== 'list') body.querySelector('h3')?.scrollIntoView?.({ block: 'nearest' });
  }

  return {
    setRevision(next) {
      if (next) revision = next;
    },
    async load() {
      view = { name: 'list' };
      generation++;
      details.clear();
      status.textContent = '';
      body.replaceChildren();
      await act(async current => {
        const result = await request('/api/operator/sources');
        if (!current()) return;
        accept(result);
        render();
        checkAll();
      });
    },
    /** Forgets everything shown when the dialog closes, and closes a Plex sign-in window. */
    reset() {
      void closeFlow();
      generation++;
      busy = false;
      view = { name: 'list' };
      sources = [];
      details.clear();
      body.replaceChildren();
      error.textContent = status.textContent = '';
    },
  };
}
