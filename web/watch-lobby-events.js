/* Lobby Upcoming list for watch nights; no playback ownership. */
(function(root) {
  'use strict';
  const SHOWN = 3;
  function mount({request, schedule, join, reopen, changed}) {
    const $ = id => document.getElementById(id), icons = root.uburoomIcons, dialogs = root.uburoomDialogs;
    const section = $('lobby-events'), list = $('lobby-event-list'), more = $('lobby-events-more'), scheduleButton = $('lobby-schedule');
    const popover = (anchor, options) => root.uburoomPopover?.show(anchor, options);
    let value, expanded = false, generation = 0, busy = false, timer;

    scheduleButton.prepend(icons.icon(document, 'calendar-event'));
    scheduleButton.addEventListener('click', () => void schedule({onChange: refresh}));
    more.addEventListener('click', () => { expanded = !expanded; render(); });

    function day(at) { return at.getFullYear() + '-' + at.getMonth() + '-' + at.getDate(); }
    // "Tonight · 8:00 PM", "Tomorrow · 8:00 PM" or "Sat, Nov 14 · 8:00 PM", in the viewer's own zone.
    function when(event) {
      const start = new Date(event.start), now = new Date(), tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
      const time = start.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});
      const label = day(start) === day(now) ? (start.getHours() >= 17 ? 'Tonight' : 'Today') : day(start) === day(tomorrow) ? 'Tomorrow' :
        start.toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'});
      return label + ' · ' + time;
    }
    function iconButton(label, icon, action, className = 'icon-button') {
      const button = document.createElement('button');
      button.type = 'button'; button.className = className + ' lobby-event-icon';
      button.setAttribute('aria-label', label); button.title = label;
      button.append(icons.icon(document, icon));
      button.addEventListener('click', () => void action(button));
      return button;
    }
    function textButton(label, icon, action, className = 'quiet') {
      const button = document.createElement('button');
      button.type = 'button'; button.className = className;
      if (icon) button.append(icons.icon(document, icon));
      button.append(label);
      button.addEventListener('click', () => void action(button));
      return button;
    }
    async function guarded(button, action) {
      if (busy) return;
      busy = true; button.disabled = true;
      try { await action(); }
      catch (error) { popover(button, {text: error.message, state: 'error'}); }
      finally { busy = false; if (button.isConnected) button.disabled = false; }
    }
    function card(event) {
      const row = document.createElement('div'); row.className = 'saved-room lobby-event';
      const copy = document.createElement('div'), name = document.createElement('strong'), info = document.createElement('p');
      name.append(icons.icon(document, 'calendar-event'), event.title);
      info.className = 'hint';
      // A room made for the event shares its name; say it once.
      const details = [event.live ? 'Starting now' : when(event), ...(event.roomName === event.title ? [] : [event.roomName])];
      if (event.discord && Number.isInteger(event.discord.interested)) details.push(event.discord.interested + ' interested');
      info.textContent = details.join(' · ');
      copy.append(name, info);
      const actions = document.createElement('div'); actions.className = 'room-actions';
      if (event.active) {
        actions.append(textButton('Join', 'login', button => guarded(button, () => join(event.roomId)), event.live ? 'primary' : 'quiet'));
      } else if (event.canManage) {
        actions.append(textButton('Open room', undefined, button => guarded(button, () => reopen(event.roomId)), event.live ? 'primary' : 'quiet'));
      } else {
        const waiting = document.createElement('span'); waiting.className = 'hint'; waiting.textContent = 'Waiting for host';
        actions.append(waiting);
      }
      if (event.canManage) {
        if (event.canEdit) actions.append(iconButton('Edit event', 'edit', () => schedule({event, onChange: refresh})));
        if (event.invite) actions.append(iconButton('Copy invite', 'copy', button => guarded(button, async () => {
          await navigator.clipboard.writeText(event.invite);
          popover(button, {text: 'Invite link copied', state: 'success'});
        })));
        actions.append(iconButton('Cancel event', 'trash', button => guarded(button, async () => {
          const release = button.closest('dialog') ? dialogs.hold(button.closest('dialog')) : () => {};
          try {
            const where = event.discord ? ' It is also canceled in Discord.' : '';
            if (!await dialogs.confirm('Cancel “' + event.title + '”?' + where, {destructive: true})) return;
          } finally { release(); }
          popover(button, {text: 'Canceling…', state: 'loading'});
          const result = await request('/api/watch/rooms/' + event.roomId + '/events', {action: 'room.event.cancel', eventKey: event.key});
          if (result.status !== 'applied') throw new Error(result.message || 'The event could not be canceled.');
          await refresh();
          popover(scheduleButton, {text: result.message, state: 'success'});
        })));
      }
      row.append(copy, actions);
      return row;
    }
    function render() {
      const events = value?.events || [];
      scheduleButton.hidden = !value?.canSchedule;
      section.hidden = !events.length;
      list.replaceChildren(...(expanded ? events : events.slice(0, SHOWN)).map(card));
      more.hidden = events.length <= SHOWN;
      more.textContent = expanded ? 'Show fewer' : 'More (' + (events.length - SHOWN) + ')';
    }
    async function refresh() {
      const ticket = ++generation;
      try {
        const next = await request('/api/watch/events');
        if (ticket !== generation) return;
        value = next; render(); changed?.();
      } catch { /* The lobby keeps its last list; the next refresh retries. */ }
      clearTimeout(timer);
      // "Starting now" and end times move on their own; Discord counts change slowly.
      timer = setTimeout(() => { if (!$('room-lobby').hidden) void refresh(); }, 60000);
    }
    return {refresh, canSchedule: () => !!value?.canSchedule, events: () => value?.events || []};
  }
  // Shared wording for when an event starts, relative to the viewer's own day.
  function startsLabel(event) {
    const start = new Date(event.start), now = new Date(), tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    const same = (a, b) => a.toDateString() === b.toDateString();
    const time = start.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});
    if (same(start, now)) return time;
    return (same(start, tomorrow) ? 'tomorrow' : start.toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'})) + ' · ' + time;
  }
  root.uburoomLobbyEvents = {mount, startsLabel};
})(globalThis);
