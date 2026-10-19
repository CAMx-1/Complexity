'use strict';
// Per-user device identity for Plex JWT auth: a random client identifier and an
// Ed25519 key pair. The public half is registered with plex.tv as a JWK when the
// PIN is created; the private half signs short-lived device JWTs.

const crypto = require('node:crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** Create a new device identity. Everything returned is JSON-serialisable. */
function createDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }); // { kty: 'OKP', crv: 'Ed25519', x }
  const kid = crypto.randomUUID();
  return {
    clientId: crypto.randomUUID(),
    kid,
    publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid, alg: 'EdDSA', use: 'sig' },
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  };
}

/**
 * Sign a device JWT (EdDSA). Plex expects aud "plex.tv", iss = the
 * X-Plex-Client-Identifier, and the registered key's kid in the header.
 * `claims` is merged in (e.g. { nonce, scope } for the token refresh flow).
 */
function signDeviceJwt(device, claims = {}, { ttlSeconds = 300, now = Date.now() } = {}) {
  const iat = Math.floor(now / 1000);
  const header = { alg: 'EdDSA', typ: 'JWT', kid: device.kid };
  const payload = { aud: 'plex.tv', iss: device.clientId, iat, exp: iat + ttlSeconds, ...claims };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = crypto.createPrivateKey(device.privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(signingInput), key);
  return `${signingInput}.${b64url(sig)}`;
}

/** Decode (without verifying) a JWT payload. Returns null for non-JWT strings. */
function decodeJwtPayload(token) {
  if (typeof token !== 'string' || !token.startsWith('eyJ')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

module.exports = { createDevice, signDeviceJwt, decodeJwtPayload };
