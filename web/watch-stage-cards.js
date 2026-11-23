// @ts-check
/* Single authority for stage overlay card precedence.
 * System readiness/recovery comes first. Automatic cards prefer break, poll,
 * readiness check and announcement. The viewer can open a specific card from Activity.
 */

const PRIORITY = Object.freeze({
  break: 40,
  poll: 30,
  check: 20,
  announcement: 10,
});

/**
 * @param {{
 *   isSystemCardVisible: () => boolean,
 *   attention: ReturnType<import('./watch-attention.js').createAttention>,
 * }} options
 */
export function createStageCardManager({ isSystemCardVisible, attention }) {
  /** @type {Array<{ kind: string, priority: number, element: () => HTMLElement | null, getActivity: (state: any) => any, render: (state: any, activity: any) => void, hide?: () => void }>} */
  const cards = [];
  let requestedId;

  const manager = {
    register(card) {
      cards.push({
        ...card,
        priority: card.priority ?? PRIORITY[card.kind] ?? 0,
      });
      cards.sort((a, b) => b.priority - a.priority);
    },
    open(id, state) {
      if (isSystemCardVisible()) return false;
      requestedId = id;
      attention.reopen(id);
      return manager.sync(state) === id;
    },
    /**
     * Evaluates card precedence and renders/shows at most one activity card
     * (and none when a system readiness/recovery card is visible).
     * @param {any} state
     */
    sync(state) {
      const systemBusy = !!isSystemCardVisible?.();
      let winner = null;
      let winnerActivity = null;

      if (!systemBusy && state) {
        for (const card of cards) {
          const activity = card.getActivity(state);
          if (!activity) continue;
          if (attention?.isDismissed(activity.id)) continue;
          if (!winner || activity.id === requestedId) {
            winner = card;
            winnerActivity = activity;
          }
          if (activity.id === requestedId) break;
        }
        if (winnerActivity?.id !== requestedId) requestedId = undefined;
      }

      for (const card of cards) {
        const el = card.element();
        if (!el) continue;
        if (card === winner && winnerActivity) {
          card.render(state, winnerActivity);
          el.hidden = false;
        } else {
          if (!el.hidden) card.hide?.();
          el.hidden = true;
        }
      }
      return winnerActivity?.id;
    },
  };
  return manager;
}
