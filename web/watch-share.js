/* Room sharing and explicit server publication; no playback ownership. */
(function(root) {
  'use strict';
  function mount({request,share,openLink}) {
    const $=id=>document.getElementById(id),dialog=$('room-share-dialog'),dialogs=root.uburoomDialogs;
    let generation=0,target,value,busy=false,editing,draftDirty=false;
    const eventFields=['title','description','zone','start','end'].map(name=>$('room-share-event-'+name));
    dialogs.register(dialog,{busy:()=>busy,dirty:()=>draftDirty});
    dialog.addEventListener('keydown',event=>{if(event.key==='Escape'&&(busy||draftDirty)){event.preventDefault();event.stopPropagation();}});
    const zones=[...new Set(['UTC',Intl.DateTimeFormat().resolvedOptions().timeZone,...(Intl.supportedValuesOf?.('timeZone')||[])])];
    for(const zone of zones){const option=document.createElement('option');option.value=option.textContent=zone;$('room-share-event-zone').append(option);}
    for(const field of eventFields)field.addEventListener('input',()=>{draftDirty=true;});
    function button(label,action,className='quiet') {
      const element=document.createElement('button');element.type='button';element.className=className;element.textContent=label;element.disabled=busy;element.addEventListener('click',action);return element;
    }
    function localTime(at,timeZone) {
      const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).map(part=>[part.type,part.value]));
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
    }
    function editEvent(event) {
      if(busy||!value)return;
      editing=event;draftDirty=false;
      $('room-share-event-title').value=event?.title||value.preview.title==='Nothing selected'&&value.preview.name||value.preview.title;
      $('room-share-event-description').value=event?.description||'';
      const zone=event?.timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone;
      if(!zones.includes(zone)){const option=document.createElement('option');option.value=option.textContent=zone;$('room-share-event-zone').append(option);zones.push(zone);}
      $('room-share-event-zone').value=zone;
      $('room-share-event-start').value=event?localTime(event.start,zone):'';
      $('room-share-event-end').value=event?localTime(event.end,zone):'';
      $('room-share-event-form').hidden=false;$('room-share-event-save').textContent=event?'Save event':'Schedule event';
      $('room-share-event-status').textContent='';render();$('room-share-event-title').focus();
    }
    function discardEvent() {editing=undefined;draftDirty=false;$('room-share-event-form').hidden=true;render();}
    function renderEvents() {
      const scheduling=value?.scheduling,visible=!!scheduling?.configured&&!!scheduling?.canManage;
      $('room-share-events').hidden=!visible;if(!visible)return;
      $('room-share-event-audience').textContent='Events are visible to the Discord server, beyond the publishing channel. Anyone who sees an event can use its room invite; entry and media requirements still apply.';
      $('room-share-event-new').hidden=!$('room-share-event-form').hidden;
      $('room-share-event-list').hidden=!$('room-share-event-form').hidden;
      $('room-share-event-new').disabled=busy||!scheduling.available;
      for(const field of eventFields)field.disabled=busy;
      $('room-share-event-save').disabled=$('room-share-event-discard').disabled=busy;
      $('room-share-event-list').replaceChildren();
      for(const event of scheduling.events) {
        const row=document.createElement('div');row.className='room-share-event';
        const title=document.createElement('strong');title.textContent=event.title;row.append(title);
        const when=document.createElement('p');when.className='hint';
        const format=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short',timeZone:event.timeZone});
        when.textContent=format.format(new Date(event.start))+' – '+format.format(new Date(event.end))+' · '+event.timeZone+' · '+event.statusName;row.append(when);
        const actions=document.createElement('div');actions.className='dialog-actions';
        if(event.url)actions.append(button('View event',()=>void openLink(event.url).catch(error=>{$('room-share-error').textContent=error.message;})));
        if(event.status===1&&event.eventId) {
          const edit=button('Edit',()=>editEvent(event));edit.disabled=busy||!scheduling.available;
          const cancel=button('Cancel event',async()=>{
            const release=dialogs.hold(dialog);
            try{if(await dialogs.confirm('Cancel “'+event.title+'” in Discord?',{destructive:true}))await changeEvent('room.event.cancel',event);}
            finally{release();}
          },'danger-button');cancel.disabled=busy||!scheduling.available;actions.append(edit,cancel);
        }
        row.append(actions);$('room-share-event-list').append(row);
      }
      if(scheduling.error)$('room-share-event-status').textContent=scheduling.error;
    }
    function render() {
      const editorOpen=!$('room-share-event-form').hidden;
      $('room-share-title').textContent=editorOpen?editing?'Edit Discord event':'Schedule Discord event':'Share room';
      $('room-share-invite').hidden=editorOpen;
      $('room-share-close').hidden=editorOpen;
      $('room-share-name').textContent=value?.preview.name || 'Room';
      $('room-share-code').textContent=value?.invite.code || '';
      $('room-share-copy').disabled=$('room-share-personal').disabled=busy||!value;
      renderEvents();
      $('room-share-error').textContent=value?.error||'';
      const publishing=!!value?.configured && !!value?.canManage;
      $('room-share-publication').hidden=!publishing||editorOpen;
      if(!publishing)return;
      const preview=value.preview;
      $('room-share-destination').textContent=value.channelName?'Publish to #'+value.channelName:'Discord publishing';
      $('room-share-preview-name').textContent=preview.name;
      $('room-share-preview-title').textContent=[preview.title,preview.subtitle].filter(Boolean).join(' · ');
      $('room-share-preview-status').textContent=preview.status+' · '+preview.viewers+' viewer'+(preview.viewers===1?'':'s');
      $('room-share-audience').textContent=preview.visibility==='private'?'Anyone who can see this channel can use this room invite. Entry and media requirements still apply.':'People in this channel can use the room invite. Entry and media requirements still apply.';
      $('room-share-publish').hidden=!!value.published||!!value.removing;
      $('room-share-publish').disabled=busy||!value.available||!value.canPublish||!preview.epoch||preview.status==='Closed'||value.uncertain;
      $('room-share-view').hidden=!value.messageUrl;
      $('room-share-view').disabled=busy;
      $('room-share-remove').hidden=!value.hasPost&&!value.published&&!value.uncertain&&!value.removing;
      $('room-share-remove').disabled=busy;
      $('room-share-publication-status').textContent=value.removing?'Removal pending · retry Remove post when Discord is available':value.uncertain?'The post could not be confirmed. Check Discord before retrying.':value.published?'Published · updates automatically':preview.status==='Closed'?'Open this room to publish it.':'';
    }
    async function load(ticket) {
      const next=await request('/api/watch/rooms/'+target+'/share');
      if(ticket!==generation||!dialog.open)return;
      value=next;render();
    }
    async function open(id) {
      if(busy)return;
      const ticket=++generation;target=id;value=undefined;
      discardEvent();$('room-share-events').hidden=true;$('room-share-event-status').textContent='';
      $('room-share-error').textContent='';$('room-share-publication').hidden=true;
      $('room-share-name').textContent='Loading room…';$('room-share-code').textContent='';
      $('room-share-copy').disabled=$('room-share-personal').disabled=true;
      dialogs.open(dialog);
      try {await load(ticket);}catch(error){if(ticket===generation&&dialog.open)$('room-share-error').textContent=error.message;}
    }
    async function change(action) {
      if(busy||!value)return;
      busy=true;const ticket=generation,snapshot=value.preview;render();$('room-share-error').textContent='';
      try {
        const response=await request('/api/watch/rooms/'+target+'/share',{action,epoch:snapshot.epoch,revision:snapshot.revision});
        if(response.status!=='applied')throw new Error(response.message||'Discord could not update the post.');
        await load(ticket);
      }catch(error){if(ticket===generation&&dialog.open){try{await load(ticket);}catch{}value.error=error.message;}}
      finally{busy=false;if(ticket===generation&&dialog.open)render();}
    }
    async function changeEvent(action,event) {
      if(busy||!value)return;
      const ticket=generation;
      const args={action,revision:value.preview.revision,...(event?{eventKey:event.key,eventVersion:event.eventVersion}:{})};
      if(action!=='room.event.cancel')Object.assign(args,{title:$('room-share-event-title').value,description:$('room-share-event-description').value,
        startLocal:$('room-share-event-start').value,endLocal:$('room-share-event-end').value,timeZone:$('room-share-event-zone').value});
      busy=true;render();$('room-share-error').textContent='';
      try {
        const result=await request('/api/watch/rooms/'+target+'/share',args);
        if(result.status!=='applied')throw new Error(result.message||'Discord could not update the event.');
        discardEvent();await load(ticket);$('room-share-event-status').textContent=result.message;
      }catch(error){if(ticket===generation&&dialog.open){try{await load(ticket);}catch{}value.error=error.message;}}
      finally{busy=false;if(ticket===generation&&dialog.open)render();}
    }
    $('room-share-event-new').addEventListener('click',()=>editEvent());
    $('room-share-event-discard').addEventListener('click',discardEvent);
    $('room-share-event-form').addEventListener('submit',event=>{event.preventDefault();void changeEvent(editing?'room.event.edit':'room.event.create',editing);});
    $('room-share-copy').addEventListener('click',()=>{if(value)void share(value.invite,value.preview.name,{copy:true});});
    $('room-share-personal').addEventListener('click',()=>{if(value)void share(value.invite,value.preview.name);});
    $('room-share-publish').addEventListener('click',()=>void change('room.publish'));
    $('room-share-remove').addEventListener('click',()=>void change('room.unpublish'));
    $('room-share-view').addEventListener('click',()=>{if(value?.messageUrl)void openLink(value.messageUrl).catch(error=>{$('room-share-error').textContent=error.message;});});
    $('room-share-close').addEventListener('click',()=>dialogs.close(dialog));
    dialog.addEventListener('close',()=>{generation++;value=undefined;draftDirty=false;});
    return {open};
  }
  root.uburoomShare={mount};
})(globalThis);
