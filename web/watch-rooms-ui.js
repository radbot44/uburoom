/* Saved rooms and role settings; safe DOM, no player or transport ownership. */
(function(root) {
  'use strict';
  const labels = { playPause:'Play / pause', seek:'Seek', chooseMedia:'Choose videos / next / previous', addQueue:'Add to queue',
    editQueue:'Reorder / remove queue entries', autoplay:'Configure autoplay', picture:'Adjust picture', roomSettings:'Rename / change visibility / remote sharing',
    closeRoom:'Close room for everyone', deleteRoom:'Permanently delete room', continueWithoutHost:'Continue without a creator or host' };
  function presetPolicy(name) {
    return { host:Object.fromEntries(Object.keys(labels).map(key => [key,key !== 'deleteRoom'])),
      viewer:Object.fromEntries(Object.keys(labels).map(key => [key,['playPause','seek'].includes(key) || name === 'shared-queue' && ['chooseMedia','addQueue','editQueue','autoplay'].includes(key)])) };
  }
  function presetName(permissions) {
    return ['host-managed','shared-queue'].find(name => {
      const policy = presetPolicy(name);
      return ['host','viewer'].every(role => Object.keys(labels).every(key => permissions[role][key] === policy[role][key]));
    }) || 'custom';
  }
  function summary(name) {
    return name === 'host-managed' ? 'Participants play, pause and seek. Hosts choose videos, manage the queue and manage the room. Only the creator can delete it.' :
      name === 'shared-queue' ? 'Participants control playback, choose videos and manage the queue and autoplay. Hosts manage the room. Only the creator can delete it.' :
      'Uses the server’s configured host and participant permissions. Review the detailed permissions in Settings after creation.';
  }
  function describe(policy) {
    const list = role => Object.keys(labels).filter(key => policy[role][key] || role === 'host' && policy.viewer[key]).map(key => labels[key].toLowerCase()).join(', ') || 'none';
    return 'Participants: ' + list('viewer') + '. Hosts: ' + list('host') + '. The creator retains all permissions.';
  }
  function mount({ request, getState, getMe, join, changed, showChooser, fail }) {
    const $ = id => document.getElementById(id), dialog = $('room-settings-dialog');
    let details, section = 'general', renameDraft = '', draftRoom, generation = 0, busy = false, offset = 0, total = 0, savedGeneration = 0;
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
      const ticket = ++savedGeneration; offset = nextOffset;
      $('room-saved-status').textContent = 'Loading saved rooms…';
      try {
        const result = await request('/api/watch/rooms/saved?offset=' + offset);
        if (ticket !== savedGeneration || !$('room-dialog').open) return;
        total = result.total; $('saved-rooms').replaceChildren();
        for (const room of result.rooms) {
          const row = node('div',$('saved-rooms'),undefined,'saved-room');
          const copy = node('div',row); node('strong',copy,room.name);
          node('p',copy,(room.active ? 'Open' : 'Closed') + ' · ' + (room.title ? room.title + ' · Saved at ' + format(room.position) : 'No video selected'),'hint');
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
        $('room-saved-previous').hidden = $('room-saved-next').hidden = total <= 50;
        $('room-saved-previous').disabled = offset === 0; $('room-saved-next').disabled = offset + 50 >= total;
      } catch (error) { if (ticket === savedGeneration) $('room-saved-status').textContent = error.message; }
    }
    function format(position) {
      const seconds = Math.floor(position || 0); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2,'0');
    }
    async function open(id, targetSection = 'general') {
      selectSection(targetSection);
      const ticket = ++generation; details = undefined; $('room-settings-content').hidden = true;
      $('room-settings-status').textContent = 'Loading room settings…';
      if (!dialog.open) show(dialog);
      try {
        const result = await request('/api/watch/rooms/' + id + '/settings');
        if (ticket !== generation || !dialog.open) return;
        details = result;
        if (draftRoom !== id) { renameDraft = result.name; draftRoom = id; }
        renderSettings();
      } catch (error) { if (ticket === generation && dialog.open) $('room-settings-status').textContent = error.message; }
    }
    function renderSettings() {
      const value = details; if (!value) return;
      $('room-settings-content').hidden = false; $('room-settings-status').textContent = '';
      $('room-role').textContent = 'Your role: ' + value.role + (getMe()?.adminMode ? ' · Admin mode gives creator rights' : '') + '. Creator: ' + value.creator.name;
      $('room-settings-title').textContent = value.name + ' · Settings';
      if ($('room-rename').value !== renameDraft) $('room-rename').value = renameDraft;
      $('room-settings-visibility').value = value.visibility;
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
      $('room-permission-apply').disabled = $('room-permission-preset').disabled = busy || !value.capabilities.managePermissions;
      const preset = presetName(value.permissions);
      $('room-permission-preset').value = preset;
      $('room-permission-summary').textContent = preset === 'custom' ? describe(value.permissions) : summary(preset);
      $('room-current-people').replaceChildren();
      node('p',$('room-current-people'),value.creator.name + ' · Creator');
      for (const person of (value.viewers || []).filter(person => person.id !== value.creator.id)) node('p',$('room-current-people'),person.name + ' · ' + (person.id === value.creator.id ? 'Creator' : value.hosts.some(host => host.id === person.id) ? 'Host' : 'Participant'));
      $('room-host-empty').hidden = !!$('room-host-candidate').options.length;
      $('room-host-candidate').hidden = $('room-host-add').hidden = !$('room-host-candidate').options.length;
      $('room-transfer-empty').hidden = !!value.hosts.length;
      $('room-transfer-target').hidden = $('room-transfer').hidden = !value.hosts.length;
      const current = getState()?.id === value.id;
      $('room-playback-unavailable').hidden = current;
      $('room-playback-controls').hidden = !current;
      if (current) document.dispatchEvent(new CustomEvent('room-playback-settings'));
      $('room-permissions').replaceChildren();
      const header = node('tr',$('room-permissions'));
      for (const label of ['Permission','Host','Participant']) node('th',header,label).scope = 'col';
      for (const [group, keys] of Object.entries({Playback:['playPause','seek','chooseMedia','picture'],Queue:['addQueue','editQueue','autoplay'],'Room management':['roomSettings','closeRoom','deleteRoom'],Continuity:['continueWithoutHost']})) {
        const heading = node('th',node('tr',$('room-permissions')),group,'permission-group'); heading.colSpan = 3;
        for (const key of keys) {
          const label = labels[key];
          const row = node('tr',$('room-permissions')); node('th',row,label).scope = 'row';
          for (const role of ['host','viewer']) {
            const cell = node('td',row), input = node('input',cell); input.type = 'checkbox';
            const inherited = role === 'host' && value.permissions.viewer[key];
            input.checked = value.permissions[role][key] || inherited;
            input.disabled = busy || !value.capabilities.managePermissions || inherited;
            input.setAttribute('aria-label',role + ': ' + label); input.dataset.role = role; input.dataset.permission = key;
            if (inherited) node('small',cell,'Included from participants','hint permission-inherited');
            input.addEventListener('change',() => void edit({action:'permissions',role,permissions:{[key]:input.checked}}));
          }
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
      busy = true; renderSettings(); $('room-settings-status').textContent = 'Saving…';
      try {
        const result = await request('/api/watch/rooms/' + id + '/settings',{revision,change});
        if (ticket === generation && dialog.open) {
          if (result.deleted) dialog.close(); else { details = result; if (change.action === 'rename' && renameDraft === change.name) renameDraft = result.name; }
          $('room-settings-status').textContent = 'Saved';
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
    function selectSection(value) {
      section = value;
      $('room-settings-section').value = value;
      for (const panel of dialog.querySelectorAll('[data-room-section]')) panel.hidden = panel.dataset.roomSection !== value;
      for (const control of $('room-settings-nav').children) control.setAttribute('aria-current', String(control.dataset.section === value));
      $('room-settings-panels').scrollTop = 0;
    }
    for (const [key, label] of [['general','General'],['people','People'],['permissions','Permissions'],['playback','Playback & queue'],['manage','Manage']]) {
      const control = button($('room-settings-nav'),label,() => selectSection(key)); control.dataset.section = key;
    }
    $('room-settings-section').addEventListener('change',event => selectSection(event.target.value));
    $('room-rename').addEventListener('input',event => { renameDraft = event.target.value; });
    $('room-people-open').addEventListener('click',() => { if (getState()?.durable) void open(getState().id,'people'); });
    $('room-settings-open').addEventListener('click',() => { if (getState()?.durable) void open(getState().id); });
    $('room-settings-dismiss').addEventListener('click',() => dialog.close());
    dialog.addEventListener('close',() => { if (!dialog.open) { generation++; details = undefined; draftRoom = undefined; } });
    $('room-settings-refresh').addEventListener('click',() => { if (details && !busy) void open(details.id, section); });
    $('room-rename-save').addEventListener('click',() => void edit({action:'rename',name:$('room-rename').value}));
    $('room-settings-visibility').addEventListener('change',() => void edit({action:'visibility',visibility:$('room-settings-visibility').value}));
    $('room-host-add').addEventListener('click',() => void edit({action:'host.add',userId:$('room-host-candidate').value}));
    $('room-transfer').addEventListener('click',async () => {
      const userId = $('room-transfer-target').value;
      if (await confirm('Transfer creatorship to this host? You will remain a host.')) await edit({action:'creator.transfer',userId});
    });
    $('room-permission-apply').addEventListener('click',() => { const preset = $('room-permission-preset').value; if (preset !== 'custom') void edit({action:'permissions.preset',preset}); });
    $('room-settings-delete').addEventListener('click',async () => { if (await confirm('Permanently delete this room and its saved progress?')) await edit({action:'delete'}); });
    $('room-clear-video').addEventListener('click',async () => { if (await confirm('Clear this saved video and its position? The room and hosts will be kept.')) await edit({action:'bookmark.clear'}); });
    $('room-settings-close-live').addEventListener('click',async () => {
      if (!details || busy || !await confirm('Close this room for everyone and save its progress?')) return;
      const value = details; busy = true; renderSettings();
      try { await request('/api/watch/rooms/' + value.id + '/close',{epoch:value.epoch}); dialog.close(); await changed(); }
      catch (error) { $('room-settings-status').textContent = error.message; }
      finally { busy = false; if (dialog.open) { const notice = $('room-settings-status').textContent; renderSettings(); $('room-settings-status').textContent = notice; } }
    });
    for (const id of ['reopen','lobby-reopen']) $(id).addEventListener('click',() => void showChooser('saved'));
    $('room-saved-previous').addEventListener('click',() => void loadSaved(Math.max(0,offset - 50)));
    $('room-saved-next').addEventListener('click',() => void loadSaved(offset + 50));
    $('room-saved-refresh').addEventListener('click',() => void loadSaved(0));
    return { loadSaved, open, render() {
      for (const id of ['reopen','lobby-reopen']) $(id).hidden = !!getState() || !getMe()?.durableRooms;
      $('room-create-details').hidden = $('room-create-policy').hidden = !getMe()?.durableRooms;
      $('room-people-open').hidden = !getState()?.durable;
      $('room-settings-open').hidden = !getState()?.durable;
      $('room-save-error').textContent = getState()?.saveError || '';
    } };
  }
  root.uburoomRoomUI = { mount, summary, presetPolicy, describe };
})(globalThis);
