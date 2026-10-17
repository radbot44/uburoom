'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const events=new Map(),layers=[],draws=[];let initialized,instance;
  const ready=new Promise(resolve=>initialized=resolve);
  class Bitmap {
    constructor(options){instance=this;this.options=options;queueMicrotask(()=>options.onLoaded());}
    whenReady(){return ready;}
    renderAtMediaTime(time,force){draws.push({time,force,offset:this.timeOffset});}
    dispose(){this.disposed=true;}
  }
  const video={currentTime:2,videoWidth:640,videoHeight:360,parentElement:{append(layer){layers.push(layer);}},
    addEventListener(event,handler){events.set(event,handler);},removeEventListener(event,handler){if(events.get(event)===handler)events.delete(event);}};
  const context={window:{},AbortController,performance,TextDecoder,Uint8Array,setTimeout,clearTimeout,
    document:{createElement:()=>({style:{},setAttribute(){},append(){},remove(){this.removed=true;}})},
    loadModule:async()=>({PgsRenderer:Bitmap,VobSubRenderer:Bitmap})};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/subtitle-renderers.js'),'utf8').replaceAll('import(', 'loadModule('),context);
  return {api:context.window.uburoomSubtitleRenderers,video,draws,events,layers,initialized:()=>initialized(),instance:()=>instance};
}
test('bitmap parsed-data callback does not publish an overlay before full initialization; paused repaints force presentation',async()=>{
  for(const format of ['pgs','vobsub']){
    const f=fixture(),abort=new AbortController();let published=false;
    const pending=f.api.create(f.video,format,{data:new Uint8Array([1,2,3])},0,abort.signal).then(value=>{published=true;return value;});
    await tick();assert.ok(f.instance());assert.equal(published,false);assert.equal(f.draws.length,0);
    f.initialized();const renderer=await pending;assert.equal(published,true);assert.deepEqual(f.draws,[{time:2,force:true,offset:undefined}]);
    renderer.offset(.1);f.events.get('pause')();
    assert.equal(f.draws.length,3);assert.ok(f.draws.every(draw=>draw.force===true));assert.equal(f.draws[1].offset,-.1);
    renderer.destroy();assert.equal(f.instance().disposed,true);assert.equal(f.events.size,0);assert.equal(f.layers[0].removed,true);
  }
});
test('cancelling during bitmap initialization removes the overlay and disposes the parser',async()=>{
  const f=fixture(),abort=new AbortController();
  const pending=f.api.create(f.video,'pgs',{data:new Uint8Array([1])},0,abort.signal);await tick();abort.abort();
  await assert.rejects(pending,/cancelled/);assert.equal(f.instance().disposed,true);assert.equal(f.layers[0].removed,true);assert.equal(f.draws.length,0);f.initialized();
});
