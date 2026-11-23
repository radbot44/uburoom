// @ts-check
/* Client-side room journal store: applies `full` and `append` messages from the
 * `journal` wire lane, handles `replaces` and `journalId` resets, and notifies subscribers.
 */

const JOURNAL_LIMIT = 500;

/**
 * @typedef {{
 *   seq: number,
 *   at: number,
 *   kind: string,
 *   actor?: { id: string, name: string },
 *   audience?: string,
 *   mediaVersion?: string,
 *   replaces?: number,
 *   data?: Record<string, any>,
 * }} JournalEntry
 */

export function createClientJournal() {
  /** @type {string | undefined} */
  let roomId;
  /** @type {string | undefined} */
  let journalId;
  let head = 0;
  /** @type {JournalEntry[]} */
  let entries = [];
  /** @type {Set<(change: { full: boolean, roomId?: string, journalId?: string, head: number, added: JournalEntry[], replaced: number[], entries: JournalEntry[] }) => void>} */
  const listeners = new Set();

  function notify(change) {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch {
        /* Keep other subscribers running. */
      }
    }
  }

  return {
    get roomId() {
      return roomId;
    },
    get journalId() {
      return journalId;
    },
    get head() {
      return head;
    },
    get entries() {
      return entries;
    },
    /** Returns true if any received entry belongs to a host-only room management audience. */
    get hasRoomEntries() {
      return entries.some(entry => entry.kind.startsWith('room.') || entry.kind === 'people.removed');
    },
    /**
     * Applies a server `journal` lane message.
     * Returns `{ gap: boolean }` so the caller can trigger a resync if needed.
     * @param {{ roomId?: string, journalId?: string, full?: boolean, head?: number, entries?: JournalEntry[] }} message
     */
    apply(message) {
      if (!message || typeof message.roomId !== 'string') return { gap: false };
      const incoming = Array.isArray(message.entries) ? message.entries : [];
      const nextHead = Number.isInteger(message.head) && message.head >= 0 ? message.head : head;
      const reset = !!message.full || message.roomId !== roomId || message.journalId !== journalId;

      if (reset) {
        roomId = message.roomId;
        journalId = message.journalId;
        entries = incoming.slice(-JOURNAL_LIMIT);
        head = Math.max(nextHead, entries.length ? entries[entries.length - 1].seq : 0);
        notify({ full: true, roomId, journalId, head, added: entries.slice(), replaced: [], entries });
        return { gap: false };
      }

      if (nextHead < head) {
        return { gap: true };
      }

      /** @type {JournalEntry[]} */
      const added = [];
      /** @type {number[]} */
      const replaced = [];
      const existingSeqs = new Set(entries.map(entry => entry.seq));

      for (const entry of incoming) {
        if (!entry || !Number.isInteger(entry.seq)) continue;
        if (entry.replaces !== undefined) {
          const idx = entries.findIndex(item => item.seq === entry.replaces);
          if (idx !== -1) {
            entries.splice(idx, 1);
            existingSeqs.delete(entry.replaces);
            replaced.push(entry.replaces);
          }
        }
        if (existingSeqs.has(entry.seq)) continue;
        entries.push(entry);
        existingSeqs.add(entry.seq);
        added.push(entry);
      }

      if (entries.length > JOURNAL_LIMIT) {
        entries.splice(0, entries.length - JOURNAL_LIMIT);
      }
      head = Math.max(head, nextHead, entries.length ? entries[entries.length - 1].seq : 0);
      if (added.length || replaced.length) {
        notify({ full: false, roomId, journalId, head, added, replaced, entries });
      }
      return { gap: false };
    },
    clear() {
      if (!roomId && !entries.length) return;
      roomId = undefined;
      journalId = undefined;
      head = 0;
      entries = [];
      notify({ full: true, roomId, journalId, head, added: [], replaced: [], entries });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const roomJournal = createClientJournal();
