'use strict';
const { eventTime, wallTime, formatter } = require('../shared/event-time.mjs');
const fail = message => Object.assign(new Error(message), { status: 400 });

function eventDetails(args, previous) {
  const start = args.startLocal === undefined ? previous.start : eventTime(args.startLocal, args.timeZone);
  const startMs = Date.parse(start);
  const end =
    args.durationMinutes !== undefined
      ? new Date(startMs + args.durationMinutes * 60000)
      : new Date(args.endLocal === undefined ? previous.end : eventTime(args.endLocal, args.timeZone));
  if (startMs <= Date.now()) throw fail('The event must start in the future.');
  if (!Number.isFinite(end.getTime()) || end.getTime() <= startMs) throw fail('The event must end after it starts.');
  return {
    title: args.title,
    description: args.description,
    start,
    end: args.durationMinutes === undefined && args.endLocal === undefined ? previous.end : end.toISOString(),
    timeZone: args.timeZone === undefined ? previous.timeZone : formatter(args.timeZone).resolvedOptions().timeZone,
  };
}
module.exports = { eventTime, eventDetails, wallTime, formatter };
