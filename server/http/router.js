'use strict';

/**
 * @typedef {object} RouteContext What every route handler receives.
 * @property {import('node:http').IncomingMessage} req
 * @property {import('node:http').ServerResponse} res
 * @property {URL} url
 * @property {string} route The request path.
 * @property {{context: boolean, query: string}} activity Whether the request comes from Discord Activity.
 * @property {(res: import('node:http').ServerResponse, status: number, value: any) => void} json
 * @property {{file: string, type: string} | undefined} [asset] The static file the path names, once looked up.
 * @property {(status: number, value: any) => void} flushed Answers after operator settings are persisted.
 */
/**
 * One entry of the route table. An entry applies when the request's method is listed (any, if `methods` is
 * omitted), `path` matches (a string, a pattern or a test of the path), and `match` returns something truthy.
 * Its `handle` then answers; returning `false` declines, and the next entry is tried.
 * @typedef {object} Route
 * @property {string} name
 * @property {string[]} [methods]
 * @property {string | RegExp | ((route: string) => boolean)} [path]
 * @property {(ctx: RouteContext, matched: any) => any} [match]
 * @property {(ctx: RouteContext, matched: any) => any} handle
 */

/**
 * The route table: entries are tried in order until one answers.
 * @param {Route[][]} sections Groups of entries, in order.
 * @returns {(ctx: RouteContext) => Promise<boolean>} Whether a route answered.
 */
function createRouter(...sections) {
  const table = sections.flat();
  return async ctx => {
    for (const entry of table) {
      if (entry.methods && !entry.methods.includes(ctx.req.method)) continue;
      let matched = true;
      if (typeof entry.path === 'string') {
        if (ctx.route !== entry.path) continue;
      } else if (entry.path instanceof RegExp) {
        matched = entry.path.exec(ctx.route);
        if (!matched) continue;
      } else if (entry.path && !entry.path(ctx.route)) continue;
      if (entry.match) {
        matched = await entry.match(ctx, matched);
        if (!matched) continue;
      }
      if ((await entry.handle(ctx, matched)) !== false) return true;
    }
    return false;
  };
}
module.exports = { createRouter };
