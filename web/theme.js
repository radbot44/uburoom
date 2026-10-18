/* Apply explicit appearance preferences before rendering; never follow the host theme. */
'use strict';
(() => {
  const root=document.documentElement, key='uburoom.appearance';
  function saved() { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } }
  function brandUrl(path) { return path+'?'+new URLSearchParams({theme:root.dataset.theme,accent:root.dataset.accent}); }
  function render() {
    const light=root.dataset.theme==='light', pink=root.dataset.accent==='pink';
    for(const [id,label,pressed,next] of [['theme-toggle',light?'Light':'Dark',light,light?'dark':'light'],['accent-toggle',pink?'Pink':'Orange',pink,pink?'orange':'pink']]) {
      const button=document.getElementById(id); if(!button)continue;
      button.setAttribute('aria-checked',String(pressed));
      const icon=id==='theme-toggle' && window.uburoomUI?.icon(document,light?'sun':'moon');
      if(icon)button.querySelector('.appearance-thumb').replaceChildren(icon);
      button.title=button.ariaLabel=(id==='theme-toggle'?'Theme: ':'Accent: ')+label+'. Switch to '+next+'.';
    }
    for(const img of document.querySelectorAll('img.brand'))img.src=brandUrl('/assets/branding/uburoom-wordmark-brand.svg');
    for(const link of document.querySelectorAll('link[rel=icon][type="image/svg+xml"]'))link.href=brandUrl('/favicon.svg');
    document.querySelector('meta[name=theme-color]')?.setAttribute('content',light?'#F8F6F2':'#101217');
  }
  function apply(value,persist=false) {
    root.dataset.theme=value.theme==='light'?'light':'dark';
    root.dataset.accent=value.accent==='pink'?'pink':'orange';
    if(persist)try{localStorage.setItem(key,JSON.stringify({theme:root.dataset.theme,accent:root.dataset.accent}));}catch{}
    render();window.dispatchEvent(new Event('uburoom-theme'));
  }
  window.uburoomTheme={brandUrl};
  apply(saved());
  document.addEventListener('DOMContentLoaded',()=>{
    render();
    document.getElementById('theme-toggle')?.addEventListener('click',()=>apply({theme:root.dataset.theme==='dark'?'light':'dark',accent:root.dataset.accent},true));
    document.getElementById('accent-toggle')?.addEventListener('click',()=>apply({theme:root.dataset.theme,accent:root.dataset.accent==='orange'?'pink':'orange'},true));
  });
  window.addEventListener('storage',event=>{if(event.key===key || event.key===null)apply(saved());});
})();
