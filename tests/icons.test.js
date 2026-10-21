'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const icons = require('../web/icons');
const remote = require('../web/remote-ui');

test('the Tabler pack resolves every semantic name without legacy artwork', () => {
  for (const [name, slug] of Object.entries(icons.aliases)) {
    assert.equal(icons.resolveName(name), slug, name);
    assert.ok(icons.glyphs[slug]?.includes('<'), name + ' resolves to a local SVG');
  }
  for (const slug of ['adjustments-horizontal','sparkles','karate','ban','volume-off','volume-4','volume-2','volume','thumb-up','thumb-down','thumb-up-off','thumb-down-off']) {
    assert.equal(icons.resolveName(slug), slug);
    assert.ok(icons.glyphs[slug]?.includes('<'), slug + ' is bundled');
  }
  for (const name of ['captionsOn','mute','muted']) assert.equal(icons.resolveName(name), null);
  assert.equal(icons.resolveName('captions'), 'badge-cc');
  assert.equal(icons.resolveName('libraryCards'), 'columns-2');
  assert.equal(icons.resolveName('libraryPosters'), 'border-all');
  assert.equal(icons.resolveName('host'), 'chair-director');
  assert.ok(!Object.hasOwn(remote, 'icon'), 'remote UI no longer exports the icon provider');
});

test('volume follows the mute and 10/50 percent boundaries', () => {
  for (const [value, muted, expected] of [
    [0,false,'volume-off'], [0,true,'volume-off'], [1,false,'volume-4'],
    [9,false,'volume-4'], [10,false,'volume-2'], [49,false,'volume-2'],
    [50,false,'volume-2'], [51,false,'volume'], [100,false,'volume'],
    [75,true,'volume-off']
  ]) assert.equal(icons.volumeName(value,muted), expected, String(value) + '%');
});

test('seek glyphs support 15, 30 and 60; other distances do not masquerade as 15', () => {
  for (const seconds of [15,30,60]) {
    assert.equal(icons.resolveName('back',seconds), 'rewind-backward-' + seconds);
    assert.equal(icons.resolveName('forward',seconds), 'rewind-forward-' + seconds);
    assert.ok(icons.glyphs['rewind-backward-' + seconds]);
    assert.ok(icons.glyphs['rewind-forward-' + seconds]);
  }
  assert.equal(icons.resolveName('back',42), 'player-skip-back');
  assert.equal(icons.resolveName('forward',42), 'player-skip-forward');
});

test('all icons render as inline SVG and the monochrome oomark retains its geometry', () => {
  const doc = {createElementNS(ns,tag) {
    assert.equal(ns,'http://www.w3.org/2000/svg');
    assert.equal(tag,'svg');
    return {attrs:{},setAttribute(k,v){this.attrs[k]=v;}};
  }};
  const caption = icons.icon(doc,'captions');
  assert.equal(caption.attrs['data-tabler-icon'],'badge-cc');
  assert.equal(caption.attrs.viewBox,'0 0 24 24');
  assert.equal(caption.attrs['aria-hidden'],'true');
  assert.match(caption.innerHTML,/<path/);
  const logo = icons.icon(doc,'oomark');
  assert.equal(logo.attrs.viewBox,'528.41 544.4 298.99 249.1061');
  assert.equal(logo.attrs.class,'oomark-icon');
  assert.match(logo.innerHTML,/<circle/);
  assert.throws(()=>icons.icon(doc,'unknown-icon'),/Unknown uburoom icon/);
});

test('legacy remote paths are archived but never executed', () => {
  const src=fs.readFileSync(path.join(__dirname,'../web/remote-ui.js'),'utf8');
  assert.match(src,/\/\* LEGACY ICON ARCHIVE/);
  assert.match(src,/\/\* LEGACY SVG RENDERER/);
  assert.doesNotMatch(src,/global\.uburoomUI\.icon/);
});
