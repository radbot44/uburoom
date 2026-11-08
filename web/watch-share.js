/* Room sharing and explicit server publication; no playback ownership. */
(function(root) {
  'use strict';
  function mount({request, share, openLink, getDuration, toasts}) {
    const $ = id => document.getElementById(id), dialog = $('room-share-dialog'), dialogs = root.uburoomDialogs;
    let generation = 0, target, value, busy = false, editing, draftDirty = false, refreshTimer;
    let selectedDuration = 60, customMinutes = 90, activePreset = 'next30';

    const titleEl = $('room-share-title');
    const backBtn = $('room-share-back');
    const dismissBtn = $('room-share-dismiss');
    const mainView = $('room-share-main');
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

    const eventForm = $('room-share-event-form');
    const eventTitle = $('room-share-event-title');
    const eventTitleCount = $('room-share-event-title-count');
    const eventDescription = $('room-share-event-description');
    const zoneToggle = $('room-share-zone-toggle');
    const zoneDisplay = $('room-share-zone-display');
    const zoneWrapper = $('room-share-zone-wrapper');
    const eventZone = $('room-share-event-zone');

    const chipNext30 = $('room-share-chip-next30');
    const chipTonight8 = $('room-share-chip-tonight8');
    const chipTomorrow8 = $('room-share-chip-tomorrow8');
    const eventDate = $('room-share-event-date');
    const eventTime = $('room-share-event-time');

    const durationPills = Array.from(dialog.querySelectorAll('.room-share-duration-pill'));
    const calculatedEnd = $('room-share-calculated-end');
    const customDurationRow = $('room-share-custom-duration-row');
    const customDurationSelect = $('room-share-custom-duration');

    const startHidden = $('room-share-event-start');
    const endHidden = $('room-share-event-end');
    const eventDiscard = $('room-share-event-discard');
    const eventSave = $('room-share-event-save');

    const eventFields = [eventTitle, eventDescription, eventZone, eventDate, eventTime, customDurationSelect];

    dialogs.register(dialog, {busy: () => busy, dirty: () => draftDirty});
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape' && (busy || draftDirty)) {
        event.preventDefault();
        event.stopPropagation();
      }
    });

    const zones = [...new Set(['UTC', Intl.DateTimeFormat().resolvedOptions().timeZone, ...(Intl.supportedValuesOf?.('timeZone') || [])])];
    for (const zone of zones) {
      const option = document.createElement('option');
      option.value = option.textContent = zone;
      eventZone.append(option);
    }

    // Populate 15-minute time intervals
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 15) {
        const opt = document.createElement('option');
        opt.value = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
        opt.textContent = formatTime12h(h, m);
        eventTime.append(opt);
      }
    }

    for (const field of eventFields) {
      field.addEventListener('input', () => { draftDirty = true; });
    }

    eventTitle.addEventListener('input', () => {
      eventTitleCount.textContent = eventTitle.value.length + ' / 100';
    });

    zoneToggle.addEventListener('click', () => {
      const isExpanded = zoneToggle.getAttribute('aria-expanded') === 'true';
      zoneToggle.setAttribute('aria-expanded', String(!isExpanded));
      zoneWrapper.hidden = isExpanded;
    });

    eventZone.addEventListener('change', () => {
      zoneDisplay.textContent = formatZoneLabel(eventZone.value);
      updateCalculatedEnd();
    });

    chipNext30.addEventListener('click', () => applyPreset('next30'));
    chipTonight8.addEventListener('click', () => applyPreset('tonight8'));
    chipTomorrow8.addEventListener('click', () => applyPreset('tomorrow8'));

    eventDate.addEventListener('change', () => {
      clearActivePreset();
      updateCalculatedEnd();
    });
    eventTime.addEventListener('change', () => {
      clearActivePreset();
      updateCalculatedEnd();
    });

    for (const pill of durationPills) {
      pill.addEventListener('click', () => {
        setDuration(pill.dataset.duration === 'custom' ? 'custom' : Number(pill.dataset.duration));
      });
    }

    customDurationSelect.addEventListener('change', () => {
      customMinutes = Number(customDurationSelect.value) || 90;
      updateCalculatedEnd();
    });

    function formatTime12h(hours, minutes) {
      const period = hours >= 12 ? 'PM' : 'AM';
      const h12 = hours % 12 === 0 ? 12 : hours % 12;
      return h12 + ':' + String(minutes).padStart(2, '0') + ' ' + period;
    }

    function formatZoneLabel(zone) {
      try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date());
        const short = parts.find(p => p.type === 'timeZoneName')?.value;
        return short ? zone + ' (' + short + ')' : zone;
      } catch {
        return zone;
      }
    }

    function toDateInputValue(dateObj) {
      const y = dateObj.getFullYear();
      const m = String(dateObj.getMonth() + 1).padStart(2, '0');
      const d = String(dateObj.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + d;
    }

    function formatDurationLabel(mins) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      if (h === 0) return m + 'm';
      if (m === 0) return h + 'h';
      return h + 'h ' + m + 'm';
    }

    function populateCustomDurations(currentValue = customMinutes) {
      const options = [30, 45, 75, 90, 105, 135, 150, 165, 210, 240];
      const videoSec = Number(getDuration?.());
      if (Number.isFinite(videoSec) && videoSec > 60) {
        const videoMins = Math.ceil(videoSec / 60);
        if (!options.includes(videoMins)) options.push(videoMins);
      }
      options.sort((a, b) => a - b);
      customDurationSelect.replaceChildren();
      for (const mins of options) {
        const opt = document.createElement('option');
        opt.value = String(mins);
        opt.textContent = formatDurationLabel(mins);
        if (mins === currentValue) opt.selected = true;
        customDurationSelect.append(opt);
      }
    }

    function setDuration(duration) {
      selectedDuration = duration;
      for (const pill of durationPills) {
        pill.setAttribute('aria-pressed', pill.dataset.duration === String(duration) ? 'true' : 'false');
      }
      if (duration === 'custom') {
        customDurationRow.hidden = false;
        populateCustomDurations();
      } else {
        customDurationRow.hidden = true;
      }
      updateCalculatedEnd();
    }

    function applyPreset(preset) {
      activePreset = preset;
      chipNext30.setAttribute('aria-pressed', preset === 'next30' ? 'true' : 'false');
      chipTonight8.setAttribute('aria-pressed', preset === 'tonight8' ? 'true' : 'false');
      chipTomorrow8.setAttribute('aria-pressed', preset === 'tomorrow8' ? 'true' : 'false');

      const now = new Date();
      const target = new Date(now);

      if (preset === 'next30') {
        const m = now.getMinutes();
        if (m < 30) {
          target.setMinutes(30, 0, 0);
        } else {
          target.setHours(now.getHours() + 1, 0, 0, 0);
        }
        if (target.getTime() <= now.getTime() + 120000) {
          target.setMinutes(target.getMinutes() + 30);
        }
      } else if (preset === 'tonight8') {
        target.setHours(20, 0, 0, 0);
        if (target.getTime() <= now.getTime() + 120000) {
          target.setDate(target.getDate() + 1);
        }
      } else if (preset === 'tomorrow8') {
        target.setDate(target.getDate() + 1);
        target.setHours(20, 0, 0, 0);
      }

      eventDate.value = toDateInputValue(target);
      eventTime.value = String(target.getHours()).padStart(2, '0') + ':' + String(target.getMinutes()).padStart(2, '0');
      updateCalculatedEnd();
    }

    function clearActivePreset() {
      activePreset = null;
      chipNext30.setAttribute('aria-pressed', 'false');
      chipTonight8.setAttribute('aria-pressed', 'false');
      chipTomorrow8.setAttribute('aria-pressed', 'false');
    }

    function updateCalculatedEnd() {
      const dateVal = eventDate.value;
      const timeVal = eventTime.value;
      if (!dateVal || !timeVal) return;

      const [y, mo, d] = dateVal.split('-').map(Number);
      const [h, mi] = timeVal.split(':').map(Number);
      const startDate = new Date(y, mo - 1, d, h, mi);
      const addMins = selectedDuration === 'custom' ? (Number(customDurationSelect.value) || 90) : Number(selectedDuration);
      const endDate = new Date(startDate.getTime() + addMins * 60000);

      startHidden.value = dateVal + 'T' + timeVal;
      endHidden.value = toDateInputValue(endDate) + 'T' + String(endDate.getHours()).padStart(2, '0') + ':' + String(endDate.getMinutes()).padStart(2, '0');

      const now = new Date();
      const todayStr = toDateInputValue(now);
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      const tomorrowStr = toDateInputValue(tomorrow);

      const endDayStr = toDateInputValue(endDate);
      const dayDesc = endDayStr === todayStr ? 'today' : endDayStr === tomorrowStr ? 'tomorrow' : endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const endTimeStr = formatTime12h(endDate.getHours(), endDate.getMinutes());

      let tzShort = '';
      try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: eventZone.value, timeZoneName: 'short' }).formatToParts(endDate);
        tzShort = parts.find(p => p.type === 'timeZoneName')?.value || '';
      } catch {}

      calculatedEnd.textContent = 'Ends ' + dayDesc + ' at ' + endTimeStr + (tzShort ? ' ' + tzShort : '');
    }

    function button(label, action, className = 'quiet') {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = className;
      element.textContent = label;
      element.disabled = busy;
      element.addEventListener('click', action);
      return element;
    }

    function localTimeParts(at, timeZone) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).formatToParts(new Date(at)).map(part => [part.type, part.value]));
      return { date: parts.year + '-' + parts.month + '-' + parts.day, time: parts.hour + ':' + parts.minute };
    }

    function editEvent(event) {
      if (busy || !value) return;
      editing = event;
      draftDirty = false;

      const titleVal = event?.title || (value.preview.title === 'Nothing selected' && value.preview.name) || value.preview.title || '';
      eventTitle.value = titleVal;
      eventTitleCount.textContent = titleVal.length + ' / 100';
      eventDescription.value = event?.description || '';

      const zone = event?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      if (!zones.includes(zone)) {
        const option = document.createElement('option');
        option.value = option.textContent = zone;
        eventZone.append(option);
        zones.push(zone);
      }
      eventZone.value = zone;
      zoneDisplay.textContent = formatZoneLabel(zone);
      zoneWrapper.hidden = true;
      zoneToggle.setAttribute('aria-expanded', 'false');

      if (event) {
        const startParts = localTimeParts(event.start, zone);
        eventDate.value = startParts.date;
        const [sh, sm] = startParts.time.split(':').map(Number);
        const roundedM = String(Math.floor(sm / 15) * 15).padStart(2, '0');
        eventTime.value = String(sh).padStart(2, '0') + ':' + roundedM;
        clearActivePreset();

        const diffMins = Math.round((new Date(event.end).getTime() - new Date(event.start).getTime()) / 60000);
        if ([60, 120, 180].includes(diffMins)) {
          setDuration(diffMins);
        } else {
          customMinutes = diffMins > 0 ? diffMins : 90;
          setDuration('custom');
          populateCustomDurations(customMinutes);
        }
      } else {
        applyPreset('next30');
        const videoSec = Number(getDuration?.());
        if (Number.isFinite(videoSec) && videoSec > 60) {
          const vm = Math.ceil(videoSec / 60);
          if (vm <= 75) setDuration(60);
          else if (vm <= 135) setDuration(120);
          else if (vm <= 195) setDuration(180);
          else setDuration(120);
        } else {
          setDuration(60);
        }
      }

      updateCalculatedEnd();
      eventForm.hidden = false;
      eventSave.textContent = event ? 'Save event' : 'Schedule event';
      eventStatus.textContent = '';
      render();
      eventTitle.focus();
    }

    function discardEvent() {
      editing = undefined;
      draftDirty = false;
      eventForm.hidden = true;
      render();
    }

    function renderEvents() {
      const scheduling = value?.scheduling;
      const visible = !!scheduling?.configured && !!scheduling?.canManage;
      eventsSection.hidden = !visible || !eventForm.hidden;
      if (!visible) return;

      for (const field of eventFields) field.disabled = busy;
      eventSave.disabled = eventDiscard.disabled = busy;
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
          const edit = button('Edit', () => editEvent(event));
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
      const editorOpen = !eventForm.hidden;
      titleEl.textContent = editorOpen ? (editing ? 'Edit Discord event' : 'Schedule Discord event') : 'Share room';
      backBtn.hidden = !editorOpen;
      mainView.hidden = editorOpen;

      const rawUrl = value?.invite?.url || '';
      urlInput.value = rawUrl.replace(/^https?:\/\//i, '');
      copyBtn.disabled = personalBtn.disabled = busy || !value;

      renderEvents();
      errorEl.textContent = value?.error || '';

      const publishing = !!value?.configured && !!value?.canManage;
      pubSection.hidden = !publishing || editorOpen;
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
      if (!dialog.open || draftDirty || busy || !(value?.removing || value?.scheduling?.events.some(event => event.cancel) || value?.canManage && value?.configured && !value?.available || value?.scheduling?.canManage && value?.scheduling?.configured && !value?.scheduling?.available)) return;
      refreshTimer = setTimeout(async () => {
        if (ticket !== generation || !dialog.open || busy || draftDirty) return;
        try { await load(ticket); } catch { scheduleRefresh(ticket); }
      }, 5000);
    }

    async function open(id) {
      if (busy) return;
      const ticket = ++generation;
      target = id;
      value = undefined;
      discardEvent();
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
      const args = { action, ...(event ? { eventKey: event.key, ...(action === 'room.event.edit' ? { eventVersion: event.eventVersion } : {}) } : {}) };
      if (action !== 'room.event.cancel') {
        Object.assign(args, {
          title: eventTitle.value,
          description: eventDescription.value,
          startLocal: startHidden.value,
          endLocal: endHidden.value,
          timeZone: eventZone.value
        });
      }
      busy = true;
      render();
      errorEl.textContent = '';
      try {
        const result = await request('/api/watch/rooms/' + target + '/share', args);
        if (result.status !== 'applied') throw new Error(result.message || 'Discord could not update the event.');
        discardEvent();
        await load(ticket);
        toasts?.show('room-event', { title: result.message, symbol: 'check', duration: 4000 });
      } catch (error) {
        if (ticket === generation && dialog.open) {
          try { await load(ticket); } catch {}
          value.error = error.message;
          toasts?.show('room-event', { type: 'error', title: "Couldn't update event", hint: error.message, symbol: 'alert-triangle', duration: 8000 });
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

    scheduleBtn.addEventListener('click', () => editEvent());
    eventDiscard.addEventListener('click', discardEvent);
    backBtn.addEventListener('click', discardEvent);
    dismissBtn.addEventListener('click', () => dialogs.close(dialog));

    eventForm.addEventListener('submit', event => {
      event.preventDefault();
      void changeEvent(editing ? 'room.event.edit' : 'room.event.create', editing);
    });

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
      draftDirty = false;
    });

    return {open};
  }
  root.uburoomShare = {mount};
})(globalThis);
