'use strict';
const DEFAULTS = Object.freeze({ maxSaved:50, maxOpen:5, minRetained:10, inactiveDays:180,
  maxMembers:20, maxPeople:100, recoverySeconds:60, maxQueue:50, maxHistory:150 });
const SETTINGS = Object.freeze({ max_saved:'maxSaved', max_open:'maxOpen', min_retained:'minRetained',
  inactive_days:'inactiveDays', max_members:'maxMembers', max_people:'maxPeople',
  recovery_seconds:'recoverySeconds', max_queue:'maxQueue', max_history:'maxHistory' });
function limits(config = {}) { return { ...DEFAULTS, ...config.roomLimits }; }
function configuration(rooms = {}) {
  const result = { ...DEFAULTS };
  for (const [key, name] of Object.entries(SETTINGS)) if (rooms[key] !== undefined) {
    const value = rooms[key], min = ['minRetained','inactiveDays','maxHistory'].includes(name) ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < min || value > 1000000) throw new Error('rooms.' + key + ' must be an integer from ' + min + ' to 1000000');
    result[name] = value;
  }
  if (result.minRetained > result.maxSaved) throw new Error('rooms.min_retained cannot exceed rooms.max_saved');
  if (result.maxOpen > result.maxSaved) throw new Error('rooms.max_open cannot exceed rooms.max_saved');
  return result;
}
module.exports = { DEFAULTS, SETTINGS, limits, configuration };
