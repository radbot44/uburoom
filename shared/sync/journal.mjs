// @ts-check
/* Room journal: a bounded, sequence-numbered event log for a live room.
 * Pure synchronization core: no Plex, Discord, HTTP, WebSocket, or SQLite.
 */

export const JOURNAL_LIMIT = 500;
export const SEEK_MERGE_MS = 5000;
export const PRESENCE_MERGE_MS = 60000;

const defaultCreateId = () => globalThis.crypto.randomUUID();

/**
 * @typedef {{ id: string, name: string }} JournalActor
 * @typedef {{
 *   seq: number,
 *   at: number,
 *   kind: string,
 *   actor?: JournalActor,
 *   audience?: string,
 *   mediaVersion?: string,
 *   replaces?: number,
 *   data?: Record<string, any>,
 * }} JournalEntry
 * @typedef {{
 *   at: number,
 *   kind: string,
 *   actor?: JournalActor,
 *   audience?: string,
 *   mediaVersion?: string,
 *   data?: Record<string, any>,
 * }} JournalInput
 * @typedef {{
 *   mergeWithin?: number,
 *   key?: string,
 *   merge?: (prev: JournalEntry, next: JournalInput) => Record<string, any> | null,
 * }} JournalMergeOptions
 */

/**
 * Normalizes an actor reference into `{ id, name }`, or `undefined` if absent.
 * @param {any} actor
 * @returns {JournalActor | undefined}
 */
export function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object') return undefined;
  const id = typeof actor.id === 'string' && actor.id ? actor.id : typeof actor.userId === 'string' ? actor.userId : '';
  if (!id) return undefined;
  const name = typeof actor.name === 'string' && actor.name.trim() ? actor.name.trim() : 'Participant';
  return { id, name };
}

/**
 * Creates a bounded, sequence-numbered journal for one live room.
 * @param {{
 *   journalId?: string,
 *   limit?: number,
 *   createId?: () => string,
 *   entries?: JournalEntry[],
 *   head?: number,
 * }} [options]
 */
