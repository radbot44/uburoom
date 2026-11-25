'use strict';
const { PlaybackError } = require('./errors');

// Whether a conversion may run, and how many run at once. `producer` is who would
// convert: 'uburoom' locally or 'provider' for a provider's own transcoder.
class ConversionPolicy {
  constructor(settings) {
    this.settings = settings;
    this.jobs = new Set();
    this.waiters = [];
    // How long a viewer waits for a free conversion job before being told none is free.
    this.waitMs = 8000;
  }
  failure(message) {
    return Object.assign(new PlaybackError(message), { playbackPolicy: true });
  }
  /**
   * @param {string} producer
   * @param {string} [codec]
   * @param {import('./media-provider').ProviderScope} [provider] The provider serving this media; under
   *   follow_provider its own conversion setting is honored.
   */
  async video(producer, codec = 'av1', provider) {
    const policy = this.settings;
    if (!policy) return;
    if (policy.policy === 'disabled' || !policy[producer])
      throw this.failure(
        'Playback needs ' +
          (producer === 'provider' ? "the media server's" : producer) +
          ' conversion, which this server has disabled. Try Original quality or another supported player/track.',
      );
    if (producer === 'uburoom' && !policy.formats.includes(codec))
      throw this.failure(codec.toUpperCase() + ' conversion is not offered by this server.');
    if (policy.policy === 'follow_provider' && (await provider?.videoConversionDisabled?.()))
      throw Object.assign(
        this.failure(
          'The media server disables video transcoding. uburoom honors this setting; try Original playback in a compatible player.',
        ),
        { videoDisabled: true },
      );
  }
  /** Copying the picture and converting only the sound is cheap, so it needs no job; "disabled" still forbids it. */
  copy() {
    if (this.settings?.policy === 'disabled')
      throw this.failure(
        'Playback needs audio conversion, which this server has disabled. Try another supported player/track.',
      );
  }
  acquire() {
    if (!this.settings) return () => {};
    if (this.jobs.size >= this.settings.maxJobs)
      throw Object.assign(
        this.failure(
          'All conversion jobs are in use. A shared quality may be available; otherwise retry after a conversion stops.',
        ),
        { conversionCapacity: true },
      );
    const job = {};
    this.jobs.add(job);
    return () => {
      this.jobs.delete(job);
      const count = Math.max(1, this.settings.maxJobs - this.jobs.size);
      for (let i = 0; i < count && i < this.waiters.length; i++) this.waiters[i]?.();
    };
  }
  async wait({ signal, authorized, timeoutMs = this.waitMs, background = false } = {}) {
    if (signal?.aborted || (authorized && !(await authorized())))
      throw this.failure('Conversion waiting cancelled: viewing access expired or selection changed.');
    if (!this.settings) return () => {};
    if (background) {
      if (this.waiters.length || this.jobs.size >= this.settings.maxJobs)
        throw Object.assign(this.failure('Conversion capacity is reserved for viewers.'), { conversionCapacity: true });
      return this.acquire();
    }
    if (!this.waiters.length && this.jobs.size < this.settings.maxJobs) return this.acquire();
    if (this.waiters.length >= 32)
      throw Object.assign(this.failure('Too many players are waiting for conversion. Try again shortly.'), {
        conversionCapacity: true,
      });
    const until = Date.now() + timeoutMs;
    let wake,
      pendingWake = false;
    const turn = () => {
      if (wake) wake();
      else pendingWake = true;
    };
    this.waiters.push(turn);
    try {
      for (;;) {
        if (signal?.aborted || (authorized && !(await authorized())))
          throw this.failure('Conversion waiting cancelled: viewing access expired or selection changed.');
        if (this.waiters[0] === turn && this.jobs.size < this.settings.maxJobs) return this.acquire();
        if (Date.now() >= until)
          throw Object.assign(
            this.failure(
              'All conversion jobs are in use. Try an available shared quality or wait for another conversion to stop.',
            ),
            { conversionCapacity: true },
          );
        if (pendingWake) {
          pendingWake = false;
          continue;
        }
        await new Promise(resolve => {
          let timer;
          const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            wake = undefined;
            resolve();
          };
          timer = setTimeout(done, Math.max(0, until - Date.now()));
          wake = done;
          signal?.addEventListener('abort', done, { once: true });
        });
      }
    } finally {
      this.waiters = this.waiters.filter(value => value !== turn);
      const count = Math.max(1, this.settings.maxJobs - this.jobs.size);
      for (let i = 0; i < count && i < this.waiters.length; i++) this.waiters[i]?.();
    }
  }
}

const PROCESS_PRIORITY = Object.freeze({ urgent: 0, normal: 1, background: 2 });

class ProcessGate {
  constructor(limit = 6, maxWaiters = 64) {
    this.limit = Math.max(1, limit);
    this.maxWaiters = maxWaiters;
    this.active = 0;
    this.waiters = [];
  }
  async acquire(signal, { priority = 'normal' } = {}) {
    if (signal?.aborted) throw signal.reason || new PlaybackError('Media process cancelled.');
    if (this.active < this.limit && !this.waiters.length) {
      this.active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.release();
      };
    }
    if (this.waiters.length >= this.maxWaiters) {
      throw Object.assign(new PlaybackError('Too many media processes are queued. Retry shortly.'), {
        conversionCapacity: true,
      });
    }
    const rank = PROCESS_PRIORITY[priority] ?? PROCESS_PRIORITY.normal;
    await new Promise((resolve, reject) => {
      const entry = {
        rank,
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const idx = this.waiters.indexOf(entry);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(signal.reason || new PlaybackError('Media process cancelled.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(entry);
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }
  release() {
    while (this.waiters.length) {
      let bestIdx = 0;
      for (let i = 1; i < this.waiters.length; i++) {
        if (this.waiters[i].rank < this.waiters[bestIdx].rank) bestIdx = i;
      }
      const [next] = this.waiters.splice(bestIdx, 1);
      if (next) {
        next.resolve();
        return;
      }
    }
    this.active = Math.max(0, this.active - 1);
  }
  async run(signal, action, options) {
    const release = await this.acquire(signal, options);
    try {
      return await action();
    } finally {
      release();
    }
  }
}

module.exports = { ConversionPolicy, ProcessGate };
