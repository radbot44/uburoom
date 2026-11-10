/* Watch-night scheduler shared by every entry point; no playback ownership. */
(function (root) {
  'use strict';
  const NEW_ROOM = 'new';
  function mount({ request }) {
    const $ = id => document.getElementById(id),
      dialog = $('event-dialog'),
      dialogs = root.uburoomDialogs;
    const form = $('event-form'),
      heading = $('event-dialog-title'),
      errorEl = $('event-error');
    const roomRow = $('event-room-row'),
      roomSelect = $('event-room');
    const title = $('event-title'),
      titleCount = $('event-title-count'),
      description = $('event-description');
    const zoneToggle = $('event-zone-toggle'),
      zoneDisplay = $('event-zone-display'),
      zoneWrapper = $('event-zone-wrapper'),
      zone = $('event-zone');
    const chips = [...dialog.querySelectorAll('.event-chip')],
      date = $('event-date'),
      time = $('event-time');
    const pills = [...dialog.querySelectorAll('.event-duration-pill')],
      endBadge = $('event-end-badge');
    const customRow = $('event-custom-duration-row'),
      customSelect = $('event-custom-duration');
    const discordRow = $('event-discord-row'),
      discord = $('event-discord');
    const startHidden = $('event-start'),
      endHidden = $('event-end'),
      discard = $('event-discard'),
      save = $('event-save');
    const fields = [roomSelect, title, description, zone, date, time, customSelect, discord];
    let generation = 0,
      busy = false,
      dirty = false,
      editing,
      getDuration,
      changed,
      opener;
    const popover = (anchor, options) => root.uburoomPopover?.show(anchor, options);
    let duration = 60,
      customMinutes = 90;

    dialogs.register(dialog, { busy: () => busy, dirty: () => dirty });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape' && (busy || dirty)) {
        event.preventDefault();
        event.stopPropagation();
      }
    });

    const zones = [
      ...new Set([
        'UTC',
        Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(Intl.supportedValuesOf?.('timeZone') || []),
      ]),
    ];
    for (const name of zones) zone.append(option(name, name));
    for (let h = 0; h < 24; h++)
      for (let m = 0; m < 60; m += 15) time.append(option(pad(h) + ':' + pad(m), clock(h, m)));
    for (const field of fields)
      field.addEventListener('input', () => {
        dirty = true;
      });
    title.addEventListener('input', () => {
      titleCount.textContent = title.value.length + ' / 100';
    });
    zoneToggle.addEventListener('click', () => {
      const expanded = zoneToggle.getAttribute('aria-expanded') === 'true';
      zoneToggle.setAttribute('aria-expanded', String(!expanded));
      zoneWrapper.hidden = expanded;
    });
    zone.addEventListener('change', () => {
      zoneDisplay.textContent = zoneLabel(zone.value);
      updateEnd();
    });
    for (const chip of chips)
      chip.addEventListener('click', () => {
        dirty = true;
        preset(chip.dataset.preset);
      });
    for (const field of [date, time])
      field.addEventListener('change', () => {
        pressChip(null);
        updateEnd();
      });
    for (const pill of pills)
      pill.addEventListener('click', () => {
        dirty = true;
        setDuration(pill.dataset.duration === 'custom' ? 'custom' : Number(pill.dataset.duration));
      });
    customSelect.addEventListener('change', () => {
      customMinutes = Number(customSelect.value) || 90;
      updateEnd();
    });

    function option(value, label) {
      const element = document.createElement('option');
      element.value = value;
      element.textContent = label;
      return element;
    }
    function pad(value) {
      return String(value).padStart(2, '0');
    }
    function clock(hours, minutes) {
      return (hours % 12 || 12) + ':' + pad(minutes) + ' ' + (hours >= 12 ? 'PM' : 'AM');
    }
    function day(at) {
      return at.getFullYear() + '-' + pad(at.getMonth() + 1) + '-' + pad(at.getDate());
    }
    function zoneLabel(name) {
      try {
        const short = new Intl.DateTimeFormat('en-US', { timeZone: name, timeZoneName: 'short' })
          .formatToParts(new Date())
          .find(part => part.type === 'timeZoneName')?.value;
        return short ? name + ' (' + short + ')' : name;
      } catch {
        return name;
      }
    }
    function durationLabel(minutes) {
      const h = Math.floor(minutes / 60),
        m = minutes % 60;
      return h === 0 ? m + 'm' : m === 0 ? h + 'h' : h + 'h ' + m + 'm';
    }
    function videoMinutes() {
      const seconds = Number(getDuration?.());
      return Number.isFinite(seconds) && seconds > 60 ? Math.ceil(seconds / 60) : undefined;
    }
    function customOptions(selected = customMinutes) {
      const options = [30, 45, 75, 90, 105, 135, 150, 165, 210, 240],
        video = videoMinutes();
      if (video && !options.includes(video)) options.push(video);
      if (!options.includes(selected)) options.push(selected);
      customSelect.replaceChildren(
        ...options
          .sort((a, b) => a - b)
          .map(minutes => {
            const element = option(String(minutes), durationLabel(minutes));
            element.selected = minutes === selected;
            return element;
          }),
      );
    }
    function setDuration(value) {
      duration = value;
      for (const pill of pills) pill.setAttribute('aria-pressed', String(pill.dataset.duration === String(value)));
      customRow.hidden = value !== 'custom';
      if (value === 'custom') customOptions();
      updateEnd();
    }
    function pressChip(name) {
      for (const chip of chips) chip.setAttribute('aria-pressed', String(chip.dataset.preset === name));
    }
    function preset(name) {
      pressChip(name);
      const now = new Date(),
        target = new Date(now);
      if (name === 'next30') {
        if (now.getMinutes() < 30) target.setMinutes(30, 0, 0);
        else target.setHours(now.getHours() + 1, 0, 0, 0);
        if (target.getTime() <= now.getTime() + 120000) target.setMinutes(target.getMinutes() + 30);
      } else {
        if (name === 'tomorrow8') target.setDate(target.getDate() + 1);
        target.setHours(20, 0, 0, 0);
        if (target.getTime() <= now.getTime() + 120000) target.setDate(target.getDate() + 1);
      }
      date.value = day(target);
      time.value = pad(target.getHours()) + ':' + pad(target.getMinutes());
      updateEnd();
    }
    function updateEnd() {
      if (!date.value || !time.value) return;
      const [y, mo, d] = date.value.split('-').map(Number),
        [h, mi] = time.value.split(':').map(Number);
      const minutes = duration === 'custom' ? Number(customSelect.value) || 90 : duration;
      const end = new Date(new Date(y, mo - 1, d, h, mi).getTime() + minutes * 60000);
      startHidden.value = date.value + 'T' + time.value;
      endHidden.value = day(end) + 'T' + pad(end.getHours()) + ':' + pad(end.getMinutes());
      const now = new Date(),
        tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      const when =
        day(end) === day(now)
          ? 'today'
          : day(end) === day(tomorrow)
            ? 'tomorrow'
            : end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      let short = '';
      try {
        short =
          new Intl.DateTimeFormat('en-US', { timeZone: zone.value, timeZoneName: 'short' })
            .formatToParts(end)
            .find(part => part.type === 'timeZoneName')?.value || '';
      } catch {}
      endBadge.textContent =
        'Ends ' + when + ' at ' + clock(end.getHours(), end.getMinutes()) + (short ? ' ' + short : '');
    }
    function local(at, name) {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
          timeZone: name,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        })
          .formatToParts(new Date(at))
          .map(part => [part.type, part.value]),
      );
      return {
        date: parts.year + '-' + parts.month + '-' + parts.day,
        hours: Number(parts.hour),
        minutes: Number(parts.minute),
      };
    }
    function render() {
      for (const field of fields) field.disabled = busy;
      roomSelect.disabled = busy || !!editing;
      save.disabled = discard.disabled = busy;
      form.setAttribute('aria-busy', String(busy));
    }
    function fillRooms(rooms, selected, selectedName) {
      // An event stays in its room; only a new one chooses.
      const options = editing ? [] : [option(NEW_ROOM, 'New room')];
      for (const room of rooms) if (!editing || room.id === selected) options.push(option(room.id, room.name));
      if (selected && !options.some(item => item.value === selected))
        options.push(option(selected, selectedName || 'This room'));
      roomSelect.replaceChildren(...options);
      roomSelect.value = selected || NEW_ROOM;
    }
    function fillForm(event, suggested) {
      const name = event?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      if (!zones.includes(name)) {
        zone.append(option(name, name));
        zones.push(name);
      }
      zone.value = name;
      zoneDisplay.textContent = zoneLabel(name);
      zoneWrapper.hidden = true;
      zoneToggle.setAttribute('aria-expanded', 'false');
      title.value = event?.title || suggested || '';
      titleCount.textContent = title.value.length + ' / 100';
      description.value = event?.description || '';
      if (event) {
        const start = local(event.start, name);
        date.value = start.date;
        time.value = pad(start.hours) + ':' + pad(Math.floor(start.minutes / 15) * 15);
        pressChip(null);
        const minutes = Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60000);
        if ([60, 120, 180].includes(minutes)) setDuration(minutes);
        else {
          customMinutes = minutes > 0 ? minutes : 90;
          setDuration('custom');
        }
      } else {
        preset('next30');
        const video = videoMinutes();
        setDuration(!video || video <= 75 ? 60 : video <= 135 ? 120 : video <= 195 ? 180 : 120);
      }
    }
    // Opens the scheduler. roomId preselects a room; event edits that event in its room.
    async function open({ roomId, roomName, event, title: suggested, duration: currentDuration, onChange } = {}) {
      if (busy || dialog.open) return;
      const ticket = ++generation;
      const selected = event ? event.roomId : roomId;
      opener = document.activeElement;
      editing = event;
      getDuration = currentDuration;
      changed = onChange;
      dirty = false;
      heading.textContent = event ? 'Edit event' : 'Schedule event';
      save.textContent = event ? 'Save' : 'Schedule';
      errorEl.textContent = '';
      fillRooms([], selected, event?.roomName || roomName);
      fillForm(event, suggested);
      discordRow.hidden = true;
      busy = true;
      render();
      dialogs.open(dialog);
      try {
        const [lobby, saved] = await Promise.all([
          request('/api/watch/events'),
          event ? { rooms: [] } : request('/api/watch/rooms/saved'),
        ]);
        if (ticket !== generation || !dialog.open) return;
        // Single-room mode always schedules into the shared room.
        roomRow.hidden = !!lobby.singleRoom;
        fillRooms(saved.rooms, selected, event?.roomName || roomName);
        discordRow.hidden = !lobby.discord?.configured;
        discord.checked = event ? !!event.discord : true;
        if (!event && !lobby.canSchedule) errorEl.textContent = 'Scheduling events is limited on this server.';
      } catch (error) {
        if (ticket === generation && dialog.open) errorEl.textContent = error.message;
      } finally {
        if (ticket === generation) {
          busy = false;
          render();
          if (dialog.open) title.focus();
        }
      }
    }
    async function submit() {
      if (busy) return;
      const ticket = generation,
        room = roomSelect.value;
      const args = {
        title: title.value,
        description: description.value,
        startLocal: startHidden.value,
        endLocal: endHidden.value,
        timeZone: zone.value,
        discord: !discordRow.hidden && discord.checked,
      };
      busy = true;
      render();
      errorEl.textContent = '';
      popover(save, { text: editing ? 'Saving…' : 'Scheduling…', state: 'loading' });
      try {
        const result = editing
          ? await request('/api/watch/rooms/' + editing.roomId + '/events', {
              action: 'room.event.edit',
              eventKey: editing.key,
              eventVersion: editing.eventVersion,
              ...args,
            })
          : await request('/api/watch/events', { room, ...args });
        if (result.status !== 'applied') throw new Error(result.message || 'The event could not be saved.');
        if (ticket !== generation) return;
        const anchor = opener;
        dirty = false;
        busy = false;
        root.uburoomPopover?.dismiss?.();
        dialogs.close(dialog, 'saved');
        await changed?.(result);
        queueMicrotask(() => popover(anchor, { text: result.message, state: 'success' }));
      } catch (error) {
        if (ticket === generation && dialog.open) popover(save, { text: error.message, state: 'error' });
      } finally {
        if (ticket === generation) {
          busy = false;
          render();
        }
      }
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      void submit();
    });
    discard.addEventListener('click', () => {
      dirty = false;
      dialogs.close(dialog);
    });
    $('event-dismiss').addEventListener('click', () => {
      dirty = false;
      dialogs.close(dialog);
    });
    dialog.addEventListener('close', () => {
      generation++;
      busy = false;
      dirty = false;
      editing = undefined;
      changed = undefined;
    });
    return { open };
  }
  root.uburoomEvents = { mount };
})(globalThis);
