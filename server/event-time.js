'use strict';
const fail = message => Object.assign(new Error(message), { status: 400 });
function formatter(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw fail('Choose a valid time zone.');
  }
}
function wallTime(format, at) {
  const parts = Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
// Resolve the explicitly chosen zone, independently of the server/browser zone.
// Reject missing/repeated DST wall times rather than silently shifting a watch night.
function eventTime(local, timeZone) {
  if (typeof local !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(local))
    throw fail('Choose an event date and time.');
  const seed = Date.parse(local + 'Z'),
    format = formatter(timeZone);
  if (!Number.isFinite(seed) || new Date(seed).toISOString().slice(0, 16) !== local)
    throw fail('Choose a valid event date and time.');
  const candidates = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    const at = seed + hours * 3600000,
      offset = Date.parse(wallTime(format, at) + 'Z') - at;
    const candidate = seed - offset;
    if (wallTime(format, candidate) === local) candidates.add(candidate);
  }
  if (!candidates.size) throw fail('That local time does not exist because the clocks change. Choose another time.');
  if (candidates.size > 1)
    throw fail('That local time occurs twice because the clocks change. Use UTC or choose another time.');
  return new Date([...candidates][0]).toISOString();
}
function eventDetails(args) {
  const start = eventTime(args.startLocal, args.timeZone),
    end = eventTime(args.endLocal, args.timeZone);
  if (Date.parse(start) <= Date.now()) throw fail('The event must start in the future.');
  if (Date.parse(end) <= Date.parse(start)) throw fail('The event must end after it starts.');
  return {
    title: args.title,
    description: args.description,
    start,
    end,
    timeZone: formatter(args.timeZone).resolvedOptions().timeZone,
  };
}
module.exports = { eventTime, eventDetails, wallTime, formatter };
