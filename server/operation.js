'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');

// Request ownership follows async calls, without changing provider identities.
// Shared work explicitly installs its own lifetime rather than inheriting its
// first consumer's cancellation. A signal is not a commit/rollback receipt.
const operations = new AsyncLocalStorage();
// Timers and detached continuations inherit this context long after their
// request ends. Ownership therefore stops at settlement: an autoplay timer armed
// by a finished command must not run under that command's expired signal.
function runOperation(signal, action) {
  const controller = signal && new AbortController();
  const forward = () => controller.abort(signal.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener('abort', forward, { once: true });
  const store = { signal: controller?.signal, storage: new Set(), finished: false };
  const finish = () => {
    store.finished = true;
    signal?.removeEventListener('abort', forward);
  };
  let result;
  try {
    result = operations.run(store, action);
  } catch (error) {
    finish();
    throw error;
  }
  if (typeof result?.then === 'function') result.then(finish, finish);
  else finish();
  return result;
}
function observeStorage(flush) {
  operations.getStore()?.storage.add(flush);
}
function commitOperation() {
  const storage = operations.getStore()?.storage;
  return storage?.size ? Promise.all([...storage].map(flush => flush())) : undefined;
}
function currentSignal() {
  const store = operations.getStore();
  return store && !store.finished ? store.signal : undefined;
}
function waitFor(promise, signal = currentSignal()) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', cancel));
  });
}
class SharedTask {
  // idleMs keeps work alive between consumers. A poller that times out while a
  // slow provider starts must not restart that work on every following poll.
  constructor(action, { timeoutMs = 60000, idleMs = 0 } = {}) {
    this.controller = new AbortController();
    this.users = 0;
    this.settled = false;
    this.idleMs = idleMs;
    this.signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeoutMs)]);
    this.promise = Promise.resolve()
      .then(() =>
        runOperation(this.signal, async () => {
          this.signal.throwIfAborted();
          const result = await action(this.signal);
          await commitOperation();
          this.signal.throwIfAborted();
          return result;
        }),
      )
      .finally(() => {
        this.settled = true;
        clearTimeout(this.idle);
      });
    this.promise.catch(() => {});
  }
  async join(signal = currentSignal()) {
    this.users++;
    clearTimeout(this.idle);
    try {
      return await waitFor(this.promise, signal);
    } finally {
      if (--this.users === 0 && !this.settled) this.release();
    }
  }
  release() {
    if (!this.idleMs) {
      this.controller.abort();
      return;
    }
    this.idle = setTimeout(() => {
      if (!this.users) this.controller.abort();
    }, this.idleMs);
    this.idle.unref?.();
  }
  abort() {
    clearTimeout(this.idle);
    this.controller.abort();
  }
}
module.exports = { runOperation, currentSignal, waitFor, SharedTask, observeStorage, commitOperation };
