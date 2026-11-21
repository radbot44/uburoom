'use strict';

/**
 * A Plex media selector: a numeric rating key, optionally with the numeric id of
 * one of its media versions. Only this form may reach a Plex URL.
 * @param {unknown} value
 * @returns {{id: string, demo: boolean, ratingKey?: string, mediaId?: string} | undefined}
 */
function plexIdentity(value) {
  if (value === 'demo') return { id: value, demo: true };
  const match = typeof value === 'string' && /^(\d{1,20})(?::(\d{1,20}))?$/.exec(value);
  return match ? { id: value, ratingKey: match[1], mediaId: match[2], demo: false } : undefined;
}

module.exports = { plexIdentity };
