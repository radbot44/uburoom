// @ts-check
/* Live activities registry for uburoom rooms.
 * Pure synchronization core: no Plex, Discord, HTTP, WebSocket, or SQLite.
 * Ephemeral live tools (readiness check, break, announcement, poll) register
 * here so the room coordinator, timer scheduling, cloning, pruning, snapshotting
 * and journal logging handle every activity uniformly.
 */
import { senderName } from './protocol.mjs';

export const HUMAN_CHECK_TTL_MS = 120000;
export const BREAK_AUTO_RESUME_COUNTDOWN_MS = 3000;

const defaultCreateId = () => globalThis.crypto.randomUUID();

/**
 * @typedef {{
 *   kind: string,
 *   commands: readonly string[],
 *   clone: (activity: any) => any,
 *   deadline?: (room: any, activity: any, now: number) => { due?: number, exact?: boolean } | number | undefined,
 *   isStale?: (room: any, activity: any, now: number) => boolean,
 *   expire?: (room: any, activity: any, now: number, ctx?: any) => boolean,
 *   onPlayback?: (room: any, activity: any, change: string, now: number, ctx?: any) => boolean,
 *   onLeave?: (room: any, activity: any, userIds: Iterable<string>, hasPresence: (userId: string) => boolean) => boolean,
 *   stamp: (activity: any) => string,
 *   snapshot: (room: any, activity: any, now: number, can?: (action: string) => boolean, actor?: any) => any,
 *   apply: (room: any, command: { action: string, args?: any }, actor: any, options?: any) => { status: 'applied'|'expired'|'unavailable'|'unsupported'|'forbidden', message: string, changed?: boolean, journal?: any[] },
 * }} ActivityDefinition
 */

/** @type {Map<string, ActivityDefinition>} */
const REGISTRY = new Map();
/** @type {Map<string, ActivityDefinition>} */
const COMMAND_INDEX = new Map();

/** @param {ActivityDefinition} def */
export function registerActivity(def) {
  REGISTRY.set(def.kind, def);
  for (const cmd of def.commands) COMMAND_INDEX.set(cmd, def);
  return def;
}

/** @param {string} kind */
export function getActivityDefinition(kind) {
  return REGISTRY.get(kind);
}

/** @param {string} action */
export function activityForCommand(action) {
  return COMMAND_INDEX.get(action);
}

/** @param {any} room @returns {Map<string, any>} */
export function ensureActivities(room) {
  if (!(room.activities instanceof Map)) room.activities = new Map();
  return room.activities;
}

/** @param {any} room */
export function syncLegacyHumanCheck(room) {
  room.humanCheck = room.activities instanceof Map ? room.activities.get('check') : undefined;
}

/** @param {Map<string, any> | undefined} activities */
export function cloneActivities(activities) {
  const next = new Map();
  if (activities instanceof Map) {
    for (const [kind, activity] of activities) {
      const def = REGISTRY.get(kind);
      next.set(kind, def ? def.clone(activity) : { ...activity });
    }
  }
  return next;
}

/**
 * Earliest timer deadline across all active room activities.
 * @param {any} room
 * @param {number} now
 */
export function nextActivityDeadline(room, now) {
  let due = Infinity;
  let exact = false;
  if (!(room.activities instanceof Map)) return { due: undefined, exact: false };
  for (const [kind, activity] of room.activities) {
    const def = REGISTRY.get(kind);
    if (!def?.deadline || !activity) continue;
    const raw = def.deadline(room, activity, now);
    const at = typeof raw === 'number' ? raw : raw?.due;
    const isExact = typeof raw === 'object' && !!raw?.exact;
    if (!Number.isFinite(at)) continue;
    if (at < due || (at === due && isExact)) {
      due = at;
      exact = isExact;
    }
  }
  return { due: due === Infinity ? undefined : due, exact };
}

/**
 * Expires or advances timed activities on settle/timer.
 * @param {any} room
 * @param {number} now
 * @param {any} [ctx]
 * @returns {boolean}
 */
