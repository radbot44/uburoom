// @ts-check
/* Single authority for stage overlay card precedence.
 * Order: system readiness/recovery > break > poll > readiness check > announcement.
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
  /** @type {Array<{ kind: string, priority: number, element: () => HTMLElement | null, getActivity: (state: any) => any, render: (state: any, activity: any) => void }>} */
  const cards = [];

  return {
    register(card) {
      cards.push({
        ...card,
        priority: card.priority ?? PRIORITY[card.kind] ?? 0,
      });
      cards.sort((a, b) => b.priority - a.priority);
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
          winner = card;
          winnerActivity = activity;
          break;
        }
      }

      for (const card of cards) {
        const el = card.element();
        if (!el) continue;
        if (card === winner && winnerActivity) {
          card.render(state, winnerActivity);
          el.hidden = false;
        } else {
          el.hidden = true;
        }
      }
      return winner?.kind || null;
    },
  };
}
