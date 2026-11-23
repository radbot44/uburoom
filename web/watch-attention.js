// @ts-check
/* Attention model for live room activities (readiness checks, breaks, polls, announcements).
 * Tracks dismissed/minimized activity IDs in sessionStorage and computes the Now list and badge count.
 */

const STORAGE_KEY = 'uburoom.dismissedActivities';
const MAX_STORED = 50;

function loadDismissed() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter(id => typeof id === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function saveDismissed(set) {
  try {
    const list = [...set].slice(-MAX_STORED);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* Ignore storage quota errors. */
  }
}

function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * @param {any} activity
 * @param {any} state
 * @param {string | undefined} selfId
 */
export function activityNeedsMe(activity, state, selfId, dismissed) {
  if (!activity || !selfId) return false;
  if (activity.kind === 'check') {
    const admitted = (Array.isArray(state?.participants) ? state.participants : []).some(
      person => person.id === selfId && person.present && !person.pending,
    );
    if (!admitted) return false;
    if (activity.mode === 'break') {
      return !activity.answers?.[selfId];
    }
    return activity.askedBy !== selfId && !activity.answers?.[selfId];
  }
  if (activity.kind === 'poll') {
    if (activity.status === 'tie') return !!activity.can?.close;
    return activity.status === 'open' && !activity.myVote;
  }
  if (activity.kind === 'announcement') {
    return activity.senderId !== selfId && !dismissed.has(activity.id);
  }
  return false;
}

/**
 * @param {any} activity
 * @param {any} state
 * @param {number | undefined} now
 */
export function describeNowItem(activity, state, now) {
  if (activity.kind === 'check') {
    const admitted = (Array.isArray(state?.participants) ? state.participants : []).filter(
      person => person.present && !person.pending,
    );
    const answers = activity.answers && typeof activity.answers === 'object' ? activity.answers : {};
    const readyCount = admitted.filter(person => answers[person.id] === 'ready').length;
    if (activity.mode === 'break') {
      let title = 'Break';
      if (now !== undefined) {
        if (activity.resumingAt > now) title += ` · resuming in ${Math.ceil((activity.resumingAt - now) / 1000)}s`;
        else if (activity.breakEndsAt > now) title += ` · back in ${formatRemaining(activity.breakEndsAt - now)}`;
        else title += ' · ready to resume';
      }
      return {
        title,
        meta: `${readyCount}/${admitted.length} ready`,
        symbol: 'clock',
      };
    }
    return {
      title: 'Readiness check',
      meta: `${readyCount}/${admitted.length} ready`,
      symbol: 'users-check',
    };
  }
  if (activity.kind === 'poll') {
    const remaining =
      activity.status === 'open' && now !== undefined && activity.closesAt > now
        ? `${formatRemaining(activity.closesAt - now)} left`
        : activity.status === 'closed'
          ? 'Results'
          : activity.status === 'tie'
            ? 'Host chooses winner'
            : 'Open';
    return {
      title: `Poll · ${activity.question || 'Vote'}`,
      meta: remaining,
      symbol: 'chart-bar',
    };
  }
  if (activity.kind === 'announcement') {
    return {
      title: activity.text || 'Announcement',
      meta: activity.senderName ? `From ${activity.senderName}` : 'Announcement',
      symbol: 'speakerphone',
    };
  }
  return { title: activity.kind, meta: '', symbol: 'info-circle' };
}

export function createAttention({ onChange = () => {} } = {}) {
  const dismissed = loadDismissed();

  return {
    isDismissed(id) {
      return !!id && dismissed.has(id);
    },
    dismiss(id) {
      if (!id || dismissed.has(id)) return;
      dismissed.add(id);
      saveDismissed(dismissed);
      onChange();
    },
    reopen(id) {
      if (!id || !dismissed.has(id)) return false;
      dismissed.delete(id);
      saveDismissed(dismissed);
      onChange();
      return true;
    },
    /**
     * Computes the live Now items and the attention badge count.
     * @param {any} state
     * @param {string | undefined} selfId
     * @param {number | undefined} now
     */
    compute(state, selfId, now) {
      const list = Array.isArray(state?.activities) ? state.activities : [];
      const items = list.map(activity => {
        const desc = describeNowItem(activity, state, now);
        const needsMe = activityNeedsMe(activity, state, selfId, dismissed);
        return {
          id: activity.id,
          kind: activity.kind,
          title: desc.title,
          meta: desc.meta,
          symbol: desc.symbol,
          needsMe,
          dismissed: dismissed.has(activity.id),
          activity,
        };
      });
      const badgeCount = items.filter(item => item.needsMe).length;
      return { items, badgeCount };
    },
  };
}
