'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {PlexAuth}=require('../server/plex-auth');

test('Plex scope invalidation discards an old validation without overwriting a replacement credential',async()=>{
  let stored={token:'old'}, oldStarted, newStarted, releaseOld, releaseNew, validations=0;
  const enteredOld=new Promise(resolve=>oldStarted=resolve), enteredNew=new Promise(resolve=>newStarted=resolve);
  const oldGate=new Promise(resolve=>releaseOld=resolve), newGate=new Promise(resolve=>releaseNew=resolve);
  const accounts={
    canonical:id=>({id}),identities:()=>[{provider:'plex',subject:'subject'}],
    credential:(_subject,value)=>{if(value)stored={...value};return {...stored};}
  };
  const auth=new PlexAuth({},accounts,{});
  auth.validate=async credential=>{
    validations++;
    if(credential.token==='old'){oldStarted();await oldGate;return {token:'old-scope'};}
    newStarted();await newGate;return {token:'new-scope'};
  };
  const old=auth.forUser('viewer');
  await enteredOld;
  stored={token:'new'};auth.clear();
  const fresh=auth.forUser('viewer');
  await enteredNew;
  releaseOld();
  await assert.rejects(old,/changed during validation/);
  assert.equal(auth.inflight.has('subject'),true,'old completion cannot remove the new validation');
  releaseNew();
  const scoped=await fresh;
  assert.equal(scoped.token,'new-scope');
  assert.equal(stored.token,'new');
  assert.equal(await auth.forUser('viewer'),scoped);
  assert.equal(validations,2);
});
