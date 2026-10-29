'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../web/playback-policy');
const toastsApi = require('../web/watch-toasts');

test('choppiness detector detects 10% dropped frames over 10 seconds of active playback', () => {
  const detector = policy.choppinessDetector({ threshold: 0.10, windowMs: 10000, minFrames: 50 });
  const cond = { paused: false, seeking: false, waiting: false, visible: true, active: true };

  // At t=0: 0 frames, 0 dropped
  let res = detector.update(0, { totalVideoFrames: 0, droppedVideoFrames: 0 }, cond);
  assert.equal(res.choppy, false);
  assert.equal(res.warming, true);

  // At t=5000: 150 frames, 15 dropped (10%), but only 5s elapsed
  res = detector.update(5000, { totalVideoFrames: 150, droppedVideoFrames: 15 }, cond);
  assert.equal(res.choppy, false);
  assert.equal(res.warming, true);

  // At t=10000: 300 frames, 33 dropped (11%)
  res = detector.update(10000, { totalVideoFrames: 300, droppedVideoFrames: 33 }, cond);
  assert.equal(res.choppy, true);
  assert.equal(res.deltaTotal, 300);
  assert.equal(res.deltaDropped, 33);
  assert.ok(res.ratio >= 0.10);
});

test('choppiness detector stays quiet when dropped frames are under threshold', () => {
  const detector = policy.choppinessDetector({ threshold: 0.10, windowMs: 10000, minFrames: 50 });
  const cond = { paused: false, seeking: false, waiting: false, visible: true, active: true };

  detector.update(0, { totalVideoFrames: 0, droppedVideoFrames: 0 }, cond);
  detector.update(5000, { totalVideoFrames: 150, droppedVideoFrames: 5 }, cond);
  const res = detector.update(10000, { totalVideoFrames: 300, droppedVideoFrames: 10 }, cond);
  assert.equal(res.choppy, false);
  assert.ok(res.ratio < 0.10);
});

test('pauses, seeking, and hidden visibility reset the 10-second window', () => {
  const detector = policy.choppinessDetector({ threshold: 0.10, windowMs: 10000, minFrames: 50 });
  const healthy = { paused: false, seeking: false, waiting: false, visible: true, active: true };

  detector.update(0, { totalVideoFrames: 0, droppedVideoFrames: 0 }, healthy);
  detector.update(8000, { totalVideoFrames: 240, droppedVideoFrames: 50 }, healthy);

  // Paused at t=9000
  let res = detector.update(9000, { totalVideoFrames: 270, droppedVideoFrames: 50 }, { ...healthy, paused: true });
  assert.equal(res.choppy, false);
  assert.equal(res.interrupted, true);

  // Resume playback at t=9500
  res = detector.update(9500, { totalVideoFrames: 270, droppedVideoFrames: 50 }, healthy);
  assert.equal(res.choppy, false);
  assert.equal(res.warming, true);

  // At t=12000 (only 2.5s since resume), even with high dropped frames, it does not falsely trigger
  res = detector.update(12000, { totalVideoFrames: 350, droppedVideoFrames: 90 }, healthy);
  assert.equal(res.choppy, false);
  assert.equal(res.warming, true);

  // Seeking interrupt
  detector.update(15000, { totalVideoFrames: 450, droppedVideoFrames: 100 }, healthy);
  res = detector.update(16000, { totalVideoFrames: 480, droppedVideoFrames: 100 }, { ...healthy, seeking: true });
  assert.equal(res.interrupted, true);

  // Waiting/buffering before 2.5s records stall without interrupt
  detector.update(17000, { totalVideoFrames: 500, droppedVideoFrames: 100 }, healthy);
  res = detector.update(18000, { totalVideoFrames: 500, droppedVideoFrames: 100 }, { ...healthy, waiting: true });
  assert.equal(res.isSettled, false);
  assert.equal(res.choppy, false);

  // Tab hidden interrupt
  detector.update(19000, { totalVideoFrames: 500, droppedVideoFrames: 100 }, healthy);
  res = detector.update(20000, { totalVideoFrames: 500, droppedVideoFrames: 100 }, { ...healthy, visible: false });
  assert.equal(res.interrupted, true);
});

test('insufficient frames (<50) over 10s does not trigger false positive', () => {
  const detector = policy.choppinessDetector({ threshold: 0.10, windowMs: 10000, minFrames: 50 });
  const cond = { paused: false, seeking: false, waiting: false, visible: true, active: true };

  detector.update(0, { totalVideoFrames: 0, droppedVideoFrames: 0 }, cond);
  // Only 10 frames total, 5 dropped (50%), but total frames < 50
  const res = detector.update(10000, { totalVideoFrames: 10, droppedVideoFrames: 5 }, cond);
  assert.equal(res.choppy, false);
  assert.equal(res.minFramesRequired, 50);
});

