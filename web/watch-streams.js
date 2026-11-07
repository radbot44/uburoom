/* One bounded preparation path for quality changes, fallback and return probes. */
(function(global) {
  'use strict';
  function prepare(next,{target,seconds=1,hlsConfig}) {
    const element=document.createElement('video'),cache={recording:true,bytes:0,segments:new Map(),windows:new Map()};
    element.muted=true;element.preload='auto';
    let client,failed=false,closed=false,anchored=false;
    const failure=()=>{failed=true;};
    const seek=()=>{if(!closed && element.readyState && Math.abs(element.currentTime-target())>1)element.currentTime=target();};
    element.addEventListener('loadedmetadata',seek);element.addEventListener('error',failure);
    if(uburoomPlayback.localFormat(next.format))client=new uburoomAV1(element,next.mediaUrl,target,failure,1,{cache,ahead:seconds,background:true});
    else if(next.format==='hls' && Hls.isSupported()) {
      client=new Hls({...hlsConfig(next,cache),maxBufferLength:seconds,maxMaxBufferLength:Math.max(30,seconds)});
      client.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal)failure();});
      client.on(Hls.Events.FRAG_LOADED,()=>{if(!anchored)client.pauseBuffering();});
      client.on(Hls.Events.FRAG_BUFFERED,()=>{
        if(!anchored){anchored=true;seek();client.resumeBuffering?.();client.startLoad(target());}
      });
      client.loadSource(next.mediaUrl);client.attachMedia(element);
    } else if(next.format==='file')element.src=next.mediaUrl;
    else failed=true;
    return {cache,get failed(){return failed;},
      ahead() {
        if(closed || failed)return 0;
        seek();
        // A moving target cannot turn preparation into an episode-sized cache.
        for(const [url,bytes] of cache.segments) {
          const index=/\/chunk-(?:video|audio)-(\d+)$/.exec(String(url))?.[1];
          if(index!==undefined && Number(index)<Math.floor(target()/uburoomPlayback.BUFFER.chunkSeconds)) {cache.segments.delete(url);cache.bytes-=bytes.byteLength;}
          if(cache.windows.get(url)?.end<target()){cache.segments.delete(url);cache.windows.delete(url);cache.bytes-=bytes.byteLength;}
        }
        return uburoomPlayback.bufferedAhead(element.buffered,target());
      },
      close(adopt=false) {
        if(closed)return;closed=true;cache.recording=false;
        client?.destroy();element.removeAttribute('src');element.load();
        if(!adopt){cache.segments.clear();cache.windows.clear();cache.bytes=0;}
      }
    };
  }
  global.uburoomStreams={prepare};
})(globalThis);
