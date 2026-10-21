/* Apply explicit appearance preferences before rendering; never follow the host theme. */
'use strict';
(() => {
  const root=document.documentElement, key='uburoom.appearance';
  function saved() { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } }
  // Canonical SVG sources arrive with this script once. Recolor page and remote
  // logos locally; keep the browser favicon static during appearance changes.
  const branding=window.uburoomBrandAssets, images=new Map();
  let sunrise=false, sunriseTimer, lastSunriseClick=0, themeLockUntil=0;
  const clicks={'theme-toggle':[], 'accent-toggle':[]};
  function brandUrl(path) {
    const light=root.dataset.theme==='light', pink=root.dataset.accent==='pink';
    const cacheKey=path+'/'+light+'/'+pink;
    if(!images.has(cacheKey)) {
      const svg=branding[path].replace(/#FF9954|#FF7197|#F8F7F4/g,color=>
        color==='#F8F7F4' ? light?'#242329':color : pink ? color==='#FF9954'?'#FF7197':'#FF9954' : color);
      images.set(cacheKey,'data:image/svg+xml,'+encodeURIComponent(svg));
    }
    return images.get(cacheKey);
  }
  function updateBrand(img,path) {
    const next=brandUrl(path);
    if(img.src===next)return;
    if(img.src.startsWith('data:') && img.complete && img.naturalWidth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      let frame=img.parentElement;
      if(!frame.classList.contains('brand-frame')) {
        frame=document.createElement('span');frame.className='brand-frame';
        img.replaceWith(frame);frame.append(img);
      }
      frame.querySelector('[data-brand-outgoing]')?.remove();
      const previous=img.cloneNode();previous.dataset.brandOutgoing='';previous.alt='';previous.setAttribute('aria-hidden','true');
      frame.append(previous);
      previous.animate([{opacity:1},{opacity:0}],{duration:100,easing:'linear'}).finished.then(()=>previous.remove(),()=>previous.remove());
    }
    img.src=next;
  }
  function burst(button,dud=false) {
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    document.querySelector('.sunrise-burst')?.remove();
    const layer=document.createElement('div');layer.className='sunrise-burst';layer.setAttribute('aria-hidden','true');document.body.append(layer);
    const rect=button.getBoundingClientRect(), x=rect.left+rect.width/2, y=rect.top+rect.height/2;
    const colors=dud?['#D6D9E0','#AAB0BC','#858B99','#5E6370']:['#FF9954','#FF7197','#FFD166','#FF537A'];
    const count=dud?28:80, duration=dud?650:1000;
    if(dud) {
      const aura=document.createElement('div');aura.className='dud-aura';
      aura.style.left=x+'px';aura.style.top=y+'px';
      layer.append(aura);
      aura.animate([
        {transform:'translate(-50%,-50%) scale(.2)',opacity:0},
        {transform:'translate(-50%,-50%) scale(.7)',opacity:.65,offset:.18},
        {transform:'translate(-50%,-50%) scale(1.6)',opacity:0}
      ],{duration,easing:'cubic-bezier(.15,.65,.4,1)',fill:'forwards'});
    } else {
      const aura=document.createElement('div');aura.className='sunrise-aura';
      aura.style.left=x+'px';aura.style.top=y+'px';
      layer.append(aura);
      aura.animate([{transform:'translate(-50%,-50%) scale(.1)',opacity:0},
        {transform:'translate(-50%,-50%) scale(.5)',opacity:.95,offset:.15},
        {transform:'translate(-50%,-50%) scale(2.8)',opacity:.5,offset:.65},
        {transform:'translate(-50%,-50%) scale(4.2)',opacity:0}],{duration,easing:'cubic-bezier(.15,.65,.4,1)',fill:'forwards'});
    }
    for(let i=0;i<count;i++) {
      const particle=document.createElement('span'), angle=Math.random()*Math.PI*2, distance=dud?35+Math.random()*65:90+Math.random()*300;
      const dx=Math.cos(angle)*distance, dy=Math.sin(angle)*distance;
      particle.style.left=x+'px';particle.style.top=y+'px';particle.style.background=colors[i%colors.length];
      particle.style.width=particle.style.height=(dud?5+Math.random()*5:4+Math.random()*9)+'px';layer.append(particle);
      particle.animate([{transform:'translate(-50%,-50%) scale(.2)',opacity:1},
        {transform:`translate(${dx*.6}px,${dy*.6}px) scale(1)`,opacity:1,offset:.3},
        {transform:`translate(${dx}px,${dy+(dud?75:150)}px) rotate(${i*37}deg) scale(.1)`,opacity:0}],{duration,easing:'cubic-bezier(.15,.65,.4,1)',fill:'forwards'});
    }
    const animation=button.animate(dud?[{transform:'rotate(0deg)'},{transform:'rotate(-10deg)'},{transform:'rotate(8deg)'},{transform:'rotate(-4deg)'},{transform:'rotate(0deg)'}]:[{transform:'scale(1)'},{transform:'scale(1.35)'},{transform:'scale(1)'}],{duration});
    animation.finished.then(()=>layer.remove(),()=>layer.remove());
  }
  function stopSunrise() {
    clearTimeout(sunriseTimer);sunrise=false;delete root.dataset.sunrise;
    for(const id of Object.keys(clicks))clicks[id]=[];
  }
  function cycleAccent() {
    apply({theme:root.dataset.theme,accent:root.dataset.accent==='orange'?'pink':'orange'});
    // Each 150 ms leg is a 100 ms fade followed by a 50 ms hold.
    sunriseTimer=setTimeout(cycleAccent,150);
  }
  function clicked(id) {
    const now=performance.now();
    if(id==='theme-toggle' && now<themeLockUntil)return;
    if(id==='accent-toggle' && sunrise) {
      // Let the activation clicking finish; a separate, slower click exits.
      const rapid=now-lastSunriseClick<250;lastSunriseClick=now;
      if(rapid)return;
      stopSunrise();apply({theme:root.dataset.theme,accent:'orange'},true);return;
    }
    clicks[id]=clicks[id].filter(time=>now-time<=5000);clicks[id].push(now);
    apply({theme:id==='theme-toggle'?(root.dataset.theme==='dark'?'light':'dark'):root.dataset.theme,
      accent:id==='accent-toggle'?(root.dataset.accent==='orange'?'pink':'orange'):root.dataset.accent},true);
    if(clicks[id].length<20)return;
    clicks[id]=[];
    if(id==='theme-toggle') {
      themeLockUntil=now+5000;
      apply({theme:'dark',accent:root.dataset.accent},true);
      const button=document.getElementById(id);
      if(button?.classList) {
        button.classList.add('theme-locked');
        button.setAttribute('aria-disabled','true');
        setTimeout(()=>{
          button.classList.remove('theme-locked');
          button.removeAttribute('aria-disabled');
        },5000);
      }
      burst(button,true);
      return;
    }
    burst(document.getElementById(id),false);
    sunrise=true;lastSunriseClick=now;root.dataset.sunrise='true';render();sunriseTimer=setTimeout(cycleAccent,150);
  }
  function render() {
    const light=root.dataset.theme==='light', pink=root.dataset.accent==='pink';
    for(const [id,label,pressed,next] of [['theme-toggle',light?'Light':'Dark',light,light?'dark':'light'],['accent-toggle',pink?'Pink':'Orange',pink,pink?'orange':'pink']]) {
      const button=document.getElementById(id); if(!button)continue;
      button.setAttribute('aria-checked',String(pressed));
      const icon=id==='theme-toggle' && window.uburoomIcons?.icon(document,light?'sun':'moon');
      if(icon)button.querySelector('.appearance-thumb').replaceChildren(icon);
      button.title=button.ariaLabel=(id==='theme-toggle'?'Theme: ':'Accent: ')+label+'. Switch to '+next+'.';
      if(id==='accent-toggle' && sunrise)button.title=button.ariaLabel='Sunrise Mode. Pause rapid clicking, then click to stop and return to orange.';
      if(id==='theme-toggle' && performance.now()<themeLockUntil)button.title=button.ariaLabel='Theme locked to Dark.';
    }
    for(const img of document.querySelectorAll('img.brand:not([data-brand-outgoing])'))updateBrand(img,'/assets/branding/uburoom-wordmark-brand.svg');
    document.querySelector('meta[name=theme-color]')?.setAttribute('content',light?'#F8F6F2':'#101217');
  }
  function apply(value,persist=false) {
    root.dataset.theme=value.theme==='light'?'light':'dark';
    root.dataset.accent=value.accent==='pink'?'pink':'orange';
    if(persist)try{localStorage.setItem(key,JSON.stringify({theme:root.dataset.theme,accent:root.dataset.accent}));}catch{}
    render();window.dispatchEvent(new Event('uburoom-theme'));
  }
  window.uburoomTheme={brandUrl,updateBrand};
  apply(saved());
  document.addEventListener('DOMContentLoaded',()=>{
    render();
    for(const id of ['theme-toggle','accent-toggle'])document.getElementById(id)?.addEventListener('click',()=>clicked(id));
  });
  window.addEventListener('storage',event=>{if(event.key===key || event.key===null){themeLockUntil=0;const b=document.getElementById('theme-toggle');b?.classList?.remove('theme-locked');b?.removeAttribute?.('aria-disabled');stopSunrise();apply(saved());}});
})();
