import * as uburoomIcons from '../icons.js';
import { $ } from './page.js';
import { store } from './store.js';

/* The ending interstitial that takes over the stage when a video ends: artwork, what plays next, the countdown ring and its actions. */
export function mount(host, deps) {
  let endingTicker = null;
  let endingArtController = null;
  const endingArtUrls = new Map();

  function initEndingStage() {
    const container = $('ending-stage');
    if (!container) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'ending-backdrop';
    backdrop.className = 'ending-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');

    const header = document.createElement('div');
    header.className = 'ending-header';
    header.id = 'ending-header';

    const playWrap = document.createElement('div');
    playWrap.className = 'ending-play-wrap';
    const playBtn = document.createElement('button');
    playBtn.id = 'ending-play';
    playBtn.className = 'ending-center-play';
    playBtn.type = 'button';
    playBtn.setAttribute('aria-label', 'Play');

    const svgNS = 'http://www.w3.org/2000/svg';
    const ring = document.createElementNS(svgNS, 'svg');
    ring.setAttribute('class', 'ending-ring');
    ring.setAttribute('viewBox', '0 0 72 72');
    ring.setAttribute('aria-hidden', 'true');
    const track = document.createElementNS(svgNS, 'circle');
    track.setAttribute('class', 'ending-ring-track');
    track.setAttribute('cx', '36');
    track.setAttribute('cy', '36');
    track.setAttribute('r', '34.25');
    const progress = document.createElementNS(svgNS, 'circle');
    progress.setAttribute('id', 'ending-ring-progress');
    progress.setAttribute('class', 'ending-ring-progress');
    progress.setAttribute('cx', '36');
    progress.setAttribute('cy', '36');
    progress.setAttribute('r', '34.25');
    ring.append(track, progress);

    const playIcon = uburoomIcons.icon(document, 'play');
    playIcon.setAttribute('class', 'ending-play-icon');
    playBtn.append(ring, playIcon);
    playWrap.append(playBtn);

    const status = document.createElement('p');
    status.className = 'ending-status';
    status.id = 'ending-status';
    status.setAttribute('role', 'status');

    const body = document.createElement('div');
    body.className = 'ending-body';

    const kicker = document.createElement('div');
    kicker.id = 'ending-kicker';
    kicker.className = 'ending-kicker';

    const title = document.createElement('h2');
    title.id = 'ending-title';
    title.className = 'ending-title';

    const subtitle = document.createElement('p');
    subtitle.id = 'ending-subtitle';
    subtitle.className = 'ending-subtitle';

    const summary = document.createElement('p');
    summary.id = 'ending-summary';
    summary.className = 'ending-summary';

    const actions = document.createElement('div');
    actions.className = 'ending-actions';

    const startNowBtn = document.createElement('button');
    startNowBtn.id = 'ending-start-now';
    startNowBtn.className = 'primary ending-secondary-primary';
    startNowBtn.type = 'button';
    startNowBtn.append(uburoomIcons.icon(document, 'play'), document.createTextNode('Start now'));

    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'ending-cancel';
    cancelBtn.className = 'quiet';
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';

    const watchAgainBtn = document.createElement('button');
    watchAgainBtn.id = 'ending-watch-again';
    watchAgainBtn.className = 'quiet';
    watchAgainBtn.type = 'button';
    watchAgainBtn.append(uburoomIcons.icon(document, 'refresh'), document.createTextNode('Watch again'));

    const browseBtn = document.createElement('button');
    browseBtn.id = 'ending-browse';
    browseBtn.className = 'quiet';
    browseBtn.type = 'button';
    browseBtn.append(uburoomIcons.icon(document, 'media'), document.createTextNode('Browse media'));
    browseBtn.addEventListener('click', deps.browseMedia);

    actions.append(startNowBtn, cancelBtn, watchAgainBtn, browseBtn);
    body.append(kicker, title, subtitle, summary, actions);

    container.replaceChildren(backdrop, header, playWrap, status, body);

    playBtn.onclick = () => {
      if (!store.room.state?.ending) return;
      const ending = store.room.state.ending;
      const p =
        ending.state === 'countdown' || ending.state === 'upNext'
          ? deps.execute({ action: 'media.next' })
          : ending.state === 'offer' && ending.next
            ? deps.execute({
                action: 'queue.offer.start',
                args: { mediaId: ending.next.mediaId, showId: ending.next.showId },
              })
            : ending.state === 'finished' && ending.completed
              ? deps.execute({
                  action: 'queue.history.replay',
                  args: { entryId: ending.completed.entryId, resume: false },
                })
              : Promise.resolve();
      p.catch(error => deps.fail(error.message));
    };

    startNowBtn.onclick = () => {
      if (!store.room.state?.ending?.next) return;
      deps
        .execute({
          action: 'queue.offer.start',
          args: { mediaId: store.room.state.ending.next.mediaId, showId: store.room.state.ending.next.showId },
        })
        .catch(error => deps.fail(error.message));
    };

    cancelBtn.onclick = () => {
      deps.execute({ action: 'media.autoplay.cancel' }).catch(error => deps.fail(error.message));
    };

    watchAgainBtn.onclick = () => {
      if (!store.room.state?.ending?.completed) return;
      deps
        .execute({
          action: 'queue.history.replay',
          args: { entryId: store.room.state.ending.completed.entryId, resume: false },
        })
        .catch(error => deps.fail(error.message));
    };
  }

  function renderEnding(next) {
    const ending = next.ending;
    if (!ending || next.mediaUrl) {
      if (endingTicker) {
        cancelAnimationFrame(endingTicker);
        endingTicker = null;
      }
      return;
    }

    const artItem = ending.next || ending.completed;
    const artMediaId = artItem?.mediaId;
    const artType = artItem?.type || 'movie';
    const artKey = artMediaId && /^\d{1,20}$/.test(String(artMediaId)) ? artMediaId + ':' + artType : '';
    const backdrop = $('ending-backdrop');
    if (backdrop && backdrop.dataset.artKey !== artKey) {
      backdrop.dataset.artKey = artKey;
      if (!artKey) {
        backdrop.style.backgroundImage = '';
      } else if (endingArtUrls.has(artKey)) {
        backdrop.style.backgroundImage = 'url(' + endingArtUrls.get(artKey) + ')';
      } else {
        backdrop.style.backgroundImage = '';
        endingArtController?.abort();
        const controller = new AbortController();
        endingArtController = controller;
        const params = new URLSearchParams({ item: String(artMediaId), kind: 'poster', type: artType });
        deps
          .fetchArtwork('/api/watch/library/art?' + params, controller.signal)
          .then(blob => {
            if (controller.signal.aborted) return;
            const url = URL.createObjectURL(blob);
            endingArtUrls.set(artKey, url);
            while (endingArtUrls.size > 24) {
              const first = endingArtUrls.keys().next().value;
              URL.revokeObjectURL(endingArtUrls.get(first));
              endingArtUrls.delete(first);
            }
            if (backdrop.dataset.artKey === artKey) {
              backdrop.style.backgroundImage = 'url(' + url + ')';
            }
          })
          .catch(() => {});
      }
    }

    const header = $('ending-header');
    if (header) {
      if (ending.completed && ending.next) {
        header.hidden = false;
        const subtitleStr = ending.completed.subtitle ? ' (' + ending.completed.subtitle + ')' : '';
        header.textContent = 'Last played: ' + ending.completed.title + subtitleStr;
      } else {
        header.hidden = true;
        header.textContent = '';
      }
    }

    const isSecondary = ending.next?.source === 'auto' || ending.next?.source === 'offer';
    const playBtn = $('ending-play');
    if (playBtn) {
      playBtn.hidden = false;
      playBtn.classList.toggle('is-secondary', isSecondary);
      const hasCaps = !!next.capabilities;
      const canPlay =
        !hasCaps ||
        (ending.state === 'offer'
          ? !!next.capabilities.addQueue && !!next.capabilities.playPause
          : !!next.capabilities.playPause || !!next.capabilities.chooseMedia);
      playBtn.disabled = !canPlay || store.room.pending;
      const status = $('ending-status');
      if (status) {
        if (!canPlay) {
          status.textContent =
            ending.state === 'offer'
              ? 'Starting continuation requires permission to add to queue and play.'
              : 'Playing next requires playback permission.';
        } else if (ending.error) {
          status.textContent = ending.error;
        } else {
          status.textContent = '';
        }
      }
    }

    const displayItem = ending.next || ending.completed;
    const title = $('ending-title');
    if (title) title.textContent = displayItem?.title || '';
    const subtitle = $('ending-subtitle');
    if (subtitle) subtitle.textContent = displayItem?.subtitle || '';
    const summary = $('ending-summary');
    if (summary) {
      summary.textContent = ending.next?.summary || '';
      summary.hidden = !ending.next?.summary;
    }

    const kicker = $('ending-kicker');
    if (kicker) {
      kicker.classList.toggle('is-secondary', isSecondary);
      if (ending.state === 'upNext') {
        kicker.textContent = isSecondary ? 'Auto-queue · Up next' : 'Up next';
      } else if (ending.state === 'offer') {
        kicker.textContent = 'Next episode · Auto-queue';
      } else if (ending.state === 'finished') {
        kicker.textContent = 'Just ended';
      }
    }

    const ring = document.querySelector('.ending-ring');
    if (ring) ring.hidden = ending.state !== 'countdown';

    const startNowBtn = $('ending-start-now');
    if (startNowBtn) {
      const canOffer = !!next.capabilities?.addQueue && !!next.capabilities?.playPause;
      startNowBtn.hidden = ending.state !== 'offer' || !canOffer;
    }
    const cancelBtn = $('ending-cancel');
    if (cancelBtn) {
      cancelBtn.hidden = ending.state !== 'countdown' || !next.capabilities?.autoplay;
    }
    const watchAgainBtn = $('ending-watch-again');
    if (watchAgainBtn) {
      const canReplay = !!next.capabilities?.playPause || !!next.capabilities?.chooseMedia;
      watchAgainBtn.hidden = !ending.completed || !canReplay;
    }
    const browseBtn = $('ending-browse');
    if (browseBtn) {
      browseBtn.hidden = !next.canBrowse;
    }

    if (ending.state === 'countdown' && ending.countdown) {
      const updateCountdown = () => {
        if (
          !store.room.state?.ending ||
          store.room.state.ending.state !== 'countdown' ||
          !store.room.state.ending.countdown
        ) {
          endingTicker = null;
          return;
        }
        const now = deps.time.serverNow();
        if (now === undefined) {
          // No usable room clock: keep the last countdown on screen until there is one.
          endingTicker = requestAnimationFrame(updateCountdown);
          return;
        }
        const remaining = Math.max(0, store.room.state.ending.countdown.endsAt - now);
        const fraction = Math.max(0, Math.min(1, remaining / (store.room.state.ending.countdown.durationMs || 10000)));
        const seconds = Math.max(0, Math.ceil(remaining / 1000));
        const kickerEl = $('ending-kicker');
        if (kickerEl) kickerEl.textContent = 'Up next in ' + seconds + 's';
        const progressEl = $('ending-ring-progress');
        if (progressEl) {
          const circumference = 215.199;
          progressEl.style.strokeDashoffset = String(circumference * (1 - fraction));
        }
        endingTicker = requestAnimationFrame(updateCountdown);
      };
      if (!endingTicker) {
        endingTicker = requestAnimationFrame(updateCountdown);
      }
    } else {
      if (endingTicker) {
        cancelAnimationFrame(endingTicker);
        endingTicker = null;
      }
    }
  }
  initEndingStage();
  return { renderEnding };
}
