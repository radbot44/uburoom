/* Room sharing and explicit server publication; no playback ownership. */
(function (root) {
  'use strict';
  function mount({ request, share, openLink }) {
    const $ = id => document.getElementById(id),
      dialog = $('room-share-dialog'),
      dialogs = root.uburoomDialogs;
    let generation = 0,
      target,
      value,
      busy = false,
      refreshTimer;

    const titleEl = $('room-share-title');
    const dismissBtn = $('room-share-dismiss');
    const urlInput = $('room-share-url-input');
    const copyBtn = $('room-share-copy');
    const personalBtn = $('room-share-personal');

    const pubSection = $('room-share-publication');
    const destinationEl = $('room-share-destination');
    const channelBadge = $('room-share-channel-badge');
    const previewName = $('room-share-preview-name');
    const previewTitle = $('room-share-preview-title');
    const previewDot = $('room-share-preview-dot');
    const previewStatus = $('room-share-preview-status');
    const pubStatus = $('room-share-publication-status');
    const publishedActions = $('room-share-published-actions');
    const viewPostBtn = $('room-share-view');
    const removePostBtn = $('room-share-remove');
    const publishBtn = $('room-share-publish');

    const errorEl = $('room-share-error');

    dialogs.register(dialog, { busy: () => busy });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape' && busy) {
        event.preventDefault();
        event.stopPropagation();
      }
    });

    function render() {
      titleEl.textContent = 'Share room';

      const rawUrl = value?.invite?.url || '';
      urlInput.value = rawUrl.replace(/^https?:\/\//i, '');
      copyBtn.disabled = personalBtn.disabled = busy || !value;

      errorEl.textContent = value?.error || '';

      const publishing = !!value?.configured && !!value?.canManage;
      pubSection.hidden = !publishing;
      if (!publishing) return;

      const preview = value.preview;
      destinationEl.textContent = 'Publish to';
      if (value.channelName) {
        channelBadge.textContent = '#' + value.channelName;
        channelBadge.hidden = false;
      } else {
        channelBadge.hidden = true;
      }

      previewName.textContent = preview.name;
      previewTitle.textContent = [preview.title, preview.subtitle].filter(Boolean).join(' · ');
      previewStatus.textContent =
        preview.status + ' · ' + preview.viewers + ' viewer' + (preview.viewers === 1 ? '' : 's');

      previewDot.className = 'room-share-status-dot';
      if (preview.status === 'Playing') previewDot.classList.add('playing');
      else if (preview.status === 'Paused') previewDot.classList.add('paused');

      const isPublished = !!value.published;
      publishedActions.hidden = !isPublished;
      publishBtn.hidden = isPublished || !!value.removing;
      publishBtn.disabled =
        busy || !value.available || !value.canPublish || preview.status === 'Closed' || value.uncertain;
      viewPostBtn.hidden = !value.messageUrl;
      viewPostBtn.disabled = busy;
      removePostBtn.hidden = !value.hasPost && !value.published && !value.uncertain && !value.removing;
      removePostBtn.disabled = busy;

      pubStatus.textContent = value.removing
        ? 'Removing post…'
        : value.uncertain
          ? 'The post could not be confirmed. Check Discord before retrying.'
          : isPublished
            ? 'Published'
            : preview.status === 'Closed'
              ? 'Open this room to publish it.'
              : '';
    }

    async function load(ticket) {
      const next = await request('room.share', { roomId: target });
      if (ticket !== generation || !dialog.open) return;
      value = next;
      render();
      scheduleRefresh(ticket);
    }

    function scheduleRefresh(ticket = generation) {
      clearTimeout(refreshTimer);
      if (!dialog.open || busy || !(value?.removing || (value?.canManage && value?.configured && !value?.available)))
        return;
      refreshTimer = setTimeout(async () => {
        if (ticket !== generation || !dialog.open || busy) return;
        try {
          await load(ticket);
        } catch {
          scheduleRefresh(ticket);
        }
      }, 5000);
    }

    async function open(id) {
      if (busy) return;
      const ticket = ++generation;
      target = id;
      value = undefined;
      errorEl.textContent = '';
      pubSection.hidden = true;
      urlInput.value = 'Loading…';
      copyBtn.disabled = personalBtn.disabled = true;
      dialogs.open(dialog);
      try {
        await load(ticket);
      } catch (error) {
        if (ticket === generation && dialog.open) errorEl.textContent = error.message;
      }
    }

    async function change(action) {
      if (busy || !value) return;
      busy = true;
      const ticket = generation;
      render();
      errorEl.textContent = '';
      try {
        const response = await request('room.share.command', { roomId: target, args: { action } });
        if (response.status !== 'applied') throw new Error(response.message || 'Discord could not update the post.');
        await load(ticket);
      } catch (error) {
        if (ticket === generation && dialog.open) {
          try {
            await load(ticket);
          } catch {}
          value.error = error.message;
        }
      } finally {
        busy = false;
        if (ticket === generation && dialog.open) {
          render();
          scheduleRefresh(ticket);
        }
      }
    }

    function copyInvite() {
      if (value) void share(value.invite, value.preview.name, { copy: true });
    }

    dismissBtn.addEventListener('click', () => dialogs.close(dialog));

    copyBtn.addEventListener('click', copyInvite);
    urlInput.addEventListener('click', copyInvite);
    personalBtn.addEventListener('click', () => {
      if (value) void share(value.invite, value.preview.name);
    });

    publishBtn.addEventListener('click', () => void change('room.publish'));
    removePostBtn.addEventListener('click', () => void change('room.unpublish'));
    viewPostBtn.addEventListener('click', () => {
      if (value?.messageUrl)
        void openLink(value.messageUrl).catch(error => {
          errorEl.textContent = error.message;
        });
    });

    dialog.addEventListener('close', () => {
      generation++;
      clearTimeout(refreshTimer);
      value = undefined;
    });

    return { open };
  }
  root.uburoomShare = { mount };
})(globalThis);
