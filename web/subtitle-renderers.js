import { asMediaSurface } from './media-surface.js';

function createSurfaceVideoProxy(stageEl, surface) {
  if (!stageEl || typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return { element: surface.videoElement, cleanup: () => {} };
  }
  // Use a real DOM Element (never a JS Proxy) so ResizeObserver.observe(video) passes WebIDL brand checks.
  const el = document.createElement('div');
  el.className = 'subtitle-video-proxy';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:absolute;inset:0;pointer-events:none;visibility:hidden;';
  stageEl.append(el);
  Object.defineProperties(el, {
    videoWidth: { get: () => surface.width(), configurable: true },
    videoHeight: { get: () => surface.height(), configurable: true },
    currentTime: { get: () => surface.currentTime(), configurable: true },
    paused: { get: () => surface.paused(), configurable: true },
    ended: { get: () => surface.ended(), configurable: true },
    seeking: { get: () => surface.seeking(), configurable: true },
    readyState: { get: () => surface.readyState(), configurable: true },
    offsetLeft: { get: () => 0, configurable: true },
    offsetTop: { get: () => 0, configurable: true },
    clientWidth: { get: () => stageEl.clientWidth || 0, configurable: true },
    clientHeight: { get: () => stageEl.clientHeight || 0, configurable: true },
    requestVideoFrameCallback: { value: cb => surface.requestFrame(cb), configurable: true },
    cancelVideoFrameCallback: { value: id => surface.cancelFrame(id), configurable: true },
    addEventListener: { value: (type, fn) => surface.addEventListener(type, fn), configurable: true },
    removeEventListener: { value: (type, fn) => surface.removeEventListener(type, fn), configurable: true },
  });
  return { element: el, cleanup: () => el.remove() };
}

function placeContentBoxCanvas(canvas, stageEl, videoWidth, videoHeight) {
  if (!canvas || !stageEl) return;
  const stageW = stageEl.clientWidth || 0;
  const stageH = stageEl.clientHeight || 0;
  if (!stageW || !stageH) return;
  let boxW = stageW,
    boxH = stageH,
    left = 0,
    top = 0;
  if (videoWidth > 0 && videoHeight > 0) {
    const scale = Math.min(stageW / videoWidth, stageH / videoHeight);
    boxW = Math.max(1, Math.round(videoWidth * scale));
    boxH = Math.max(1, Math.round(videoHeight * scale));
    left = Math.round((stageW - boxW) / 2);
    top = Math.round((stageH - boxH) / 2);
  }
  canvas.style.left = left + 'px';
  canvas.style.top = top + 'px';
  canvas.style.width = boxW + 'px';
  canvas.style.height = boxH + 'px';
}