export function createJournal(options = {}) {
  const createId = options.createId || defaultCreateId;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : JOURNAL_LIMIT;
  let journalId = typeof options.journalId === 'string' && options.journalId ? options.journalId : createId();
  /** @type {JournalEntry[]} */
  let entries = [];
  let head = Number.isInteger(options.head) && options.head >= 0 ? options.head : 0;
  /** @type {WeakMap<JournalEntry, string>} */
  const mergeKeys = new WeakMap();
  /** @type {Set<number>} */
  const deletedSeqs = new Set();

  if (Array.isArray(options.entries) && options.entries.length) {
    const sorted = options.entries
      .filter(entry => entry && Number.isInteger(entry.seq) && entry.seq > 0 && typeof entry.kind === 'string')
      .map(entry => ({ ...entry }))
      .sort((a, b) => a.seq - b.seq);
    entries = sorted.length > limit ? sorted.slice(sorted.length - limit) : sorted;
    if (entries.length) head = Math.max(head, entries[entries.length - 1].seq);
  }

  return {
    get journalId() {
      return journalId;
    },
    get head() {
      return head;
    },
    get size() {
      return entries.length;
    },
    get limit() {
      return limit;
    },
    /**
     * Appends an entry to the journal, optionally merging with a recent entry
     * sharing the same kind and merge key within `mergeWithin` milliseconds.
     * @param {JournalInput} input
     * @param {JournalMergeOptions} [mergeOptions]
     * @returns {JournalEntry}
     */
    append(input, mergeOptions = undefined) {
      if (!input || typeof input.kind !== 'string' || !input.kind) {
        throw new TypeError('Journal entry requires a non-empty kind');
      }
      const at = Number.isFinite(input.at) ? Math.floor(input.at) : Date.now();
      const actor = normalizeActor(input.actor);
      const audience = typeof input.audience === 'string' && input.audience ? input.audience : undefined;
      const mediaVersion =
        typeof input.mediaVersion === 'string' && input.mediaVersion ? input.mediaVersion : undefined;

      /** @type {number | undefined} */
      let replaces;
      /** @type {Record<string, any> | undefined} */
      let data = input.data && typeof input.data === 'object' ? { ...input.data } : undefined;

      const mergeWithin = mergeOptions?.mergeWithin || 0;
      const key = mergeOptions?.key;
      if (mergeWithin > 0 && key) {
        for (let index = entries.length - 1; index >= 0; index--) {
          const candidate = entries[index];
          if (at - candidate.at > mergeWithin) break;
          if (
            candidate.kind === input.kind &&
            candidate.audience === audience &&
            candidate.mediaVersion === mediaVersion &&
            mergeKeys.get(candidate) === key
          ) {
            const merged = mergeOptions.merge ? mergeOptions.merge(candidate, input) : (data ?? candidate.data);
            if (merged !== null) {
              replaces = candidate.seq;
              data = merged;
              entries.splice(index, 1);
              deletedSeqs.add(candidate.seq);
            }
            break;
          }
        }
      }

      head += 1;
      /** @type {JournalEntry} */
      const entry = {
        seq: head,
        at,
        kind: input.kind,
        ...(actor ? { actor } : {}),
        ...(audience ? { audience } : {}),
        ...(mediaVersion ? { mediaVersion } : {}),
        ...(replaces !== undefined ? { replaces } : {}),
        ...(data && Object.keys(data).length ? { data } : {}),
      };
      if (key) mergeKeys.set(entry, key);
      entries.push(entry);
      if (entries.length > limit) {
        entries.splice(0, entries.length - limit);
      }
      return entry;
    },
    /** Returns all entries with `seq > sinceSeq`. @param {number} [sinceSeq] */
    since(sinceSeq = 0) {
      if (!sinceSeq || sinceSeq <= 0) return entries.slice();
      if (sinceSeq >= head) return [];
      return entries.filter(entry => entry.seq > sinceSeq);
    },
    /** Returns a copy of the journal state. */
    snapshot() {
      return {
        journalId,
        head,
        entries: entries.slice(),
      };
    },
    /** Returns entries newer than `savedSeq` and any seqs deleted by merges. @param {number} [savedSeq] */
    pendingWrite(savedSeq = 0) {
      return {
        journalId,
        head,
        entries: this.since(savedSeq),
        deletes: [...deletedSeqs],
      };
    },
    /** Marks previously flushed merge deletes as persisted. @param {number[]} flushedDeletes */
    acknowledgeDeletes(flushedDeletes) {
      for (const seq of flushedDeletes || []) deletedSeqs.delete(seq);
    },
    /** Replaces the journal contents (used when hydrating from storage). */
    hydrate(saved) {
      if (!saved || typeof saved !== 'object') return;
      if (typeof saved.journalId === 'string' && saved.journalId) journalId = saved.journalId;
      const list = Array.isArray(saved.entries) ? saved.entries : [];
      const sorted = list
        .filter(entry => entry && Number.isInteger(entry.seq) && entry.seq > 0 && typeof entry.kind === 'string')
        .map(entry => ({ ...entry }))
        .sort((a, b) => a.seq - b.seq);
      entries = sorted.length > limit ? sorted.slice(sorted.length - limit) : sorted;
      head = Math.max(
        Number.isInteger(saved.head) && saved.head >= 0 ? saved.head : 0,
        entries.length ? entries[entries.length - 1].seq : 0,
      );
      deletedSeqs.clear();
    },
    /** Clears all entries and rotates `journalId` so clients reset their copy. */
    clear(nextJournalId = undefined) {
      entries = [];
      head = 0;
      deletedSeqs.clear();
      journalId = typeof nextJournalId === 'string' && nextJournalId ? nextJournalId : createId();
    },
  };
}
