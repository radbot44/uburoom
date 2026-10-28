/* Apply the saved page layout before any watch content is parsed. */
'use strict';
(() => {
  const mobile = innerWidth <= 700 || matchMedia('(pointer:coarse) and (max-height:700px)').matches;
  document.body.classList.toggle('mobile-player', mobile);
  try {
    if (!mobile && !new URLSearchParams(location.search).has('frame_id') && localStorage.getItem('uburoom.watchMode') === 'theater') document.body.classList.add('theater');
  } catch {}
})();