export function expireActivities(room, now, ctx = undefined) {
  if (!(room.activities instanceof Map) || !room.activities.size) return false;
  let changed = false;
  for (const [kind, activity] of [...room.activities.entries()]) {
    const def = REGISTRY.get(kind);
    if (!def) continue;
    if (def.expire) {
      if (def.expire(room, activity, now, ctx)) changed = true;
    } else if (def.isStale?.(room, activity, now)) {
      room.activities.delete(kind);
      changed = true;
    }
  }
  if (changed) syncLegacyHumanCheck(room);
  return changed;
}

/**
 * Notifies active activities of a playback/lifecycle transition ('play' | 'pause' | 'media-change' | 'close').
 * @param {any} room
 * @param {string} change
 * @param {number} [now]
 * @param {any} [ctx]
 * @returns {boolean}
 */
export function onActivitiesPlayback(room, change, now = Date.now(), ctx = undefined) {
  if (!(room.activities instanceof Map) || !room.activities.size) return false;
  let changed = false;
  for (const [kind, activity] of [...room.activities.entries()]) {
    if (change === 'close') {
      room.activities.delete(kind);
      changed = true;
      continue;
    }
    const def = REGISTRY.get(kind);
    if (def?.onPlayback?.(room, activity, change, now, ctx)) changed = true;
  }
  if (changed) syncLegacyHumanCheck(room);
  return changed;
}

/**
 * Prunes departed users from active activities.
 * @param {any} room
 * @param {Iterable<string>} userIds
 * @param {(userId: string) => boolean} hasPresence
 * @returns {boolean}
 */
export function onActivitiesLeave(room, userIds, hasPresence) {
  if (!(room.activities instanceof Map) || !room.activities.size) return false;
  const list = [...userIds].filter(Boolean);
  if (!list.length) return false;
  let changed = false;
  for (const [kind, activity] of room.activities) {
    const def = REGISTRY.get(kind);
    if (def?.onLeave?.(room, activity, list, hasPresence)) changed = true;
  }
  if (changed) syncLegacyHumanCheck(room);
  return changed;
}

