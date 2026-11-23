import * as uburoom from '../../shared/engine.mjs';
import { uburoomAV1 } from '../watch-av1.js';
import * as uburoomControls from '../watch-controls.js';
import * as uburoomPlayback from '../playback-policy.js';
import * as uburoomPopover from '../watch-popover.js';
import { $ } from './page.js';
import { store } from './store.js';

/* The room as shown: applying each new view of the room, the stage and panels that follow it, viewers who are buffering, invites and room notices. */
export function mount(host, deps) {
  // The viewer's HDR choice in Player settings (web/watch/preferences.js).
  const hdrMode = () => store.preferences.playerPreferences?.hdrMode;
  function renderVisibility() {
    $('empty-hint').hidden = !store.identity.me;
    const inRoom = Boolean(store.room.state || store.identity.directRoomEntry);
    document.body.classList.toggle('outside-room', !inRoom);
    document.body.classList.toggle(
      'idle-player',
      !store.room.state?.mediaId &&
        !(store.identity.directRoomEntry && store.identity.pageBootstrap?.targetRoom?.media),
    );
    $('current-room').hidden = !inRoom;
    $('rooms').hidden = true;
    $('refresh').hidden = true;
    $('room-bar').hidden = !store.identity.me && $('auth-overlay').hidden;
    $('switch-room').textContent = inRoom ? 'Switch room' : 'Choose room';
    $('switch-room').hidden = !!store.identity.config?.singleRoom;
    $('create').hidden = inRoom || !!store.identity.config?.singleRoom || !!store.identity.me?.guestRoomId;
    $('close-room').hidden = !inRoom || !!store.identity.config?.singleRoom;
    if (store.identity.config?.singleRoom || store.identity.me?.guestRoomId)
      for (const id of ['lobby-create', 'lobby-reopen', 'room-chooser-new']) $(id).hidden = true;
    if (store.identity.me?.guestRoomId) $('switch-room').hidden = true;
    if ($('options-title'))
      $('options-title').textContent = store.room.state
        ? store.room.state.roomName || 'Room'
        : store.identity.directRoomEntry && store.identity.pageBootstrap?.targetRoom?.name
          ? store.identity.pageBootstrap.targetRoom.name
          : 'Room';
    $('room-share').hidden = !store.room.state?.invite;
    deps.renderScheduleButton();
    if (store.room.state) {
      if (!$('room-share').firstChild)
        uburoomControls.content($('room-share'), { icon: 'share', label: 'Share room', iconOnly: true });
      $('room-share').setAttribute('aria-label', 'Share room');
      if (!$('room-schedule').firstChild) {
        uburoomControls.content($('room-schedule'), {
          icon: 'calendar-event',
          label: 'Schedule',
        });
        $('room-schedule').setAttribute('aria-label', 'Schedule event');
        $('room-schedule').title = 'Schedule event';
      }
      const viewersCount = store.room.state.viewers + '/' + (store.room.state.maxMembers || 20);
      if ($('room-participants-heading')) $('room-participants-heading').textContent = 'Viewers (' + viewersCount + ')';
      $('room-people-open')?.setAttribute('aria-label', 'Viewers (' + viewersCount + ')');
      if ($('room-people-open')) $('room-people-open').title = store.room.state.durable ? 'Room settings: Viewers' : '';
    } else if ($('room-participants-heading')) {
      $('room-participants-heading').textContent = 'Viewers';
      $('room-people-open')?.setAttribute('aria-label', 'Viewers');
      if ($('room-people-open')) $('room-people-open').title = '';
    }
    deps.roomUI.render();
    renderHumanCheckPrompt();
    deps.queueUI.render(store.room.state?.queueSummary);
    deps.library?.refreshSuggestions?.();
    for (const id of ['options-panel', 'queue-panel', 'library-panel']) $(id).inert = !store.identity.me;
    $('options-panel').hidden = !store.identity.me && $('auth-overlay').hidden;
    if ($('watch-settings')) {
      $('watch-settings').hidden = !store.room.state || !store.room.state.canManage;
      $('watch-settings').inert = !store.room.state;
      $('watch-settings').setAttribute('aria-disabled', String(!store.room.state));
    }
    $('admin-end-room').hidden = true;
    deps.updateSectionTabs();
    checkBufferingViewers();
    if (!store.room.selected || !store.room.state) void deps.clearRichPresence?.();
  }
  function checkBufferingViewers() {
    if (!store.room.state?.mediaUrl || !store.room.state?.canPlayback) {
      for (const id of deps.bufferingViewers.keys()) deps.toasts.dismiss('buffering-' + id);
      deps.bufferingViewers.clear();
      store.room.voluntarilyPausedFor = null;
      return;
    }
    const isPaused = !!store.room.state.pauseAt || store.room.state.state.paused !== false;
    const participants = store.room.state.participants || [];
    const activeIds = new Set();

    for (const person of participants) {
      if (person.id === store.identity.me?.userId) continue;
      activeIds.add(person.id);

      const sessions = person.syncQuality?.sessions || [];
      const isBuffering =
        sessions.some(s => s.current && s.status === 'buffering') || person.syncQuality?.status === 'buffering';

      if (isBuffering && !isPaused) {
        if (!deps.bufferingViewers.has(person.id)) {
          deps.bufferingViewers.set(person.id, deps.time.wall());
        } else {
          const elapsed = deps.time.wall() - deps.bufferingViewers.get(person.id);
          if (elapsed >= 3000 && !deps.suppressedBuffering.has(person.id)) {
            deps.toasts.show('buffering-' + person.id, {
              title: person.name + ' is buffering…',
              hint: 'Playback continues for other viewers.',
              symbol: 'loader-4',
              loading: true,
              action: {
                label: 'Pause to wait',
                run: () => {
                  store.room.voluntarilyPausedFor = person.id;
                  deps.toasts.dismiss('buffering-' + person.id);
                  deps.execute({ action: 'media.pause' }).catch(err => deps.fail(err.message));
                },
              },
              onDismiss: () => {
                deps.suppressedBuffering.add(person.id);
              },
            });
          }
        }
      } else {
        if (deps.bufferingViewers.has(person.id)) {
          deps.bufferingViewers.delete(person.id);
          deps.suppressedBuffering.delete(person.id);
          deps.toasts.dismiss('buffering-' + person.id);

          if (store.room.voluntarilyPausedFor === person.id) {
            store.room.voluntarilyPausedFor = null;
            deps.toasts.show('recovered-' + person.id, {
              title: person.name + ' is ready',
              hint: 'Playback was paused to wait.',
              symbol: 'check',
              duration: 8000,
              action: {
                label: 'Resume playback',
                run: () => {
                  deps.execute({ action: 'media.play' }).catch(err => deps.fail(err.message));
                },
              },
            });
          }
        }
      }
    }

    for (const id of deps.bufferingViewers.keys()) {
      if (!activeIds.has(id)) {
        deps.bufferingViewers.delete(id);
        deps.suppressedBuffering.delete(id);
        deps.toasts.dismiss('buffering-' + id);
        if (store.room.voluntarilyPausedFor === id) store.room.voluntarilyPausedFor = null;
      }
    }
  }
  deps.every(1000, checkBufferingViewers);
  // Shares the room invite: Discord's share link inside an Activity (falling back to
  // its invite dialog), the device share sheet in a browser, else the clipboard.
  async function shareInvite(
    invite = store.room.state?.invite,
    roomName = store.room.state?.roomName || 'Room',
    { copy = false } = {},
  ) {
    if (!invite) return;
    const message = 'Join me in ' + roomName + ' on uburoom';
    if (!copy && deps.activity && store.connection.sdk) {
      try {
        await store.connection.sdk.commands.shareLink({ message, custom_id: invite.code });
        return;
      } catch {
        try {
          await store.connection.sdk.commands.openInviteDialog();
          return;
        } catch {
          /* Fall back to copying below. */
        }
      }
    }
    if (!copy && !deps.activity && navigator.share) {
      try {
        await navigator.share({ title: roomName, text: message, url: invite.url });
        return;
      } catch (error) {
        if (error.name === 'AbortError') return;
      }
    }
    const anchor = $('room-share-copy') || $('room-share-url-input');
    try {
      await navigator.clipboard.writeText(invite.url);
      if (anchor && anchor.offsetParent !== null) {
        uburoomPopover.show(anchor, { text: 'Invite link copied', state: 'success' });
      } else {
        deps.toasts.show('room-invite', {
          title: 'Invite link copied',
          hint: 'Code: ' + invite.code,
          symbol: 'check',
          duration: 4000,
        });
      }
    } catch {
      if (anchor && anchor.offsetParent !== null) {
        uburoomPopover.show(anchor, { text: "Couldn't copy invite", state: 'error' });
      } else {
        deps.toasts.show('room-invite', {
          type: 'error',
          title: "Couldn't copy the invite",
          hint: invite.url,
          symbol: 'copy',
          duration: 12000,
        });
      }
    }
  }
  $('room-share').addEventListener('click', () => void deps.roomShare.open(store.room.selected));
  $('room-schedule').addEventListener('click', () => {
    void deps.roomEvents.open({
      roomId: store.room.selected,
      roomName: store.room.state?.roomName,
      duration: () => store.room.state?.state?.duration,
      onChange: () => deps.lobbyEvents.refresh(),
    });
  });
  let unavailableNotices = new Set();
  function unavailableToasts(items = []) {
    const ids = new Set(items.map(item => 'unavailable:' + item.id));
    for (const id of unavailableNotices) if (!ids.has(id)) deps.toasts.dismiss(id);
    for (const item of items) {
      const id = 'unavailable:' + item.id;
      if (!unavailableNotices.has(id))
        deps.toasts.show(id, {
          type: 'error',
          title: item.title + ' is unavailable.',
          symbol: 'film',
          persistent: true,
        });
    }
    unavailableNotices = ids;
  }
  // A host's report carries the room's viewer spread, at most once a minute while it changes.
  let lastSpreadDiagnostic = { at: 0, samples: undefined };
  function recordSyncSpread(spread) {
    if (
      !spread ||
      spread.samples === lastSpreadDiagnostic.samples ||
      deps.time.wall() - lastSpreadDiagnostic.at < 60000
    )
      return;
    deps.diagnostics.record('sync-spread', {
      spreadP50Ms: spread.p50Ms,
      spreadP95Ms: spread.p95Ms,
      spreadWithin50Percent: spread.within50Percent,
      spreadWithin100Percent: spread.within100Percent,
      spreadSamples: spread.samples,
      spreadPlayers: spread.players,
    });
    lastSpreadDiagnostic = { at: deps.time.wall(), samples: spread.samples };
  }
  function applyState(next, local = false) {
    if (!local) {
      if (next.id !== store.room.selected) return;
      next = deps.fallbackPlayback.receive(next, store.connection.reconnecting);
    }
    deps.time.clearTimeout(store.connection.disconnectGraceTimer);
    store.connection.disconnectGraceTimer = undefined;
    const wasExtended = store.connection.disconnectExtended;
    store.connection.disconnectExtended = false;
    deps.hideDisconnectToast();
    const resumed = store.connection.reconnecting;
    store.connection.reconnecting = false;
    store.player.sync.transition(next);
    deps.diagnostics.state(next);
    recordSyncSpread(next.syncSpread);
    const mediaChanged = store.stream.mediaVersion !== next.mediaVersion || !next.mediaUrl;
    // A new quality of the same converted stream keeps the player and buffer.
    const burned = value => (value?.tracks?.subtitleDelivery === 'burn' ? value.tracks.subtitleId : undefined);
    const seamless =
      !mediaChanged &&
      !!store.stream.av1 &&
      store.stream.mediaSource !== next.mediaUrl &&
      uburoomPlayback.localFormat(next.format) &&
      store.room.state?.format === next.format &&
      !!store.room.state?.fallbackActive === !!next.fallbackActive &&
      store.room.state.tracks?.audioId === next.tracks?.audioId &&
      burned(store.room.state) === burned(next);
    const changed = !seamless && (mediaChanged || store.stream.mediaSource !== next.mediaUrl);
    let released = false;
    if (store.stream.heldStream) {
      const held = store.stream.heldStream.next;
      if (
        next.id === held.id &&
        next.mediaVersion === held.mediaVersion &&
        next.readinessVersion === held.readinessVersion &&
        next.state?.paused === store.room.state?.state?.paused
      ) {
        const replaced = next.mediaUrl !== held.mediaUrl;
        store.stream.heldStream.next = next;
        if (store.room.state) {
          store.room.state = {
            ...next,
            format: store.room.state.format,
            container: store.room.state.container,
            quality: store.room.state.quality,
            videoCodec: store.room.state.videoCodec,
            audioCodec: store.room.state.audioCodec,
            compatible: store.room.state.compatible,
            streamVersion: store.room.state.streamVersion,
            mediaUrl: store.room.state.mediaUrl,
            directHls: store.room.state.directHls,
            directDelivery: store.room.state.directDelivery,
            deliveryInfo: store.room.state.deliveryInfo,
          };
          store.room.receivedAt = deps.time.mono();
        }
        if (replaced) deps.prepareHeldStream(store.stream.heldStream);
        return;
      }
      // Someone seeked, paused or changed the video, so the new stream is needed now.
      deps.dropHeldStream();
      released = true;
    }
    // Only a timeline nobody changed may keep the old stream playing; a pause or seek, or a
    // hold just released for one, applies to the player now.
    if (
      !released &&
      !local &&
      changed &&
      !mediaChanged &&
      next.state?.paused === store.room.state?.state?.paused &&
      deps.canHoldStream(next)
    )
      return void deps.holdStream(next);
    const qualityContextChanged =
      !!store.room.state &&
      (store.room.state.mediaVersion !== next.mediaVersion ||
        store.room.state.streamVersion !== next.streamVersion ||
        store.room.state.id !== next.id ||
        store.room.state.epoch !== next.epoch);
    const preserveChoppiness =
      !!store.room.state &&
      store.room.state.id === next.id &&
      store.room.state.mediaVersion === next.mediaVersion &&
      !!next.mediaUrl;
    if (qualityContextChanged && !changed) {
      deps.resetSyncQuality();
      deps.choppyDetector.interrupt();
      store.player.capabilityProbeVersion++;
      store.player.capabilityProbeKey = undefined;
    }
    if (store.room.seekPendingValue !== undefined && (changed || next.id !== store.room.selected)) {
      store.room.seekPendingValue = undefined;
      store.room.seekPendingUntil = 0;
      store.room.seekPendingToken = (store.room.seekPendingToken || 0) + 1;
    }
    const previousTarget = store.room.state ? deps.expected() : undefined,
      previousRevision = store.room.state?.revision,
      previousReadinessVersion = store.room.state?.readinessVersion;
    if (store.player.trackContext && store.player.trackContext.mediaVersion !== next.mediaVersion) {
      store.player.playerUI.reset();
      $('tracks-dialog').close();
      store.player.trackContext = undefined;
    }
    if (next.canManage && next.mediaId && next.mediaVersion !== deps.videoCheck.media) {
      deps.videoCheck.media = next.mediaVersion;
      deps.videoCheck.report = undefined;
      queueMicrotask(() => void deps.loadVideoCheck());
    }
    if (store.room.state && store.room.state.epoch !== next.epoch) deps.dropVolume();
    store.room.state = next;
    store.room.receivedAt = deps.time.mono();
    if (store.room.selected) deps.syncRoomUrl(store.room.selected, next.slug);
    unavailableToasts(next.unavailableMedia);
    deps.renderProviderNotice(next.providerNotice);
    if (store.player.playerUI.settingsOpen())
      store.player.trackContext = { mediaVersion: next.mediaVersion, streamVersion: next.streamVersion };
    if (seamless) {
      store.stream.mediaSource = next.mediaUrl;
      store.stream.av1.switchStream(next.mediaUrl);
    }
    if (changed) {
      if (!mediaChanged) deps.holdLastFrame();
      deps.clearPlayer('state-change', !mediaChanged, preserveChoppiness);
      store.stream.mediaVersion = next.mediaVersion;
      store.stream.mediaSource = next.mediaUrl;
      if (next.mediaUrl) {
        $('stage').classList.remove('ending-active');
        $('ending-stage').hidden = true;
        $('empty-stage').hidden = true;
        if (next.format === 'youtube-embed') {
          deps.youtube.attach(next);
        } else {
          deps.watchFrames();
          if (
            (next.format === 'file' &&
              uburoomPlayback.needsCompatible(next, type => deps.video.canPlayType(type), undefined, hdrMode())) ||
            (next.format === 'hls' &&
              uburoomPlayback.needsVideoConversion(next, type => deps.video.canPlayType(type), undefined, hdrMode()))
          ) {
            const videoUnsupported = uburoomPlayback.needsVideoConversion(
              next,
              type => deps.video.canPlayType(type),
              undefined,
              hdrMode(),
            );
            const reason =
              next.hdrKind === 'dovi-p5' && videoUnsupported
                ? 'Dolby Vision Profile 5 is not supported directly by this browser.'
                : next.hdr && videoUnsupported && hdrMode() === 'sdr'
                  ? 'SDR chosen in Player settings; converting HDR to SDR.'
                  : next.hdr && videoUnsupported && !uburoomPlayback.supportsHdrDisplay(undefined, hdrMode())
                    ? 'HDR Original requires an HDR display; converting to SDR.'
                    : 'The browser does not support the original codecs.';
            queueMicrotask(() => {
              if (store.room.state === next) void deps.compatibleFallback(reason, !videoUnsupported);
            });
          } else if (uburoomPlayback.localFormat(next.format)) {
            // With no other codec to try, giving up ends playback, so ride out a slow
            // or briefly unavailable source for about 40 seconds instead of 7.
            const alternatives = uburoomPlayback.fallbackCodecs(
              store.identity.config.localFormats || ['av1'],
              new Set([next.format]),
              mime => typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime),
            );
            try {
              store.stream.av1 = new uburoomAV1(
                deps.video,
                next.mediaUrl,
                deps.expected,
                (message, error) => {
                  if (error?.kind === 'grant-expired') {
                    const key = `${next.mediaVersion}:${next.streamVersion}`;
                    if (store.stream.av1GrantRefreshKey !== key) {
                      store.stream.av1GrantRefreshKey = key;
                      store.stream.av1GrantRefreshCount = 0;
                    }
                    if ((store.stream.av1GrantRefreshCount || 0) < 2) {
                      store.stream.av1GrantRefreshCount = (store.stream.av1GrantRefreshCount || 0) + 1;
                      void deps
                        .refreshState()
                        .then(() => {
                          if (
                            store.room.state?.mediaVersion === next.mediaVersion &&
                            store.room.state?.streamVersion === next.streamVersion &&
                            store.room.state?.mediaUrl === next.mediaUrl
                          )
                            return deps.execute({
                              action: 'media.stream.refresh',
                              args: { mediaVersion: next.mediaVersion, streamVersion: next.streamVersion },
                            });
                        })
                        .catch(() => deps.fail(message));
                      return;
                    }
                    deps.fail(message);
                    return;
                  }
                  void deps.compatibleFallback(message);
                },
                alternatives.length ? 3 : 8,
                {
                  cache:
                    store.stream.preparedStream?.url === next.mediaUrl ? store.stream.preparedStream.cache : undefined,
                },
              );
              store.stream.preparedStream = undefined;
            } catch (error) {
              void deps.compatibleFallback('Converted WebM transport unavailable: ' + error.message);
            }
          } else if (next.format === 'hls' && typeof Hls === 'undefined') {
            store.stream.mediaVersion = store.stream.mediaSource = undefined;
            void deps
              .ensureHls()
              .then(() => {
                if (store.room.state === next) applyState(next, true);
              })
              .catch(error => deps.fail(error.message));
          } else if (next.format === 'hls' && Hls.isSupported()) {
            store.player.sync.prepare({ timeline: true });
            const config = deps.hlsClientConfig(
              next,
              store.stream.preparedStream?.url === next.mediaUrl ? store.stream.preparedStream.cache : undefined,
            );
            store.stream.preparedStream = undefined;
            const client = (store.stream.hls = new Hls(config));
            client.on(Hls.Events.ERROR, (_, data) => deps.handleHlsError(client, data));
            client.on(Hls.Events.LEVEL_LOADED, (_, data) => {
              if (store.stream.hls !== client) return;
              const level = client.levels[data.level];
              // Only declared output metadata, never source dimensions or a guessed
              // profile/frame rate. Single media playlists commonly lack these.
              void deps.probePlaybackCapabilities(
                {
                  type: 'media-source',
                  video: {
                    contentType: `video/mp4; codecs="${level?.videoCodec || ''}"`,
                    width: level?.width,
                    height: level?.height,
                    bitrate: level?.bitrate,
                    framerate: level?.frameRate,
                  },
                },
                client,
              );
            });
            // Finish appending the anchor without requesting segment one before
            // the target seek; aborting that speculative load adds recovery noise.
            client.on(Hls.Events.FRAG_LOADED, () => {
              if (store.stream.hls === client && store.player.sync.timelinePending) client.pauseBuffering();
            });
            client.on(Hls.Events.FRAG_BUFFERED, () => deps.handleHlsFragmentBuffered(client));
            client.on(Hls.Events.BUFFER_FLUSHING, (_, data) => {
              if (store.stream.hls === client)
                deps.diagnosticSample('hls-buffer-flushing', { target: data.startOffset, position: data.endOffset });
            });
            client.loadSource(next.mediaUrl);
            client.attachMedia(deps.video);
            if (next.directHls)
              store.stream.directStartupTimer = deps.time.setTimeout(() => {
                if (
                  store.stream.hls === client &&
                  store.room.state?.streamVersion === next.streamVersion &&
                  deps.video.readyState < 2
                )
                  void deps.proxyDirectFile();
              }, 12000);
          } else if (next.directHls)
            queueMicrotask(() => {
              if (store.room.state === next) void deps.proxyDirectFile();
            });
          else if (next.directDelivery) void deps.attachDirectFile(next);
          else {
            deps.video.removeAttribute('crossorigin');
            deps.video.src = next.mediaUrl;
          }
          if (next.format === 'file') void deps.probePlaybackCapabilities({ type: 'file' });
        }
      }
    }
    const nextTarget = deps.expected();
    const sharedSeekRequested =
      !changed &&
      !store.player.sync.timelinePending &&
      ((next.readinessVersion !== undefined &&
        next.readinessVersion !== previousReadinessVersion &&
        !next.readiness?.buffering) ||
        (previousTarget !== undefined && Math.abs(nextTarget - previousTarget) > 1.5));
    if (
      !changed &&
      !sharedSeekRequested &&
      previousRevision !== undefined &&
      previousRevision !== next.revision &&
      previousTarget !== undefined &&
      nextTarget !== undefined &&
      Math.abs(nextTarget - previousTarget) > 0.65
    )
      store.player.sync.sharedSeek();
    if (sharedSeekRequested) {
      deps.choppyDetector.interrupt();
      store.player.sync.sharedSeek();
      if (store.stream.hls && uburoomPlayback.bufferedAhead(deps.video.buffered, nextTarget) <= 0.05) {
        store.stream.hls.startLoad(nextTarget);
      } else if (store.player.sync.preparationUntil && store.stream.hls) {
        store.stream.hls.startLoad(deps.expected());
      } else {
        deps.restartHlsForSeek(deps.expected());
      }
    } else if (wasExtended && !changed && store.stream.hls) {
      store.stream.hls.startLoad(deps.expected());
    }
    deps.captions.update(next);
    queueMicrotask(() => {
      if (store.room.state === next) void deps.restorePlayerSubtitles(next);
    });
    if (next.mediaError) store.player.playbackError = next.mediaError;
    const isIdle = !next.mediaUrl;
    const isEnding = isIdle && !!next.ending;
    $('stage').classList.toggle('ending-active', isEnding);
    $('ending-stage').hidden = !isEnding;
    $('empty-stage').hidden = !isIdle || isEnding;
    if (isEnding) deps.renderEnding(next);
    else deps.renderEnding({ ending: null });
    $('title').textContent = isIdle ? next.roomName || 'Room' : next.title;
    $('details').textContent = isIdle ? '' : next.subtitle;
    $('viewers').textContent = next.viewers + (next.viewers === 1 ? ' viewer' : ' viewers');
    $('viewers').title = (next.roomName ? next.roomName + ' · ' : '') + 'Live controller: ' + next.hostName;
    $('empty-title').textContent = 'Choose something to watch…';
    $('empty-hint').textContent = "...or he'll be watching you.";
    $('empty-browse').hidden = !isIdle || !next.canBrowse;
    $('close-room').hidden = !!store.identity.config?.singleRoom;
    $('timeline').max = next.durationUnknown ? 100 : next.state.duration || 60;
    $('duration').textContent = next.durationUnknown ? '--:--' : deps.clock(next.state.duration);
    const chaptersSelect = $('chapters');
    if (chaptersSelect) {
      const chapters = next.chapters || [];
      chaptersSelect.disabled = !chapters.length;
      const existingOpts = [...chaptersSelect.options];
      for (let i = existingOpts.length - 1; i >= chapters.length; i--) existingOpts[i].remove();
      chapters.forEach((ch, i) => {
        const opt = chaptersSelect.options[i] || document.createElement('option');
        const val = String(ch.startTime);
        if (opt.value !== val) opt.value = val;
        if (opt.textContent !== ch.title) opt.textContent = ch.title;
        const end = ch.endTime || next.state.duration || ch.startTime;
        const caption = deps.clock(ch.startTime) + ' – ' + deps.clock(end);
        if (opt.dataset.caption !== caption) opt.dataset.caption = caption;
        if (!opt.parentNode) chaptersSelect.append(opt);
      });
    }
    $('quality-notice').textContent = next.qualityNotice || '';
    deps.renderMediaInformation(next);
    const maximum = !next.fallbackActive && uburoomPlayback.convertedOriginal(next);
    const maxMbps =
      maximum && next.deliveryInfo?.bitrateCeiling > 0 ? Math.round(next.deliveryInfo.bitrateCeiling / 1000) : null;
    const choices = (next.qualities || uburoom.QUALITIES).map(q =>
      maximum && q.id === 'direct'
        ? { ...q, label: maxMbps ? 'Maximum · ' + maxMbps + ' Mbps' : q.label.replace(/^Original/, 'Maximum') }
        : q,
    );
    $('quality-detail').textContent = next.fallbackActive
      ? 'Using fallback · ' + next.fallbackStream.height + 'p · ' + next.fallbackStream.bitrate + ' Mbps'
      : maximum
        ? 'Converted to ' +
          (next.deliveryInfo.videoCodec || 'another format').toUpperCase() +
          ' at the highest quality available.'
        : '';
    $('quality-detail').hidden = !maximum && !next.fallbackActive;
    const qualitySelect = $('quality');
    if (
      JSON.stringify([...qualitySelect.options].map(o => [o.value, o.textContent])) !==
      JSON.stringify(choices.map(q => [q.id, q.label]))
    ) {
      const previous = qualitySelect.value;
      const existingById = new Map([...qualitySelect.options].map(o => [o.value, o]));
      for (const [id, opt] of existingById) {
        if (!choices.some(q => q.id === id)) opt.remove();
      }
      let cursor = qualitySelect.firstChild;
      for (const q of choices) {
        let option = existingById.get(q.id);
        if (!option) {
          option = document.createElement('option');
          option.value = q.id;
        }
        if (option.textContent !== q.label) option.textContent = q.label;
        if (option !== cursor) qualitySelect.insertBefore(option, cursor);
        cursor = option.nextSibling;
      }
      if (choices.some(q => q.id === previous)) qualitySelect.value = previous;
    }
    if (next.mediaUrl && !store.room.pending && !store.stream.qualityPending && document.activeElement !== $('quality'))
      $('quality').value = uburoom.qualityId(next.quality);
    deps.renderBrowsing();
    document.title = next.title + ' · uburoom';
    renderVisibility();
    deps.renderTransport();
    if (resumed) {
      deps.queueUI.restorePosition();
      deps.diagnostics.record('control-reconnected', {
        connectionId: store.connection.transport?.connectionId,
        connectionAttempt: store.connection.transport?.connectionAttempt,
      });
    }
    store.player.observing = !!next.mediaUrl;
    void deps.syncRichPresence?.();
    void store.player.sync.synchronize();
  }
  function sendHumanCheck(action, args = {}) {
    return deps.execute({ action, args }).catch(error => {
      deps.fail(error.message);
    });
  }
  function askHumanCheck() {
    return sendHumanCheck('check.ask');
  }
  function clearHumanCheck(checkId = store.room.state?.humanCheck?.id) {
    return sendHumanCheck('check.clear', checkId ? { checkId } : {});
  }
  function replyHumanCheck(status, checkId = store.room.state?.humanCheck?.id) {
    return sendHumanCheck('check.reply', checkId ? { status, checkId } : { status });
  }
  /**
   * The ready check's card on the video, in the same place and style as the room's other readiness
   * choices (which take precedence over it). Viewers answer here; people who can play start or cancel here.
   */
  function renderHumanCheckCard(state, check) {
    const readyButton = $('human-check-ready');
    const holdButton = $('human-check-hold');
    const playButton = $('human-check-play');
    const clearButton = $('human-check-clear');
    const selfId = state.actorId || store.identity.me?.account?.id || store.identity.me?.userId;
    const admitted = (Array.isArray(state.participants) ? state.participants : []).filter(
      person => person.present && !person.pending,
    );
    const answers = check.answers && typeof check.answers === 'object' ? check.answers : {};
    const ready = admitted.filter(person => answers[person.id] === 'ready');
    const holding = admitted.filter(person => answers[person.id] === 'hold');
    const waiting = admitted.filter(person => !answers[person.id]);
    const names = people => people.map(person => person.name).join(', ');
    const everyone = admitted.length > 0 && ready.length === admitted.length;
    const myAnswer = selfId ? answers[selfId] : undefined;
    const answering = admitted.some(person => person.id === selfId) && check.askedBy !== selfId;
    const busy = !!store.room.pending;
    $('human-check-prompt-title').textContent = everyone
      ? 'Everyone is ready'
      : check.askedByName
        ? check.askedByName + ' asks: Ready to play?'
        : 'Ready to play?';
    $('human-check-prompt-meta').textContent = [
      ready.length + ' of ' + admitted.length + ' ready',
      holding.length ? names(holding) + (holding.length === 1 ? ' needs' : ' need') + ' a moment' : '',
      waiting.length ? 'Waiting for ' + names(waiting) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    readyButton.hidden = holdButton.hidden = !answering;
    readyButton.disabled = holdButton.disabled = busy;
    readyButton.setAttribute('aria-pressed', String(myAnswer === 'ready'));
    holdButton.setAttribute('aria-pressed', String(myAnswer === 'hold'));
    // Play never starts by itself: whoever can play chooses when, as with the other readiness choices.
    playButton.hidden = !state.canCheck || !state.canPlayback || !state.mediaUrl || !state.state?.paused;
    playButton.disabled = busy || !!state.waitingForReady;
    clearButton.hidden = !state.canCheck;
    clearButton.disabled = busy;
  }
  function renderBreakCard(state, brk) {
    const now = deps.time.serverNow();
    const selfId = state.actorId || store.identity.me?.account?.id || store.identity.me?.userId;
    const admitted = (Array.isArray(state.participants) ? state.participants : []).filter(
      person => person.present && !person.pending,
    );
    const answers = brk.answers && typeof brk.answers === 'object' ? brk.answers : {};
    const ready = admitted.filter(person => answers[person.id] === 'ready');
    const holding = admitted.filter(person => answers[person.id] === 'hold');
    const myAnswer = selfId ? answers[selfId] : undefined;
    const busy = !!store.room.pending;
    const fmt = ms => {
      const s = Math.max(0, Math.ceil(ms / 1000));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    if (brk.resumingAt && brk.resumingAt > now) {
      const secs = Math.max(1, Math.ceil((brk.resumingAt - now) / 1000));
      $('break-card-title').textContent = `Resuming in ${secs}s…`;
    } else if (brk.breakEndsAt > now) {
      $('break-card-title').textContent = `Intermission · back in ${fmt(brk.breakEndsAt - now)}`;
    } else {
      $('break-card-title').textContent = 'Ready to resume?';
    }
    $('break-card-meta').textContent = [
      `${ready.length} of ${admitted.length} ready`,
      holding.length ? `${holding.map(p => p.name).join(', ')} need${holding.length === 1 ? 's' : ''} a moment` : '',
      brk.autoResume ? 'Auto-resume on' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const readyBtn = $('break-ready');
    const holdBtn = $('break-hold');
    const resumeBtn = $('break-resume');
    const extendBtn = $('break-extend');
    const endBtn = $('break-end');
    readyBtn.disabled = holdBtn.disabled = busy;
    readyBtn.setAttribute('aria-pressed', String(myAnswer === 'ready'));
    holdBtn.setAttribute('aria-pressed', String(myAnswer === 'hold'));
    const canManage = !!brk.can?.play || !!state.canCheck;
    resumeBtn.hidden = !canManage || !state.canPlayback || !state.mediaUrl;
    resumeBtn.disabled = busy;
    extendBtn.hidden = !canManage;
    extendBtn.disabled = busy;
    endBtn.hidden = !canManage;
    endBtn.disabled = busy;
  }
  let breakTickTimer;
  function syncBreakTick() {
    const brk = store.room.state?.activities?.find(a => a.kind === 'check' && a.mode === 'break');
    if (brk && !breakTickTimer) {
      breakTickTimer = deps.time.setInterval(() => {
        if (!store.room.state?.activities?.some(a => a.kind === 'check' && a.mode === 'break')) {
          deps.time.clearInterval(breakTickTimer);
          breakTickTimer = undefined;
          return;
        }
        deps.stageCards?.sync(store.room.state);
        deps.activityHub?.sync?.();
      }, 1000);
    } else if (!brk && breakTickTimer) {
      deps.time.clearInterval(breakTickTimer);
      breakTickTimer = undefined;
    }
  }
  /** @type {Map<string, HTMLButtonElement>} */
  const pollTileNodes = new Map();
  let renderedPollId = '';
  function renderPollCard(state, poll) {
    const now = deps.time.serverNow();
    const optionsEl = $('poll-card-options');
    const closeBtn = $('poll-close-btn');
    const clearBtn = $('poll-clear-btn');
    const errorEl = $('poll-card-error');
    const total = Number(poll.totalVotes || 0);
    const fmt = ms => {
      const s = Math.max(0, Math.ceil(ms / 1000));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    $('poll-card-title').textContent = poll.question || 'Poll';
    const metaParts = [];
    if (poll.status === 'open') {
      metaParts.push(poll.closesAt && poll.closesAt > now ? `${fmt(poll.closesAt - now)} left` : 'Open');
    } else if (poll.status === 'tie') {
      metaParts.push('Tie — host chooses winner');
    } else {
      const winner = poll.options.find(o => o.id === poll.winnerOptionId);
      metaParts.push(winner ? `Winner: ${winner.label}` : 'Closed');
      if (poll.tieBrokenBy === 'random') metaParts.push('tie → random');
    }
    metaParts.push(`${total} ${total === 1 ? 'vote' : 'votes'}`);
    $('poll-card-meta').textContent = metaParts.join(' · ');

    if (errorEl) {
      errorEl.textContent = poll.actionError || '';
      errorEl.hidden = !poll.actionError;
    }

    // Preserve tile DOM nodes by option.id for the same poll so live vote updates never steal focus!
    if (renderedPollId !== poll.id) {
      renderedPollId = poll.id;
      pollTileNodes.clear();
      optionsEl.replaceChildren();
    }
    const canManage = !!poll.can?.close;
    const isTiePick = poll.status === 'tie' && canManage;
    for (const opt of poll.options) {
      let tile = pollTileNodes.get(opt.id);
      if (!tile) {
        tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'poll-option-tile';
        tile.dataset.optionId = opt.id;
        const bar = document.createElement('span');
        bar.className = 'poll-option-bar';
        const head = document.createElement('span');
        head.className = 'poll-option-head';
        const label = document.createElement('span');
        label.className = 'poll-option-label';
        const count = document.createElement('span');
        count.className = 'poll-option-count';
        head.append(label, count);
        const votersEl = document.createElement('span');
        votersEl.className = 'poll-option-voters';
        tile.append(bar, head, votersEl);
        tile.addEventListener('click', () => {
          const active = store.room.state?.activities?.find(a => a.kind === 'poll');
          if (!active) return;
          if (active.status === 'open') {
            void deps
              .execute({ action: 'poll.vote', args: { pollId: active.id, optionId: opt.id } })
              .catch(error => deps.fail(error.message));
          } else if (active.status === 'tie' && active.can?.close && active.tiedOptionIds?.includes(opt.id)) {
            void deps
              .execute({ action: 'poll.close', args: { pollId: active.id, winnerOptionId: opt.id } })
              .catch(error => deps.fail(error.message));
          }
        });
        pollTileNodes.set(opt.id, tile);
        optionsEl.append(tile);
      }
      const list = Array.isArray(poll.voters?.[opt.id]) ? poll.voters[opt.id] : [];
      const pct = total > 0 ? Math.round((list.length / total) * 100) : 0;
      const bar = /** @type {HTMLElement} */ (tile.querySelector('.poll-option-bar'));
      const labelEl = tile.querySelector('.poll-option-label');
      const countEl = tile.querySelector('.poll-option-count');
      const votersEl = tile.querySelector('.poll-option-voters');
      bar.style.width = `${pct}%`;
      if (labelEl) {
        const prefix = poll.winnerOptionId === opt.id ? '★ ' : '';
        const text = prefix + opt.label;
        if (labelEl.textContent !== text) labelEl.textContent = text;
      }
      if (countEl) {
        const countText =
          isTiePick && poll.tiedOptionIds?.includes(opt.id) ? `Pick (${list.length})` : `${list.length}`;
        if (countEl.textContent !== countText) countEl.textContent = countText;
      }
      if (votersEl) {
        const namesText = list.map(v => v.name).join(', ');
        if (votersEl.textContent !== namesText) votersEl.textContent = namesText;
      }
      tile.setAttribute('aria-pressed', String(poll.myVote === opt.id));
      tile.disabled =
        !!store.room.pending ||
        poll.status === 'closed' ||
        (poll.status === 'tie' && (!isTiePick || !poll.tiedOptionIds?.includes(opt.id)));
    }
    if (closeBtn) {
      closeBtn.hidden = !canManage || poll.status !== 'open';
      closeBtn.disabled = !!store.room.pending;
    }
    if (clearBtn) {
      clearBtn.hidden = !canManage;
      clearBtn.disabled = !!store.room.pending;
    }
  }
  function openPollDialog(prefill = undefined) {
    const dialog = $('poll-dialog');
    const questionInput = $('poll-question');
    const optionsWrap = $('poll-options-inputs');
    const onCloseGroup = $('poll-on-close-group');
    const playNowNote = $('poll-play-now-note');
    if (!dialog || !questionInput || !optionsWrap) return;

    /** @type {Array<{label: string, media?: any}>} */
    let draftOptions =
      Array.isArray(prefill?.options) && prefill.options.length >= 2
        ? prefill.options.slice(0, 6)
        : [{ label: '' }, { label: '' }];
    let durationSeconds = null;
    let onClose = 'queueNext';
    let tieRule = 'host';

    questionInput.value = prefill?.question || (draftOptions.every(o => o.media) ? 'What should we watch next?' : '');

    const syncOnCloseVisibility = () => {
      const allMedia = draftOptions.length >= 2 && draftOptions.every(o => !!o.media);
      if (onCloseGroup) onCloseGroup.hidden = !allMedia;
      if (playNowNote) playNowNote.hidden = !allMedia || onClose !== 'playNow';
    };

    const renderDraftOptions = () => {
      optionsWrap.replaceChildren();
      draftOptions.forEach((opt, idx) => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.gap = '6px';
        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 100;
        input.required = true;
        input.placeholder = `Option ${idx + 1}`;
        input.value = opt.label || '';
        input.style.flex = '1';
        input.addEventListener('input', () => {
          opt.label = input.value;
        });
        row.append(input);
        if (draftOptions.length > 2) {
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'quiet';
          rm.textContent = '×';
          rm.setAttribute('aria-label', 'Remove option');
          rm.addEventListener('click', () => {
            draftOptions.splice(idx, 1);
            renderDraftOptions();
          });
          row.append(rm);
        }
        optionsWrap.append(row);
      });
      syncOnCloseVisibility();
    };

    const form = $('poll-form');
    const setPressed = (selector, attr, val) => {
      dialog.querySelectorAll(selector).forEach(el => {
        el.setAttribute('aria-pressed', String(el.getAttribute(attr) === String(val ?? '')));
      });
    };
    setPressed('.poll-timer-chip', 'data-seconds', '');
    setPressed('.poll-action-chip', 'data-action', onClose);
    setPressed('.poll-tie-chip', 'data-tie', tieRule);

    dialog.querySelectorAll('.poll-timer-chip').forEach(btn => {
      btn.onclick = () => {
        const raw = btn.getAttribute('data-seconds');
        durationSeconds = raw ? Number(raw) : null;
        setPressed('.poll-timer-chip', 'data-seconds', raw || '');
      };
    });
    dialog.querySelectorAll('.poll-action-chip').forEach(btn => {
      btn.onclick = () => {
        onClose = btn.getAttribute('data-action') || 'queueNext';
        setPressed('.poll-action-chip', 'data-action', onClose);
        syncOnCloseVisibility();
      };
    });
    dialog.querySelectorAll('.poll-tie-chip').forEach(btn => {
      btn.onclick = () => {
        tieRule = btn.getAttribute('data-tie') || 'host';
        setPressed('.poll-tie-chip', 'data-tie', tieRule);
      };
    });
    $('poll-add-option').onclick = () => {
      if (draftOptions.length >= 6) return;
      draftOptions.push({ label: '' });
      renderDraftOptions();
    };
    $('poll-fill-suggestions').onclick = () => {
      const suggestions = (store.room.state?.suggestions || []).slice(0, 6);
      if (suggestions.length < 2) {
        deps.fail('At least 2 suggestions are needed to fill a poll.');
        return;
      }
      draftOptions = suggestions.map(s => ({
        label: s.title || s.item?.title || 'Suggestion',
        media: {
          serverId: s.serverId || s.item?.serverId,
          mediaId: s.mediaId || s.item?.mediaId,
          type: s.type || s.item?.type || 'movie',
          title: s.title || s.item?.title || 'Suggestion',
          suggestionId: s.id,
        },
      }));
      if (!questionInput.value.trim()) questionInput.value = 'Which suggestion should we watch next?';
      renderDraftOptions();
    };
    $('poll-fill-queue').onclick = async () => {
      try {
        const summary = await deps.call('room.queue', { roomId: store.room.selected });
        const pending = (summary?.pending || []).slice(0, 6);
        if (pending.length < 2) {
          deps.fail('At least 2 queued items are needed to fill a poll.');
          return;
        }
        draftOptions = pending.map(item => ({
          label: item.title || 'Queued item',
          media: {
            serverId: item.serverId,
            mediaId: item.mediaId,
            type: item.type || 'movie',
            title: item.title || 'Queued item',
          },
        }));
        if (!questionInput.value.trim()) questionInput.value = 'Which queued video next?';
        renderDraftOptions();
      } catch (error) {
        deps.fail(error.message);
      }
    };
    $('poll-cancel').onclick = () => dialog.close();
    form.onsubmit = event => {
      event.preventDefault();
      const question = questionInput.value.replace(/\s+/g, ' ').trim();
      const options = draftOptions
        .map((opt, idx) => ({
          id: `opt-${idx + 1}`,
          label: (opt.label || '').replace(/\s+/g, ' ').trim(),
          ...(opt.media ? { media: opt.media } : {}),
        }))
        .filter(opt => opt.label);
      if (!question || options.length < 2) return;
      const allMedia = options.every(o => !!o.media);
      dialog.close();
      void deps
        .execute({
          action: 'poll.start',
          args: {
            question,
            options,
            durationSeconds,
            onClose: allMedia ? onClose : 'results',
            tieRule,
          },
        })
        .catch(error => deps.fail(error.message));
    };

    renderDraftOptions();
    if (!dialog.open) dialog.showModal();
    questionInput.focus();
  }
  $('room-poll-btn')?.addEventListener('click', () => openPollDialog());
  $('poll-close-btn')?.addEventListener('click', () => {
    const poll = store.room.state?.activities?.find(a => a.kind === 'poll');
    if (poll) void deps.execute({ action: 'poll.close', args: { pollId: poll.id } }).catch(e => deps.fail(e.message));
  });
  $('poll-clear-btn')?.addEventListener('click', () => {
    void deps.execute({ action: 'poll.clear', args: {} }).catch(e => deps.fail(e.message));
  });
  $('poll-minimize')?.addEventListener('click', () => {
    const poll = store.room.state?.activities?.find(a => a.kind === 'poll');
    if (poll?.id) deps.attention?.dismiss(poll.id);
  });
  if (deps.stageCards) {
    deps.stageCards.register({
      kind: 'poll',
      element: () => $('poll-card'),
      getActivity: state => (Array.isArray(state?.activities) ? state.activities.find(a => a.kind === 'poll') : null),
      render: renderPollCard,
    });
    deps.stageCards.register({
      kind: 'break',
      element: () => $('break-card'),
      getActivity: state =>
        Array.isArray(state?.activities) ? state.activities.find(a => a.kind === 'check' && a.mode === 'break') : null,
      render: renderBreakCard,
    });
    deps.stageCards.register({
      kind: 'check',
      element: () => $('human-check-prompt'),
      getActivity: state =>
        (Array.isArray(state?.activities)
          ? state.activities.find(a => a.kind === 'check' && a.mode !== 'break')
          : null) || (state?.humanCheck && state.humanCheck.mode !== 'break' ? state.humanCheck : null),
      render: renderHumanCheckCard,
    });
    deps.stageCards.register({
      kind: 'announcement',
      element: () => $('stage-announcement-banner'),
      getActivity: state =>
        Array.isArray(state?.activities) ? state.activities.find(a => a.kind === 'announcement') : null,
      render: (_state, ann) => {
        $('stage-announcement-sender').textContent = ann.senderName || 'Host';
        $('stage-announcement-text').textContent = ann.text || '';
        const clearBtn = $('stage-announcement-clear');
        if (clearBtn) clearBtn.hidden = !ann.can?.clear;
      },
    });
  }
  $('stage-announcement-dismiss')?.addEventListener('click', () => {
    const ann = store.room.state?.activities?.find(a => a.kind === 'announcement');
    if (ann?.id) deps.attention?.dismiss(ann.id);
  });
  $('stage-announcement-clear')?.addEventListener('click', () => {
    void deps.execute({ action: 'announce.clear', args: {} }).catch(error => deps.fail(error.message));
  });
  {
    const announceBtn = $('room-announce-btn');
    const dialog = $('announce-dialog');
    const form = $('announce-form');
    const input = $('announce-text');
    const count = $('announce-count');
    const pin = $('announce-pin');
    const cancel = $('announce-cancel');
    if (announceBtn && dialog && form && input) {
      const updateCount = () => {
        if (count) count.textContent = `${input.value.length} / 140`;
      };
      input.addEventListener('input', updateCount);
      announceBtn.addEventListener('click', () => {
        input.value = '';
        if (pin) pin.checked = false;
        updateCount();
        if (!dialog.open) dialog.showModal();
        input.focus();
      });
      cancel?.addEventListener('click', () => dialog.close());
      form.addEventListener('submit', event => {
        event.preventDefault();
        const text = input.value.replace(/\s+/g, ' ').trim();
        if (!text) return;
        dialog.close();
        void deps
          .execute({ action: 'announce.send', args: { text, pinned: !!pin?.checked } })
          .catch(error => deps.fail(error.message));
      });
    }
  }
  function renderHumanCheckPrompt() {
    const state = store.room.state;
    if (deps.stageCards) {
      deps.stageCards.sync(state);
    } else {
      const prompt = $('human-check-prompt');
      const check = state?.humanCheck || null;
      if (!state || !check) {
        prompt.hidden = true;
      } else {
        renderHumanCheckCard(state, check);
        prompt.hidden = false;
      }
    }
    deps.activityHub?.sync?.();
    syncBreakTick();
  }
  $('break-ready')?.addEventListener('click', () => void replyHumanCheck('ready'));
  $('break-hold')?.addEventListener('click', () => void replyHumanCheck('hold'));
  $('break-resume')?.addEventListener('click', () =>
    deps.execute({ action: 'media.play' }).catch(error => deps.fail(error.message)),
  );
  $('break-extend')?.addEventListener('click', () =>
    deps.execute({ action: 'break.extend', args: { minutes: 5 } }).catch(error => deps.fail(error.message)),
  );
  $('break-end')?.addEventListener('click', () =>
    deps.execute({ action: 'break.end', args: {} }).catch(error => deps.fail(error.message)),
  );
  $('break-minimize')?.addEventListener('click', () => {
    const brk = store.room.state?.activities?.find(a => a.kind === 'check' && a.mode === 'break');
    if (brk?.id) deps.attention?.dismiss(brk.id);
  });
  {
    const popover = $('break-popover');
    const autoResumeEl = $('break-auto-resume');
    const customInput = $('break-custom-minutes');
    const startBreak = minutes => {
      if (popover) popover.hidden = true;
      const mins = Math.max(1, Math.min(120, Math.round(Number(minutes) || 5)));
      void deps
        .execute({ action: 'break.start', args: { minutes: mins, autoResume: !!autoResumeEl?.checked } })
        .catch(error => deps.fail(error.message));
    };
    popover?.querySelectorAll('.break-chip').forEach(btn => {
      btn.addEventListener('click', () => startBreak(btn.dataset.minutes));
    });
    $('break-start-custom')?.addEventListener('click', () => startBreak(customInput?.value));
  }
  $('human-check-ready').addEventListener('click', () => void replyHumanCheck('ready'));
  $('human-check-hold').addEventListener('click', () => void replyHumanCheck('hold'));
  $('human-check-play').addEventListener('click', () =>
    deps.execute({ action: 'media.play' }).catch(error => deps.fail(error.message)),
  );
  $('human-check-clear').addEventListener('click', () => void clearHumanCheck());
  $('human-check-minimize')?.addEventListener('click', () => {
    const state = store.room.state;
    const check =
      (Array.isArray(state?.activities) ? state.activities.find(a => a.kind === 'check') : null) || state?.humanCheck;
    if (check?.id) deps.attention?.dismiss(check.id);
  });
  return {
    applyState,
    askHumanCheck,
    clearHumanCheck,
    renderHumanCheckPrompt,
    renderVisibility,
    replyHumanCheck,
    openPollDialog,
    shareInvite,
    unavailableToasts,
  };
}
