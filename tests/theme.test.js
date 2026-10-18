'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../web/theme.js'),'utf8');
function fixture(stored,{blocked=false}={}) {
  const events={},ready={},dataset={},buttons={},writes=[];
  for(const id of ['theme-toggle','accent-toggle'])buttons[id]={label:{},querySelector(){return this.label;},setAttribute(name,value){this[name]=value;},addEventListener(name,callback){this[name]=callback;}};
  const context={URLSearchParams,Event,document:{documentElement:{dataset},querySelectorAll:()=>[],querySelector:()=>null,getElementById:id=>buttons[id],addEventListener:(name,callback)=>{ready[name]=callback;}},
    localStorage:{getItem(){if(blocked)throw Error('Storage unavailable');return stored;},setItem(key,value){if(blocked)throw Error('Storage unavailable');writes.push({key,value});}}};
  context.window={uburoomBrandAssets:{
    '/assets/branding/uburoom-wordmark-brand.svg':fs.readFileSync(require.resolve('../web/assets/uburoom-wordmark-brand.svg'),'utf8'),
    '/favicon.svg':fs.readFileSync(require.resolve('../web/assets/uburoom-oomark-brand.svg'),'utf8')
  },addEventListener:(name,callback)=>{events[name]=callback;},dispatchEvent(){}};
  vm.runInNewContext(source,context);ready.DOMContentLoaded();
  return {dataset,buttons,writes,context,events};
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
