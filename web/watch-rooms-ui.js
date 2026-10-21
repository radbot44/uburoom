/* Saved rooms and role settings; safe DOM, no player or transport ownership. */
(function(root) {
  'use strict';
  const labels = { playPause:'Play / pause', seek:'Seek', chooseMedia:'Choose video', addQueue:'Add to queue',
    editQueue:'Edit queue', autoplay:'Manage auto-play', roomSettings:'Room settings',
    closeRoom:'Close room for everyone', deleteRoom:'Permanently delete room', continueWithoutHost:'Continue without hosts', addHosts:'Add hosts' };
  function presetPolicy(name) {
    return { host:Object.fromEntries(Object.keys(labels).map(key => [key,!['deleteRoom','addHosts'].includes(key)])),
      viewer:Object.fromEntries(Object.keys(labels).map(key => [key,name === 'play-pause' && key === 'playPause' || name === 'queue' && ['playPause','seek','chooseMedia','addQueue','editQueue','autoplay'].includes(key)])), allHosts:false };
  }
  function presetName(permissions) {
    return ['host-control','play-pause','queue'].find(name => {
      const policy = presetPolicy(name);
      return ['host','viewer'].every(role => Object.keys(labels).every(key => permissions[role][key] === policy[role][key]));
    }) || 'custom';
  }
  function mount({ request, getState, getMe, join, entry=()=>({}), changed, showChooser, fail, createDraft, draftChanged, execute }) {
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
      if (text === 'Settings') { control.replaceChildren(root.uburoomUI.icon(document,'settings')); control.className = 'icon-button'; control.setAttribute('aria-label','Room settings'); control.title = 'Room settings'; }
      if (['Join','Reopen'].includes(text)) control.prepend(root.uburoomUI.icon(document,text === 'Join' ? 'login' : 'reopen'));
      control.addEventListener('click',action); return control;
    }
    let openedFromSaved = false, draftRecord;
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
      $('room-chooser-refresh').classList.add('spinning');
      try {
        const result = await request('/api/watch/rooms/saved?offset=' + offset);
        if (ticket !== savedGeneration || !$('room-dialog').open || busy) return;
        total = result.total; $('saved-rooms').replaceChildren();
        for (const room of result.rooms) {
          const row = node('div',$('saved-rooms'),undefined,'saved-room');
          const copy = node('div',row); node('strong',copy,room.name);
          node('p',copy,(room.recovering ? 'Recovering' : room.active ? 'Open' : 'Closed') + ' · ' + (room.title ? room.title + ' · Paused at ' + format(room.position) : 'No video selected'),'hint');
          if (room.retentionReason) node('small',copy,room.retentionReason,'hint');
          node('p',copy,'Last active ' + new Date(room.lastAccessedAt).toLocaleString() + ' · ' + room.members + ' / ' + room.maxMembers + ' people','hint');
          const actions = node('div',row,undefined,'room-actions');
          const currentRoom = room.active && getState()?.id === room.id;
          button(actions,currentRoom ? 'Cancel' : room.active ? 'Join' : 'Reopen',async () => {
            if (currentRoom) { $('room-dialog').close('cancel'); return; }
            if(busy)return;busy=true;savedGeneration++;
            const original = [...actions.querySelectorAll('button')]; original.forEach(control => control.disabled = true);
            $('room-saved-status').textContent=room.active?'Joining room…':'Opening room…';
            $('room-dialog').setAttribute('aria-busy','true');
            try {
              const opened = room.active ? room : await request('/api/watch/rooms/' + room.id + '/reopen',entry(),{timeoutMs:35000});
              await join(opened.id,opened.state); $('room-dialog').close('reopened');
            } catch (error) { $('room-dialog-error').textContent = error.message; }
            finally { busy=false;$('room-chooser-refresh').classList.remove('spinning');$('room-dialog').removeAttribute('aria-busy');$('room-saved-status').textContent='';original.forEach(control => control.disabled = false); }
          });
          button(actions,'Settings',() => { openedFromSaved = true; $('room-dialog').close('settings'); void open(room.id); });
        }
        $('room-saved-status').textContent = total > 50 ? (offset + 1) + '–' + Math.min(offset + 50,total) + ' of ' + total : total ? '' : 'No saved rooms yet.';
        $('room-saved-pagination').hidden = $('room-saved-previous').hidden = $('room-saved-next').hidden = total <= 50;
        $('room-saved-previous').disabled = offset === 0; $('room-saved-next').disabled = offset + 50 >= total;
      } catch (error) { if (ticket === savedGeneration) $('room-saved-status').textContent = error.message; }
      finally { if (ticket === savedGeneration) $('room-chooser-refresh').classList.remove('spinning'); }
    }
    function format(position) {
      const seconds = Math.floor(position || 0); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2,'0');
    }
    async function open(id, targetSection = 'general') {
      clearSearch(); $('room-person-search').value='';
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
    function draftOptions() {
      if (!draftRecord) return {};
      return {keepEmpty:!!draftRecord.keepEmpty,maxMembers:draftRecord.maxMembers ?? null,name:draftRecord.name,visibility:draftRecord.visibility,permissions:structuredClone(draftRecord.permissions),autoplay:draftRecord.autoplay.enabled,autoQueue:structuredClone(draftRecord.queueSummary.autoQueue)};
    }
    function openDraft(options) {
      const person = {id:getMe().account.id,name:getMe().name};
      const base = draftRecord || {canSetAllHosts:true,allHosts:false,actorId:person.id,pendingHosts:[],id:'draft-' + crypto.randomUUID(),draft:true,creator:person,candidates:[person],hosts:[],viewers:[],role:'creator',active:false,hasLiveRoom:false,hasBookmark:false,revision:0,
        permissions:presetPolicy(options.permissionPreset || 'host-control'),autoplay:{enabled:true},queueSummary:{queueRevision:0,autoQueue:{mode:'off',includeSpecials:false}},
        capabilities:Object.fromEntries([...Object.keys(labels),'manageHosts','managePermissions','transferCreator'].map(key=>[key,!['deleteRoom','closeRoom','transferCreator'].includes(key)]))};
      draftRecord = {...base,name:options.name?.trim() || 'Room',visibility:options.visibility};
      details = draftRecord; draftRoom = details.id; renameDraft = details.name; openedFromSaved = false; generation++;
      selectSection('general'); if (!dialog.open) show(dialog); renderSettings();
    }
    async function savePlayback(change) {
      if (!details) throw new Error('Open room settings first');
      const target = details, id = target.id;
      if (target.draft) {
        if (change.autoplay !== undefined) target.autoplay.enabled = change.autoplay;
        if (change.autoQueue) {
          if (change.autoQueue.mode !== 'off' && !change.autoQueue.scope?.id) throw new Error('Choose an auto-queue source');
          target.queueSummary.autoQueue = structuredClone(change.autoQueue);
        }
        draftRecord = target; draftChanged?.(draftOptions()); renderSettings(); return target;
      }
      let result;
      if (change.resetProgress) result = await request('/api/watch/rooms/' + id + '/settings',{revision:target.revision,change:{action:'auto.reset'}});
      else if (change.autoplay !== undefined) {
        if (getState()?.id === id && target.active) {
          await execute({action:'media.autoplay.set',args:{enabled:change.autoplay}});
          result = await request('/api/watch/rooms/' + id + '/settings');
        } else result = await request('/api/watch/rooms/' + id + '/settings',{revision:target.revision,change:{action:'autoplay',enabled:change.autoplay}});
      }
      else {
        await request('/api/watch/rooms/' + id + '/queue',{action:'auto',...change.autoQueue,expectedRevision:target.queueSummary.queueRevision},{timeoutMs:35000});
        result = await request('/api/watch/rooms/' + id + '/settings');
      }
      if (details?.id === id && dialog.open) { details = result; renderSettings(); }
      await changed(); return result;
    }
    let searchTimer, searchGeneration = 0, searchIndex = -1, searchButtons = [];
    function clearSearch() {
      clearTimeout(searchTimer); searchGeneration++; searchIndex=-1; searchButtons=[];
      $('room-person-results').replaceChildren(); $('room-person-search').setAttribute('aria-expanded','false');
      $('room-person-search').removeAttribute('aria-activedescendant'); $('room-person-search-status').textContent='';
    }
    function selectSearch(index) {
      searchIndex=index;
      searchButtons.forEach((button,i)=>button.setAttribute('aria-selected',String(i===index)));
      if (index>=0) { $('room-person-search').setAttribute('aria-activedescendant',searchButtons[index].id); searchButtons[index].scrollIntoView({block:'nearest'}); }
      else $('room-person-search').removeAttribute('aria-activedescendant');
    }
    $('room-person-search').addEventListener('input',()=>{
      clearSearch(); const query=$('room-person-search').value.trim(), target=details, ticket=searchGeneration;
      if (!query || !target?.capabilities.addHosts || target.draft) return;
      $('room-person-search-status').textContent='Searching…';
      searchTimer=setTimeout(async()=>{
        try {
          const result=await request('/api/watch/rooms/'+target.id+'/people?q='+encodeURIComponent(query));
          if(ticket!==searchGeneration || details?.id!==target.id || !dialog.open || !details.capabilities.addHosts) return;
          for (const [index,person] of result.results.entries()) {
            const control=button($('room-person-results'),'',async()=>{
              if (busy || person.assigned) return;
              clearSearch(); $('room-person-search').value='';
              await edit(person.userId ? {action:'host.add',userId:person.userId} : {action:'host.pending.add',provider:person.provider,subject:person.subject});
            },person.assigned);
            control.id='room-person-result-'+index; control.setAttribute('role','option');control.setAttribute('aria-selected','false');control.tabIndex=-1;
            node('strong',control,person.name);node('small',control,person.caption+(person.assigned?' · Already assigned':person.host?' · Host through All hosts':''),'hint');
            searchButtons.push(control);
          }
          $('room-person-search').setAttribute('aria-expanded',String(searchButtons.length>0));
          $('room-person-search-status').textContent=[result.results.length ? result.results.length+(result.results.length===1?' result.':' results.')+' Choose a person to assign host.' : 'No matching people.',...result.notices].join(' ');
        } catch(error) { if(ticket===searchGeneration) $('room-person-search-status').textContent=error.message; }
      },250);
    });
    $('room-person-search').addEventListener('keydown',event=>{
      if (event.key==='Escape' && searchButtons.length) {event.preventDefault();event.stopPropagation();clearSearch();}
      else if (['ArrowDown','ArrowUp'].includes(event.key) && searchButtons.length) {
        event.preventDefault(); const step=event.key==='ArrowDown'?1:-1;
        selectSearch((searchIndex+step+searchButtons.length)%searchButtons.length);
      } else if(event.key==='Enter') {event.preventDefault(); if(searchIndex>=0) searchButtons[searchIndex].click();}
    });
    function renderSettings() {
      const value = details; if (!value) return;
      $('room-settings-content').hidden = false; $('room-settings-status').textContent = '';
      $('room-role').textContent = getMe()?.adminMode ? 'Admin mode' : '';
      $('room-settings-title').textContent = value.name; $('room-settings-title').title = value.name;
      $('room-name-fields').hidden = !!value.singleRoom;
      $('room-keep-empty').checked = !!value.keepEmpty || !!value.singleRoom;
      $('room-keep-empty').disabled = busy || !!value.singleRoom || !value.capabilities.roomSettings;
      $('room-member-limit').max = value.serverMaxMembers || getMe()?.roomLimits?.maxMembers || 20;
      if (document.activeElement !== $('room-member-limit')) $('room-member-limit').value = value.maxMembers || $('room-member-limit').max;
      $('room-member-limit').disabled = $('room-member-limit-save').disabled = busy || !value.capabilities.roomSettings;
      $('room-lifetime-details').textContent = value.createdAt ? 'Created ' + new Date(value.createdAt).toLocaleString() + ' · Last active ' + new Date(value.lastAccessedAt).toLocaleString() : '';
      $('room-capacity-details').textContent = new Set(value.viewers.map(person=>person.id)).size + ' / ' + (value.maxMembers || $('room-member-limit').max) + ' people · Server maximum ' + $('room-member-limit').max;
      if ($('room-rename').value !== renameDraft) $('room-rename').value = renameDraft;
      $('room-settings-visibility').value = value.visibility;
      for (const id of ['room-rename','room-rename-save','room-settings-visibility']) $(id).disabled = busy || !value.capabilities.roomSettings;
      $('room-host-search').hidden = !!value.draft || !value.capabilities.addHosts;
      $('room-person-search').disabled = busy;
      if (!value.capabilities.addHosts) clearSearch();
      $('room-all-hosts').checked = !!value.permissions.allHosts;
      $('room-all-hosts').disabled = busy || !value.canSetAllHosts;
      $('room-host-inheritance').textContent = value.permissions.allHosts ? 'All hosts is on. Everyone uses the host permissions below.' : 'Hosts also receive participant permissions.';
      $('room-permission-roles').hidden = !!value.permissions.allHosts;
      if (value.permissions.allHosts) selectPermissionRole('host');
      $('room-permission-custom').classList.toggle('all-hosts',!!value.permissions.allHosts);
      const roster = $('room-current-people'); roster.replaceChildren();
      for (const person of value.candidates) {
        const isCreator = person.id === value.creator.id;
        const isHost = value.hosts.some(host => host.id === person.id);
        const effectiveHost = isHost || value.permissions.allHosts;
        const role = isCreator ? 'Room Leader' : effectiveHost ? 'Host' : 'Participant';
        const row = node('div',roster,undefined,'room-person'); node('span',row,person.name);
        const badge = node('small',row,undefined,'room-role-badge ' + (isCreator ? 'creator' : role.toLowerCase()));
        badge.append(root.uburoomUI.icon(document, isCreator ? 'creator' : effectiveHost ? 'host' : 'users'), document.createTextNode(role));
        if (effectiveHost && !isCreator) node('small',row,isHost ? 'Explicitly assigned' : 'All hosts mode','hint');
        if (!isCreator) {
          const self = person.id === (value.actorId || getMe()?.account?.id);
          if (isHost && (self || value.capabilities.manageHosts)) {
            const action = button(row,self ? 'Give up host role' : 'Remove host',async () => {
              if (self && !await confirm(value.permissions.allHosts ? 'Remove your explicit host assignment? You will remain a host while All hosts is on.' : 'Give up your host role? You may lose access to this room if it is private or closed.')) return;
              await edit({action:self ? 'host.leave' : 'host.remove',userId:person.id});
            },busy); action.id='room-host-'+person.id;
          } else if (!isHost && value.capabilities.addHosts) {
            const action=button(row,value.permissions.allHosts ? 'Assign host explicitly' : 'Make host',()=>void edit({action:'host.add',userId:person.id}),busy);action.id='room-host-'+person.id;
          }
        }
      }
      for (const pending of value.pendingHosts || []) {
        const row=node('div',roster,undefined,'room-person');node('span',row,pending.name);
        node('small',row,'Host · Awaiting '+(pending.provider==='discord'?'Discord':'Plex')+' sign-in','hint');
        if (value.capabilities.manageHosts) button(row,'Remove assignment',()=>void edit({action:'host.pending.remove',provider:pending.provider,subject:pending.subject}),busy);
      }
      $('room-transfer-target').replaceChildren();
      const transferGroup = $('room-transfer-target-group');
      if (transferGroup) transferGroup.replaceChildren();
      for (const person of value.hosts) {
        const option = node('option',$('room-transfer-target'),person.name); option.value = person.id;
        if (transferGroup) {
          const btn = node('button', transferGroup, person.name, 'group-button');
          btn.type = 'button';
          btn.dataset.value = person.id; btn.title = 'Transfer room leadership to ' + person.name;
          btn.addEventListener('click', () => {
            $('room-transfer-target').value = person.id;
            for (const b of transferGroup.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === person.id));
          });
        }
      }
      if (transferGroup && value.hosts.length) {
        if (!$('room-transfer-target').value) $('room-transfer-target').value = value.hosts[0].id;
        for (const b of transferGroup.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === $('room-transfer-target').value));
      }
      $('room-transfer-target').disabled = busy || !value.capabilities.transferCreator || !value.hosts.length;
      $('room-transfer').disabled = busy || !value.capabilities.transferCreator || !value.hosts.length;
      $('room-transfer').closest('.room-actions').hidden=!!value.singleRoom;
      const transferLabel=dialog.querySelector('label[for="room-transfer-target"]');
      transferLabel.hidden=!!value.singleRoom;
      transferLabel.previousElementSibling.hidden=!!value.singleRoom;
      $('room-permission-preset').disabled = busy || !value.capabilities.managePermissions;
      const preset = presetName(value.permissions);
      $('room-permission-preset').value = preset;
      for (const button of $('room-permission-preset-group').querySelectorAll('button')) {
        button.hidden = false;
        button.disabled = busy || !value.capabilities.managePermissions;
      }
      $('room-permission-preset').querySelector('[value=custom]').hidden = false;
      $('room-transfer-empty').hidden = !!value.singleRoom||!!value.hosts.length;
      $('room-transfer-target').hidden = true;
      if (transferGroup) transferGroup.hidden = $('room-transfer').hidden = !value.hosts.length;
      $('room-playback-controls').hidden = false;
      document.dispatchEvent(new CustomEvent('room-playback-settings'));
      const launch = $('room-settings-primary');
      launch.hidden = !(value.draft || !value.active || openedFromSaved && getState()?.id !== value.id);
      launch.textContent = value.draft ? 'Create room' : 'Reopen room'; launch.disabled = busy;
      $('room-permissions').replaceChildren();
      const header = node('tr',$('room-permissions'));
      for (const [label,role] of [['Permission',''],['Host','host'],['Participant','viewer']]) { const cell = node('th',header,label); cell.scope = 'col'; if (role) cell.dataset.permissionRole = role; }
      for (const [group, keys] of Object.entries({Playback:['playPause','seek','chooseMedia'],Queue:['addQueue','editQueue','autoplay'],'Room management':['roomSettings','closeRoom','deleteRoom','addHosts'],Continuity:['continueWithoutHost']})) {
        const heading = node('th',node('tr',$('room-permissions')),group,'permission-group'); heading.colSpan = 3;
        for (const key of keys) {
          const label = labels[key];
          const row = node('tr',$('room-permissions')); node('th',row,label).scope = 'row';
          for (const role of ['host','viewer']) {
            const cell = node('td',row), input = node('input',cell); cell.dataset.permissionRole = role; input.type = 'checkbox'; input.setAttribute('role','switch');
            input.checked = !!value.permissions[role][key];
            input.disabled = busy || !value.capabilities.managePermissions || role === 'viewer' && ['roomSettings','closeRoom','deleteRoom','addHosts'].includes(key);
            input.setAttribute('aria-label',role + ': ' + label); input.dataset.role = role; input.dataset.permission = key;
            input.addEventListener('change',() => {
              if (role === 'host' && !input.checked) {
                const viewerInput = row.querySelector('input[data-role="viewer"]');
                if (viewerInput) viewerInput.checked = false;
              } else if (role === 'viewer' && input.checked) {
                const hostInput = row.querySelector('input[data-role="host"]');
                if (hostInput) hostInput.checked = true;
              }
              void edit({action:'permissions',role,permissions:{[key]:input.checked}});
            });
          }
        }
      }
      $('room-settings-close-live').hidden = !value.hasLiveRoom;
      if(value.singleRoom)$('room-settings-close-live').hidden=true;
      $('room-settings-close-live').previousElementSibling.textContent=value.singleRoom?'Reset clears playback, the queue and room history, and restores configured room defaults. The shared room and its fixed leader remain.':'Ends live viewing and saves playback progress.';
      $('room-settings-close-live').disabled = busy || !value.capabilities.closeRoom;
      $('room-settings-delete').disabled = busy || !value.capabilities.deleteRoom;
      $('room-settings-delete').textContent=value.singleRoom?'Reset room':'Delete room';
      $('room-clear-video').hidden = value.hasLiveRoom || !value.hasBookmark;
      $('room-clear-video').disabled = busy || !value.capabilities.chooseMedia;
    }
    let settingsStatusTimer;
    function setSettingsStatus(text, transient = false) {
      clearTimeout(settingsStatusTimer);
      $('room-settings-status').textContent = text;
      if (transient) settingsStatusTimer = setTimeout(() => { if ($('room-settings-status').textContent === text) $('room-settings-status').textContent = ''; }, 2500);
    }
    async function edit(change) {
      if (!details || busy) return;
      if (details.draft) {
        if (change.action === 'rename') { if (!change.name.trim()) { setSettingsStatus('Enter a room name'); return; } details.name = change.name.trim(); }
        else if (change.action === 'keepEmpty') details.keepEmpty = change.enabled;
        else if (change.action === 'maxMembers') details.maxMembers = change.value;
        else if (change.action === 'visibility') details.visibility = change.visibility;
        else if (change.action === 'allHosts') details.permissions.allHosts = change.enabled;
        else if (change.action === 'permissions.preset') details.permissions = {...presetPolicy(change.preset),allHosts:details.permissions.allHosts};
        else if (change.action === 'permissions') {
          Object.assign(details.permissions[change.role],change.permissions);
          for (const key of Object.keys(labels)) {
            if (change.role === 'host' && !details.permissions.host[key]) details.permissions.viewer[key] = false;
            if (change.role === 'viewer' && details.permissions.viewer[key]) details.permissions.host[key] = true;
          }
        }
        draftRecord = details; draftChanged?.(draftOptions()); renderSettings(); setSettingsStatus('Updated',true); return;
      }
      const id = details.id, revision = details.revision, ticket = generation;
      const focused = document.activeElement;
      const focusSelector = focused?.dataset.permission ? 'input[data-role="' + focused.dataset.role + '"][data-permission="' + focused.dataset.permission + '"]' : focused?.id ? '#' + CSS.escape(focused.id) : undefined;
      busy = true; renderSettings(); setSettingsStatus('Saving…');
      try {
        const result = await request('/api/watch/rooms/' + id + '/settings',{revision,change});
        if (ticket === generation && dialog.open) {
          if (result.deleted) dialog.close(); else { details = result; if (change.action === 'rename' && renameDraft === change.name) renameDraft = result.name; }
          setSettingsStatus('Saved', true);
        }
        await changed();
      } catch (error) { if (ticket === generation && dialog.open) setSettingsStatus(error.message); else fail(error.message); }
      finally {
        busy = false;
        if (ticket === generation && dialog.open) {
          const notice = $('room-settings-status').textContent; renderSettings(); $('room-settings-status').textContent = notice;
          if (focusSelector && [document.body,dialog].includes(document.activeElement)) (dialog.querySelector(focusSelector) || $('room-settings-dismiss')).focus();
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
    $('room-all-hosts').addEventListener('change',()=>void edit({action:'allHosts',enabled:$('room-all-hosts').checked}));
    $('room-keep-empty').addEventListener('change',async () => {
      const enabled = $('room-keep-empty').checked;
      if (!enabled && !await confirm('When everyone leaves and there is no unfinished video, upcoming queue or auto-queue source, this room and its hosts, permissions and history will be deleted. Allow this?')) { $('room-keep-empty').checked = true; return; }
      void edit({action:'keepEmpty',enabled});
    });
    $('room-member-limit-save').addEventListener('click',() => void edit({action:'maxMembers',value:Number($('room-member-limit').value)}));
    $('room-rename').addEventListener('input',event => { renameDraft = event.target.value; });
    $('room-people-open').addEventListener('click',() => { if (getState()?.durable) void open(getState().id,'people'); });
    $('room-more-permissions').addEventListener('click',() => { if (getState()?.durable) void open(getState().id,'permissions'); });
    for (const [id,icon] of [['lobby-create','plus'],['lobby-reopen','reopen'],['reopen','reopen'],['room-chooser-new','plus'],['room-create-back','reopen'],['close-room','logout']]) $(id).prepend(root.uburoomUI.icon(document,icon));
    let quickBusy = false, quickRoom, quickStatusTimer;
    function setQuickStatus(text, transient = false) {
      clearTimeout(quickStatusTimer);
      $('room-quick-status').textContent = text;
      if (transient) quickStatusTimer = setTimeout(() => { if ($('room-quick-status').textContent === text) $('room-quick-status').textContent = ''; }, 2500);
    }
    const quickInputs = [];
    for (const [key,label] of [['playPause','Play/pause'],['seek','Seek'],['addQueue','Add to queue']]) {
      const wrap = node('label',$('room-quick-switches'),undefined,'room-quick-switch');
      const input = node('input',wrap); input.type = 'checkbox'; input.setAttribute('role','switch'); input.dataset.quickPermission = key;
      wrap.append(document.createTextNode(label)); quickInputs.push(input);
      input.addEventListener('change',async () => {
        const state = getState(), enabled = input.checked;
        if (quickBusy || !state?.capabilities?.managePermissions) { renderQuick(); return; }
        const id = state.id, focused = document.activeElement === input; quickBusy = true; renderQuick(); setQuickStatus('Saving…');
        try {
          const current = await request('/api/watch/rooms/' + id + '/settings');
          if (getState()?.id !== id) return;
          if (!!current.allHosts !== !!state.allHosts) throw new Error('Room mode changed; check the controls again');
          await request('/api/watch/rooms/' + id + '/settings',{revision:current.revision,change:{action:'permissions',role:current.allHosts?'host':'viewer',permissions:{[key]:enabled}}});
          await changed(); if (getState()?.id === id) setQuickStatus('Saved', true);
        } catch (error) { if (getState()?.id === id) setQuickStatus(error.message); }
        finally { quickBusy = false; renderQuick(); if (focused && getState()?.id === id && document.activeElement === document.body) input.focus(); }
      });
    }
    function renderQuick() {
      const state = getState(); if (quickRoom !== state?.id) { quickRoom = state?.id; setQuickStatus(''); }
      $('room-quick-permissions').hidden = !state?.durable;
      const canEdit = !!state?.capabilities?.managePermissions;
      const controls = state?.allHosts ? state.hostPermissions : state?.participantPermissions;
      $('room-quick-permissions').querySelector('h4').textContent = state?.allHosts ? 'Host controls' : 'Participant controls';
      $('room-quick-switches').hidden = !canEdit;
      $('room-quick-readonly').hidden = canEdit;
      for (const input of quickInputs) {
        input.checked = !!controls?.[input.dataset.quickPermission];
        input.disabled = quickBusy || !canEdit;
      }
      if (!canEdit) {
        const allowed = [['playPause','Play/pause'],['seek','Seek'],['addQueue','Add to queue']].filter(([k]) => controls?.[k]).map(([,l]) => l);
        $('room-quick-readonly').textContent = (state?.allHosts ? 'Hosts: ' : 'Participants: ') + (allowed.length ? allowed.join(', ') : 'no playback or queue controls');
        $('room-more-permissions').replaceChildren(root.uburoomUI.icon(document,'settings'),document.createTextNode('View permissions'));
      } else {
        $('room-more-permissions').replaceChildren(root.uburoomUI.icon(document,'settings'),document.createTextNode('More permissions'));
      }
    }
    let permissionRole = 'viewer';
    function selectPermissionRole(role) {
      permissionRole = role; $('room-permission-custom').dataset.role = role;
      for (const key of ['host','viewer']) { const tab = $('room-permission-' + key); tab.setAttribute('aria-selected',String(key === role)); tab.tabIndex = key === role ? 0 : -1; }
    }
    for (const role of ['host','viewer']) {
      $('room-permission-' + role).addEventListener('click',() => selectPermissionRole(role));
      $('room-permission-' + role).addEventListener('keydown',event => { if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) { event.preventDefault(); selectPermissionRole(event.key === 'Home' ? 'viewer' : event.key === 'End' ? 'host' : permissionRole === 'host' ? 'viewer' : 'host'); $('room-permission-' + permissionRole).focus(); } });
    }
    selectPermissionRole('viewer');
    for (const [id,icon,label] of [['room-settings-open','settings','Room settings'],['room-settings-refresh','refresh','Refresh settings'],['room-settings-dismiss','close','Close settings'],['room-chooser-refresh','refresh','Refresh rooms']]) { $(id).replaceChildren(root.uburoomUI.icon(document,icon)); $(id).setAttribute('aria-label',label); $(id).title = label; }
    $('room-settings-open').addEventListener('click',() => { if (getState()?.durable) void open(getState().id); });
    $('room-settings-dismiss').addEventListener('click',() => {
      const fromSaved = openedFromSaved; openedFromSaved = false;
      dialog.close();
      if (fromSaved) void showChooser('saved');
    });
    dialog.addEventListener('cancel',() => {
      if (openedFromSaved) { openedFromSaved = false; void showChooser('saved'); }
    });
    dialog.addEventListener('close',() => { if (!dialog.open) { clearSearch(); generation++; details = undefined; draftRoom = undefined; } });
    $('room-settings-refresh').addEventListener('click',() => { if (details && !busy) { if (details.draft) renderSettings(); else void open(details.id, section); } });
    $('room-rename-save').addEventListener('click',() => void edit({action:'rename',name:$('room-rename').value}));
    $('room-settings-visibility').addEventListener('change',() => void edit({action:'visibility',visibility:$('room-settings-visibility').value}));

    $('room-transfer').addEventListener('click',async () => {
      const userId = $('room-transfer-target').value;
      if (await confirm('Transfer room leadership to this host? You will remain a host.')) await edit({action:'creator.transfer',userId});
    });
    $('room-permission-preset').addEventListener('change',() => { const preset = $('room-permission-preset').value; if (preset !== 'custom') void edit({action:'permissions.preset',preset}); });
    $('room-settings-primary').addEventListener('click',async () => {
      if (!details || busy) return;
      const target = details; busy = true; renderSettings();
      if(!target.draft)setSettingsStatus('Opening room…');
      try {
        if (target.draft) { await createDraft(draftOptions()); draftRecord = undefined; }
        else { const opened = await request('/api/watch/rooms/' + target.id + '/reopen',entry(),{timeoutMs:35000}); await join(opened.id,opened.state); }
        openedFromSaved = false; dialog.close('opened');
      } catch (error) { setSettingsStatus(error.message); }
      finally { busy = false; if (dialog.open) { const notice = $('room-settings-status').textContent; renderSettings(); $('room-settings-status').textContent = notice; } }
    });
    $('room-settings-delete').addEventListener('click',async () => {
      const single=!!details?.singleRoom;
      if(await confirm(single?'Reset this room? Playback, queue and room history will be cleared and permissions reset to server defaults. Accounts and fixed leadership are preserved.':'Permanently delete this room? This cannot be undone.'))await edit({action:single?'reset':'delete'});
    });
    $('room-clear-video').addEventListener('click',async () => { if (await confirm('Clear this saved video and its position? The room and hosts will be kept.')) await edit({action:'bookmark.clear'}); });
    $('room-settings-close-live').addEventListener('click',async () => {
      if (!details || busy || !await confirm('Close this room for everyone and save progress? Viewers will be returned to the lobby.')) return;
      const value = details; busy = true; renderSettings();
      try { await request('/api/watch/rooms/' + value.id + '/close',{epoch:value.epoch}); dialog.close(); await changed(); }
      catch (error) { setSettingsStatus(error.message); }
      finally { busy = false; if (dialog.open) { const notice = $('room-settings-status').textContent; renderSettings(); $('room-settings-status').textContent = notice; } }
    });
    for (const id of ['reopen','lobby-reopen']) $(id).addEventListener('click',() => void showChooser('saved'));
    $('room-saved-previous').addEventListener('click',() => void loadSaved(Math.max(0,offset - 50)));
    $('room-saved-next').addEventListener('click',() => void loadSaved(offset + 50));
    return { loadSaved, open, openDraft, draftOptions, clearDraft() { draftRecord = undefined; }, updateDraftPreset(name) { if (draftRecord) draftRecord.permissions = presetPolicy(name); }, playbackContext() { return dialog.open && details ? {...details,durable:true} : getState(); }, savePlayback, render() {
      $('reopen').hidden = !!getState() || !getMe()?.durableRooms; $('lobby-reopen').hidden = !getMe()?.durableRooms;
      renderQuick();
      $('room-create-details').hidden = $('room-create-policy').hidden = $('room-create-settings').hidden = !getMe()?.durableRooms;
      $('room-people-open').hidden = !getState()?.durable;
      $('room-settings-open').hidden = !getState()?.durable;
      $('room-save-error').textContent = getState()?.saveError || '';
    } };
  }
  root.uburoomRoomUI = { mount, presetPolicy, presetName };
})(globalThis);
