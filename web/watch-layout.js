/* Apply the saved page layout before any watch content is parsed. */
'use strict';
(() => {
  // Same query as web/watch/breakpoints.js.
  const mobile = matchMedia('(max-width: 700px), (pointer: coarse) and (max-height: 700px)').matches;
  const activity = new URLSearchParams(location.search).has('frame_id');
  const supportsPiP =
    'documentPictureInPicture' in window ||
    ('pictureInPictureEnabled' in document &&
      typeof HTMLVideoElement !== 'undefined' &&
      typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function');
  document.body.dataset.layout = mobile ? 'phone' : 'wide';
  document.body.classList.toggle('activity', activity);
  document.body.classList.toggle('no-pip', activity || !supportsPiP);
  try {
    if (!mobile && !activity && localStorage.getItem('uburoom.watchMode') === 'theater')
      document.body.classList.add('theater');
  } catch {}
})();
