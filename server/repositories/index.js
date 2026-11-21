'use strict';
const { AccountsRepo } = require('./accounts');
const { RoomsRepo } = require('./rooms');
const { QueueRepo } = require('./queue');
const { HistoryRepo } = require('./history');
const { UburoomAccountsRepo } = require('./uburoom-accounts');

// One prepared repository set per connection; no rows are mirrored or cached.
const connections = new WeakMap();
function repositories(db) {
  let repos = connections.get(db);
  if (!repos) {
    repos = {
      accounts: new AccountsRepo(db),
      rooms: new RoomsRepo(db),
      queue: new QueueRepo(db),
      history: new HistoryRepo(db),
      uburoomAccounts: new UburoomAccountsRepo(db),
    };
    connections.set(db, repos);
  }
  return repos;
}
module.exports = { repositories };
