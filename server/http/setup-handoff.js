'use strict';
// @ts-check
/**
 * The hand-off from first-run setup to this app, in the same process (docs/first-run-setup.md D6,
 * step 7). Setup passes the operator's verified account and the hash of a single-use ticket that
 * expires in two minutes. The setup page opens `/auth/setup#ticket=…`; the page posts the ticket
 * from this origin and is signed in through the same completion code a normal sign-in uses.
 *
 * A uburoom account is created when the app starts, whether or not the ticket is used, so the
 * operator can always sign in with the password they chose.
 */
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');
const { isAllowedBrowserOrigin } = require('../origins');
const { WEB } = require('./static');

const EXPIRED = 'This sign-in from setup has expired. Sign in to uburoom.';

/**
 * @param {{handoff: any, config: any, registry: any, uburoomAccounts: any, accountRoutes: () => any,
 *   sessions: any, files: any, logger: any}} services
 */
function setupHandoff({ handoff, config, registry, uburoomAccounts, accountRoutes, sessions, files, logger }) {
  const { json, body } = sessions;
  let pending = handoff ? { ...handoff } : undefined;
  /** @type {{userId: string} | {provider: string, subject: string, name: string, credential?: any} | undefined} */
  let who;

  return {
    /** Makes the operator's uburoom account (setup's choice), before the app answers anyone. */
    async prepare() {
      if (!pending || !pending.account) return;
      const account = pending.account;
      if (account.provider !== 'uburoom') {
        who = {
          provider: account.provider,
          subject: account.subject,
          name: account.name,
          credential: account.credential,
        };
        return;
      }
      try {
        const created = await uburoomAccounts.createFirst({
          username: account.username,
          name: account.name,
          hashed: account.hashed,
          subject: account.subject,
        });
        await registry.flush();
        who = { userId: created.userId };
      } catch (error) {
        pending = undefined;
        logger.error('Setup', 'The operator account was not created: ' + error.message);
      }
    },
    /** @type {import('./router').Route[]} */
    routes: [
      {
        name: 'setup hand-off page',
        methods: ['GET', 'HEAD'],
        path: '/auth/setup',
        async handle({ req, res }) {
          res.setHeader('Referrer-Policy', 'no-referrer');
          files.send(
            req,
            res,
            await files.readAsset(path.join(WEB, 'setup/handoff.html')),
            'text/html; charset=utf-8',
            '/auth/setup',
            { cacheControl: 'no-store' },
          );
        },
      },
      {
        name: 'setup hand-off',
        methods: ['POST'],
        path: '/api/setup-handoff',
        async handle({ req, res }) {
          if (!isAllowedBrowserOrigin(config, req.headers.origin, req))
            return json(res, 403, { error: 'Not authorized' });
          let data;
          try {
            data = await body(req, 1024);
          } catch {
            return json(res, 400, { error: EXPIRED });
          }
          const ticket = typeof data.ticket === 'string' && data.ticket.length <= 100 ? data.ticket : '';
          const expected = pending?.ticket ? Buffer.from(pending.ticket, 'hex') : undefined;
          const given = createHash('sha256').update(ticket).digest();
          const match = !!expected && expected.length === given.length && timingSafeEqual(expected, given);
          if (!match || !who || pending.expires <= Date.now()) {
            if (pending && pending.expires <= Date.now()) pending = undefined;
            return json(res, 400, { error: EXPIRED });
          }
          // Single use.
          pending = undefined;
          const account = await accountRoutes().completeSignIn(req, res, who);
          if (account) registry.seen(account.id);
          who = undefined;
          await registry.flush();
          json(res, 200, { ok: true });
        },
      },
    ],
  };
}

module.exports = { setupHandoff };
