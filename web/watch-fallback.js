/* Personal delivery ownership. The shared quality policy owns all switch thresholds. */
import * as uburoomSyncQuality from '../shared/sync/quality.mjs';

function create({ prepare, swap, notify, record, now = () => performance.now(), supported }) {
  const limits = uburoomSyncQuality.FALLBACK_LIMITS;
  let main,
    key,
    selection,
    active = false,
    stage,
    lastReturn = -Infinity,
    failedReturns = 0,
    returned = false,
    bootstrap = true,
    retryAt = 0,
    disabled = false;
  function drop() {
    stage?.preparation.close();
    stage = undefined;
  }
  function reset() {
    drop();
    main = key = selection = undefined;
    active = false;
    lastReturn = -Infinity;
    failedReturns = 0;
    returned = false;
    bootstrap = true;
    retryAt = 0;
    disabled = false;
  }
  function available(next) {
    return (
      !disabled &&
      next?.fallbackStream &&
      supported(next.fallbackStream.format) &&
      next.tracks?.subtitleDelivery !== 'burn'
    );
  }
  function receive(next, reconnected = false) {
    const context = next.id + ':' + next.mediaVersion,
      choice = JSON.stringify([
        next.preferredQuality,
        next.tracks?.audioChoice,
        next.tracks?.subtitleChoice,
        next.tracks?.subtitleMode,
      ]);
    if (context !== key) {
      reset();
      key = context;
    } else if (selection !== undefined && selection !== choice) {
      drop();
      active = false;
      bootstrap = false;
      retryAt = 0;
    }
    if (main?.mediaUrl !== next.mediaUrl || main?.fallbackStream?.mediaUrl !== next.fallbackStream?.mediaUrl) drop();
    selection = choice;
    main = next;
    if (reconnected) {
      drop();
      bootstrap = true;
      active = false;
    }
    if (!available(next)) {
      if (active) {
        active = false;
        drop();
      }
      return next;
    }
    if (bootstrap) {
      bootstrap = false;
      active = true;
      record('fallback-start', { format: next.fallbackStream.format });
      record('fallback-switch', { fallbackReason: reconnected ? 'reconnect' : 'join' });
      notify(true, next);
    }
    return display();
  }
  function display() {
    if (!active || !available(main)) return main;
    const fallback = main.fallbackStream;
    return {
      ...main,
      mediaUrl: fallback.mediaUrl,
      format: fallback.format,
      videoCodec: fallback.format,
      audioCodec: 'opus',
      bitrate: fallback.bitrate * 1000000,
      fallbackActive: true,
      mediaError: undefined,
      directHls: undefined,
      directDelivery: false,
      deliveryInfo: {
        format: fallback.format,
        videoCodec: fallback.format,
        audioCodec: 'opus',
        height: fallback.height,
        bitrate: fallback.bitrate * 1000000,
      },
    };
  }
  function ensure(next, seconds) {
    if (!next?.mediaUrl || now() < retryAt) return;
    if (stage?.url !== next.mediaUrl) {
      drop();
      try {
        stage = { url: next.mediaUrl, preparation: prepare(next, seconds) };
      } catch {
        retryAt = now() + 5000;
      }
    }
    if (stage?.preparation.failed) {
      drop();
      retryAt = now() + 5000;
    }
    return stage?.preparation;
  }
  function activate(value, reason) {
    const prepared = stage?.preparation;
    const cache = prepared?.cache,
      url = stage?.url;
    prepared?.close(true);
    stage = undefined;
    active = value;
    if (value && returned) {
      failedReturns++;
      returned = false;
    }
    if (!value) {
      lastReturn = now();
      returned = true;
    }
    record(value ? 'fallback-switch' : 'fallback-return', { fallbackReason: reason, failedReturns });
    notify(value, main);
    swap(main, { url, cache });
  }
  function tick(sample) {
    if (!active && !available(main) && sample.bufferAhead >= limits.prefetchSeconds) bootstrap = false;
    if (!available(main)) return;
    if (main.preparingQuality || !main.mediaUrl) {
      drop();
      return;
    }
    const decision = uburoomSyncQuality.fallbackDecision({
      ...sample,
      onFallback: active,
      now: now(),
      lastReturn,
      failedReturns,
    });
    if (decision === 'idle') {
      drop();
      return;
    }
    if (active) {
      if (failedReturns >= limits.failedReturns || now() - lastReturn < limits.returnIntervalMs) {
        drop();
        return;
      }
      const preparation = ensure(main, limits.returnSeconds + 2);
      const ready = preparation?.ahead() || 0;
      const required = Math.min(limits.returnSeconds, Math.max(0, main.state.duration - sample.target - 0.1));
      if (
        ready > 0 &&
        uburoomSyncQuality.fallbackDecision({
          ...sample,
          onFallback: true,
          now: now(),
          lastReturn,
          failedReturns,
          readyAhead: ready + limits.returnSeconds - required,
        }) === 'return'
      )
        activate(false, 'buffer-ready');
    } else {
      const fallback = { ...main, ...main.fallbackStream, directHls: undefined, directDelivery: false };
      const preparation = ensure(fallback, limits.cacheSeconds);
      if (
        decision === 'switch' &&
        preparation?.ahead() >= Math.min(1, Math.max(0, main.state.duration - sample.target - 0.1))
      )
        activate(true, sample.stallSeconds >= limits.stallSeconds ? 'stall' : 'low-buffer');
    }
  }
  function failed() {
    if (!active || !main?.mediaUrl || main.preparingQuality) return false;
    drop();
    active = false;
    disabled = true;
    record('fallback-failed', { fallbackReason: 'decode' });
    notify(false, main);
    swap(main);
    return true;
  }
  return {
    receive,
    display,
    tick,
    reset,
    failed,
    get active() {
      return active;
    },
  };
}
export { create };