test('cooldown suppresses detection for 10 seconds after quality change', () => {
  const detector = policy.choppinessDetector({ threshold: 0.10, windowMs: 10000, minFrames: 50 });
  const cond = { paused: false, seeking: false, waiting: false, visible: true, active: true };

  detector.triggerCooldown(10000, 1000);
  assert.equal(detector.inCooldown(5000), true);

  let res = detector.update(5000, { totalVideoFrames: 300, droppedVideoFrames: 100 }, cond);
  assert.equal(res.choppy, false);
  assert.equal(res.inCooldown, true);

  assert.equal(detector.inCooldown(11001), false);
  // Fresh window starts after cooldown
  res = detector.update(11001, { totalVideoFrames: 300, droppedVideoFrames: 100 }, cond);
  assert.equal(res.warming, true);
});

test('deliberate dismissal permanently suppresses detection until session reset', () => {
  const detector = policy.choppinessDetector({ threshold: 0.10, windowMs: 10000, minFrames: 50 });
  const cond = { paused: false, seeking: false, waiting: false, visible: true, active: true };

  detector.dismiss(true);
  assert.equal(detector.isDismissed, true);

  let res = detector.update(10000, { totalVideoFrames: 500, droppedVideoFrames: 200 }, cond);
  assert.equal(res.choppy, false);
  assert.equal(res.dismissed, true);

  detector.reset();
  assert.equal(detector.isDismissed, false);
  res = detector.update(0, { totalVideoFrames: 0, droppedVideoFrames: 0 }, cond);
  assert.equal(res.warming, true);
});

test('toast with action renders container div and supports action and deliberate dismissal', () => {
  const mockDoc = {
    createElement(tag) {
      const el = {
        tagName: tag.toUpperCase(),
        className: '',
        dataset: {},
        style: {},
        children: [],
        listeners: {},
        textContent: '',
        hidden: false,
        type: '',
        title: '',
        attributes: {},
        append(...nodes) { this.children.push(...nodes); },
        replaceChildren(...nodes) { this.children = [...nodes]; },
        setAttribute(k, v) { this.attributes[k] = v; },
        removeAttribute(k) { delete this.attributes[k]; },
        addEventListener(event, fn) { this.listeners[event] = fn; },
        remove() { el.removed = true; },
        animate() { return { cancel() {}, onfinish: null }; },
        classList: {
          toggle(cls, val) {
            const set = new Set((el.className || '').split(' ').filter(Boolean));
            if (val) set.add(cls); else set.delete(cls);
            el.className = [...set].join(' ');
          }
        }
      };
      el.ownerDocument = mockDoc;
      return el;
    },
    defaultView: {
      matchMedia: () => ({ matches: true }),
      getComputedStyle: () => ({ opacity: '1', transform: 'none', getPropertyValue: () => '16px' })
    }
  };
  mockDoc.ownerDocument = mockDoc;
  const host = mockDoc.createElement('div');

  const toasts = toastsApi.create(host, { icons: { icon: () => mockDoc.createElement('svg') } });

  let actionRan = false;
  let dismissedDeliberately = false;

  toasts.show('choppy', {
    title: 'Playback seems choppy',
    action: { label: 'Lower quality', run: () => { actionRan = true; } },
    onDismiss: (deliberate) => { dismissedDeliberately = deliberate; }
  });

  const toastRoot = host.children[0];
  assert.equal(toastRoot.tagName, 'DIV');
  assert.ok(toastRoot.className.includes('watch-toast'));
  assert.ok(toastRoot.className.includes('with-action'));
  assert.equal(toastRoot.attributes.role, 'status');

  const message = toastRoot.children[1];
  const heading = message.children[0];
  assert.equal(heading.textContent, 'Playback seems choppy');

  const actions = message.children[2];
  const actionBtn = actions.children[0];
  assert.equal(actionBtn.textContent, 'Lower quality');
  const dismissBtn = actions.children[1];
  assert.equal(dismissBtn.textContent, 'Dismiss');

  // Trigger action
  actionBtn.listeners.click({ stopPropagation() {} });
  assert.equal(actionRan, true);
  assert.equal(toastRoot.removed, true);
});

