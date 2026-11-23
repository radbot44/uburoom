import * as controls from './watch-controls.js';
import * as dialogs from './watch-dialogs.js';
import { icon } from './icons.js';

const tabColors = ['--sync-blue', '--sync-orange', '--sync-teal', '--sync-purple', '--sync-rose'];
const events = { video: 'Video loaded', pause: 'Room paused', play: 'Room resumed', seek: 'Room seek' };
const statuses = {
  playing: 'Playing',
  paused: 'Paused',
  buffering: 'Buffering',
  reconnecting: 'Reconnecting',
  seeking: 'Seeking',
  starting: 'Starting',
  error: 'Playback error',
};
const canSee = state => !!state?.capabilities?.roomSettings;
const text = (node, value) => {
  if (node.textContent !== value) node.textContent = value;
};
const offsetText = value => (value > 0 ? '+' : '') + value + ' ms';
const ago = ms => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds >= 60 ? Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's ago' : seconds + 's ago';
};

function drawChart(canvas, { from, now, samples, series, interval, markers, spread, inspection }) {
  const width = canvas.clientWidth,
    height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  const style = getComputedStyle(canvas);
  const left = 52,
    right = width - 12,
    top = 16,
    bottom = height - 30;
  let bound = 100;
  for (const { points } of series)
    for (const [, value] of points) if (value !== null) bound = Math.max(bound, Math.abs(value));
  const magnitude = 10 ** Math.floor(Math.log10(bound / 2));
  const step = ([1, 2, 5, 10].find(value => value * magnitude >= bound / 2) || 10) * magnitude;
  const max = 2 * step,
    min = spread ? 0 : -max;
  const x = time => left + ((time - from) / (now - from)) * (right - left);
  const y = value => bottom - ((value - min) / (max - min)) * (bottom - top);
  ctx.font = `11px ${style.getPropertyValue('--font-body').trim() || 'system-ui'}`;
  ctx.textBaseline = 'middle';
  for (let value = min; value <= max; value += spread ? step / 2 : step) {
    ctx.strokeStyle = style.getPropertyValue(value === 0 ? '--muted' : '--border');
    ctx.beginPath();
    ctx.moveTo(left, y(value));
    ctx.lineTo(right, y(value));
    ctx.stroke();
    ctx.fillStyle = style.getPropertyValue('--muted');
    ctx.textAlign = 'right';
    ctx.fillText(value + ' ms', left - 7, y(value), left - 8);
  }
  for (const fraction of [0, 0.5, 1]) {
    const at = from + (now - from) * fraction;
    ctx.textAlign = fraction === 0 ? 'left' : fraction === 1 ? 'right' : 'center';
    ctx.fillText(fraction === 1 ? 'Now' : '−' + ago(now - at).replace(' ago', ''), x(at), bottom + 17);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(left - 1, top - 1, right - left + 2, bottom - top + 2);
  ctx.clip();
  for (const [at, event] of markers) {
    ctx.strokeStyle = style.getPropertyValue(event === 'seek' ? '--warning' : '--muted');
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(x(at), top);
    ctx.lineTo(x(at), bottom);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // A blank stretch means no reliable sample. It must never read as a flat zero line.
  for (const { points, color, index } of series) {
    ctx.strokeStyle = ctx.fillStyle = style.getPropertyValue(color);
    ctx.lineWidth = spread ? 2.5 : 2;
    ctx.lineJoin = 'round';
    ctx.setLineDash(index >= tabColors.length ? [5, 3] : []);
    let previous;
    ctx.beginPath();
    for (const [at, value] of points) {
      if (value === null) {
        previous = undefined;
        continue;
      }
      if (previous === undefined || at - previous > 1.6 * interval) ctx.moveTo(x(at), y(value));
      else ctx.lineTo(x(at), y(value));
      previous = at;
    }
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [at, value] of points) {
      if (value === null) continue;
      ctx.beginPath();
      ctx.arc(x(at), y(value), spread ? 1.65 : 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const latest = samples.at(-1);
  if (spread && latest && latest[1] !== null) {
    ctx.beginPath();
    ctx.fillStyle = style.getPropertyValue('--primary');
    ctx.arc(x(latest[0]), y(latest[1]), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (inspection !== undefined) {
    ctx.strokeStyle = style.getPropertyValue('--text');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(inspection), top);
    ctx.lineTo(x(inspection), bottom);
    ctx.stroke();
  }
  ctx.restore();
}

function recentActivity(points) {
  let previous, buffering, reconnect;
  for (const [at, , status, rejoined] of points) {
    if (status === 'buffering' && previous !== 'buffering') buffering = at;
    if (rejoined || (status === 'reconnecting' && previous !== 'reconnecting')) reconnect = at;
    previous = status;
  }
  return [buffering && [buffering, 'Buffered'], reconnect && [reconnect, 'Reconnect']].filter(Boolean);
}

export function mountRoomSync({ request, every, getState }) {
  const $ = id => document.getElementById('room-sync-' + id);
  const trigger = $('spread'),
    dialog = $('dialog'),
    range = $('window'),
    view = $('view'),
    freeze = $('freeze'),
    scrub = $('time'),
    canvas = $('chart'),
    rows = new Map();
  const close = $('close');
  close.append(icon(document, 'close'));
  close.addEventListener('click', () => dialogs.close(dialog));
  dialogs.register(dialog);
  window.addEventListener('uburoom-theme', () => renderGraph());

  let data,
    roomId,
    stop,
    controller,
    chart,
    frozen,
    secondsBack = 0;
  function reset() {
    data = chart = undefined;
    for (const row of rows.values()) {
      row.element.remove();
      row.option.remove();
    }
    rows.clear();
    view.value = 'spread';
    canvas.hidden = true;
    $('inspector').hidden = true;
    secondsBack = 0;
    text($('video'), '');
    text($('coverage'), '');
    text($('chart-title'), 'Room spread');
    $('status').hidden = false;
    text($('status'), 'Loading room sync…');
    text($('caption'), '');
  }

  function renderGraph() {
    if (!data || !dialog.open) return;
    const now = data.now,
      from = now - Number(range.value) * 60 * 1000,
      samples = data.samples.filter(([at]) => at >= from),
      markers = data.events.filter(([at]) => at >= from);
    const seconds = Number(range.value) * 60;
    secondsBack = Math.min(seconds, secondsBack);
    scrub.max = String(seconds);
    scrub.value = String(seconds - secondsBack);
    const inspection = secondsBack ? now - secondsBack * 1000 : undefined;
    const selectedSample =
      inspection === undefined ? samples.at(-1) : samples.findLast(([at]) => at <= inspection + data.interval / 2);
    const sampleAvailable =
      selectedSample &&
      Math.abs((inspection ?? now) - selectedSample[0]) <=
        (inspection === undefined ? 2 * data.interval : data.interval / 2);
    const people = new Map();
    for (const viewer of data.viewers) {
      if (!people.has(viewer.person)) people.set(viewer.person, []);
      people.get(viewer.person).push(viewer.id);
    }
    const current = new Set(data.viewers.map(viewer => viewer.id));
    for (const [id, row] of rows) {
      if (current.has(id)) continue;
      row.element.remove();
      row.option.remove();
      rows.delete(id);
    }
    if (!view.value) view.value = 'spread';
    const selected = view.value,
      spread = selected === 'spread',
      series = [];
    let currentName;
    for (const [index, viewer] of data.viewers.entries()) {
      const { id, points } = viewer;
      const tabs = people.get(viewer.person),
        name = viewer.name + (tabs.length > 1 ? ' · Tab ' + (tabs.indexOf(id) + 1) : ''),
        color = tabColors[index % tabColors.length];
      const inRange = points.filter(([at]) => at >= from);
      let row = rows.get(id);
      if (!row) {
        const option = new Option(name, 'viewer:' + id);
        view.append(option);
        const element = document.createElement('li'),
          button = document.createElement('button'),
          status = document.createElement('span'),
          activity = document.createElement('small');
        button.type = 'button';
        button.className = 'quiet';
        button.addEventListener('click', () => {
          view.value = option.value;
          renderGraph();
        });
        element.append(button, status, activity);
        $('viewers').append(element);
        rows.set(id, (row = { element, option, button, status, activity }));
      }
      row.element.hidden = !inRange.length;
      text(row.option, name);
      text(row.button, name);
      row.button.style.setProperty('--sync-series', 'var(' + color + ')');
      row.button.setAttribute('aria-pressed', String(selected === row.option.value));
      const latest = sampleAvailable && inRange.findLast(([at]) => at === selectedSample[0]);
      text(
        row.status,
        latest && latest[1] !== null ? offsetText(latest[1]) : (latest && statuses[latest[2]]) || 'No timing',
      );
      text(
        row.activity,
        recentActivity(inspection === undefined ? inRange : inRange.filter(([at]) => at <= inspection))
          .map(([at, label]) => label + ' · ' + ago(now - at))
          .join('  /  '),
      );
      row.activity.hidden = !row.activity.textContent;
      if (selected === row.option.value) currentName = name;
      if (selected === 'all' || selected === row.option.value) series.push({ points: inRange, color, index });
    }
    if (spread) series.push({ points: samples, color: '--primary', index: 0 });
    text($('video'), data.title || 'No video in this room');
    text($('chart-title'), spread ? 'Room spread' : currentName || 'Viewer offsets');
    const timeLabel = inspection === undefined ? 'Latest' : ago(now - inspection);
    const coverage = sampleAvailable
      ? (spread && selectedSample[1] !== null ? selectedSample[1] + ' ms spread · ' : '') +
        selectedSample[2] +
        ' of ' +
        selectedSample[3] +
        ' reporting'
      : 'No report';
    text($('coverage'), samples.length ? timeLabel + ' · ' + coverage : '');
    scrub.setAttribute('aria-valuetext', timeLabel + '. ' + coverage);
    const hasPoints = series.some(line => line.points.some(([, value]) => value !== null));
    $('status').hidden = hasPoints;
    canvas.hidden = !hasPoints;
    $('inspector').hidden = !samples.length;
    text(
      $('status'),
      spread ? 'Waiting for timing from at least two players.' : 'No reliable timing in this time range.',
    );
    const recentMarkers = markers.slice(-3).map(([at, kind]) => events[kind] + ' · ' + ago(now - at));
    text(
      $('caption'),
      [
        spread ? 'Gap between the leading and trailing players.' : 'Positive is ahead of the room. Negative is behind.',
        'Gaps mean timing was unavailable.',
        recentMarkers.join(' / '),
      ]
        .filter(Boolean)
        .join(' '),
    );
    canvas.setAttribute('aria-label', $('chart-title').textContent + '. ' + $('coverage').textContent);
    chart = { from, now, samples, series, interval: data.interval, markers, spread, inspection };
    if (hasPoints) drawChart(canvas, chart);
  }

  async function refresh() {
    if (!dialog.open || frozen || controller) return;
    const current = (controller = new AbortController());
    try {
      // Load all three ranges together so switching ranges works while frozen.
      const next = await request('room.sync', { roomId, args: { minutes: 15 } }, { signal: current.signal });
      const state = getState();
      if (current.signal.aborted || !dialog.open || !canSee(state) || state.id !== roomId) return;
      if (next.mediaVersion !== (state.mediaId ? state.mediaVersion : undefined)) return;
      if (data?.mediaVersion !== next.mediaVersion) reset();
      data = next;
      renderGraph();
    } catch (error) {
      if (current.signal.aborted || !dialog.open) return;
      if (error.status === 403 || error.status === 404) {
        reset();
        dialogs.close(dialog);
        return;
      }
      $('status').hidden = false;
      text($('status'), data ? 'Reconnecting to room sync…' : 'Room sync could not load. Retrying…');
    } finally {
      if (controller === current) controller = undefined;
    }
  }

  trigger.addEventListener('click', () => {
    if (!canSee(getState())) return;
    roomId = getState().id;
    frozen = false;
    freeze.setAttribute('aria-pressed', 'false');
    text(freeze, 'Freeze');
    reset();
    dialogs.open(dialog, trigger);
    stop = every(5000, () => void refresh());
    void refresh();
  });
  dialog.addEventListener('close', () => {
    controller?.abort();
    controller = undefined;
    stop?.();
    stop = undefined;
    reset();
  });
  freeze.addEventListener('click', () => {
    frozen = !frozen;
    freeze.setAttribute('aria-pressed', String(frozen));
    text(freeze, frozen ? 'Resume live' : 'Freeze');
    if (frozen) controller?.abort();
    else void refresh();
  });
  range.addEventListener('change', renderGraph);
  scrub.addEventListener('input', () => {
    secondsBack = Number(scrub.max) - scrub.valueAsNumber;
    renderGraph();
  });
  view.addEventListener('change', renderGraph);
  new ResizeObserver(() => {
    if (dialog.open && chart && !canvas.hidden) drawChart(canvas, chart);
  }).observe(canvas);

  return {
    render(state) {
      const allowed = canSee(state);
      trigger.hidden = !allowed;
      const spread = state?.syncSpread;
      const spreadSummary = spread ? 'Spread ' + spread.p50Ms + ' ms · p95 ' + spread.p95Ms + ' ms' : '';
      controls.content(trigger, { icon: 'graph', label: 'Room sync' });
      trigger.title =
        (spreadSummary ? spreadSummary + ' · ' : '') +
        'Open room sync. Reported by players; screen and speaker delay are not included.';
      trigger.setAttribute('aria-label', spreadSummary ? 'Room sync: ' + spreadSummary : 'Open room sync');
      if (!dialog.open) return;
      if (!allowed || state.id !== roomId) {
        reset();
        dialogs.close(dialog);
      } else if (data && data.mediaVersion !== (state.mediaId ? state.mediaVersion : undefined)) {
        controller?.abort();
        controller = undefined;
        reset();
        frozen = false;
        freeze.setAttribute('aria-pressed', 'false');
        text(freeze, 'Freeze');
        void refresh();
      }
    },
  };
}
