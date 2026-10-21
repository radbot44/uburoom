'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(require.resolve('../web/watch-rooms-ui.js'),'utf8'),context);
const sortPeople = context.uburoomRoomUI.sortPeople;

test('Room rosters put self first, then leader, hosts and viewers alphabetically without mutating the input', () => {
  const people = [
    {id:'v2',name:'Zoe',role:'viewer'},{id:'h2',name:'Zane',role:'host'},
    {id:'c',name:'Leader',role:'creator'},{id:'v1',name:'alice',role:'viewer'},
    {id:'h1',name:'Alice',role:'host'},{id:'self',name:'Zzz',role:'viewer'}
  ];
  const original = people.map(person=>person.id);
  assert.deepEqual(Array.from(sortPeople(people,'self'),person=>person.id),['self','c','h1','h2','v1','v2']);
  assert.deepEqual(people.map(person=>person.id),original);
  assert.deepEqual(Array.from(sortPeople(people,'h2'),person=>person.id),['h2','c','h1','v1','v2','self']);
  assert.deepEqual(Array.from(sortPeople([],undefined)),[]);
});