test('mid-stream buffering stalls trigger choppiness while initial load and seek buffers are ignored', () => {
  const detector = policy.choppinessDetector({ threshold: 0.10, windowMs: 10000, minFrames: 50, maxStallMs: 1500, maxStallCount: 2, minMultiStallMs: 1000, settleMs: 2500 });
  const cond = { paused: false, seeking: false, waiting: false, visible: true, active: true };

  // 1. Initial load buffering (4 seconds of waiting before playback starts)
  for (let t = 0; t <= 4000; t += 1000) {
    const res = detector.update(t, { totalVideoFrames: 0, droppedVideoFrames: 0 }, { ...cond, waiting: true });
    assert.equal(res.choppy, false);
    assert.equal(res.isSettled, false);
  }

  // 2. Playback starts and warms up for 3 seconds (settles at 2.5s)
  detector.update(5000, { totalVideoFrames: 0, droppedVideoFrames: 0 }, cond);
  detector.update(6000, { totalVideoFrames: 30, droppedVideoFrames: 0 }, cond);
  detector.update(7000, { totalVideoFrames: 60, droppedVideoFrames: 0 }, cond);
  let res = detector.update(8000, { totalVideoFrames: 90, droppedVideoFrames: 0 }, cond);
  assert.equal(res.isSettled, true);
  assert.equal(res.choppy, false);

  // 3. Mid-stream stall: buffer runs empty at t=9000
  detector.update(9000, { totalVideoFrames: 90, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  // At t=10000: 1000ms of stall (<1500ms), not yet choppy
  res = detector.update(10000, { totalVideoFrames: 90, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  assert.equal(res.choppy, false);
  assert.equal(res.totalStallMs, 1000);

  // At t=11000: 2000ms of stall (>=1500ms maxStallMs) -> triggers choppiness!
  res = detector.update(11000, { totalVideoFrames: 90, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  assert.equal(res.choppy, true);
  assert.equal(res.stallChoppy, true);
  assert.equal(res.totalStallMs, 2000);

  // 4. User seeks to new position at t=12000: seek buffer resets detector and is not choppy
  res = detector.update(12000, { totalVideoFrames: 90, droppedVideoFrames: 0 }, { ...cond, seeking: true });
  assert.equal(res.choppy, false);
  assert.equal(res.interrupted, true);

  // Seek load buffering for 2 seconds
  detector.update(13000, { totalVideoFrames: 90, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  res = detector.update(14000, { totalVideoFrames: 90, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  assert.equal(res.choppy, false);

  // Resumes playing and settles
  detector.update(15000, { totalVideoFrames: 90, droppedVideoFrames: 0 }, cond);
  detector.update(18000, { totalVideoFrames: 180, droppedVideoFrames: 0 }, cond); // settled

  // 5. Two distinct shorter stalls (700ms each = 1400ms >= minMultiStallMs 1000ms and count >= 2)
  detector.update(19000, { totalVideoFrames: 180, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  detector.update(19700, { totalVideoFrames: 180, droppedVideoFrames: 0 }, cond); // stall 1 ends (700ms)

  detector.update(21000, { totalVideoFrames: 220, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  res = detector.update(21700, { totalVideoFrames: 220, droppedVideoFrames: 0 }, { ...cond, waiting: true }); // stall 2 in progress (700ms)
  assert.equal(res.stallCount, 2);
  assert.equal(res.choppy, true);
  assert.equal(res.stallChoppy, true);
});

test('sub-2.5s stalls do not reset playingStartedAt in a loop and record into stallHistory', () => {
  const detector = policy.choppinessDetector({ threshold: 0.10, windowMs: 10000, minFrames: 50, maxStallMs: 1500, maxStallCount: 2, minMultiStallMs: 1000, settleMs: 2500 });
  const cond = { paused: false, seeking: false, waiting: false, visible: true, active: true };

  // Waiting before any playback has started returns warming
  const preplay = detector.update(0, { totalVideoFrames: 0, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  assert.equal(preplay.choppy, false);
  assert.equal(preplay.warming, true);
  assert.equal(preplay.isSettled, false);

  // Playback starts at t=1000
  detector.update(1000, { totalVideoFrames: 0, droppedVideoFrames: 0 }, cond);

  // Stall occurs at t=2000 (1000ms in, before settleMs 2500ms)
  let res = detector.update(2000, { totalVideoFrames: 30, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  assert.equal(res.choppy, false);
  assert.equal(res.isSettled, false);

  // Stall ends at t=2600 (600ms stall)
  res = detector.update(2600, { totalVideoFrames: 30, droppedVideoFrames: 0 }, cond);
  // playingStartedAt was preserved at 1000, so now-playingStartedAt = 1600 < 2500 -> isSettled false
  assert.equal(res.isSettled, false);

  // Second stall occurs at t=3200 (2200ms since t=1000, still before 2500ms)
  detector.update(3200, { totalVideoFrames: 50, droppedVideoFrames: 0 }, { ...cond, waiting: true });
  // Stall ends at t=3800 (600ms stall, totalStallMs = 1200ms >= 1000ms, stallCount = 2)
  res = detector.update(3800, { totalVideoFrames: 50, droppedVideoFrames: 0 }, cond);
  // t=3800 is 2800ms since playingStartedAt (1000), so isSettled is now true!
  assert.equal(res.isSettled, true);
  assert.equal(res.stallCount, 2);
  assert.equal(res.totalStallMs, 1200);
  assert.equal(res.stallChoppy, true);
  assert.equal(res.choppy, true);
});
