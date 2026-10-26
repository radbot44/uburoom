/* Apply explicit appearance preferences before rendering; never follow the host theme. */
'use strict';
(() => {
  const root=document.documentElement, key='uburoom.appearance';
  function saved() { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } }
  // Canonical SVG sources arrive with this script once. Recolor page and remote
  // logos locally; keep the browser favicon static during appearance changes.
  const branding=window.uburoomBrandAssets, images=new Map();
  function brandUrl(path) {
    const light=root.dataset.theme==='light';
    const cacheKey=path+'/'+light;
    if(!images.has(cacheKey)) {
      const svg=light ? branding[path].replace(/#F8F7F4/g,'#242329') : branding[path];
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
  function clicked() {
    apply({theme:root.dataset.theme==='dark'?'light':'dark'},true);
  }
  function render() {
    const light=root.dataset.theme==='light';
    const button=document.getElementById('theme-toggle');
    if(button) {
      button.setAttribute('aria-checked',String(light));
      const icon=window.uburoomIcons?.icon(document,light?'sun':'moon');
      if(icon)button.querySelector('.appearance-thumb').replaceChildren(icon);
      button.title=button.ariaLabel='Theme: '+(light?'Light':'Dark')+'. Switch to '+(light?'dark':'light')+'.';
    }
    for(const img of document.querySelectorAll('img.brand:not([data-brand-outgoing])'))updateBrand(img,'/assets/branding/uburoom-wordmark-brand.svg');
    document.querySelector('meta[name=theme-color]')?.setAttribute('content',light?'#F8F6F2':'#101217');
  }
  function apply(value,persist=false) {
    root.dataset.theme=value.theme==='light'?'light':'dark';
    if(persist)try{localStorage.setItem(key,JSON.stringify({theme:root.dataset.theme}));}catch{}
    render();window.dispatchEvent(new Event('uburoom-theme'));
  }
  window.uburoomTheme={brandUrl,updateBrand};
  apply(saved());
  document.addEventListener('DOMContentLoaded',()=>{
    render();
    document.getElementById('theme-toggle')?.addEventListener('click',clicked);
  });
  window.addEventListener('storage',event=>{if(event.key===key || event.key===null){apply(saved());}});
})();
