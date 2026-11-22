/* Browser-only server settings; existing sessions, APIs and dialog lifecycle. */
import * as uburoomControls from './watch-controls.js';
import * as uburoomDialogs from './watch-dialogs.js';
import * as uburoomIcons from './icons.js';
import * as uburoomServerAccounts from './server-settings-accounts.js';
import * as uburoomServerSources from './server-settings-sources.js';

function mount({ request, trigger }) {
  const popups = uburoomDialogs,
    controls = uburoomControls;
  const node = (tag, parent, text, style) => {
    const value = document.createElement(tag);
    if (text) value.textContent = text;
    if (style) value.className = style;
    parent?.append(value);
    return value;
  };
  const dialog = node('dialog', document.body, null, 'watch-dialog server-settings-dialog');
  dialog.id = 'server-settings-dialog';
  dialog.setAttribute('aria-labelledby', 'server-settings-title');
  const header = node('header', dialog),
    title = node('h2', header, 'Server settings');
  title.id = 'server-settings-title';
  const close = controls.button(document, {
    label: 'Close server settings',
    icon: 'close',
    iconOnly: true,
    action: () => popups.close(dialog),
  });
  close.id = 'server-settings-close';
  close.autofocus = true;
  header.append(close);
  node('p', dialog, 'Saved changes take effect after restarting uburoom.', 'hint');
  const nav = node('nav', dialog, null, 'server-settings-tabs');
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', 'Server settings sections');
  const content = node('div', dialog, null, 'server-settings-content'),
    panels = {},
    tabs = {};
  content.id = 'server-settings-content';
  const message = node('p', dialog, null, 'hint');
  message.id = 'server-settings-status';
  message.classList.add('server-settings-status');
  message.setAttribute('role', 'status');
  const error = node('p', dialog, null, 'server-settings-error');
  error.id = 'server-settings-error';
  error.setAttribute('role', 'alert');
  const review = node('button', dialog, 'Review latest settings', 'quiet');
  review.type = 'button';
  review.id = 'server-settings-review';
  review.hidden = true;
  const resolutions = node('div', dialog);
  resolutions.id = 'server-settings-conflicts';
  resolutions.classList.add('server-settings-conflicts');
  const footer = node('footer', dialog, null, 'dialog-footer with-divider');
  const cancel = node('button', footer, 'Cancel', 'quiet');
  cancel.type = 'button';
  cancel.id = 'server-settings-cancel';
  cancel.addEventListener('click', () => popups.close(dialog));
  const save = node('button', footer, null, 'primary');
  save.type = 'button';
  save.id = 'server-settings-save';
  save.classList.add('server-settings-save');
  node('span', save, 'Save');
  const spinner = uburoomIcons.icon(document, 'refresh');
  spinner.classList.add('server-settings-spinner');
  save.append(spinner);
  let base,
    draft,
    revision,
    accessMeta,
    serverPasswordDraft = '',
    sourcesDirty = false,
    generation = 0,
    busy = false,
    saving = false,
    section = 'rooms',
    conflicts = new Set();
  const labels = {},
    writers = new Map(),
    permissionControls = [];
  const same = (key, a, b) =>
    JSON.stringify(
      key.endsWith('_permissions') || key === 'access.source_members' || key === 'discord.excluded_guild_ids'
        ? [...a].sort()
        : a,
    ) ===
    JSON.stringify(
      key.endsWith('_permissions') || key === 'access.source_members' || key === 'discord.excluded_guild_ids'
        ? [...b].sort()
        : b,
    );
  const changes = () => {
    if (!base) return {};
    const patch = Object.fromEntries(
      Object.keys(base)
        .filter(key => !same(key, base[key], draft[key]))
        .map(key => [key, structuredClone(draft[key])]),
    );
    if (draft?.['access.password'] && serverPasswordDraft.length > 0)
      patch['secrets.server_password'] = serverPasswordDraft;
    return patch;
  };
  const dirty = () => !!base && Object.keys(changes()).length > 0;
  const savedControl = control => !panels.accounts.contains(control) && !panels.sources.contains(control);
  popups.register(dialog, { dirty, busy: () => saving });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    generation++;
    base = draft = undefined;
    revision = undefined;
    accessMeta = undefined;
    serverPasswordDraft = '';
    sourcesDirty = false;
    conflicts.clear();
    busy = saving = false;
    accountsPanel.reset();
    sourcesPanel.reset();
  });
  function state() {
    updateAccessUi();
    save.disabled = busy || !revision || !dirty() || conflicts.size > 0;
    cancel.disabled = close.disabled = saving;
    save.setAttribute('aria-busy', String(saving));
    // Accounts and Sources act at once and keep their own busy state; only the saved-settings fields wait for a draft.
    for (const control of content.querySelectorAll('input,select,button'))
      if (savedControl(control)) control.disabled = busy || !draft || control.dataset.fixed === 'true';
    for (const item of permissionControls) {
      const own = draft?.[item.key]?.includes(item.cap),
        inherited = item.role === 'host' && draft?.['rooms.viewer_permissions']?.includes(item.cap);
      item.control.update({
        checked: !!(own || inherited),
        disabled: busy || !draft || item.blocked || inherited,
        reason: inherited ? 'Inherited from viewers' : item.blocked ? 'Room management is unavailable to viewers' : '',
      });
    }
    for (const button of resolutions.querySelectorAll('button')) button.disabled = busy;
    add.disabled = busy || !draft || draft['transcoding.qualities'].length >= 32;
    review.disabled = busy;
  }
  function set(key, value) {
    draft[key] = value;
    state();
  }
  function selectSection(key) {
    if (section !== key) content.scrollTop = 0;
    if (key === 'accounts' && section !== key && dialog.open) void accountsPanel.load();
    if (key === 'sources' && section !== key && dialog.open) void sourcesPanel.load();
    if (
      key !== 'accounts' &&
      key !== 'sources' &&
      section !== key &&
      dialog.open &&
      sourcesDirty &&
      !dirty() &&
      !busy
    ) {
      sourcesDirty = false;
      void load();
    }
    section = key;
    // Accounts and Sources do not depend on the saved settings, so they show even before (or without) them.
    if (key === 'accounts' || key === 'sources') content.hidden = false;
    else if (!draft) content.hidden = true;
    for (const name of Object.keys(panels)) {
      panels[name].hidden = name !== key;
      tabs[name].setAttribute('aria-selected', String(name === key));
      tabs[name].tabIndex = name === key ? 0 : -1;
    }
  }
  for (const [key, label] of [
    ['rooms', 'Rooms'],
    ['access', 'Access'],
    ['directory', 'Directory'],
    ['transcoding', 'Transcoding'],
    ['sources', 'Sources'],
    ['accounts', 'Accounts'],
  ]) {
    const button = node('button', nav, label, 'quiet');
    button.type = 'button';
    button.id = 'server-settings-tab-' + key;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', 'server-settings-' + key);
    button.addEventListener('click', () => selectSection(key));
    tabs[key] = button;
    const panel = node('section', content);
    panel.id = 'server-settings-' + key;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    panels[key] = panel;
  }
  nav.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const keys = Object.keys(tabs),
      index = keys.indexOf(section);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? keys.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
    selectSection(keys[next]);
    tabs[keys[next]].focus();
  });
  function field(parent, key, label, type, options) {
    labels[key] = label;
    const wrapper = node('label', parent, null, 'server-settings-field');
    node('span', wrapper, label);
    const input = node(type === 'select' ? 'select' : 'input', wrapper);
    input.id = 'server-' + key.replaceAll('.', '-');
    if (type === 'select')
      for (const [value, text] of options) {
        const option = node('option', input, text);
        option.value = value;
      }
    else {
      input.type = type;
      if (type === 'number') {
        input.min = '1';
        input.max = key === 'transcoding.max_jobs' ? '32' : '1000000';
        input.step = '1';
        input.required = true;
      }
    }
    input.addEventListener(type === 'number' ? 'input' : 'change', () =>
      set(key, type === 'number' ? input.valueAsNumber : input.value),
    );
    writers.set(key, value => {
      input.value = value;
    });
    return input;
  }
  function checkbox(parent, key, label) {
    labels[key] = label;
    const row = node('label', parent, null, 'form-checkbox'),
      input = node('input', row);
    input.type = 'checkbox';
    input.id = 'server-' + key.replaceAll('.', '-');
    node('span', row, label);
    input.addEventListener('change', () => set(key, input.checked));
    writers.set(key, value => {
      input.checked = value;
    });
    return input;
  }
  const accountsPanel = uburoomServerAccounts.mount(panels.accounts, {
    request,
    onOpenAccess: () => selectSection('access'),
  });
  const sourcesPanel = uburoomServerSources.mount(panels.sources, {
    request,
    onSaved: () => {
      sourcesDirty = true;
    },
  });
  node('h3', panels.access, 'Who can sign in');
  node(
    'p',
    panels.access,
    'Anyone matching at least one enabled method can sign in and watch every library.',
    'hint',
  );
  const sourceMembersKey = 'access.source_members';
  labels[sourceMembersKey] = 'Media server members';
  const sourceMemberRows = node('div', panels.access);
  sourceMemberRows.id = 'server-access-sources';
  writers.set(sourceMembersKey, selected => {
    sourceMemberRows.replaceChildren();
    const sources = accessMeta?.sources || [];
    if (!sources.length) {
      node(
        'p',
        sourceMemberRows,
        'No Plex or Jellyfin servers configured yet. Add one in Sources to let its members sign in.',
        'hint',
      );
      return;
    }
    for (const source of sources) {
      const label = node('label', sourceMemberRows, null, 'form-checkbox');
      const input = node('input', label);
      input.type = 'checkbox';
      input.value = source.id;
      input.id = 'server-access-source-' + source.id;
      input.checked = selected.includes(source.id);
      const text =
        source.type === 'plex'
          ? `People with access to ${source.name} (Plex)`
          : source.type === 'jellyfin'
            ? `People with an account on ${source.name} (Jellyfin)`
            : `Members of ${source.name}`;
      node('span', label, text);
      input.addEventListener('change', () => {
        const next = new Set(draft[sourceMembersKey]);
        if (input.checked) next.add(source.id);
        else next.delete(source.id);
        set(sourceMembersKey, [...next]);
      });
    }
  });
  checkbox(panels.access, 'access.accounts', 'People with an uburoom account');
  node('p', panels.access, 'Master switch for local username and password accounts created in Accounts.', 'hint');
  checkbox(panels.access, 'access.password', 'Anyone with the server password');
  node('p', panels.access, 'Lets people join as named guests using one shared password.', 'hint');
  const serverPasswordGroup = node('div', panels.access, null, 'server-access-subgroup');
  serverPasswordGroup.hidden = true;
  const serverPasswordWrapper = node('label', serverPasswordGroup, null, 'server-settings-field');
  node('span', serverPasswordWrapper, 'Server password');
  const serverPasswordInput = node('input', serverPasswordWrapper);
  serverPasswordInput.type = 'password';
  serverPasswordInput.id = 'server-secrets-server_password';
  serverPasswordInput.autocomplete = 'new-password';
  serverPasswordInput.maxLength = 1024;
  serverPasswordInput.addEventListener('input', () => {
    serverPasswordDraft = serverPasswordInput.value;
    state();
  });
  const serverPasswordHint = node('p', serverPasswordGroup, '', 'hint');
  checkbox(panels.access, 'access.discord_server', 'Members of Discord servers the bot has joined');
  const discordConfigHint = node(
    'p',
    panels.access,
    'Discord bot and OAuth credentials are not configured in config.yaml.',
    'hint',
  );
  discordConfigHint.hidden = true;
  const discordServersGroup = node('div', panels.access, null, 'server-access-subgroup');
  const excludedGuilds = 'discord.excluded_guild_ids';
  labels[excludedGuilds] = 'Discord server exclusions';
  node('h3', discordServersGroup, 'Discord servers');
  node('p', discordServersGroup, 'Uncheck a server to exclude it from Discord entry after restart.', 'hint');
  const guildRows = node('div', discordServersGroup);
  let joinedGuilds;
  writers.set(excludedGuilds, excluded => {
    guildRows.replaceChildren();
    if (!joinedGuilds?.length)
      node(
        'p',
        guildRows,
        joinedGuilds ? 'The bot hasn’t joined a Discord server.' : 'Discord server list unavailable.',
        'hint',
      );
    const servers = new Map((joinedGuilds || []).map(server => [server.id, server]));
    for (const id of excluded)
      if (!servers.has(id)) servers.set(id, { id, name: `Previously excluded server (${id})` });
    for (const { id, name, memberCount } of servers.values()) {
      const label = node('label', guildRows, null, 'form-checkbox');
      const input = node('input', label);
      input.type = 'checkbox';
      input.checked = !excluded.includes(id);
      node('span', label, name);
      if (Number.isFinite(memberCount))
        node('span', label, `${memberCount.toLocaleString()} ${memberCount === 1 ? 'member' : 'members'}`, 'hint');
      input.addEventListener('change', () => {
        const next = new Set(draft[excludedGuilds]);
        if (input.checked) next.delete(id);
        else next.add(id);
        set(excludedGuilds, [...next].sort());
      });
      if (memberCount > 500)
        node(
          'p',
          guildRows,
          `About ${memberCount.toLocaleString()} members. Leave checked only if you want them to have access.`,
          'hint',
        );
    }
  });
  node('h3', panels.access, 'Room invites');
  const guestsEnabledInput = checkbox(
    panels.access,
    'guests.enabled',
    'Allow room hosts to let guests in with an invite link',
  );
  const guestsHint = node('p', panels.access, 'Guests only see the room they were invited to.', 'hint');
  const accessEmptyWarning = node('p', panels.access, 'Turn on at least one sign-in method.', 'server-settings-error');
  accessEmptyWarning.id = 'server-access-empty-warning';
  accessEmptyWarning.hidden = true;
  const operatorLockoutWarning = node(
    'p',
    panels.access,
    'Warning: none of the selected sign-in methods match your server operator account. After restart, you could lose access to Server settings unless another operator identity can sign in.',
    'server-source-problem server-access-warning',
  );
  operatorLockoutWarning.id = 'server-access-lockout-warning';
  operatorLockoutWarning.hidden = true;
  function hasEntryRule() {
    return !!(
      draft?.['access.discord_server'] ||
      draft?.['access.source_members']?.length ||
      draft?.['access.accounts'] ||
      draft?.['access.password']
    );
  }
  function isOperatorLockedOut() {
    const op = accessMeta?.operatorSignIn;
    if (!op || !draft) return false;
    const hasKnownMethod = op.discord || op.plex || op.accounts || op.jellyfinSourceIds?.length > 0;
    if (!hasKnownMethod) return false;
    const selectedSources = draft['access.source_members'] || [];
    const plexIds = new Set((accessMeta?.sources || []).filter(s => s.type === 'plex').map(s => s.id));
    if (op.discord && draft['access.discord_server']) return false;
    if (op.accounts && draft['access.accounts']) return false;
    if (op.plex && selectedSources.some(id => plexIds.has(id))) return false;
    if (op.jellyfinSourceIds?.some(id => selectedSources.includes(id))) return false;
    return true;
  }
  function updateAccessUi() {
    const passwordOn = !!draft?.['access.password'];
    serverPasswordGroup.hidden = !passwordOn;
    serverPasswordInput.placeholder = base?.['access.password'] ? 'Saved; type to change' : 'Enter a server password';
    serverPasswordHint.textContent = base?.['access.password']
      ? 'Leave blank to keep the current password. Changing it signs out current password guests.'
      : 'Required to enable server password entry.';
    discordConfigHint.hidden = accessMeta?.discordConfigured !== false;
    discordServersGroup.hidden = !draft?.['access.discord_server'];
    const publicWebOff = accessMeta?.publicWeb === false;
    guestsEnabledInput.dataset.fixed = publicWebOff ? 'true' : '';
    guestsHint.textContent = publicWebOff
      ? 'Requires the public web app (server.public_web_app: true).'
      : 'Guests only see the room they were invited to.';
    const anyRule = hasEntryRule();
    accessEmptyWarning.hidden = !draft || anyRule;
    operatorLockoutWarning.hidden = !draft || !anyRule || !isOperatorLockedOut();
    accountsPanel.updateAccess(
      accessMeta ? { running: accessMeta.runningAccounts, saved: base?.['access.accounts'] } : {},
    );
  }
  const capacity = node('div', panels.rooms, null, 'server-settings-grid');
  for (const [name, label] of [
    ['max_saved', 'Saved rooms limit'],
    ['max_open', 'Open rooms limit'],
    ['max_members', 'Viewers per room'],
    ['max_people', 'People on the server'],
    ['recovery_seconds', 'Reconnect window (seconds)'],
    ['max_queue', 'Upcoming videos per room'],
  ])
    field(capacity, 'rooms.' + name, label, 'number');
  node('h3', panels.rooms, 'Default room permissions');
  node('p', panels.rooms, 'Defaults for new rooms. Hosts also receive viewer permissions.', 'hint');
  const table = node('table', panels.rooms, null, 'room-permission-table');
  table.setAttribute('aria-label', 'Default room permissions');
  const head = node('tr', node('thead', table));
  for (const text of ['Permission', 'Host', 'Viewer']) {
    const cell = node('th', head, text);
    cell.scope = 'col';
    if (text !== 'Permission') cell.dataset.permissionRole = text === 'Host' ? 'host' : 'viewer';
  }
  const body = node('tbody', table),
    blocked = ['roomSettings', 'closeRoom', 'deleteRoom', 'addHosts', 'kickParticipants'];
  for (const [cap, label] of Object.entries({
    playPause: 'Play / pause',
    seek: 'Seek',
    chooseMedia: 'Skip / replay',
    addQueue: 'Add to queue',
    editQueue: 'Edit queue',
    autoplay: 'Manage auto-play',
    roomSettings: 'Room settings',
    closeRoom: 'Close room',
    deleteRoom: 'Delete room',
    continueWithoutHost: 'Continue without hosts',
    addHosts: 'Add hosts',
    kickParticipants: 'Kick viewers',
  })) {
    const row = node('tr', body),
      heading = node('th', row, label);
    heading.scope = 'row';
    for (const role of ['host', 'viewer']) {
      const key = 'rooms.' + (role === 'host' ? 'host' : 'viewer') + '_permissions';
      labels[key] = (role === 'host' ? 'Host' : 'Viewer') + ' permissions';
      const control = controls.permissionButton(document, {
        label: (role === 'host' ? 'Host' : 'Viewer') + ': ' + label,
        action: () => {
          const value = draft[key];
          set(key, value.includes(cap) ? value.filter(name => name !== cap) : [...value, cap]);
        },
      });
      node('td', row).append(control.element);
      permissionControls.push({ key, role, cap, control, blocked: role === 'viewer' && blocked.includes(cap) });
    }
  }
  checkbox(panels.directory, 'directory.expose_discord_members', 'Show Discord members in host search');
  node(
    'p',
    panels.directory,
    'Controls whether Discord members appear when searching for hosts. It does not grant access or permissions.',
    'hint',
  );
  const transcoding = node('div', panels.transcoding, null, 'server-settings-grid');
  const policy = field(transcoding, 'transcoding.policy', 'Conversion policy', 'select', [
    ['follow_provider', 'Follow the media server'],
    ['disabled', 'Disabled'],
    ['override', 'Allow conversion'],
  ]);
  policy.hidden = true;
  const policyGroup = node('div', policy.parentElement, null, 'button-group');
  policyGroup.setAttribute('role', 'group');
  policyGroup.setAttribute('aria-label', 'Conversion policy');
  for (const option of policy.options) {
    const button = node('button', policyGroup, option.textContent, 'group-button');
    button.type = 'button';
    button.dataset.value = option.value;
  }
  controls.bindSelect(policy, policyGroup);
  field(transcoding, 'transcoding.encoder', 'uburoom encoder', 'select', [
    ['auto', 'Automatic'],
    ['hardware', 'Hardware'],
    ['qsv', 'Intel Quick Sync'],
    ['nvenc', 'NVIDIA NVENC'],
    ['software', 'Software'],
  ]);
  field(transcoding, 'transcoding.max_jobs', 'Maximum shared conversion jobs', 'number');
  checkbox(panels.transcoding, 'transcoding.provider', 'Allow media server conversion');
  checkbox(panels.transcoding, 'transcoding.uburoom', 'Allow uburoom conversion');
  checkbox(panels.transcoding, 'transcoding.cpu_fallback', 'Allow software fallback');
  node('h3', panels.transcoding, 'uburoom video formats');
  labels['transcoding.formats'] = 'uburoom video formats';
  const formatInputs = [];
  for (const format of ['av1', 'vp9', 'vp8']) {
    const row = node('label', panels.transcoding, null, 'form-checkbox'),
      input = node('input', row);
    input.type = 'checkbox';
    node('span', row, format.toUpperCase());
    formatInputs.push([format, input]);
    input.addEventListener('change', () =>
      set(
        'transcoding.formats',
        input.checked
          ? [...draft['transcoding.formats'], format]
          : draft['transcoding.formats'].filter(name => name !== format),
      ),
    );
  }
  writers.set('transcoding.formats', value => {
    for (const [format, input] of formatInputs) input.checked = value.includes(format);
  });
  node('h3', panels.transcoding, 'Offered video qualities');
  checkbox(panels.transcoding, 'transcoding.allow_original', 'Offer Original quality');
  node('p', panels.transcoding, 'Maximum height and bitrate; videos are not upscaled. Original is separate.', 'hint');
  const qualities = node('div', panels.transcoding);
  qualities.id = 'server-settings-qualities';
  labels['transcoding.qualities'] = 'Offered video qualities';
  const add = node('button', panels.transcoding, 'Add quality', 'quiet');
  add.type = 'button';
  add.id = 'server-settings-add-quality';
  function renderQualities(value) {
    qualities.replaceChildren();
    value.forEach((pair, index) => {
      const row = node('div', qualities, null, 'server-quality-row');
      for (const [position, label, min, max, step] of [
        [0, 'Height (px)', 144, 4320, 2],
        [1, 'Bitrate (Mbps)', 0.1, 200, 0.001],
      ]) {
        const wrap = node('label', row, label),
          input = node('input', wrap);
        input.type = 'number';
        input.min = min;
        input.max = max;
        input.step = step;
        input.required = true;
        input.value = pair[position];
        input.setAttribute('aria-label', label + ' for quality ' + (index + 1));
        input.addEventListener('input', () => {
          draft['transcoding.qualities'][index][position] = input.valueAsNumber;
          state();
        });
      }
      const remove = controls.button(document, {
        label: 'Remove quality ' + (index + 1),
        icon: 'close',
        iconOnly: true,
        action: () => {
          draft['transcoding.qualities'].splice(index, 1);
          renderQualities(draft['transcoding.qualities']);
          state();
          add.focus();
        },
      });
      row.append(remove);
    });
  }
  writers.set('transcoding.qualities', renderQualities);
  add.addEventListener('click', () => {
    if (draft['transcoding.qualities'].length >= 32) return;
    draft['transcoding.qualities'].push([480, 1]);
    renderQualities(draft['transcoding.qualities']);
    state();
    qualities.lastElementChild.querySelector('input').focus();
  });
  function render() {
    for (const [key, write] of writers) write(draft[key]);
    content.hidden = false;
    state();
  }
  function showConflicts() {
    resolutions.replaceChildren();
    for (const key of conflicts) {
      const row = node('div', resolutions, null, 'server-conflict');
      node('strong', row, labels[key]);
      const describe = value =>
        typeof value === 'boolean'
          ? value
            ? 'Enabled'
            : 'Disabled'
          : Array.isArray(value)
            ? key === 'transcoding.qualities'
              ? value.map(pair => pair[0] + 'p / ' + pair[1] + ' Mbps').join(', ')
              : key === 'access.source_members'
                ? value
                    .map(id => (accessMeta?.sources || []).find(s => s.id === id)?.name || id)
                    .join(', ') || 'None'
                : value
                    .map(
                      name =>
                        ({
                          playPause: 'Play / pause',
                          chooseMedia: 'Skip / replay',
                          addQueue: 'Add to queue',
                          editQueue: 'Edit queue',
                          continueWithoutHost: 'Continue without hosts',
                          roomSettings: 'Room settings',
                          closeRoom: 'Close room',
                          deleteRoom: 'Delete room',
                          addHosts: 'Add hosts',
                          kickParticipants: 'Kick viewers',
                          autoplay: 'Manage auto-play',
                          seek: 'Seek',
                        })[name] || name.toUpperCase(),
                    )
                    .join(', ') || 'None'
            : {
                follow_provider: 'Follow media server settings',
                override: 'Allow conversion',
                disabled: 'Disable conversion',
                auto: 'Automatic',
                hardware: 'Hardware',
                qsv: 'Intel Quick Sync',
                nvenc: 'NVIDIA NVENC',
                software: 'Software',
              }[value] || String(value);
      node('p', row, 'Saved: ' + describe(base[key]) + '. Your draft: ' + describe(draft[key]) + '.', 'hint');
      for (const [label, useSaved] of [
        ['Use saved value', true],
        ['Keep my change', false],
      ]) {
        const button = node('button', row, label, 'quiet');
        button.type = 'button';
        button.setAttribute('aria-label', label + ' for ' + labels[key]);
        button.addEventListener('click', () => {
          if (useSaved) draft[key] = structuredClone(base[key]);
          conflicts.delete(key);
          showConflicts();
          render();
          if (!conflicts.size) message.textContent = 'Your draft is kept. Review and Save.';
        });
      }
    }
    state();
  }
  async function load(rebase = false) {
    if (busy) return;
    const id = ++generation,
      patch = rebase ? changes() : {},
      reviewFocused = document.activeElement === review;
    busy = true;
    state();
    message.textContent = 'Loading saved settings…';
    error.textContent = '';
    try {
      const [value, guilds] = await Promise.all([
        request('/api/operator/settings/saved'),
        request('/api/operator/discord/servers').catch(() => null),
      ]);
      if (id !== generation || !dialog.open) return;
      joinedGuilds = guilds?.servers;
      accessMeta = value.access;
      sourcesDirty = false;
      const keepPassword = rebase ? patch['secrets.server_password'] : undefined;
      delete patch['secrets.server_password'];
      conflicts = new Set(
        Object.keys(patch).filter(
          key => !same(key, base[key], value.settings[key]) && !same(key, patch[key], value.settings[key]),
        ),
      );
      base = structuredClone(value.settings);
      draft = { ...structuredClone(base), ...patch };
      serverPasswordDraft = keepPassword || '';
      serverPasswordInput.value = serverPasswordDraft;
      revision = value.revision;
      review.hidden = true;
      showConflicts();
      render();
      message.textContent = rebase
        ? conflicts.size
          ? 'Choose which values to keep below, then review and Save.'
          : 'Latest settings loaded. Your changes are kept; review and Save.'
        : '';
    } catch (failure) {
      if (id === generation && dialog.open) {
        message.textContent = '';
        error.textContent = failure.message;
        review.hidden = false;
        review.textContent = rebase ? 'Review latest settings' : 'Retry loading';
      }
    } finally {
      if (id === generation && dialog.open) {
        busy = false;
        state();
        if (reviewFocused)
          (!review.hidden ? review : resolutions.querySelector('button') || (dirty() ? save : tabs[section])).focus({
            preventScroll: true,
          });
      }
    }
  }
  review.addEventListener('click', () => void load(!!base));
  save.addEventListener('click', async () => {
    if (save.disabled || busy) return;
    for (const input of content.querySelectorAll('input,select'))
      if (savedControl(input) && !input.validity.valid) {
        selectSection(Object.keys(panels).find(key => panels[key].contains(input)));
        input.reportValidity();
        return;
      }
    if (!hasEntryRule()) {
      selectSection('access');
      error.textContent = 'Turn on at least one sign-in method.';
      return;
    }
    if (draft['access.password'] && !base['access.password'] && !serverPasswordDraft) {
      selectSection('access');
      error.textContent = 'Enter a server password to enable password entry.';
      serverPasswordInput.focus();
      return;
    }
    const pairs = draft['transcoding.qualities'];
    if (
      (!draft['transcoding.allow_original'] && !pairs.length) ||
      new Set(pairs.map(pair => pair.join(':'))).size !== pairs.length
    ) {
      selectSection('transcoding');
      error.textContent = 'Offer Original or at least one quality, without duplicate qualities.';
      return;
    }
    const id = generation,
      submitted = structuredClone(draft),
      patch = changes(),
      saveFocused = document.activeElement === save;
    busy = saving = true;
    state();
    error.textContent = '';
    message.textContent = 'Saving settings…';
    let auditWarning = false;
    try {
      try {
        await request('/api/operator/settings/saved', { revision, changes: patch });
      } catch (failure) {
        if (!failure.response?.saved) throw failure;
        auditWarning = true;
      }
      if (id !== generation || !dialog.open) return;
      base = structuredClone(submitted);
      draft = submitted;
      serverPasswordDraft = '';
      serverPasswordInput.value = '';
      revision = undefined;
      message.textContent = auditWarning
        ? 'Saved. Restart uburoom to apply changes. Audit recording could not be confirmed.'
        : 'Saved. Restart uburoom to apply changes.';
      try {
        const latest = await request('/api/operator/settings/saved');
        if (id !== generation || !dialog.open) return;
        accessMeta = latest.access;
        base = structuredClone(latest.settings);
        draft = structuredClone(base);
        revision = latest.revision;
        render();
      } catch (failure) {
        if (id === generation && dialog.open) {
          error.textContent = 'Settings were saved, but could not be reloaded. ' + failure.message;
          review.hidden = false;
          review.textContent = 'Reload saved settings';
        }
      }
    } catch (failure) {
      if (id === generation && dialog.open) {
        if (failure.status === 409) {
          error.textContent = 'Another edit was saved. Your draft is kept. Review the latest settings before saving.';
          message.textContent = '';
          review.hidden = false;
          review.textContent = 'Review latest settings';
          revision = undefined;
        } else {
          error.textContent = failure.message;
          message.textContent = 'Your draft is kept.';
        }
      }
    } finally {
      if (id === generation && dialog.open) {
        busy = saving = false;
        state();
        if (saveFocused && [document.body, dialog, save].includes(document.activeElement))
          (!review.hidden ? review : save.disabled ? cancel : save).focus({ preventScroll: true });
      }
    }
  });
  selectSection(section);
  state();
  return {
    open() {
      if (dialog.open) return;
      generation++;
      base = draft = undefined;
      revision = undefined;
      accessMeta = undefined;
      serverPasswordDraft = '';
      serverPasswordInput.value = '';
      sourcesDirty = false;
      conflicts.clear();
      busy = saving = false;
      resolutions.replaceChildren();
      content.hidden = true;
      review.hidden = true;
      message.textContent = error.textContent = '';
      selectSection('rooms');
      popups.open(dialog, trigger);
      void load();
    },
  };
}
export { mount };
