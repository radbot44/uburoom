'use strict';
/**
 * Sign-in methods: each proves who someone is, and nothing else. Plex sign-in (plex.tv PIN, no
 * server involved) and Discord sign-in (OAuth). Whether a proven identity gets in is
 * server/admission/'s decision; identity code never reads media sources.
 */
const { PlexTv, PlexAccessError } = require('./plex');
const { createDiscordSignIn } = require('./discord');

module.exports = { PlexTv, PlexAccessError, createDiscordSignIn };
