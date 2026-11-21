'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createCertificate } = require('../server/local-tls');

test('a self-signed certificate parses when the random serial bytes start with zero', t => {
  t.mock.method(crypto, 'randomBytes', () => Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));

  const { certPem, keyPem } = createCertificate();
  const certificate = new crypto.X509Certificate(certPem);

  assert.ok(BigInt('0x' + certificate.serialNumber) > 0n);
  assert.ok(certificate.checkPrivateKey(crypto.createPrivateKey(keyPem)));
});
