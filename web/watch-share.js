/* Room sharing and explicit server publication; no playback ownership. */
(function(root) {
  'use strict';
  function mount({request, share, openLink, getDuration, schedule}) {
    const $ = id => document.getElementById(id), dialog = $('room-share-dialog'), dialogs = root.uburoomDialogs;
    let generation = 0, target, value, busy = false, refreshTimer;

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
    const scheduleBtn = $('room-share-schedule-btn');

    const eventsSection = $('room-share-events');
    const eventsList = $('room-share-event-list');
    const eventStatus = $('room-share-event-status');
    const errorEl = $('room-share-error');

    dialogs.register(dialog, {busy: () => busy});
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape' && busy) {
        event.preventDefault();
        event.stopPropagation();
      }
    });

    function button(label, action, className = 'quiet') {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = className;
      element.textContent = label;
      element.disabled = busy;
      element.addEventListener('click', action);
      return element;
    }

    function renderEvents() {
      const scheduling = value?.scheduling;
      const visible = !!scheduling?.configured && !!scheduling?.canManage;
      eventsSection.hidden = !visible;
      if (!visible) return;
      eventsList.replaceChildren();

      if (!scheduling.events || scheduling.events.length === 0) {
        eventsSection.hidden = true;
        return;
      }

      for (const event of scheduling.events) {
        const row = document.createElement('div');
        row.className = 'room-share-event';
        const title = document.createElement('strong');
        title.textContent = event.title;
        row.append(title);

        const when = document.createElement('p');
        when.className = 'hint';
        const format = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: event.timeZone });
        when.textContent = format.format(new Date(event.start)) + ' – ' + format.format(new Date(event.end)) + ' · ' + event.timeZone + ' · ' + event.statusName;
        row.append(when);

        const actions = document.createElement('div');
        actions.className = 'dialog-actions';
        if (event.url) {
          actions.append(button('View event', () => void openLink(event.url).catch(error => { errorEl.textContent = error.message; })));
        }
        if (event.status === 1 && event.eventId && !event.cancel) {
          const edit = button('Edit', () => scheduleEvent(event));
          edit.disabled = busy || !scheduling.available;
          const cancel = button('Cancel event', async () => {
            const release = dialogs.hold(dialog);
            try {
              if (await dialogs.confirm('Cancel “' + event.title + '” in Discord?', { destructive: true })) {
                await changeEvent('room.event.cancel', event);
              }
            } finally {
              release();
            }
          }, 'danger-button');
          cancel.disabled = busy || !scheduling.available;
          actions.append(edit, cancel);
        }
        row.append(actions);
        eventsList.append(row);
      }
      if (scheduling.error) eventStatus.textContent = scheduling.error;
    }

    function render() {
      titleEl.textContent = 'Share room';

      const rawUrl = value?.invite?.url || '';
      urlInput.value = rawUrl.replace(/^https?:\/\//i, '');
      copyBtn.disabled = personalBtn.disabled = busy || !value;

      renderEvents();
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
      previewStatus.textContent = preview.status + ' · ' + preview.viewers + ' viewer' + (preview.viewers === 1 ? '' : 's');

      previewDot.className = 'room-share-status-dot';
      if (preview.status === 'Playing') previewDot.classList.add('playing');
      else if (preview.status === 'Paused') previewDot.classList.add('paused');

      const isPublished = !!value.published;
      publishedActions.hidden = !isPublished;
      publishBtn.hidden = isPublished || !!value.removing;
      publishBtn.disabled = busy || !value.available || !value.canPublish || preview.status === 'Closed' || value.uncertain;
      viewPostBtn.hidden = !value.messageUrl;
      viewPostBtn.disabled = busy;
      removePostBtn.hidden = !value.hasPost && !value.published && !value.uncertain && !value.removing;
      removePostBtn.disabled = busy;

      pubStatus.textContent = value.removing ? 'Removing post…' : value.uncertain ? 'The post could not be confirmed. Check Discord before retrying.' : isPublished ? 'Published' : preview.status === 'Closed' ? 'Open this room to publish it.' : '';
    }

    async function load(ticket) {
      const next = await request('/api/watch/rooms/' + target + '/share');
      if (ticket !== generation || !dialog.open) return;
      value = next;
      render();
      scheduleRefresh(ticket);
    }

    function scheduleRefresh(ticket = generation) {
      clearTimeout(refreshTimer);
      if (!dialog.open || busy || !(value?.removing || value?.scheduling?.events.some(event => event.cancel) || value?.canManage && value?.configured && !value?.available || value?.scheduling?.canManage && value?.scheduling?.configured && !value?.scheduling?.available)) return;
      refreshTimer = setTimeout(async () => {
        if (ticket !== generation || !dialog.open || busy) return;
        try { await load(ticket); } catch { scheduleRefresh(ticket); }
      }, 5000);
    }

    async function open(id) {
      if (busy) return;
      const ticket = ++generation;
      target = id;
      value = undefined;
      eventsSection.hidden = true;
      eventStatus.textContent = '';
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
        const response = await request('/api/watch/rooms/' + target + '/share', {action});
        if (response.status !== 'applied') throw new Error(response.message || 'Discord could not update the post.');
        await load(ticket);
      } catch (error) {
        if (ticket === generation && dialog.open) {
          try { await load(ticket); } catch {}
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

    async function changeEvent(action, event) {
      if (busy || !value) return;
      const ticket = generation;
      busy = true;
      render();
      errorEl.textContent = '';
      try {
        const result = await request('/api/watch/rooms/' + target + '/events', {action, eventKey: event.key});
        if (result.status !== 'applied') throw new Error(result.message || 'The event could not be canceled.');
        await load(ticket);
      } catch (error) {
        if (ticket === generation && dialog.open) {
          try { await load(ticket); } catch {}
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

    // Until scheduling leaves Share, its buttons open the shared scheduler for this room.
    function scheduleEvent(event) {
      if (busy || !value) return;
      const ticket = generation, suggested = value.preview.title === 'Nothing selected' ? '' : value.preview.title;
      void schedule({roomId: target, roomName: value.preview.name, event, title: suggested, duration: getDuration,
        onChange: () => ticket === generation && dialog.open ? load(ticket) : undefined});
    }

    function copyInvite() {
      if (value) void share(value.invite, value.preview.name, { copy: true });
    }

    scheduleBtn.addEventListener('click', () => scheduleEvent());
    dismissBtn.addEventListener('click', () => dialogs.close(dialog));

    copyBtn.addEventListener('click', copyInvite);
    urlInput.addEventListener('click', copyInvite);
    personalBtn.addEventListener('click', () => {
      if (value) void share(value.invite, value.preview.name);
    });

    publishBtn.addEventListener('click', () => void change('room.publish'));
    removePostBtn.addEventListener('click', () => void change('room.unpublish'));
    viewPostBtn.addEventListener('click', () => {
      if (value?.messageUrl) void openLink(value.messageUrl).catch(error => { errorEl.textContent = error.message; });
    });

    dialog.addEventListener('close', () => {
      generation++;
      clearTimeout(refreshTimer);
      value = undefined;
    });

    return {open};
  }
  root.uburoomShare = {mount};
})(globalThis);
