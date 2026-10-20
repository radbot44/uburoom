'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { findOnPath } = require('../server/media-tools');
const { normalizeConfig } = require('../server/config');
const { AV1 } = require('../server/av1');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-tool-path-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const directory = path.join(root,'tools with spaces'); fs.mkdirSync(directory);
  const name = tool => tool + (process.platform === 'win32' ? '.exe' : '');
  const ffmpeg = path.join(directory,name('ffmpeg')), ffprobe = path.join(directory,name('ffprobe'));
  fs.copyFileSync(process.execPath,ffmpeg); fs.chmodSync(ffmpeg,0o700);
  fs.copyFileSync(process.execPath,ffprobe); fs.chmodSync(ffprobe,0o700);
  return {root,directory,ffmpeg,ffprobe};
}

test('blank or omitted tools resolve executable files from PATH and run without a shell', t => {
  const fixtureTools = fixture(t);
  const environment = {PATH:fixtureTools.directory};
  for (const value of [{}, {tools:{ffmpeg:'',ffprobe:''}}]) {
    const config = normalizeConfig(value,{environment});
    assert.equal(config.ffmpegPath,fixtureTools.ffmpeg);
    assert.equal(config.ffprobePath,fixtureTools.ffprobe);
    const manager = new AV1({},config);
    assert.equal(manager.ffmpeg,fixtureTools.ffmpeg);
    assert.equal(manager.ffprobe,fixtureTools.ffprobe);
    const output = spawnSync(manager.ffmpeg,['-e','process.stdout.write("fixture-tool")'],{encoding:'utf8'});
    assert.equal(output.status,0,output.stderr);
    assert.equal(output.stdout,'fixture-tool');
  }
});

test('PATH order, missing entries, spaces and explicit path precedence are preserved', t => {
  const tools = fixture(t), second = path.join(tools.root,'second'); fs.mkdirSync(second);
  const environment = {PATH:[path.join(tools.root,'absent'),tools.directory,second].join(path.delimiter)};
  assert.equal(findOnPath('ffmpeg',environment),tools.ffmpeg);
  const config = normalizeConfig({tools:{ffmpeg:'custom/ffmpeg',ffprobe:'custom/ffprobe'}},{base:tools.root,environment});
  assert.equal(config.ffmpegPath,path.join(tools.root,'custom/ffmpeg'));
  assert.equal(config.ffprobePath,path.join(tools.root,'custom/ffprobe'));
  assert.equal(normalizeConfig({tools:{ffmpeg:'custom/ffmpeg'}},{base:tools.root,environment}).ffprobePath,tools.ffprobe);
  fs.unlinkSync(tools.ffmpeg);
  fs.mkdirSync(tools.ffmpeg);
  assert.equal(findOnPath('ffmpeg',environment),undefined,'a directory is not an executable');
  assert.equal(findOnPath('ffmpeg', {PATH:['','relative','"'+tools.directory+'"'].join(path.delimiter)}),undefined);
  assert.equal(findOnPath('ffprobe', {PATH:'"'+tools.directory+'"'}),tools.ffprobe);
});

test('missing PATH tools leave optional features unavailable and preserve sibling ffprobe fallback', t => {
  const tools = fixture(t);
  const empty = normalizeConfig({}, {environment:{PATH:''}});
  assert.equal(empty.ffmpegPath,undefined);
  assert.equal(empty.ffprobePath,undefined);
  assert.throws(() => new AV1({},empty).acquire({id:'1'},'direct'), /install FFmpeg.*PATH/);
  const explicit = normalizeConfig({tools:{ffmpeg:tools.ffmpeg}},{environment:{PATH:''}});
  assert.equal(new AV1({},explicit).ffprobe,tools.ffprobe);
  if(process.platform==='win32') {
    assert.equal(findOnPath('ffmpeg',{Path:tools.directory}),tools.ffmpeg,'Windows Path is case insensitive');
  } else {
    fs.chmodSync(tools.ffmpeg,0o600);
    assert.equal(findOnPath('ffmpeg',{PATH:tools.directory}),undefined,'Unix requires executable permission');
    assert.equal(findOnPath('ffprobe',{Path:tools.directory}),undefined,'Unix PATH is case sensitive');
  }
});