/** @param {Map<string, any> | undefined} activities */
export function activitiesStamp(activities) {
  if (!(activities instanceof Map) || !activities.size) return '';
  const parts = [];
  for (const [kind, activity] of [...activities.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const def = REGISTRY.get(kind);
    if (def && activity) parts.push(`${kind}:${def.stamp(activity)}`);
  }
  return parts.join(';');
}

/**
 * Produces JSON-safe snapshots for all active, non-stale activities on the room.
 * @param {any} room
 * @param {number} [now]
 * @param {(action: string) => boolean} [can]
 * @param {any} [actor]
 */
export function snapshotActivities(room, now = Date.now(), can = undefined, actor = undefined) {
  if (!(room.activities instanceof Map) || !room.activities.size) return [];
  const out = [];
  for (const [kind, activity] of room.activities) {
    const def = REGISTRY.get(kind);
    if (!def || !activity || def.isStale?.(room, activity, now)) continue;
    const snap = def.snapshot(room, activity, now, can, actor);
    if (snap) out.push(snap);
  }
  return out;
}

/**
 * Applies an activity command through its registered definition.
 * @param {any} room
 * @param {{ action: string, args?: any }} command
 * @param {any} actor
 * @param {any} [options]
 * @returns {{ status: 'applied'|'expired'|'unavailable'|'unsupported'|'forbidden', message: string, changed?: boolean, journal?: any[] }}
 */
export function applyActivityCommand(room, command, actor = undefined, options = {}) {
  const def = activityForCommand(command?.action);
  if (!def) return { status: 'unsupported', message: 'Unsupported command or value.' };
  const result = def.apply(room, command, actor, options);
  syncLegacyHumanCheck(room);
  return result;
}

// ---------------------------------------------------------------------------
// Built-in activity: Human readiness check ('check')
// ---------------------------------------------------------------------------

function isCheckStale(room, check, now = Date.now()) {
  if (!check) return false;
  return now >= check.expiresAt || check.mediaVersion !== room.mediaVersion || check.hadMedia !== !!room.media;
}

function createCheck(room, actor = undefined, options = {}) {
  const now = options.now ?? Date.now();
  const createId = options.createId || defaultCreateId;
  const askedBy = actor?.userId || room.hostId;
  const viewerName = askedBy && [...room.viewers.values()].find(viewer => viewer.userId === askedBy)?.name;
  const askedByName = senderName(actor?.name || viewerName || (askedBy === room.hostId ? room.hostName : ''), 'Host');
  const answers = new Map();
  if (askedBy) answers.set(askedBy, 'ready');
  const check = {
    id: createId(),
    kind: 'check',
    askedBy,
    askedByName,
    askedAt: now,
    startedAt: now,
    expiresAt: now + HUMAN_CHECK_TTL_MS,
    mediaVersion: room.mediaVersion,
    hadMedia: !!room.media,
    answers,
  };
  ensureActivities(room).set('check', check);
  syncLegacyHumanCheck(room);
  return check;
}

function allPresentReady(room, check) {
  const userIds = new Set();
  for (const viewer of room.viewers.values()) if (viewer.userId) userIds.add(viewer.userId);
  if (!userIds.size) return false;
  for (const userId of userIds) {
    if (check.answers.get(userId) !== 'ready') return false;
  }
  return true;
}

function canAutoResumeBreak(room, check, now) {
  return (
    check.mode === 'break' &&
    !!check.autoResume &&
    now >= check.breakEndsAt &&
    !room.closed &&
    !room.frozen &&
    !room.waitingForHost &&
    !room.recovery &&
    !room.bufferingViewerId &&
    !room.readinessTimedOut &&
    !!room.media &&
    allPresentReady(room, check)
  );
}

export const CHECK_ACTIVITY = registerActivity({
  kind: 'check',
  commands: Object.freeze(['check.ask', 'check.reply', 'check.clear', 'break.start', 'break.extend', 'break.end']),
  clone(check) {
    return {
      ...check,
      answers: new Map(check.answers),
    };
  },
  deadline(_room, check, now) {
    if (check.mode === 'break') {
      if (Number.isFinite(check.resumingAt)) return { due: check.resumingAt, exact: true };
      if (Number.isFinite(check.breakEndsAt) && now < check.breakEndsAt) return { due: check.breakEndsAt, exact: true };
    }
    return Number.isFinite(check.expiresAt) ? check.expiresAt : undefined;
  },
  isStale: isCheckStale,
  expire(room, check, now, ctx) {
    if (isCheckStale(room, check, now)) {
      room.activities.delete('check');
      return true;
    }
    if (check.mode === 'break' && check.autoResume) {
      if (canAutoResumeBreak(room, check, now)) {
        if (!check.resumingAt) {
          check.resumingAt = now + BREAK_AUTO_RESUME_COUNTDOWN_MS;
          return true;
        }
        if (now >= check.resumingAt) {
          room.activities.delete('check');
          ctx?.onBreakAutoResume?.(room, now);
          return true;
        }
      } else if (check.resumingAt) {
        check.resumingAt = undefined;
        return true;
      }
    }
    return false;
  },
  onPlayback(room, _check, change) {
    if (change === 'play') {
      return room.activities.delete('check');
    }
    return false;
  },
  onLeave(_room, check, userIds, hasPresence) {
    const answers = check?.answers;
    if (!answers?.size) return false;
    let removed = false;
    for (const userId of userIds) {
      if (userId && !hasPresence(userId) && answers.delete(userId)) removed = true;
    }
    return removed;
  },
  stamp(check) {
    return `${check.id}:${check.mode || 'check'}:${check.breakEndsAt || 0}:${check.resumingAt || 0}:${check.expiresAt}:${[
      ...check.answers.entries(),
    ]
      .map(([userId, status]) => `${userId}=${status}`)
      .sort()
      .join(',')}`;
  },
  snapshot(room, check, now, can) {
    if (!check || isCheckStale(room, check, now)) return undefined;
    /** @type {Record<string, string>} */
    const answers = {};
    for (const [userId, status] of check.answers) {
      if (userId === '__proto__' || userId === 'constructor' || userId === 'prototype') continue;
      answers[userId] = status;
    }
    const canManage = can ? !!can('check.ask') : undefined;
    return {
      id: check.id,
      kind: 'check',
      mode: check.mode || 'check',
      startedAt: check.startedAt ?? check.askedAt,
      askedBy: check.askedBy,
      askedByName: check.askedByName,
      askedAt: check.askedAt,
      expiresAt: check.expiresAt,
      ...(check.mode === 'break'
        ? {
            durationMinutes: check.durationMinutes,
            breakEndsAt: check.breakEndsAt,
            autoResume: !!check.autoResume,
            resumingAt: check.resumingAt ?? null,
          }
        : {}),
      answers,
      ...(canManage !== undefined ? { can: { clear: canManage, play: canManage, extend: canManage } } : {}),
    };
  },
  apply(room, command, actor = undefined, options = {}) {
    const now = options.now ?? Date.now();
    const createId = options.createId || defaultCreateId;
    const { action, args = {} } = command || {};
    const activities = ensureActivities(room);
    const existing = activities.get('check');
    if (existing && isCheckStale(room, existing, now)) {
      activities.delete('check');
      room.revision++;
    }
    if (action === 'check.ask') {
      if (room.closed || !room.viewers.size) {
        return { status: 'unavailable', message: 'No viewer is connected.' };
      }
      const check = createCheck(room, actor, { now, createId });
      return {
        status: 'applied',
        message: 'Readiness check started.',
        changed: true,
        journal: [{ kind: 'check.start', actor, data: { checkId: check.id } }],
      };
    }
    if (action === 'break.start') {
      if (room.closed || !room.viewers.size) {
        return { status: 'unavailable', message: 'No viewer is connected.' };
      }
      const minutes = Number(args.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
        return { status: 'unsupported', message: 'Choose a break length between 1 and 120 minutes.' };
      }
      const askedBy = actor?.userId || room.hostId;
      const viewerName = askedBy && [...room.viewers.values()].find(v => v.userId === askedBy)?.name;
      const askedByName = senderName(
        actor?.name || viewerName || (askedBy === room.hostId ? room.hostName : ''),
        'Host',
      );
      const breakEndsAt = now + minutes * 60000;
      const brk = {
        id: createId(),
        kind: 'check',
        mode: 'break',
        askedBy,
        askedByName,
        askedAt: now,
        startedAt: now,
        durationMinutes: minutes,
        breakEndsAt,
        expiresAt: breakEndsAt + HUMAN_CHECK_TTL_MS,
        autoResume: !!args.autoResume,
        resumingAt: undefined,
        mediaVersion: room.mediaVersion,
        hadMedia: !!room.media,
        answers: new Map(),
      };
      activities.set('check', brk);
      options.onBreakPause?.(room, now);
      return {
        status: 'applied',
        message: `Break started (${minutes} min).`,
        changed: true,
        journal: [{ kind: 'break.start', actor, data: { minutes, autoResume: brk.autoResume } }],
      };
    }
    if (action === 'break.extend') {
      const current = activities.get('check');
      if (current?.mode !== 'break' || (args.checkId !== undefined && current.id !== args.checkId)) {
        return { status: 'expired', message: 'This break has ended.' };
      }
      const addMinutes = args.minutes === undefined ? 5 : Number(args.minutes);
      if (!Number.isInteger(addMinutes) || addMinutes < 1 || addMinutes > 60) {
        return { status: 'unsupported', message: 'Choose an extension between 1 and 60 minutes.' };
      }
      current.breakEndsAt = Math.max(now, current.breakEndsAt) + addMinutes * 60000;
      current.expiresAt = current.breakEndsAt + HUMAN_CHECK_TTL_MS;
      current.resumingAt = undefined;
      return {
        status: 'applied',
        message: `Break extended by ${addMinutes} min.`,
        changed: true,
        journal: [{ kind: 'break.extend', actor, data: { minutes: addMinutes } }],
      };
    }
    if (action === 'break.end' || action === 'check.clear') {
      if (room.closed) return { status: 'unavailable', message: 'Room unavailable' };
      const current = activities.get('check');
      if (
        (action === 'break.end' && current?.mode !== 'break') ||
        (args.checkId !== undefined && current?.id !== args.checkId)
      ) {
        return { status: 'expired', message: 'This readiness check has ended.' };
      }
      const changed = activities.delete('check');
      const wasBreak = current?.mode === 'break';
      return {
        status: 'applied',
        message: wasBreak ? 'Break ended.' : 'Readiness check cleared.',
        changed,
        ...(changed
          ? {
              journal: [
                wasBreak
                  ? { kind: 'break.end', actor, data: { reason: 'ended' } }
                  : { kind: 'check.end', actor, data: { checkId: current?.id, reason: 'cancelled' } },
              ],
            }
          : {}),
      };
    }
    if (action === 'check.reply') {
      if (room.closed || !room.viewers.size) {
        return { status: 'unavailable', message: 'No viewer is connected.' };
      }
      const current = activities.get('check');
      if (!current) return { status: 'expired', message: 'Readiness check expired.' };
      if (args.checkId !== undefined && args.checkId !== current.id) {
        return { status: 'expired', message: 'Readiness check expired.' };
      }
      const userId = actor?.userId;
      if (typeof userId !== 'string' || ![...room.viewers.values()].some(viewer => viewer.userId === userId)) {
        return { status: 'unavailable', message: 'Join the room first.' };
      }
      if (args.status !== 'ready' && args.status !== 'hold') {
        return { status: 'unavailable', message: 'Choose Ready or Need a moment.' };
      }
      const previous = current.answers.get(userId);
      current.answers.set(userId, args.status);
      let countdownChanged = false;
      if (current.mode === 'break' && current.autoResume) {
        if (canAutoResumeBreak(room, current, now) && !current.resumingAt) {
          current.resumingAt = now + BREAK_AUTO_RESUME_COUNTDOWN_MS;
          countdownChanged = true;
        } else if (args.status !== 'ready' && current.resumingAt) {
          current.resumingAt = undefined;
          countdownChanged = true;
        }
      }
      return {
        status: 'applied',
        message: 'Readiness reply recorded.',
        changed: previous !== args.status || countdownChanged,
      };
    }
    return { status: 'unsupported', message: 'Unsupported command or value.' };
  },
});

// ---------------------------------------------------------------------------
// Built-in activity: Room polls ('poll')
// ---------------------------------------------------------------------------

export const POLL_RESULTS_TTL_MS = 15000;
export const POLL_TIE_TTL_MS = 120000;

function cryptoRandomIndex(max) {
  if (max <= 1) return 0;
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  let value;
  do {
    globalThis.crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= limit);
  return value % max;
}

function tallyPoll(poll) {
  /** @type {Map<string, Array<{id: string, name: string}>>} */
  const byOption = new Map(poll.options.map(opt => [opt.id, []]));
  for (const [userId, vote] of poll.votes) {
    const list = byOption.get(vote.optionId);
    if (list) list.push({ id: userId, name: vote.name });
  }
  let maxVotes = -1;
  /** @type {any[]} */
  let leaders = [];
  for (const opt of poll.options) {
    const count = (byOption.get(opt.id) || []).length;
    if (count > maxVotes) {
      maxVotes = count;
      leaders = [opt];
    } else if (count === maxVotes) {
      leaders.push(opt);
    }
  }
  return { byOption, maxVotes, leaders };
}

function resolvePollClose(poll, now, { winnerOptionId = undefined, randomIndex = cryptoRandomIndex } = {}) {
  const { leaders, maxVotes } = tallyPoll(poll);
  if (leaders.length === 1) {
    poll.status = 'closed';
    poll.winnerOptionId = leaders[0].id;
    poll.tiedOptionIds = undefined;
    poll.tieBrokenBy = undefined;
    poll.closedAt = now;
    poll.expiresAt = now + POLL_RESULTS_TTL_MS;
    return { resolved: true, winner: leaders[0], totalTopVotes: maxVotes };
  }
  if (poll.tieRule === 'random') {
    const picked = leaders[randomIndex(leaders.length)];
    poll.status = 'closed';
    poll.winnerOptionId = picked.id;
    poll.tiedOptionIds = leaders.map(o => o.id);
    poll.tieBrokenBy = 'random';
    poll.closedAt = now;
    poll.expiresAt = now + POLL_RESULTS_TTL_MS;
    return { resolved: true, winner: picked, totalTopVotes: maxVotes, tieBrokenBy: 'random' };
  }
  if (winnerOptionId) {
    const picked = leaders.find(o => o.id === winnerOptionId);
    if (!picked) return { resolved: false, error: 'Choose one of the tied options.' };
    poll.status = 'closed';
    poll.winnerOptionId = picked.id;
    poll.tiedOptionIds = leaders.map(o => o.id);
    poll.tieBrokenBy = 'host';
    poll.closedAt = now;
    poll.expiresAt = now + POLL_RESULTS_TTL_MS;
    return { resolved: true, winner: picked, totalTopVotes: maxVotes, tieBrokenBy: 'host' };
  }
  poll.status = 'tie';
  poll.tiedOptionIds = leaders.map(o => o.id);
  poll.expiresAt = now + POLL_TIE_TTL_MS;
  return { resolved: false, tied: true };
}

export const POLL_ACTIVITY = registerActivity({
  kind: 'poll',
  commands: Object.freeze(['poll.start', 'poll.vote', 'poll.close', 'poll.clear']),
  clone(poll) {
    return {
      ...poll,
      options: poll.options.map(opt => ({ ...opt, ...(opt.media ? { media: { ...opt.media } } : {}) })),
      votes: new Map([...poll.votes.entries()].map(([k, v]) => [k, { ...v }])),
      ...(poll.tiedOptionIds ? { tiedOptionIds: [...poll.tiedOptionIds] } : {}),
    };
  },
  deadline(_room, poll, now) {
    if (poll.status === 'open' && Number.isFinite(poll.closesAt)) {
      return { due: poll.closesAt, exact: true };
    }
    if (Number.isFinite(poll.expiresAt)) return poll.expiresAt;
    return undefined;
  },
  isStale(_room, poll, now = Date.now()) {
    if (!poll) return false;
    return poll.status !== 'open' && Number.isFinite(poll.expiresAt) && now >= poll.expiresAt;
  },
  expire(room, poll, now, ctx) {
    if (poll.status === 'open' && Number.isFinite(poll.closesAt) && now >= poll.closesAt) {
      const res = resolvePollClose(poll, now);
      if (res.resolved) {
        ctx?.onPollClosed?.(room, poll, res.winner, now);
      }
      return true;
    }
    if (poll.status !== 'open' && Number.isFinite(poll.expiresAt) && now >= poll.expiresAt) {
      room.activities.delete('poll');
      return true;
    }
    return false;
  },
  stamp(poll) {
    return `${poll.id}:${poll.status}:${poll.winnerOptionId || ''}:${poll.actionError || ''}:${poll.votes.size}:${[
      ...poll.votes.entries(),
    ]
      .map(([u, v]) => `${u}=${v.optionId}`)
      .sort()
      .join(',')}`;
  },
  snapshot(_room, poll, now, can, actor) {
    if (!poll) return undefined;
    if (poll.status !== 'open' && Number.isFinite(poll.expiresAt) && now >= poll.expiresAt) return undefined;
    const { byOption } = tallyPoll(poll);
    /** @type {Record<string, string[]>} */
    const votes = Object.fromEntries(poll.options.map(opt => [opt.id, (byOption.get(opt.id) || []).map(v => v.id)]));
    /** @type {Record<string, Array<{id: string, name: string}>>} */
    const voters = Object.fromEntries(byOption);
    const canManage = can ? !!can('poll.close') : undefined;
    const myVote = actor?.userId ? poll.votes.get(actor.userId)?.optionId || null : null;
    return {
      id: poll.id,
      kind: 'poll',
      status: poll.status,
      closed: poll.status === 'closed',
      startedAt: poll.startedAt,
      closesAt: poll.closesAt ?? null,
      expiresAt: poll.expiresAt ?? null,
      question: poll.question,
      creatorId: poll.creatorId,
      creatorName: poll.creatorName,
      options: poll.options.map(opt => ({
        id: opt.id,
        label: opt.label,
        ...(opt.media ? { media: { ...opt.media } } : {}),
      })),
      onClose: poll.onClose,
      tieRule: poll.tieRule,
      votes,
      voters,
      totalVotes: poll.votes.size,
      myVote,
      ...(poll.winnerOptionId ? { winnerOptionId: poll.winnerOptionId } : {}),
      ...(poll.tiedOptionIds ? { tiedOptionIds: [...poll.tiedOptionIds] } : {}),
      ...(poll.tieBrokenBy ? { tieBrokenBy: poll.tieBrokenBy } : {}),
      ...(poll.actionError ? { actionError: poll.actionError } : {}),
      ...(canManage !== undefined ? { can: { close: canManage, clear: canManage } } : {}),
    };
  },
  apply(room, command, actor = undefined, options = {}) {
    const now = options.now ?? Date.now();
    const createId = options.createId || defaultCreateId;
    const { action, args = {} } = command || {};
    const activities = ensureActivities(room);

    if (action === 'poll.clear') {
      if (room.closed) return { status: 'unavailable', message: 'Room unavailable' };
      if (args.pollId !== undefined && activities.get('poll')?.id !== args.pollId)
        return { status: 'expired', message: 'Poll expired.' };
      const changed = activities.delete('poll');
      return { status: 'applied', message: 'Poll cleared.', changed };
    }

    if (action === 'poll.start') {
      if (room.closed || !room.viewers.size) {
        return { status: 'unavailable', message: 'No viewer is connected.' };
      }
      const creatorId = actor?.userId || room.hostId;
      const viewerName = creatorId && [...room.viewers.values()].find(v => v.userId === creatorId)?.name;
      const creatorName = senderName(
        actor?.name || viewerName || (creatorId === room.hostId ? room.hostName : ''),
        'Host',
      );
      const closesAt = Number.isInteger(args.durationSeconds) ? now + args.durationSeconds * 1000 : undefined;
      const poll = {
        id: createId(),
        kind: 'poll',
        status: 'open',
        question: args.question,
        options: args.options.map((opt, idx) => ({
          id: opt.id || `opt-${idx + 1}`,
          label: opt.label,
          ...(opt.media ? { media: { ...opt.media } } : {}),
        })),
        onClose: args.onClose || 'results',
        tieRule: args.tieRule || 'host',
        creatorId,
        creatorName,
        creatorActor: actor ? { ...actor } : undefined,
        startedAt: now,
        closesAt,
        expiresAt: undefined,
        votes: new Map(),
      };
      activities.set('poll', poll);
      return {
        status: 'applied',
        message: 'Poll started.',
        changed: true,
        journal: [{ kind: 'poll.start', actor, data: { pollId: poll.id, question: poll.question } }],
      };
    }

    if (action === 'poll.vote') {
      if (room.closed || !room.viewers.size) {
        return { status: 'unavailable', message: 'No viewer is connected.' };
      }
      const poll = activities.get('poll');
      if (!poll || poll.status !== 'open' || (Number.isFinite(poll.closesAt) && now >= poll.closesAt))
        return { status: 'expired', message: 'Poll is closed.' };
      if (args.pollId && args.pollId !== poll.id) return { status: 'expired', message: 'Poll expired.' };
      const userId = actor?.userId;
      if (typeof userId !== 'string' || ![...room.viewers.values()].some(v => v.userId === userId)) {
        return { status: 'unavailable', message: 'Join the room first.' };
      }
      if (!poll.options.some(opt => opt.id === args.optionId)) {
        return { status: 'unsupported', message: 'Unknown poll option.' };
      }
      const viewerName = [...room.viewers.values()].find(v => v.userId === userId)?.name;
      const name = senderName(actor?.name || viewerName, 'Participant');
      const prev = poll.votes.get(userId);
      poll.votes.set(userId, { optionId: args.optionId, name });
      return { status: 'applied', message: 'Vote recorded.', changed: prev?.optionId !== args.optionId };
    }

    if (action === 'poll.close') {
      const poll = activities.get('poll');
      if (!poll || (Number.isFinite(poll.expiresAt) && now >= poll.expiresAt))
        return { status: 'expired', message: 'No active poll.' };
      if (args.pollId && args.pollId !== poll.id) return { status: 'expired', message: 'Poll expired.' };
      if (poll.status === 'closed') return { status: 'applied', message: 'Poll already closed.', changed: false };
      const res = resolvePollClose(poll, now, {
        winnerOptionId: args.winnerOptionId,
        randomIndex: options.randomIndex || cryptoRandomIndex,
      });
      if (res.error) return { status: 'unsupported', message: res.error };
      if (res.tied) {
        return { status: 'applied', message: 'Poll tied — choose a winner.', changed: true };
      }
      options.onPollClosed?.(room, poll, res.winner, now);
      return {
        status: 'applied',
        message: 'Poll closed.',
        changed: true,
        journal: [
          {
            kind: 'poll.close',
            actor,
            data: {
              pollId: poll.id,
              question: poll.question,
              winner: res.winner?.label,
              ...(res.tieBrokenBy ? { tieRule: res.tieBrokenBy } : {}),
              action: poll.onClose,
            },
          },
        ],
      };
    }

    return { status: 'unsupported', message: 'Unsupported command or value.' };
  },
});

export { createCheck };

// ---------------------------------------------------------------------------
// Built-in activity: Room announcements ('announcement')
// ---------------------------------------------------------------------------

export const ANNOUNCEMENT_TTL_MS = 12000;
export const ANNOUNCEMENT_MAX_LENGTH = 140;
export const ANNOUNCEMENT_RATE_LIMIT_MS = 10000;

/** @type {WeakMap<any, Map<string, number>>} */
const announcementRates = new WeakMap();

function isAnnouncementStale(_room, ann, now = Date.now()) {
  if (!ann) return false;
  return Number.isFinite(ann.expiresAt) && now >= ann.expiresAt;
}

export const ANNOUNCEMENT_ACTIVITY = registerActivity({
  kind: 'announcement',
  commands: Object.freeze(['announce.send', 'announce.clear']),
  clone(ann) {
    return { ...ann };
  },
  deadline(_room, ann) {
    return Number.isFinite(ann.expiresAt) ? ann.expiresAt : undefined;
  },
  isStale: isAnnouncementStale,
  expire(room, ann, now) {
    if (!isAnnouncementStale(room, ann, now)) return false;
    room.activities.delete('announcement');
    return true;
  },
  stamp(ann) {
    return `${ann.id}:${ann.pinned ? 1 : 0}:${ann.expiresAt ?? 0}`;
  },
  snapshot(room, ann, now, can) {
    if (!ann || isAnnouncementStale(room, ann, now)) return undefined;
    const canClear = can ? !!can('announce.clear') : undefined;
    return {
      id: ann.id,
      kind: 'announcement',
      startedAt: ann.startedAt,
      expiresAt: ann.expiresAt ?? null,
      text: ann.text,
      pinned: !!ann.pinned,
      senderId: ann.senderId,
      senderName: ann.senderName,
      ...(canClear !== undefined ? { can: { clear: canClear } } : {}),
    };
  },
  apply(room, command, actor = undefined, options = {}) {
    const now = options.now ?? Date.now();
    const createId = options.createId || defaultCreateId;
    const { action, args = {} } = command || {};
    const activities = ensureActivities(room);
    if (action === 'announce.clear') {
      if (room.closed) return { status: 'unavailable', message: 'Room unavailable' };
      const changed = activities.delete('announcement');
      return { status: 'applied', message: 'Announcement cleared.', changed };
    }
    if (action === 'announce.send') {
      if (room.closed || !room.viewers.size) {
        return { status: 'unavailable', message: 'No viewer is connected.' };
      }
      const raw = typeof args.text === 'string' ? args.text.replace(/\s+/g, ' ').trim() : '';
      if (!raw || raw.length > ANNOUNCEMENT_MAX_LENGTH) {
        return { status: 'unsupported', message: `Announcement must be 1–${ANNOUNCEMENT_MAX_LENGTH} characters.` };
      }
      const actorId = actor?.userId || room.hostId || '';
      if (actorId) {
        let rates = announcementRates.get(room);
        if (!rates) announcementRates.set(room, (rates = new Map()));
        const lastAt = rates.get(actorId) || 0;
        if (now - lastAt < ANNOUNCEMENT_RATE_LIMIT_MS) {
          return { status: 'unavailable', message: 'Wait a few seconds before sending another announcement.' };
        }
        rates.set(actorId, now);
      }
      const viewerName = actorId && [...room.viewers.values()].find(v => v.userId === actorId)?.name;
      const fromName = senderName(actor?.name || viewerName || (actorId === room.hostId ? room.hostName : ''), 'Host');
      const pinned = !!args.pinned;
      const ann = {
        id: createId(),
        kind: 'announcement',
        text: raw,
        pinned,
        senderId: actorId,
        senderName: fromName,
        startedAt: now,
        expiresAt: pinned ? undefined : now + ANNOUNCEMENT_TTL_MS,
      };
      activities.set('announcement', ann);
      return {
        status: 'applied',
        message: 'Announcement sent.',
        changed: true,
        journal: [{ kind: 'announcement.send', actor, data: { text: raw, pinned } }],
      };
    }
    return { status: 'unsupported', message: 'Unsupported command or value.' };
  },
});
