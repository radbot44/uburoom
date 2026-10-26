'use strict';
// One active overlay. Subtitle/font bytes are already fetched through viewer
// grants; libraries never receive Plex URLs or choose external font services.
window.uburoomSubtitleRenderers={
  supported(){return typeof WebAssembly==='object' && typeof Worker==='function' && typeof OffscreenCanvas==='function' &&
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen==='function';},
  async create(video,format,assets,offset,signal,resolveMediaTime){
    const layer=document.createElement('div'),canvas=document.createElement('canvas');
    layer.className='subtitle-layer';layer.setAttribute('aria-hidden','true');canvas.className='subtitle-canvas';layer.append(canvas);video.parentElement.append(layer);
    let renderer,disposed=false;
    const currentMediaTime=()=>typeof resolveMediaTime==='function'?resolveMediaTime(video.currentTime):video.currentTime;
    const dispose=()=>{if(disposed)return;disposed=true;layer.remove();try{Promise.resolve(renderer?.destroy?.() || renderer?.dispose?.()).catch(()=>{});}catch{}};
    signal.addEventListener('abort',dispose,{once:true});
    const repaint=()=>{if(disposed||!renderer)return;
      const mediaTime=currentMediaTime();
      if(format==='ass')void renderer.manualRender({expectedDisplayTime:performance.now(),width:video.videoWidth || 1,height:video.videoHeight || 1,mediaTime},true)?.catch(()=>{});
      else renderer.renderAtMediaTime(mediaTime,true);
    };
    const wait=promise=>new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);error?reject(error):resolve(value);};
      const cancel=()=>finish(new Error('Subtitle loading was cancelled.'));
      const timer=setTimeout(()=>finish(new Error('Subtitle renderer startup timed out. Try Plex burn-in.')),15000);
      signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
      Promise.resolve(promise).then(value=>finish(null,value),error=>finish(error));
    });
    try{
      signal.throwIfAborted();
      if(format==='ass'){
        const {default:JASSUB}=await wait(import('/vendor/subtitles/jassub.js'));signal.throwIfAborted();
        const fontResponse=await fetch('/vendor/subtitles/default.woff2',{signal});if(!fontResponse.ok)throw new Error('Subtitle fallback font could not load.');
        const fallbackFont=new Uint8Array(await fontResponse.arrayBuffer());signal.throwIfAborted();
        renderer=new JASSUB({video,canvas,subContent:new TextDecoder().decode(assets.data),fonts:[fallbackFont,...assets.fonts || []],queryFonts:false,timeOffset:-offset,
          workerUrl:'/vendor/subtitles/jassub-worker.js',wasmUrl:'/vendor/subtitles/jassub-worker.wasm',modernWasmUrl:'/vendor/subtitles/jassub-worker-modern.wasm',
          libassMemoryLimit:32,libassGlyphLimit:1000,maxRenderHeight:2160});
        await wait(renderer.ready);
      }else{
        const {PgsRenderer,VobSubRenderer}=await wait(import('/vendor/subtitles/libbitsub-renderer.js'));signal.throwIfAborted();
        const pushStream=format==='pgs' && !!assets.subUrl && !assets.data;
        await wait(new Promise((resolve,reject)=>{
          const options={video,canvas,container:layer,
            ...(pushStream?{}:assets.subUrl?{subUrl:assets.subUrl,streamingLoad:true,rangeRequests:false}:{subContent:assets.data.buffer.slice(assets.data.byteOffset,assets.data.byteOffset+assets.data.byteLength)}),
            ...(assets.index?{idxContent:new TextDecoder().decode(assets.index)}:{}),fileName:assets.fileName,timeOffset:-offset,
            cacheLimit:12,devicePixelRatioCap:2,maxSubtitleBytes:64*1024*1024,onLoaded:resolve,onError:reject};
          renderer=format==='pgs'?new PgsRenderer(options):new VobSubRenderer(options);
          renderer.resolveMediaTime=resolveMediaTime;
        }));
        await wait(renderer.whenReady());
      }
      signal.throwIfAborted();repaint();
      for(const event of ['seeked','loadedmetadata','pause'])video.addEventListener(event,repaint);
      const cleanup=()=>{signal.removeEventListener('abort',dispose);for(const event of ['seeked','loadedmetadata','pause'])video.removeEventListener(event,repaint);dispose();};
      return {destroy:cleanup,append:chunk=>renderer.append(chunk),flush:()=>renderer.flush(),
        synced:(time=currentMediaTime())=>renderer.isSyncedAtMediaTime?renderer.isSyncedAtMediaTime(time):true,
        offset(value){renderer.timeOffset=-value;repaint();},picture(value){
        layer.style.scale=value.zoom*value.stretchX+' '+value.zoom*value.stretchY;layer.style.translate=value.x*100+'% '+value.y*100+'%';
      }};
    }catch(error){dispose();throw error;}
  }
};
