'use strict';
// @ts-check
/**
 * The config first-run setup writes: config.example.yaml with the wizard's answers filled in, through
 * the `yaml` document API so every comment stays, then validated as the server would load it.
 */
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { ROOT, parseConfig, normalizeConfig } = require('../config');
const { serializeYaml } = require('../config-editor');

const TEMPLATE = path.join(ROOT, 'config.example.yaml');
// Where setup puts the certificate it makes, relative to the config file (inside the data folder).
const CERT = 'data/certs/server-cert.pem',
  KEY = 'data/certs/server-key.pem';

/** A YAML node for `value`, strings single-quoted like the rest of config.yaml. */
function node(doc, value, flow) {
  const made = doc.createNode(value);
  YAML.visit(made, {
    Scalar(key, scalar) {
      if (key !== 'key' && typeof scalar.value === 'string') scalar.type = 'QUOTE_SINGLE';
    },
  });
  if (flow !== undefined && YAML.isCollection(made)) made.flow = flow;
  return made;
}
/** Sets one setting, keeping the comments the template has on it. */
function set(doc, keys, value, flow) {
  const old = doc.getIn(keys, true);
  const next = node(doc, value, flow ?? (YAML.isCollection(old) ? old.flow : undefined));
  if (YAML.isNode(old)) {
    next.commentBefore = old.commentBefore;
    next.comment = old.comment;
    next.spaceBefore = old.spaceBefore;
  }
  doc.setIn(keys, next);
}

/**
 * The config text for a complete draft (server/setup/wizard.js `complete()`).
 * @param {ReturnType<ReturnType<typeof import('./wizard').createWizard>['complete']>} answers
 * @param {{template?: string, today?: Date}} [options]
 */
function configText({ draft, rules, discordSettings }, { template, today = new Date() } = {}) {
  const source = template ?? fs.readFileSync(TEMPLATE, 'utf8');
  const doc = YAML.parseDocument(source, { prettyErrors: false, uniqueKeys: true, version: '1.2', stringKeys: true });
  doc.commentBefore = (doc.commentBefore || '').replace(
    / Copy to config\.yaml\./,
    ` Written by first-run setup on ${today.toISOString().slice(0, 10)}.`,
  );
  set(doc, ['operator', 'identities'], [draft.account.provider + ':' + draft.account.subject]);
  // Media sources: a block list, each entry's library list on one line.
  const list = node(doc, draft.sources, false);
  for (const item of list.items) {
    const offered = YAML.isMap(item) ? item.get('libraries', true) : undefined;
    if (YAML.isSeq(offered) && offered.items.every(value => YAML.isScalar(value))) offered.flow = true;
  }
  const old = doc.get('sources', true);
  if (YAML.isNode(old)) list.commentBefore = old.commentBefore;
  doc.set('sources', list);
  set(doc, ['access', 'discord_server'], rules.discord);
  set(doc, ['access', 'source_members'], rules.sourceMembers);
  set(doc, ['access', 'password'], !!rules.password);
  set(doc, ['access', 'accounts'], rules.accounts);
  set(doc, ['secrets', 'server_password'], rules.password || '');
  set(doc, ['guests', 'enabled'], rules.guests);
  if (discordSettings)
    for (const [key, value] of Object.entries(discordSettings.discord)) set(doc, ['discord', key], value);
  set(doc, ['server', 'host'], draft.network.host);
  set(doc, ['server', 'port'], draft.network.port);
  set(doc, ['server', 'public_url'], draft.network.publicUrl);
  set(doc, ['server', 'lan_url'], draft.network.lanUrl || '');
  set(doc, ['server', 'listen'], draft.network.listen || 'https');
  if (draft.network.trustedProxies?.length) {
    set(doc, ['server', 'trusted_proxies'], draft.network.trustedProxies);
    set(doc, ['server', 'trusted_proxy_header'], draft.network.trustedProxyHeader || 'x-forwarded-for');
  }
  set(doc, ['server', 'tls_cert'], draft.network.listen === 'http-proxy' ? '' : CERT);
  set(doc, ['server', 'tls_key'], draft.network.listen === 'http-proxy' ? '' : KEY);
  return serializeYaml(doc, source, { flowCollectionPadding: false });
}

/**
 * The config as the server would load it from `configFile`, or the reason it would not load.
 * @param {string} text
 * @param {string} configFile
 * @param {boolean} [discoverTools]
 */
function load(text, configFile, discoverTools = false) {
  const config = normalizeConfig(parseConfig(text), { base: path.dirname(configFile), discoverTools });
  config.configFile = path.resolve(configFile);
  return config;
}

module.exports = { configText, load, CERT, KEY, TEMPLATE };
