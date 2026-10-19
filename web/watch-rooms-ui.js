/* Saved rooms and role settings; safe DOM, no player or transport ownership. */
(function(root) {
  'use strict';
  const labels = { playPause:'Play / pause', seek:'Seek', chooseMedia:'Choose videos / next / previous', addQueue:'Add to queue',
    editQueue:'Reorder / remove queue entries', autoplay:'Configure autoplay', picture:'Adjust picture', roomSettings:'Rename / change visibility / remote sharing',
    closeRoom:'Close room for everyone', deleteRoom:'Permanently delete room', continueWithoutHost:'Continue without a creator or host' };
  function mount({ request, getState, getMe, join, changed, showChooser, fail }) {
    const $ = id => document.getElementById(id), dialog = $('room-settings-dialog');
    let details, generation = 0, busy = false, offset = 0, total = 0, savedGeneration = 0;
    function node(tag, parent, text, className) {
      const element = document.createElement(tag);
      if (text !== undefined) element.textContent = text;
      if (className) element.className = className;
      parent?.append(element); return element;
    }
    function button(parent, text, action, disabled = false) {
      const control = node('button',parent,text,'quiet'); control.type = 'button'; control.disabled = disabled;
      control.addEventListener('click',action); return control;
    }
    function show(target) {
      (document.fullscreenElement || document.body).append(target); target.returnValue = ''; target.showModal();
    }
    async function confirm(message) {
      const target = $('room-confirm-dialog');
      if (target.open) return false;
      $('room-confirm-message').textContent = message;
      const result = new Promise(resolve => target.addEventListener('close',() => resolve(target.returnValue === 'yes'),{once:true}));
      show(target); return result;
    }
    async function loadSaved(nextOffset = offset) {
      if (!getMe()?.durableRooms) { $('room-reopen').hidden = true; return; }
      const ticket = ++savedGeneration; offset = nextOffset; $('room-reopen').hidden = false;
      $('room-saved-status').textContent = 'Loading saved rooms…';
      try {
        const result = await request('/api/watch/rooms/saved?offset=' + offset);
        if (ticket !== savedGeneration || !$('room-dialog').open) return;
        total = result.total; $('saved-rooms').replaceChildren();
        for (const room of result.rooms) {
          const row = node('div',$('saved-rooms'),undefined,'saved-room');
          const copy = node('div',row); node('strong',copy,room.name);
          node('p',copy,room.active ? 'Open now' : room.title ? room.title + ' · Resume at ' + format(room.position) : 'No video selected','hint');
          const actions = node('div',row,undefined,'room-actions');
          button(actions,room.active ? 'Join' : 'Reopen',async () => {
            const original = [...actions.querySelectorAll('button')]; original.forEach(control => control.disabled = true);
            try {
              const opened = room.active ? room : await request('/api/watch/rooms/' + room.id + '/reopen',{});
              await join(opened.id); $('room-dialog').close('reopened');
            } catch (error) { $('room-dialog-error').textContent = error.message; }
            finally { original.forEach(control => control.disabled = false); }
          });
          button(actions,'Settings',() => { $('room-dialog').close('settings'); void open(room.id); });
        }
        $('room-saved-status').textContent = total ? (offset + 1) + '–' + Math.min(offset + 50,total) + ' of ' + total + ' saved rooms. Reopening preserves the saved video.' : 'No saved rooms yet.';
        $('room-saved-previous').disabled = offset === 0; $('room-saved-next').disabled = offset + 50 >= total;
      } catch (error) { if (ticket === savedGeneration) $('room-saved-status').textContent = error.message; }
    }
    function format(position) {
      const seconds = Math.floor(position || 0); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2,'0');
    }
    async function open(id) {
      const ticket = ++generation; details = undefined; $('room-settings-content').hidden = true;
      $('room-settings-status').textContent = 'Loading room settings…';
      if (!dialog.open) show(dialog);
      try {
        const result = await request('/api/watch/rooms/' + id + '/settings');
        if (ticket !== generation || !dialog.open) return;
        details = result; renderSettings();
      } catch (error) { if (ticket === generation && dialog.open) $('room-settings-status').textContent = error.message; }
    }
    function renderSettings() {
      const value = details; if (!value) return;
      $('room-settings-content').hidden = false; $('room-settings-status').textContent = '';
      $('room-role').textContent = 'Your role: ' + value.role + (getMe()?.adminMode ? ' · Admin mode gives creator rights' : '') + '. Creator: ' + value.creator.name;
      $('room-rename').value = value.name; $('room-settings-visibility').value = value.visibility;
      for (const id of ['room-rename','room-rename-save','room-settings-visibility']) $(id).disabled = busy || !value.capabilities.roomSettings;
      const hosts = $('room-hosts'); hosts.replaceChildren();
      for (const host of value.hosts) {
        const row = node('div',hosts,undefined,'room-actions'); node('span',row,host.name);
        button(row,'Remove host',() => void edit({action:'host.remove',userId:host.id}),busy || !value.capabilities.manageHosts);
      }
      if (!value.hosts.length) node('p',hosts,'No additional hosts.','hint');
      for (const [id, people] of [['room-host-candidate',value.candidates.filter(person => person.id !== value.creator.id && !value.hosts.some(host => host.id === person.id))],['room-transfer-target',value.hosts]]) {
        $(id).replaceChildren();
        for (const person of people) { const option = node('option',$(id),person.name); option.value = person.id; }
        $(id).disabled = busy || !people.length;
      }
      $('room-host-add').disabled = busy || !value.capabilities.manageHosts || !$('room-host-candidate').options.length;
      $('room-transfer').disabled = busy || !value.capabilities.transferCreator || !value.hosts.length;
      $('room-permission-full').disabled = busy || !value.capabilities.managePermissions;
      $('room-permissions').replaceChildren();
      const header = node('tr',$('room-permissions'));
      for (const label of ['Permission','Host','Viewer']) node('th',header,label).scope = 'col';
      for (const [key,label] of Object.entries(labels)) {
        const row = node('tr',$('room-permissions')); node('th',row,label).scope = 'row';
        for (const role of ['host','viewer']) {
          const cell = node('td',row), input = node('input',cell); input.type = 'checkbox';
          const inherited = role === 'host' && value.permissions.viewer[key];
          input.checked = value.permissions[role][key] || inherited;
          input.disabled = busy || !value.capabilities.managePermissions || inherited;
          input.setAttribute('aria-label',role + ': ' + label); input.dataset.role = role; input.dataset.permission = key;
          if (inherited) input.title = 'Inherited from viewer permissions';
          input.addEventListener('change',() => void edit({action:'permissions',role,permissions:{[key]:input.checked}}));
        }
      }
      $('room-settings-close-live').hidden = !value.hasLiveRoom;
      $('room-settings-close-live').disabled = busy || !value.capabilities.closeRoom;
      $('room-settings-delete').disabled = busy || !value.capabilities.deleteRoom;
      $('room-clear-video').hidden = value.hasLiveRoom || !value.hasBookmark;
      $('room-clear-video').disabled = busy || !value.capabilities.chooseMedia;
    }
    async function edit(change) {
      if (!details || busy) return;
      const id = details.id, revision = details.revision, ticket = generation;
      const focused = document.activeElement;
      const focusSelector = focused?.dataset.permission ? 'input[data-role="' + focused.dataset.role + '"][data-permission="' + focused.dataset.permission + '"]' : focused?.id ? '#' + CSS.escape(focused.id) : undefined;
      busy = true; renderSettings();
      try {
        const result = await request('/api/watch/rooms/' + id + '/settings',{revision,change});
        if (ticket === generation && dialog.open) {
          if (result.deleted) dialog.close(); else details = result;
        }
        await changed();
      } catch (error) { if (ticket === generation && dialog.open) $('room-settings-status').textContent = error.message; else fail(error.message); }
      finally {
        busy = false;
        if (ticket === generation && dialog.open) {
          const notice = $('room-settings-status').textContent; renderSettings(); $('room-settings-status').textContent = notice;
          if (focusSelector && [document.body,dialog].includes(document.activeElement)) dialog.querySelector(focusSelector)?.focus();
        }
      }
    }
    $('room-settings-open').addEventListener('click',() => { if (getState()?.durable) void open(getState().id); });
    $('room-settings-dismiss').addEventListener('click',() => dialog.close());
    dialog.addEventListener('close',() => { if (!dialog.open) { generation++; details = undefined; } });
    $('room-settings-refresh').addEventListener('click',() => { if (details && !busy) void open(details.id); });
    $('room-rename-save').addEventListener('click',() => void edit({action:'rename',name:$('room-rename').value}));
    $('room-settings-visibility').addEventListener('change',() => void edit({action:'visibility',visibility:$('room-settings-visibility').value}));
    $('room-host-add').addEventListener('click',() => void edit({action:'host.add',userId:$('room-host-candidate').value}));
    $('room-transfer').addEventListener('click',async () => {
      const userId = $('room-transfer-target').value;
      if (await confirm('Transfer creatorship to this host? You will remain a host.')) await edit({action:'creator.transfer',userId});
    });
    $('room-permission-full').addEventListener('click',() => void edit({action:'permissions',role:'viewer',permissions:Object.fromEntries(Object.keys(labels).map(key => [key,true]))}));
    $('room-settings-delete').addEventListener('click',async () => { if (await confirm('Permanently delete this room and its saved progress?')) await edit({action:'delete'}); });
    $('room-clear-video').addEventListener('click',async () => { if (await confirm('Clear this saved video and its position? The room and hosts will be kept.')) await edit({action:'bookmark.clear'}); });
    $('room-settings-close-live').addEventListener('click',async () => {
      if (!details || busy || !await confirm('Close this room for everyone and save its progress?')) return;
      const value = details; busy = true; renderSettings();
      try { await request('/api/watch/rooms/' + value.id + '/close',{epoch:value.epoch}); dialog.close(); await changed(); }
      catch (error) { $('room-settings-status').textContent = error.message; }
      finally { busy = false; if (dialog.open) { const notice = $('room-settings-status').textContent; renderSettings(); $('room-settings-status').textContent = notice; } }
    });
    for (const id of ['reopen','lobby-reopen']) $(id).addEventListener('click',() => void showChooser());
    $('room-saved-previous').addEventListener('click',() => void loadSaved(Math.max(0,offset - 50)));
    $('room-saved-next').addEventListener('click',() => void loadSaved(offset + 50));
    $('room-saved-refresh').addEventListener('click',() => void loadSaved(0));
    return { loadSaved, open, render() {
      for (const id of ['reopen','lobby-reopen','room-create-details']) $(id).hidden = !getMe()?.durableRooms;
      $('room-settings-open').hidden = !getState()?.durable;
      $('room-save-error').textContent = getState()?.saveError || '';
    } };
  }
  root.uburoomRoomUI = { mount };
})(globalThis);
