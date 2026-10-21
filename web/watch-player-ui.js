/* Player menus and pointer interaction; playback still uses the shared command engine. */
(function (global) {
  'use strict';
  function trackLabel(track) {
    let language=['und','unknown'].includes(track.languageName?.toLowerCase())?undefined:track.languageName;
    const code=language && /^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(language)?language:!language?track.language:undefined;
    if (code && !['und','unknown'].includes(code)) {
      try { language=new Intl.DisplayNames(['en'],{type:'language'}).of(code); } catch {}
    }
    const channels=track.channels===1?'Mono':track.channels===2?'Stereo':track.channels===6?'5.1':track.channels===8?'7.1':track.channels?track.channels+' ch':'';
    const codec=/^pcm/.test(track.codec || '')?'PCM':track.codec?.toUpperCase();
    return [language || 'Unknown',codec,channels,track.forced && 'Forced',track.sdh && 'SDH',track.commentary && 'Commentary',track.description && 'Audio description',!track.available && 'Unavailable'].filter(Boolean).join(' · ');
  }
  function mount({getState,execute,fail,beforeSettings,afterSettings,changeTrack,captions}) {
    const $ = id => document.getElementById(id), stage=$('stage'), cog=$('tracks-open'), dialog=$('tracks-dialog');
    const mobile=()=>document.body.classList.contains('mobile-player');
    const menu=document.createElement('div'); menu.id='player-settings-menu'; menu.className='player-settings-menu'; menu.popover='manual'; menu.setAttribute('role','menu'); menu.setAttribute('aria-label','Player settings'); stage.append(menu);
    const submenu=document.createElement('div'); submenu.id='player-settings-choices'; submenu.className='settings-submenu'; submenu.setAttribute('role','menu'); submenu.hidden=true; menu.append(submenu);
    const badge=document.createElement('span'); badge.id='quality-badge'; badge.setAttribute('aria-hidden','true'); cog.append(badge);
    const choices=[['quality','Quality'],['audio-track','Audio track'],['subtitle-track','Subtitle track']];
    const rows=[]; let opened=false, activeChoice, choiceSignature, chromeTimer, tapTimer, feedbackTimer, press, taps, lastSubtitle, touching=false;
    function layoutCaptions() {
      const transport=stage.querySelector('.transport'), font=Math.max(14,Math.min(innerWidth*.024,32));
      captions.layout(getComputedStyle(transport).pointerEvents!=='none',Math.ceil(transport.offsetHeight/(font*1.2))+1);
    }
    const captionLayoutObserver=new ResizeObserver(layoutCaptions); captionLayoutObserver.observe(stage.querySelector('.transport'));
    for(const event of ['pointerenter','pointerleave','focusin','focusout'])stage.addEventListener(event,()=>requestAnimationFrame(layoutCaptions));
    function button(parent,label) { const b=document.createElement('button'); b.type='button'; b.textContent=label; parent.append(b); return b; }
    for(const [id,label] of choices) {
      const row=button(menu,label); row.id='settings-'+id; row.setAttribute('role','menuitem'); row.setAttribute('aria-haspopup','menu'); row.setAttribute('aria-expanded','false'); row.setAttribute('aria-controls',submenu.id);
      const value=document.createElement('span'); value.className='settings-value'; row.append(value,uburoomIcons.icon(document,'left')); row.onclick=()=>openChoices(id); rows.push({id,row,value});
    }
    const more=button(menu,'More settings'); more.id='settings-more'; more.setAttribute('role','menuitem'); more.setAttribute('aria-haspopup','dialog'); more.setAttribute('aria-controls',dialog.id); more.append(uburoomIcons.icon(document,'settings')); more.onclick=openDialog;
    // Keep the submenu last in reading order, after the four main choices.
    menu.append(submenu);
    function placeMenu() {
      if(!opened)return;
      const anchor=cog.getBoundingClientRect(), width=menu.offsetWidth;
      const left=Math.max(8,Math.min(innerWidth-width-8,anchor.right-width));
      menu.style.left=left+'px'; menu.style.top=Math.max(8,anchor.top-menu.offsetHeight-8)+'px';
      if(!submenu.hidden) {
        const box=menu.getBoundingClientRect();
        submenu.style.left=Math.max(8,box.left-submenu.offsetWidth-8)+'px';
        submenu.style.top=Math.max(8,Math.min(innerHeight-submenu.offsetHeight-8,box.bottom-submenu.offsetHeight))+'px';
      }
    }
    function closeSettings(focus=false) {
      if(opened)menu.hidePopover(); opened=false; submenu.hidden=true; activeChoice=undefined; choiceSignature=undefined;
      rows.forEach(({row})=>row.setAttribute('aria-expanded','false'));
      cog.setAttribute('aria-expanded','false'); stage.classList.remove('settings-open');
      if(!dialog.open)afterSettings();
      if(focus)cog.focus();
      layoutCaptions();
    }
    function openDialog() {
      closeSettings(); beforeSettings(); global.uburoomDialogs.open(dialog,cog); stage.classList.add('settings-open'); cog.setAttribute('aria-expanded','true');
      $('quality').focus(); showChrome();
    }
    function openSettings() {
      if(mobile())return openDialog();
      if(opened)return closeSettings(true);
      beforeSettings(); opened=true; menu.showPopover(); stage.classList.add('settings-open'); cog.setAttribute('aria-expanded','true'); render(); placeMenu(); menu.querySelector('button:not(:disabled)')?.focus(); showChrome();
    }
    function openChoices(id) {
      activeChoice=id; choiceSignature=undefined; submenu.hidden=false;
      submenu.setAttribute('aria-label',choices.find(choice=>choice[0]===id)[1]);
      rows.forEach(({id:other,row})=>row.setAttribute('aria-expanded',String(other===id)));
      renderChoices(); placeMenu(); submenu.querySelector('[aria-checked=true]:not(:disabled),button:not(:disabled)')?.focus();
    }
    function renderChoices() {
      if(!activeChoice)return;
      const select=$(activeChoice), tracks=getState()?.tracks, audio=activeChoice==='audio-track';
      const trackRows=activeChoice==='quality'?[]:audio?tracks?.audio || []:tracks?.subtitles || [];
      const resolved=audio?tracks?.audioId:tracks?.subtitleId;
      const signature=JSON.stringify([select.value,select.disabled,resolved,trackRows,[...select.options].map(o=>[o.value,o.textContent,o.disabled])]);
      if(signature===choiceSignature)return; choiceSignature=signature;
      const focused=submenu.contains(document.activeElement), previous=document.activeElement?.dataset.value;
      submenu.replaceChildren();
      for(const option of select.options) {
        const track=trackRows.find(row=>row.id===option.value);
        const b=button(submenu,track?trackLabel(track):option.textContent); b.dataset.value=option.value; b.disabled=select.disabled||option.disabled;
        if (track?.title) { const caption=document.createElement('span'); caption.className='settings-caption'; caption.textContent=track.title; b.append(caption); }
        if (select.value==='auto' && option.value===resolved) {
          const marker=document.createElement('span'); marker.className='settings-auto'; marker.textContent='Used by Automatic'; b.append(marker);
        }
        if (option.value==='auto' && activeChoice==='subtitle-track' && !resolved) {
          const caption=document.createElement('span'); caption.className='settings-caption'; caption.textContent='Currently Off'; b.append(caption);
        }
        b.setAttribute('role','menuitemradio'); b.setAttribute('aria-checked',String(option.value===select.value));
        b.onclick=()=>{select.value=option.value; select.dispatchEvent(new Event('change',{bubbles:true}));};
        if(focused&&option.value===previous)b.focus();
      }
    }
    function render() {
      const state=getState(), tracks=state?.tracks;
      cog.setAttribute('aria-haspopup',mobile()?'dialog':'menu'); cog.setAttribute('aria-controls',mobile()?dialog.id:menu.id);
      badge.textContent=state?.quality==='direct'?'ORIG':state?.quality?.startsWith('1080p')?'HD':'';
      badge.hidden=!badge.textContent;
      const enabled=!!tracks?.subtitleId, available=tracks?.subtitles.some(t=>t.available);
      const cc=$('captions-toggle'); cc.disabled=!available||$('subtitle-track').disabled;
      cc.setAttribute('aria-pressed',String(enabled)); cc.title=cc.ariaLabel=enabled?'Disable subtitles':'Enable subtitles';
      const symbol='captions';
      if(cc.dataset.symbol!==symbol){cc.replaceChildren(uburoomIcons.icon(document,symbol));cc.dataset.symbol=symbol;}
      if(enabled)lastSubtitle={media:state.mediaVersion,id:tracks.subtitleId};
      for(const {id,row,value} of rows) {
        const select=$(id), audio=id==='audio-track';
        const track=id==='quality'?undefined:(audio?tracks?.audio:tracks?.subtitles)?.find(track=>track.id===(audio?tracks?.audioId:tracks?.subtitleId));
        row.disabled=select.disabled;
        value.textContent=id==='quality'?select.selectedOptions[0]?.textContent || 'Unavailable':track?trackLabel(track):tracks && !audio?'Off':'Unavailable';
        if (track?.title) { const caption=document.createElement('span'); caption.className='settings-caption'; caption.textContent=track.title; value.append(caption); }
        value.title=value.textContent;
      }
      if(opened){renderChoices(); placeMenu();}
      layoutCaptions();
    }
    $('captions-toggle').onclick=()=>{
      const state=getState(), tracks=state?.tracks; if(!tracks)return;
      const available=tracks.subtitles.filter(t=>t.available);
      const previous=lastSubtitle?.media===state.mediaVersion&&available.find(t=>t.id===lastSubtitle.id);
      const track=previous||available.find(t=>t.selected)||available.find(t=>t.default)||available[0];
      if(!track)return;
      void changeTrack({subtitleId:tracks.subtitleId?'off':track.id},{mediaVersion:state.mediaVersion,streamVersion:state.streamVersion});
    };
    cog.onclick=openSettings;
    $('tracks-close').onclick=()=>global.uburoomDialogs.close(dialog);
    dialog.addEventListener('close',()=>{stage.classList.remove('settings-open');cog.setAttribute('aria-expanded','false');afterSettings();cog.focus();showChrome();});
    document.addEventListener('pointerdown',event=>{if(opened&&!menu.contains(event.target)&&!cog.contains(event.target))closeSettings();});
    menu.addEventListener('focusout',event=>{if(opened&&event.relatedTarget&&!menu.contains(event.relatedTarget)&&event.relatedTarget!==cog)closeSettings();});
    document.addEventListener('focusin',event=>{if(opened&&!menu.contains(event.target)&&event.target!==cog)closeSettings();});
    menu.addEventListener('keydown',event=>{
      const group=submenu.contains(event.target)?submenu:menu;
      const buttons=[...group.children].filter(n=>n.tagName==='BUTTON'&&!n.disabled), index=buttons.indexOf(document.activeElement);
      if(['ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
        event.preventDefault(); const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length; buttons[next]?.focus();
      } else if((event.key==='ArrowRight'||event.key==='Escape')&&!submenu.hidden) {
        event.preventDefault(); event.stopPropagation(); submenu.hidden=true; rows.find(r=>r.id===activeChoice)?.row.focus(); activeChoice=undefined; rows.forEach(({row})=>row.setAttribute('aria-expanded','false'));
      } else if(event.key==='ArrowLeft'&&group===menu) {event.preventDefault();rows.find(r=>r.row===document.activeElement)?.row.click();}
    });
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&opened){event.preventDefault();event.stopImmediatePropagation(); if(!submenu.hidden){submenu.hidden=true;rows.find(r=>r.id===activeChoice)?.row.focus();activeChoice=undefined;rows.forEach(({row})=>row.setAttribute('aria-expanded','false'));}else closeSettings(true);}
      if(event.key==='Tab')stage.classList.remove('touch-controls');
    },true);
    function showChrome() {
      clearTimeout(chromeTimer); stage.classList.add('controls-visible');
      layoutCaptions();
      chromeTimer=setTimeout(()=>{
        if(touching||opened||dialog.open||stage.classList.contains('drawer-open')||stage.classList.contains('remote-open'))return showChrome();
        stage.classList.remove('controls-visible');
        layoutCaptions();
      },2500);
    }
    function finishTaps() {
      clearTimeout(tapTimer); const sequence=taps; taps=undefined;
      const state=getState();
      if(!sequence||sequence.count<2||!state?.canPlayback||state.id!==sequence.room||state.epoch!==sequence.epoch||state.mediaVersion!==sequence.media)return;
      void execute({action:'media.seek.relative',args:{seconds:sequence.side*15*(sequence.count-1)}}).catch(error=>fail(error.message));
    }
    stage.addEventListener('pointerdown',event=>{
      if(event.pointerType==='mouse'||!event.isPrimary)return;
      touching=true;
      stage.classList.add('touch-controls'); showChrome();
      if(event.target===$('video')||event.target===stage)press={x:event.clientX,y:event.clientY,id:event.pointerId};
    });
    stage.addEventListener('pointercancel',()=>{press=undefined;touching=false;});
    stage.addEventListener('pointerup',event=>{
      touching=false;
      if(!press||press.id!==event.pointerId)return;
      const start=press; press=undefined;
      if(Math.hypot(event.clientX-start.x,event.clientY-start.y)>12)return;
      showChrome(); const state=getState(); if(!state?.mediaUrl||!state.canPlayback)return;
      const rect=stage.getBoundingClientRect(), x=(event.clientX-rect.left)/rect.width, side=x<.35?-1:x>.65?1:0;
      if(!side)return;
      if(taps&&taps.side!==side)finishTaps();
      if(!taps)taps={side,count:0,room:state.id,epoch:state.epoch,media:state.mediaVersion};
      taps.count++; clearTimeout(tapTimer); tapTimer=setTimeout(finishTaps,400);
      if(taps.count>1) {
        const feedback=$('seek-feedback'); feedback.textContent=(side<0?'−':'+')+(taps.count-1)*15+' seconds'; feedback.dataset.side=side<0?'left':'right';feedback.hidden=false;
        clearTimeout(feedbackTimer); feedbackTimer=setTimeout(()=>{feedback.hidden=true;},900);
      }
    });
    const reset=()=>{clearTimeout(tapTimer);taps=press=undefined;touching=false;closeSettings();if(dialog.open)dialog.close();};
    window.addEventListener('resize',()=>{if(opened&&mobile())closeSettings();else placeMenu();});
    document.addEventListener('fullscreenchange',()=>{if(opened)closeSettings();});
    return {render,closeSettings,reset,settingsOpen:()=>opened||dialog.open,showChrome};
  }
  global.uburoomPlayerUI={mount,trackLabel};
  if(typeof module==='object')module.exports=global.uburoomPlayerUI;
})(globalThis);
