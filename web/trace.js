// @ts-check
/* Player timing events from helper modules go to the page's diagnostics recorder once it exists.
 * The recorder drops anything it does not allow. */
/** @type {((event: string, fields?: object) => void) | undefined} */
let sink;
/** @param {(event: string, fields?: object) => void} next */
export function setTraceSink(next) {
  sink = next;
}
/** @param {string} event @param {object} [fields] */
export function trace(event, fields) {
  sink?.(event, fields);
}
