/* Saved rooms and role settings; safe DOM, no player or transport ownership. */
(function(root) {
  'use strict';
  const labels = { playPause:'Play / pause', seek:'Seek', chooseMedia:'Choose video', addQueue:'Add to queue',
    editQueue:'Edit queue', autoplay:'Manage auto-play', roomSettings:'Room settings',
    closeRoom:'Close room for everyone', deleteRoom:'Permanently delete room', continueWithoutHost:'Continue without hosts', addHosts:'Add hosts', kickParticipants:'Kick participants' };
  const descriptions = {
    playPause:'Start or pause playback for the room.', seek:'Change the playback position for everyone.',
    chooseMedia:'Choose or replace the room’s current video.', addQueue:'Add videos to the room queue.',
    editQueue:'Reorder or remove queued videos.', autoplay:'Change automatic playback and queue generation.',
    roomSettings:'Edit the room’s name, visibility and capacity.', closeRoom:'End live viewing and save playback progress.',
    deleteRoom:'Permanently delete this room and its saved history.', addHosts:'Appoint additional hosts; cannot remove other hosts.',
    kickParticipants:'Remove viewers from the room; they may rejoin.', continueWithoutHost:'Keep watching when no host is present.',
    allHosts:'Everyone admitted uses host permissions. Only the leader can change this; explicit host assignments are kept.'
  };
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
  function sortPeople(people, selfId) {
    const rank = {creator:0,host:1,viewer:2};
    return [...people].sort((a,b) => Number(b.id === selfId) - Number(a.id === selfId) ||
      rank[a.role] - rank[b.role] || a.name.localeCompare(b.name,undefined,{sensitivity:'base'}) || a.id.localeCompare(b.id));
  }
  function mount({ request, getState, getMe, join, entry=()=>({}), changed, showChooser, fail, createDraft, draftChanged, execute }) {
    const $ = id => document.getElementById(id), dialog = $('room-settings-dialog');
    const controls = root.uburoomControls;
    $('room-bar').classList.add('watch-control-group');
    $('room-keep-empty').closest('label').classList.add('watch-switch-label');
    for (const id of ['switch-room','create','reopen','admin-end-room','close-room']) {
      const control = $(id); controls.content(control,{label:control.textContent,icon:id === 'close-room' ? 'logout' : undefined});
    }
    controls.content($('refresh'),{label:'Refresh rooms',icon:'refresh',iconOnly:true});
    let details, section = 'general', renameDraft = '', draftRoom, generation = 0, busy = false, offset = 0, total = 0, savedGeneration = 0;
    function node(tag, parent, text, className) {
      const element = document.createElement(tag);
      if (text !== undefined) element.textContent = text;
      if (className) element.className = className;
      parent?.append(element); return element;
    }
    function button(parent, text, action, disabled = false) {
      if (parent.id === 'room-settings-nav') {
        const control = node('button',parent,text,'quiet watch-focus'); control.type = 'button'; control.disabled = disabled; control.addEventListener('click',action); return control;
      }
      const settings = text === 'Settings';
      const control = controls.button(document,{label:settings ? 'Room settings' : text,icon:settings ? 'settings' : text === 'Join' ? 'login' : text === 'Reopen' ? 'reopen' : undefined,iconOnly:settings,action,disabled});
      parent.append(control); return control;
    }
    let rosterBusy = false, rosterRoom;
    const rosterStatus = node('p',$('room-roster-frame').parentElement,'','hint'); rosterStatus.setAttribute('role','status');
    const expand = $('room-participants-expand'), rosterFrame = $('room-roster-frame');
    controls.content(expand,{icon:'chevron',label:'Expand participants',iconOnly:true});
    const settingsRoster = $('room-current-people'), settingsFrame = document.createElement('div');
    settingsFrame.className = 'room-roster-frame'; settingsRoster.before(settingsFrame); settingsFrame.append(settingsRoster);
    const settingsExpand = controls.button(document,{icon:'chevron',label:'Expand participants',iconOnly:true});
    settingsExpand.id = 'room-settings-participants-expand'; settingsExpand.hidden = true; settingsFrame.append(settingsExpand);
    const rosterViews = [{roster:$('room-participants'),frame:rosterFrame,button:expand},{roster:settingsRoster,frame:settingsFrame,button:settingsExpand}];
    for (const view of rosterViews) {
      view.button.classList.add('room-roster-expand'); view.button.setAttribute('aria-controls',view.roster.id);
      view.button.addEventListener('click',() => { view.frame.classList.toggle('expanded'); updateRosterSize(); });
      new ResizeObserver(updateRosterSize).observe(view.roster);
    }
    function updateRosterSize() {
      for (const {roster,frame,button} of rosterViews) {
        const overflow = [...roster.children].reduce((height,row) => height + row.offsetHeight,0) > roster.clientHeight + 1;
        const expanded = frame.classList.contains('expanded');
        button.hidden = !overflow && !expanded;
        frame.classList.toggle('has-overflow',overflow || expanded);
        button.setAttribute('aria-expanded',String(expanded));
        button.setAttribute('aria-label',expanded ? 'Show fewer participants' : 'Expand participants');
        button.title = button.getAttribute('aria-label');
      }
    }
    new MutationObserver(() => { if ($('options-panel').classList.contains('section-collapsed')) { for (const view of rosterViews) view.frame.classList.remove('expanded'); updateRosterSize(); } }).observe($('options-panel'),{attributes:true,attributeFilter:['class']});
    async function confirmHostAddition(name, value) {
      return (value.roomRole || value.role) !== 'host' || !!getMe()?.adminMode ||
        await confirm('Make ' + name + ' a host? You cannot remove their host role afterward. Only the room leader or an administrator can remove it.');
    }
    async function personAction(person, value, inSettings, kick = false) {
      if (rosterBusy || inSettings && busy) return;
      if (person.pending) { await edit({action:'host.pending.remove',provider:person.provider,subject:person.subject}); return; }
      const self = person.id === (value.actorId || getMe()?.account?.id);
      if (!kick && !person.explicitHost && !await confirmHostAddition(person.name,value)) return;
      if (kick && !await confirm('Remove ' + person.name + ' from this room? They may rejoin.')) return;
      if (!kick && self && person.explicitHost && !await confirm(value.permissions?.allHosts || value.allHosts ? 'Remove your explicit host assignment? You will remain a host while All hosts is on.' : 'Give up your host role? You may lose access to this room if it is private or closed.')) return;
      const change = {action:person.explicitHost ? self ? 'host.leave' : 'host.remove' : 'host.add',userId:person.id};
      if (!kick && inSettings) { await edit(change); return; }
      if (rosterBusy) return;
      const id = value.id; rosterBusy = true; rosterStatus.textContent = kick ? 'Removing participant…' : 'Saving host role…'; renderLivePeople();
      if (inSettings) { renderSettings(); setSettingsStatus('Removing participant…'); }
      try {
        if (inSettings ? details?.id !== id : getState()?.id !== id) throw new Error('Room changed; try again');
        if (kick) {
          const command = {action:'room.kick',args:{userId:person.id}};
          const result = inSettings ? await request('/api/watch/rooms/' + id + '/command',{epoch:value.epoch,expiresAt:Date.now()+2900,command}) : await execute(command);
          if (result.status !== 'applied') throw new Error(result.message);
        } else {
          const current = await request('/api/watch/rooms/' + id + '/settings');
          if (getState()?.id !== id) throw new Error('Room changed; try again');
          await request('/api/watch/rooms/' + id + '/settings',{revision:current.revision,change});
        }
        await changed();
        if (inSettings && dialog.open && details?.id === id) { await open(id,'people'); setSettingsStatus('Participant removed',true); }
        if (getState()?.id === id) rosterStatus.textContent = kick ? 'Participant removed' : 'Host role saved';
      } catch (error) {
        if (inSettings && dialog.open && details?.id === id) setSettingsStatus(error.message,false,true);
        else if (getState()?.id === id) { rosterStatus.textContent = error.message; fail(error.message); }
      }
      finally {
        rosterBusy = false; renderLivePeople();
        if (inSettings && dialog.open && details?.id === id) { const notice = $('room-settings-status').textContent; renderSettings(); $('room-settings-status').textContent = notice; }
      }
    }
    function renderPeople(roster, people, value, inSettings = false) {
      const self = value.actorId || getMe()?.account?.id, caps = value.capabilities || {};
      const canHost = !!(caps.addHosts || caps.manageHosts || people.some(person => person.id === self && person.explicitHost));
      const canKick = !!caps.kickParticipants, canKickHosts = (value.roomRole || value.role) === 'creator' || !!getMe()?.adminMode;
      const signature = JSON.stringify([people,self,caps,rosterBusy,inSettings && busy,canKickHosts]);
      if (roster.dataset.signature === signature) return;
      roster.dataset.signature = signature;
      const focusId = roster.contains(document.activeElement) ? document.activeElement.id : undefined;
      roster.replaceChildren(); roster.classList.add('room-roster');
      roster.classList.toggle('can-host',canHost); roster.classList.toggle('can-kick',canKick);
      for (const person of sortPeople(people,self)) {
        const row = node('div',roster,undefined,'room-person'); row.dataset.personId = person.id;
        const roleCell = node('span',row,undefined,'room-roster-role');
        const roleName = person.role === 'creator' ? 'Room Leader' : person.role === 'host' ? 'Host' : 'Participant';
        const glyph = person.role === 'creator' ? 'creator' : person.role === 'host' ? 'host' : 'user';
        roleCell.title = roleName; roleCell.setAttribute('aria-label',roleName);
        const allowed = person.role !== 'creator' && (person.explicitHost ? person.id === self || caps.manageHosts : caps.addHosts);
        if (allowed) {
          const label = person.pending ? 'Remove assignment' : person.explicitHost ? person.id === self ? 'Give up host role' : 'Remove host' : 'Make host';
          const action = controls.button(document,{label:label + ': ' + person.name,icon:glyph,iconOnly:true,disabled:rosterBusy || inSettings && busy,action:()=>void personAction(person,value,inSettings)});
          action.classList.add('room-host-action');
          if (person.role === 'viewer') {
            action.classList.add('room-host-promote');
            const hover = root.uburoomIcons.icon(document,'host'); hover.classList.add('room-host-hover'); action.append(hover);
          }
          action.id = (inSettings ? 'room-host-' : 'room-roster-host-') + person.id; roleCell.append(action);
        } else roleCell.append(root.uburoomIcons.icon(document,glyph));
        const username = node('span',row,person.name,'room-roster-name'); username.title = person.name;
        if (person.pending) { username.title += ' · Awaiting ' + (person.provider === 'discord' ? 'Discord' : 'Plex') + ' sign-in'; username.setAttribute('aria-label',username.title); }
        if (!inSettings) {
          const sync=person.syncQuality&&typeof person.syncQuality==='object'?person.syncQuality:{status:'unknown',reason:'measurements-unavailable',sessions:[]};
          const levels={excellent:'Excellent',good:'Good',fair:'Fair',poor:'Poor'};
          const icons={excellent:'wifi',good:'wifi-2',fair:'wifi-1',poor:'wifi-0'};
          const score=Number.isFinite(sync.score)&&sync.score>=0&&sync.score<=1?sync.score:undefined;
          const level=sync.status==='known'?(sync.level||root.uburoomSyncQuality.level(score)):undefined;
          const percent=value=>Number.isFinite(value)&&value>=0&&value<=1?Math.round(value*100)+'%':undefined;
          const reasonLabel={paused:'paused',disconnected:'device disconnected',stale:'stale measurement',seeking:'seeking',starting:'starting playback',
            buffering:'buffering while collecting measurements',
            'clock-unavailable':'clock timing unavailable','clock-stale':'clock timing is stale','clock-low-confidence':'clock timing is unreliable',
            'insufficient-clock-samples':'waiting for clock samples','insufficient-sync-samples':'collecting sync measurements',
            'measurement-stale':'stale measurement','stream-changed':'stream changed; collecting new measurements','playback-error':'playback error',
            'no-sessions':'no playback sessions','measurements-unavailable':'waiting for reliable measurements'};
          const sessions=Array.isArray(sync.sessions)?sync.sessions:[];
          const sessionDetails=sessions.map(session=>{
            const device=(session.device||'Playback')+' · Session '+(session.sessionNumber||1);
            const activePercent=percent(session.score),lastPercent=percent(session.lastKnownScore);
            if(activePercent&&['playing','buffering'].includes(session.status))
              return device+': '+levels[session.level||root.uburoomSyncQuality.level(session.score)]+' ('+activePercent+')'+(session.status==='buffering'?' · Buffering':'');
            const status={playing:'Playing · measuring',buffering:'Buffering · measuring',paused:'Paused',seeking:'Seeking',starting:'Starting',stale:'Stale',
              disconnected:'Disconnected',error:'Playback error',unknown:'Unknown'}[session.status]||'Unknown';
            const prior=lastPercent?' · last known '+(levels[session.lastKnownLevel]||'quality')+' ('+lastPercent+')':'';
            return device+': '+status+prior;
          });
          const label=level&&percent(score)?'Sync quality: '+levels[level]+' ('+percent(score)+')':
            'Sync quality: Unknown ('+(reasonLabel[sync.reason]||'measurement unavailable')+')';
          const tooltip=[label,...sessionDetails].join('\n');
          const quality = node('span',row,undefined,'room-roster-sync-quality');
          quality.dataset.quality = level || 'unknown'; quality.title = tooltip; quality.setAttribute('role','img'); quality.setAttribute('aria-label',tooltip);
          const qualityIcon = root.uburoomIcons.icon(document,icons[level||sync.lastKnownLevel]||'wifi');
          qualityIcon.setAttribute('aria-hidden','true'); quality.append(qualityIcon);
        }
        const kickable = canKick && person.present && person.id !== self && person.role !== 'creator' && (person.role !== 'host' || canKickHosts);
        row.classList.toggle('has-kick',!!kickable);
        if (kickable) {
          const cell = node('span',row,undefined,'room-roster-action');
          const action = controls.button(document,{label:'Kick ' + person.name,icon:'karate',iconOnly:true,disabled:rosterBusy || inSettings && busy,action:()=>void personAction(person,value,inSettings,true)});
          action.classList.add('watch-header-control');
          action.id = (inSettings ? 'room-settings-kick-' : 'room-kick-') + person.id; cell.append(action);
        }
      }
      if (focusId) document.getElementById(focusId)?.focus({preventScroll:true});
    }
    function renderLivePeople() {
      const state = getState();
      if (rosterRoom !== state?.id) { rosterRoom = state?.id; rosterFrame.classList.remove('expanded'); rosterStatus.textContent = ''; }
      renderPeople($('room-participants'),state?.participants || [],state || {});
      updateRosterSize();
    }
    let openedFromSaved = false, draftRecord;
    const popups = root.uburoomDialogs, confirm = popups.confirm;
    const show = target => popups.open(target);
    let capacityDraft;
    popups.register(dialog, {busy:() => busy || rosterBusy, dirty:() => !!details &&
      (renameDraft !== details.name || capacityDraft !== undefined && Number(capacityDraft) !== Number(details.maxMembers || $('room-member-limit').max))});
    popups.register($('room-dialog'), {busy:() => busy});
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
      setSettingsStatus('Loading room settings…');
      if (!dialog.open) show(dialog);
      try {
        const result = await request('/api/watch/rooms/' + id + '/settings');
        if (ticket !== generation || !dialog.open) return;
        details = result;
        if (draftRoom !== id) { renameDraft = result.name; capacityDraft = undefined; draftRoom = id; }
        renderSettings();
      } catch (error) { if (ticket === generation && dialog.open) setSettingsStatus(error.message,false,true); }
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
      details = draftRecord; capacityDraft = undefined; draftRoom = details.id; renameDraft = details.name; openedFromSaved = false; generation++;
      selectSection('general'); if (!dialog.open) show(dialog); renderSettings();
    }
    async function savePlayback(change) {
      if (!details) throw new Error('Open room settings first');
      const release = popups.hold(dialog);
      try {
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
      } finally { release(); }
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
              if (!await confirmHostAddition(person.name,details)) return;
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
      $('room-settings-panels').setAttribute('aria-busy',String(busy));
      $('room-role').textContent = getMe()?.adminMode ? 'Admin mode' : '';
      $('room-settings-title').textContent = value.name; $('room-settings-title').title = value.name;
      $('room-name-fields').hidden = !!value.singleRoom;
      $('room-keep-empty').checked = !!value.keepEmpty || !!value.singleRoom;
      $('room-keep-empty').disabled = busy || !!value.singleRoom || !value.capabilities.roomSettings;
      $('room-member-limit').max = value.serverMaxMembers || getMe()?.roomLimits?.maxMembers || 20;
      if (document.activeElement !== $('room-member-limit')) $('room-member-limit').value = capacityDraft ?? value.maxMembers ?? $('room-member-limit').max;
      $('room-member-limit').disabled = $('room-member-limit-save').disabled = busy || !value.capabilities.roomSettings;
      $('room-lifetime-details').textContent = value.createdAt ? 'Created ' + new Date(value.createdAt).toLocaleString() + ' · Last active ' + new Date(value.lastAccessedAt).toLocaleString() : '';
      $('room-capacity-details').textContent = new Set(value.viewers.map(person=>person.id)).size + ' / ' + (value.maxMembers || $('room-member-limit').max) + ' people · Server maximum ' + $('room-member-limit').max;
      if ($('room-rename').value !== renameDraft) $('room-rename').value = renameDraft;
      $('room-settings-visibility').value = value.visibility;
      for (const id of ['room-rename','room-rename-save','room-settings-visibility']) $(id).disabled = busy || !value.capabilities.roomSettings;
      $('room-host-search').hidden = !!value.draft || !value.capabilities.addHosts;
      $('room-person-search').disabled = busy;
      if (!value.capabilities.addHosts) clearSearch();
      $('room-host-inheritance').textContent = value.permissions.allHosts ? 'Everyone is host. Everyone uses the host permissions below.' : 'Hosts also receive participant permissions.';
      $('room-permission-custom').classList.toggle('all-hosts',!!value.permissions.allHosts);
      const roster = $('room-current-people'); delete roster.dataset.signature;
      const people = value.candidates.map(person => ({...person,role:person.id === value.creator.id ? 'creator' : value.hosts.some(host => host.id === person.id) || value.permissions.allHosts ? 'host' : 'viewer',explicitHost:value.hosts.some(host => host.id === person.id),present:value.viewers.some(viewer => viewer.id === person.id)}));
      people.push(...(value.pendingHosts || []).map(person => ({...person,id:'pending-' + person.provider + '-' + person.subject,role:'host',explicitHost:true,present:false,pending:true})));
      renderPeople(roster,people,value,true);
      updateRosterSize();
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
      for (const control of transferGroup?.querySelectorAll('button') || []) control.disabled = $('room-transfer-target').disabled;
      if (transferGroup) controls.segmented(transferGroup);
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
      function permissionTitle(row,key,label) {
        const cell = node('th',row); cell.scope = 'row';
        const title = node('span',cell,label,'permission-name'); title.dataset.permissionTitle = key;
        const caption = node('small',cell,descriptions[key],'permission-caption');
        caption.id = 'permission-description-' + key;
        title.setAttribute('aria-describedby',caption.id);
      }
      function permissionButton(cell,{label,checked,disabled,reason,action}) {
        const {element:control} = controls.permissionButton(document,{label,checked,disabled,reason,action});
        control.classList.add('permission-button');
        cell.append(control); return control;
      }
      for (const [group, keys] of Object.entries({Playback:['playPause','seek','chooseMedia'],Queue:['addQueue','editQueue','autoplay'],'Room management':['roomSettings','closeRoom','deleteRoom','addHosts','kickParticipants','allHosts'],Continuity:['continueWithoutHost']})) {
        const heading = node('th',node('tr',$('room-permissions')),group,'permission-group'); heading.colSpan = 3;
        for (const key of keys) {
          const label = key === 'allHosts' ? 'Everyone is host' : labels[key];
          const row = node('tr',$('room-permissions')); row.dataset.permissionRow = key;
          permissionTitle(row,key,label);
          if (key === 'allHosts') {
            const cell = node('td',row); cell.colSpan = 2;
            const control = permissionButton(cell,{label,checked:!!value.permissions.allHosts,disabled:busy || !value.canSetAllHosts,
              reason:busy ? 'Saving…' : !value.canSetAllHosts ? 'Only the room leader can change this' : '',
              action:()=>void edit({action:'allHosts',enabled:!value.permissions.allHosts})});
            control.id = 'room-all-hosts'; control.setAttribute('aria-describedby','permission-description-allHosts');
            continue;
          }
          for (const role of ['host','viewer']) {
            const cell = node('td',row); cell.dataset.permissionRole = role;
            const restricted = role === 'viewer' && ['roomSettings','closeRoom','deleteRoom','addHosts','kickParticipants'].includes(key);
            const control = permissionButton(cell,{label:(role === 'host' ? 'Host' : 'Participant') + ': ' + label,
              checked:!!value.permissions[role][key],disabled:busy || !value.capabilities.managePermissions || restricted,
              reason:busy ? 'Saving…' : restricted ? 'Room management is restricted to the leader and authorized hosts' : !value.capabilities.managePermissions ? 'Only the room leader or an active administrator can edit permissions' : '',
              action:()=>void edit({action:'permissions',role,permissions:{[key]:!value.permissions[role][key]}})});
            control.dataset.role = role; control.dataset.permission = key;
            control.setAttribute('aria-describedby','permission-description-' + key);
          }
        }
      }
      renderPermissionDensity();
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
    function setSettingsStatus(text, transient = false, error = false) {
      clearTimeout(settingsStatusTimer);
      $('room-settings-status').textContent = text;
      $('room-settings-status').classList.toggle('error',error);
      if (transient) settingsStatusTimer = setTimeout(() => { if ($('room-settings-status').textContent === text) $('room-settings-status').textContent = ''; }, 2500);
    }
    async function edit(change) {
      if (!details || busy) return;
      if (details.draft) {
        if (change.action === 'rename') { if (!change.name.trim()) { setSettingsStatus('Enter a room name',false,true); return; } details.name = change.name.trim(); }
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
      const focusSelector = focused?.dataset.permission ? 'button[data-role="' + focused.dataset.role + '"][data-permission="' + focused.dataset.permission + '"]' : focused?.id ? '#' + CSS.escape(focused.id) : undefined;
      busy = true; renderSettings(); setSettingsStatus('Saving…');
      try {
        const result = await request('/api/watch/rooms/' + id + '/settings',{revision,change});
        if (ticket === generation && dialog.open) {
          if (result.deleted) dialog.close(); else { details = result; if (change.action === 'maxMembers') capacityDraft = undefined; if (change.action === 'rename' && renameDraft === change.name) renameDraft = result.name; }
          setSettingsStatus('Saved', true);
        }
        await changed();
      } catch (error) { if (ticket === generation && dialog.open) setSettingsStatus(error.message,false,true); else fail(error.message); }
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
      requestAnimationFrame(() => {
        const nav = $('room-settings-nav'), selected = nav.querySelector('[aria-current=true]');
        if (selected && matchMedia('(max-width:620px)').matches) {
          nav.scrollTo({left:selected.offsetLeft - nav.offsetLeft - (nav.clientWidth - selected.offsetWidth) / 2,
            behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
        }
        updateNavigationEdges();
      });
    }
    for (const [key, label] of [['general','General'],['people','People'],['permissions','Permissions'],['playback','Playback & queue'],['manage','Manage']]) {
      const control = button($('room-settings-nav'),label,() => selectSection(key)); control.dataset.section = key;
    }
    function updateNavigationEdges() {
      const nav = $('room-settings-nav'), wrap = $('room-settings-navigation');
      wrap.classList.toggle('hidden-before', nav.scrollLeft > 1);
      wrap.classList.toggle('hidden-after', nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1);
    }
    $('room-settings-nav').addEventListener('scroll', updateNavigationEdges, {passive:true});
    new ResizeObserver(updateNavigationEdges).observe($('room-settings-nav'));
    $('room-settings-nav').addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...$('room-settings-nav').children], index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus(); buttons[next].click();
    });
    $('room-member-limit').addEventListener('input', event => { capacityDraft = event.target.value; });
    $('room-settings-section').addEventListener('change',event => selectSection(event.target.value));
    function renderPermissionDensity() {
      const condensed = $('room-permissions-condensed').checked;
      $('room-permission-custom').classList.toggle('condensed',condensed);
      for (const title of $('room-permissions').querySelectorAll('.permission-name')) {
        title.tabIndex = condensed ? 0 : -1;
        title.nextElementSibling.setAttribute('role',condensed ? 'tooltip' : 'note');
      }
    }
    $('room-permissions-condensed').addEventListener('change',renderPermissionDensity);
    $('room-keep-empty').addEventListener('change',async () => {
      const enabled = $('room-keep-empty').checked;
      if (!enabled && !await confirm('When everyone leaves and there is no unfinished video, upcoming queue or auto-queue source, this room and its hosts, permissions and history will be deleted. Allow this?',{destructive:true})) { $('room-keep-empty').checked = true; return; }
      void edit({action:'keepEmpty',enabled});
    });
    $('room-member-limit-save').addEventListener('click',() => void edit({action:'maxMembers',value:Number($('room-member-limit').value)}));
    $('room-rename').addEventListener('input',event => { renameDraft = event.target.value; });
    $('room-people-open').addEventListener('click',() => { if (getState()?.durable) void open(getState().id,'people'); });
    for (const [id,icon] of [['lobby-create','plus'],['lobby-reopen','reopen'],['room-chooser-new','plus'],['room-create-back','reopen']]) $(id).prepend(root.uburoomIcons.icon(document,icon));
    controls.content($('reopen'),{label:'Reopen room',icon:'reopen'});
    let quickBusy = false, quickRoom, quickStatusTimer;
    function setQuickStatus(text, transient = false) {
      clearTimeout(quickStatusTimer);
      $('room-quick-status').textContent = text;
      if (transient) quickStatusTimer = setTimeout(() => { if ($('room-quick-status').textContent === text) $('room-quick-status').textContent = ''; }, 2500);
    }
    const quickControls = [];
    for (const [role,title,icon] of [['viewer','Participants','users'],['host','Hosts','host']]) {
      const heading = node('h4',$('room-quick-switches'),undefined,'room-control-row room-control-heading');
      heading.append(root.uburoomIcons.icon(document,icon)); node('span',heading,title);
      for (const [key,label] of [['playPause','Play/pause'],['seek','Seek'],['addQueue','Add to queue']]) {
        const row = node('div',$('room-quick-switches'),undefined,'room-control-row');
        node('span',row,label,'room-control-name');
        const control = controls.permissionButton(document,{label:title + ': ' + label});
        const input = control.element; input.dataset.quickPermission = key; input.dataset.quickRole = role;
        row.append(input); quickControls.push(control);
        input.addEventListener('click',async () => {
          const state = getState(), enabled = input.getAttribute('aria-pressed') !== 'true';
          if (quickBusy || !state?.capabilities?.managePermissions) { renderQuick(); return; }
          const id = state.id, focused = document.activeElement === input; quickBusy = true; renderQuick(); setQuickStatus('Saving…');
          try {
            const current = await request('/api/watch/rooms/' + id + '/settings');
            if (getState()?.id !== id) return;
            if (!!current.allHosts !== !!state.allHosts) throw new Error('Room mode changed; check the controls again');
            await request('/api/watch/rooms/' + id + '/settings',{revision:current.revision,change:{action:'permissions',role,permissions:{[key]:enabled}}});
            await changed(); if (getState()?.id === id) setQuickStatus('Saved', true);
          } catch (error) { if (getState()?.id === id) setQuickStatus(error.message); }
          finally { quickBusy = false; renderQuick(); if (focused && getState()?.id === id && document.activeElement === document.body) input.focus(); }
        });
      }
    }
    function renderQuick() {
      const state = getState(); if (quickRoom !== state?.id) { quickRoom = state?.id; setQuickStatus(''); }
      $('room-quick-permissions').hidden = !state?.durable;
      const canEdit = !!state?.capabilities?.managePermissions;
      $('room-quick-switches').hidden = false;
      $('room-quick-switches').setAttribute('aria-busy',String(quickBusy));
      for (const control of quickControls) {
        const input = control.element;
        const grants = input.dataset.quickRole === 'host' ? state?.hostPermissions : state?.participantPermissions;
        control.update({checked:!!grants?.[input.dataset.quickPermission],disabled:quickBusy || !canEdit,
          reason:quickBusy ? 'Saving permissions…' : !canEdit ? 'Only the room leader or an active administrator can edit permissions' : ''});
      }
    }
    for (const [id,icon,label] of [['room-settings-open','settings','Room settings'],['room-settings-refresh','refresh','Refresh settings'],['room-settings-dismiss','close','Close settings'],['room-chooser-refresh','refresh','Refresh rooms']]) controls.content($(id),{icon,label,iconOnly:true});
    for (const control of document.querySelectorAll('.room-header-actions button')) control.classList.add('watch-header-control');
    $('room-settings-open').addEventListener('click',() => { if (getState()?.durable) void open(getState().id); });
    $('room-settings-dismiss').addEventListener('click',() => popups.close(dialog));
    dialog.addEventListener('close',() => {
      if (dialog.open) return;
      clearSearch(); generation++; details = undefined;
      if (openedFromSaved) { openedFromSaved = false; void showChooser('saved'); }
    });
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
      } catch (error) { setSettingsStatus(error.message,false,true); }
      finally { busy = false; if (dialog.open) { const notice = $('room-settings-status').textContent; renderSettings(); $('room-settings-status').textContent = notice; } }
    });
    $('room-settings-delete').addEventListener('click',async () => {
      const single=!!details?.singleRoom;
      if(await confirm(single?'Reset this room? Playback, queue and room history will be cleared and permissions reset to server defaults. Accounts and fixed leadership are preserved.':'Permanently delete this room? This cannot be undone.',{destructive:true}))await edit({action:single?'reset':'delete'});
    });
    $('room-clear-video').addEventListener('click',async () => { if (await confirm('Clear this saved video and its position? The room and hosts will be kept.',{destructive:true})) await edit({action:'bookmark.clear'}); });
    $('room-settings-close-live').addEventListener('click',async () => {
      if (!details || busy || !await confirm('Close this room for everyone and save progress? Viewers will be returned to the lobby.')) return;
      const value = details; busy = true; renderSettings();
      try { await request('/api/watch/rooms/' + value.id + '/close',{epoch:value.epoch}); dialog.close(); await changed(); }
      catch (error) { setSettingsStatus(error.message,false,true); }
      finally { busy = false; if (dialog.open) { const notice = $('room-settings-status').textContent; renderSettings(); $('room-settings-status').textContent = notice; } }
    });
    for (const id of ['reopen','lobby-reopen']) $(id).addEventListener('click',() => void showChooser('saved'));
    $('room-saved-previous').addEventListener('click',() => void loadSaved(Math.max(0,offset - 50)));
    $('room-saved-next').addEventListener('click',() => void loadSaved(offset + 50));
    return { loadSaved, open, openDraft, draftOptions, clearDraft() { draftRecord = undefined; }, updateDraftPreset(name) { if (draftRecord) draftRecord.permissions = presetPolicy(name); }, playbackContext() { return dialog.open && details ? {...details,durable:true} : getState(); }, savePlayback, render() {
      $('reopen').hidden = !!getState() || !getMe()?.durableRooms; $('lobby-reopen').hidden = !getMe()?.durableRooms;
      renderQuick();
      renderLivePeople();
      $('room-create-details').hidden = $('room-create-policy').hidden = $('room-create-settings').hidden = !getMe()?.durableRooms;
      $('room-people-open').hidden = !getState()?.durable;
      $('room-settings-open').hidden = !getState()?.durable;
      $('room-visibility').hidden = !getState();
      $('room-save-error').textContent = getState()?.saveError || '';
    } };
  }
  root.uburoomRoomUI = { mount, presetPolicy, presetName, sortPeople };
})(globalThis);
