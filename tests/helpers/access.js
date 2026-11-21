'use strict';
/**
 * A normalized `config.accessPolicy` for tests, as server/config.js builds it from `access:`.
 * Member rules here always name Plex sources, so Plex sign-in is offered whenever there is one.
 */
function accessPolicy({
  discordServer = true,
  sourceMembers = [],
  password = false,
  accounts = false,
  publicWeb = true,
} = {}) {
  return {
    discordServer,
    sourceMembers,
    password,
    accounts,
    publicWeb,
    discord: discordServer,
    plex: sourceMembers.length > 0,
  };
}

module.exports = { accessPolicy };
