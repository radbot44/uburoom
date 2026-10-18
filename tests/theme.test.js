'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../web/theme.js'),'utf8');
function fixture(stored,{blocked=false}={}) {
  const events={},ready={},dataset={},buttons={},writes=[];
  let now=0, sequence=0;const timers=new Map();
  for(const id of ['theme-toggle','accent-toggle'])buttons[id]={label:{},querySelector(){return this.label;},setAttribute(name,value){this[name]=value;},addEventListener(name,callback){this[name]=callback;}};
  const context={URLSearchParams,Event,performance:{now:()=>now},setTimeout:(callback,delay)=>{const id=++sequence;timers.set(id,{callback,at:now+delay});return id;},clearTimeout:id=>timers.delete(id),document:{documentElement:{dataset},querySelectorAll:()=>[],querySelector:()=>null,getElementById:id=>buttons[id],addEventListener:(name,callback)=>{ready[name]=callback;}},
    localStorage:{getItem(){if(blocked)throw Error('Storage unavailable');return stored;},setItem(key,value){if(blocked)throw Error('Storage unavailable');writes.push({key,value});}}};
  context.window={uburoomBrandAssets:{
    '/assets/branding/uburoom-wordmark-brand.svg':fs.readFileSync(require.resolve('../web/assets/uburoom-wordmark-brand.svg'),'utf8'),
    '/favicon.svg':fs.readFileSync(require.resolve('../web/assets/uburoom-oomark-brand.svg'),'utf8')
  },matchMedia:()=>({matches:true}),addEventListener:(name,callback)=>{events[name]=callback;},dispatchEvent(){}};
  vm.runInNewContext(source,context);ready.DOMContentLoaded();
  function advance(ms) {
    const target=now+ms;
    while(true) {
      const next=[...timers].filter(([,timer])=>timer.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next)break;
      timers.delete(next[0]);now=next[1].at;next[1].callback();
    }
    now=target;
  }
  return {dataset,buttons,writes,context,events,advance,timers};
}
test('appearance is explicit, defaults to dark/orange and validates persisted values',()=>{
  for(const stored of [null,'broken','{}','{"theme":"system","accent":"blue"}']) {
    const f=fixture(stored);assert.equal(f.dataset.theme,'dark');assert.equal(f.dataset.accent,'orange');
  }
  const f=fixture('{"theme":"light","accent":"pink"}');
  assert.equal(f.dataset.theme,'light');assert.equal(f.dataset.accent,'pink');
  assert.equal(f.buttons['theme-toggle']['aria-checked'],'true');
  assert.ok(decodeURIComponent(f.context.window.uburoomTheme.brandUrl('/favicon.svg')).includes('stroke="#242329"'));
});
test('rapid theme and accent changes reuse local images for both logos and favicon',()=>{
  const f=fixture(null),urls=new Set();
  for(let i=0;i<1000;i++) {
    f.advance(1000);
    f.buttons[i%2?'theme-toggle':'accent-toggle'].click();
    for(const path of Object.keys(f.context.window.uburoomBrandAssets)) {
      const url=f.context.window.uburoomTheme.brandUrl(path);
      assert.ok(url.startsWith('data:image/svg+xml,'));
      const svg=decodeURIComponent(url.slice(url.indexOf(',')+1));
      assert.ok(svg.includes(f.dataset.theme==='light'?'#242329':'#F8F7F4'));
      assert.ok(svg.includes('stroke="'+(f.dataset.accent==='pink'?'#FF9954':'#FF7197')+'"'));
      urls.add(url);
    }
  }
  assert.equal(urls.size,8,'Only four variants per canonical asset');
});
test('Sunrise needs 20 clicks within five seconds, cycles locally and exits to orange',()=>{
  const f=fixture(null);
  for(let i=0;i<19;i++){f.buttons['accent-toggle'].click();f.advance(200);}
  assert.equal(f.dataset.sunrise,undefined);f.buttons['accent-toggle'].click();
  assert.equal(f.dataset.sunrise,'true');assert.equal(f.dataset.accent,'orange');
  const writes=f.writes.length;
  f.advance(299);assert.equal(f.dataset.accent,'orange');
  f.advance(1);assert.equal(f.dataset.accent,'pink');
  f.advance(300);assert.equal(f.dataset.accent,'orange');assert.equal(f.writes.length,writes);
  f.buttons['accent-toggle'].click();assert.equal(f.dataset.sunrise,undefined);assert.equal(f.dataset.accent,'orange');
  f.advance(1000);assert.equal(f.dataset.accent,'orange');assert.equal(f.timers.size,0);
});
test('slow clicks do not activate Sunrise and rapid theme clicks only produce a dud',()=>{
  const f=fixture(null);
  for(let i=0;i<20;i++){f.buttons['accent-toggle'].click();f.advance(300);}
  assert.equal(f.dataset.sunrise,undefined);
  for(let i=0;i<20;i++)f.buttons['theme-toggle'].click();
  assert.equal(f.dataset.theme,'dark');assert.equal(f.dataset.sunrise,undefined);assert.equal(f.timers.size,0);
});
test('a saved preference from another tab stops Sunrise without persisting animation frames',()=>{
  const f=fixture(null);for(let i=0;i<20;i++)f.buttons['accent-toggle'].click();
  f.context.localStorage.getItem=()=>'{"theme":"light","accent":"pink"}';f.events.storage({key:'uburoom.appearance'});
  assert.equal(f.dataset.sunrise,undefined);assert.equal(f.dataset.accent,'pink');assert.equal(f.timers.size,0);
});
test('independent toggles persist only appearance; blocked storage still allows local choices',()=>{
  for(const blocked of [false,true]) {
    const f=fixture(null,{blocked});f.buttons['theme-toggle'].click();
    assert.equal(f.dataset.theme,'light');assert.equal(f.dataset.accent,'orange');
    f.buttons['accent-toggle'].click();assert.equal(f.dataset.accent,'pink');
    if(!blocked)assert.deepEqual(JSON.parse(f.writes.at(-1).value),{theme:'light',accent:'pink'});
  }
});
test('storage updates synchronize appearance without writing another update',()=>{
  const f=fixture(null);f.context.localStorage.getItem=()=>'{"theme":"light","accent":"pink"}';
  f.events.storage({key:'uburoom.appearance'});
  assert.equal(f.dataset.theme,'light');assert.equal(f.dataset.accent,'pink');assert.equal(f.writes.length,0);
});