// One active overlay. Subtitle/font bytes are already fetched through viewer
// grants; libraries never receive Plex URLs or choose external font services.
export const subtitleRenderers = {
  supported() {
    return (
      typeof WebAssembly === 'object' &&
      typeof Worker === 'function' &&
      typeof OffscreenCanvas === 'function' &&
      typeof HTMLCanvasElement !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function'
    );
  },
  async create(target, format, assets, offset, signal, resolveMediaTime) {
    const surface = asMediaSurface(target);
    const stageEl = surface.stageElement();
    const layer = document.createElement('div'),
      canvas = document.createElement('canvas');
    layer.className = 'subtitle-layer';
    layer.setAttribute('aria-hidden', 'true');
    canvas.className = 'subtitle-canvas';
    layer.append(canvas);
    stageEl?.append(layer);
    let renderer,
      renderAssFrame,
      frameHandle,
      proxyCleanup,
      disposed = false,
      renderError;
    const manualAssMode = format === 'ass' && (surface.isUbuPlayer() || !surface.videoElement);
    const currentMediaTime = raw =>
      typeof resolveMediaTime === 'function'
        ? resolveMediaTime(Number.isFinite(raw) ? raw : surface.currentTime())
        : Number.isFinite(raw)
          ? raw
          : surface.currentTime();
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (frameHandle !== undefined) {
        surface.cancelFrame(frameHandle);
        frameHandle = undefined;
      }
      if (proxyCleanup) {
        proxyCleanup();
        proxyCleanup = undefined;
      }
      layer.remove();
      try {
        Promise.resolve(renderer?.destroy?.() || renderer?.dispose?.()).catch(() => {});
      } catch {}
    };
    signal.addEventListener('abort', dispose, { once: true });
    const repaint = () => {
      if (disposed || !renderer) return;
      const mediaTime = currentMediaTime();
      if (format === 'ass') {
        const w = surface.width(),
          h = surface.height();
        if (manualAssMode) placeContentBoxCanvas(canvas, stageEl, w, h);
        if (!w || !h) return;
        void (renderAssFrame || renderer.manualRender)
          .call(
            renderer,
            {
              expectedDisplayTime: performance.now(),
              width: w,
              height: h,
              mediaTime,
            },
            true,
          )
          ?.catch(() => {});
      } else {
        renderer.updateCanvasSize?.();
        renderer.renderAtMediaTime(mediaTime, true);
      }
    };
    const scheduleSurfaceFrameLoop = () => {
      if (disposed || !manualAssMode || !surface.supportsFrameCallback()) return;
      frameHandle = surface.requestFrame((now, meta) => {
        frameHandle = undefined;
        if (disposed || !renderer) return;
        const w = meta?.width || surface.width(),
          h = meta?.height || surface.height();
        placeContentBoxCanvas(canvas, stageEl, w, h);
        if (w > 0 && h > 0) {
          void (renderAssFrame || renderer.manualRender)
            .call(
              renderer,
              {
                expectedDisplayTime: Number.isFinite(meta?.expectedDisplayTime) ? meta.expectedDisplayTime : now,
                width: w,
                height: h,
                mediaTime: currentMediaTime(meta?.mediaTime),
              },
              false,
            )
            ?.catch(() => {});
        }
        scheduleSurfaceFrameLoop();
      });
    };
    const wait = promise =>
      new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
          error ? reject(error) : resolve(value);
        };
        const cancel = () => finish(new Error('Subtitle loading was cancelled.'));
        const timer = setTimeout(() => finish(new Error('Subtitle renderer startup timed out. Try burn-in.')), 15000);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        Promise.resolve(promise).then(
          value => finish(null, value),
          error => finish(error),
        );
      });
    try {
      signal.throwIfAborted();
      if (format === 'ass') {
        const { default: JASSUB } = await wait(import('/vendor/subtitles/jassub.js'));
        signal.throwIfAborted();
        const fontResponse = await fetch('/vendor/subtitles/default.woff2', { signal });
        if (!fontResponse.ok) throw new Error('Subtitle fallback font could not load.');
        const fallbackFont = new Uint8Array(await fontResponse.arrayBuffer());
        signal.throwIfAborted();
        const initialSubContent = assets.data
          ? new TextDecoder().decode(assets.data)
          : '[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
        if (manualAssMode) {
          placeContentBoxCanvas(canvas, stageEl, surface.width() || 1920, surface.height() || 1080);
        }
        renderer = new JASSUB({
          ...(manualAssMode ? {} : { video: surface.videoElement }),
          canvas,
          subContent: initialSubContent,
          fonts: [fallbackFont, ...(assets.fonts || [])],
          queryFonts: false,
          timeOffset: -offset,
          workerUrl: '/vendor/subtitles/jassub-worker.js',
          wasmUrl: '/vendor/subtitles/jassub-worker.wasm',
          modernWasmUrl: '/vendor/subtitles/jassub-worker-modern.wasm',
          libassMemoryLimit: 32,
          libassGlyphLimit: 1000,
          maxRenderHeight: 2160,
        });
        const rawManualRender = renderer.manualRender.bind(renderer);
        renderAssFrame = rawManualRender;
        if (!manualAssMode && typeof resolveMediaTime === 'function') {
          renderer.manualRender = (frameInfo, force = false) =>
            rawManualRender(
              frameInfo && typeof frameInfo === 'object'
                ? {
                    ...frameInfo,
                    width: frameInfo.width,
                    height: frameInfo.height,
                    expectedDisplayTime: frameInfo.expectedDisplayTime,
                    mediaTime: resolveMediaTime(frameInfo.mediaTime),
                  }
                : frameInfo,
              force,
            );
        }
        await wait(renderer.ready);
        if (manualAssMode) scheduleSurfaceFrameLoop();
      } else {
        const { PgsRenderer, VobSubRenderer } = await wait(import('/vendor/subtitles/libbitsub-renderer.js'));
        signal.throwIfAborted();
        const pushStream =
          (format === 'pgs' || format === 'vobsub') && !!(assets.subUrl || assets.pushStream) && !assets.data;
        let videoTarget = surface.videoElement;
        if (surface.isUbuPlayer()) {
          const proxy = createSurfaceVideoProxy(stageEl, surface);
          videoTarget = proxy.element;
          proxyCleanup = proxy.cleanup;
        }
        await wait(
          new Promise((resolve, reject) => {
            const options = {
              video: videoTarget,
              canvas,
              container: layer,
              ...(pushStream
                ? {}
                : assets.subUrl
                  ? { subUrl: assets.subUrl, streamingLoad: true, rangeRequests: false }
                  : {
                      subContent: assets.data
                        ? assets.data.buffer.slice(
                            assets.data.byteOffset,
                            assets.data.byteOffset + assets.data.byteLength,
                          )
                        : new Uint8Array(0),
                    }),
              ...(assets.index ? { idxContent: new TextDecoder().decode(assets.index) } : {}),
              fileName: assets.fileName,
              timeOffset: -offset,
              cacheLimit: 12,
              devicePixelRatioCap: 2,
              maxSubtitleBytes: 64 * 1024 * 1024,
              onLoaded: resolve,
              onError: error => {
                renderError = error;
                reject(error);
              },
              onWarning: warning => {
                if (format === 'pgs' && ['MISSING_PALETTE', 'INVALID_SUBTITLE_DATA'].includes(warning.code))
                  renderError = new Error('PGS subtitle bitmap could not be rendered. Try burn-in.');
              },
            };
            renderer = format === 'pgs' ? new PgsRenderer(options) : new VobSubRenderer(options);
            renderer.resolveMediaTime = resolveMediaTime;
            renderer.boundedWindow = Boolean(pushStream);
          }),
        );
        await wait(renderer.whenReady());
      }
      signal.throwIfAborted();
      repaint();
      const resizeObserver =
        typeof ResizeObserver === 'function' && stageEl ? new ResizeObserver(() => repaint()) : undefined;
      resizeObserver?.observe(stageEl);
      for (const event of ['seeked', 'loadedmetadata', 'resize', 'pause', 'playing', 'ratechange'])
        surface.addEventListener(event, repaint);
      const cleanup = () => {
        resizeObserver?.disconnect();
        signal.removeEventListener('abort', dispose);
        for (const event of ['seeked', 'loadedmetadata', 'resize', 'pause', 'playing', 'ratechange'])
          surface.removeEventListener(event, repaint);
        dispose();
      };
      return {
        destroy: cleanup,
        error: () => renderError,
        append: chunk =>
          renderer.append
            ? renderer.append(chunk)
            : format === 'ass'
              ? (async () => {
                  const text = new TextDecoder().decode(chunk);
                  if (renderer.renderer?.processData) {
                    await renderer.renderer.processData(text);
                  } else if (renderer.renderer?.setTrack) {
                    await renderer.renderer.setTrack(text);
                  }
                  repaint();
                  return 1;
                })()
              : format === 'vobsub' && renderer.loadVobSubBuffer
                ? (async () => {
                    await renderer.loadVobSubBuffer(chunk, null, true, true);
                    repaint();
                    return 1;
                  })()
                : undefined,
        flush: () => renderer.flush?.(),
        reset: () => {
          renderError = undefined;
          return renderer.reset ? renderer.reset() : renderer.onSeek ? renderer.onSeek() : undefined;
        },
        synced: (time = currentMediaTime()) =>
          renderer.isSyncedAtMediaTime ? renderer.isSyncedAtMediaTime(time) : true,
        offset(value) {
          renderer.timeOffset = -value;
          repaint();
        },
      };
    } catch (error) {
      dispose();
      throw error;
    }
  },
};
