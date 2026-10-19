'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { createDevice, signDeviceJwt, decodeJwtPayload } = require('../src/plex/deviceKey');
const auth = require('../src/plex/auth');
const servers = require('../src/plex/servers');
const { fakePlex, server, verifyJwt } = require('./fakePlex');

test('device JWT is EdDSA-signed with plex.tv claims and the kid', () => {
  const d = createDevice();
  const jwt = signDeviceJwt(d, { nonce: 'n1' }, { now: 1_700_000_000_000, ttlSeconds: 60 });
  const v = verifyJwt(jwt, d.publicJwk);
  assert.ok(v, 'signature verifies with the public JWK');
  assert.deepEqual(v.header, { alg: 'EdDSA', typ: 'JWT', kid: d.kid });
  assert.equal(v.payload.aud, 'plex.tv');
  assert.equal(v.payload.iss, d.clientId);
  assert.equal(v.payload.nonce, 'n1');
  assert.equal(v.payload.exp - v.payload.iat, 60);
  assert.equal(d.publicJwk.kty, 'OKP');
  assert.equal(d.publicJwk.crv, 'Ed25519');
  assert.equal(d.publicJwk.d, undefined, 'private part never in the JWK');
});

test('PIN flow: pending, then a JWT once linked; refresh via nonce', async () => {
  const plex = fakePlex();
  const d = createDevice();
  const pin = await auth.createPin(plex.fetchImpl, d);
  assert.match(pin.code, /^[A-Z0-9]{4}$/);
  const created = plex.calls.find((c) => c.path === '/api/v2/pins');
  assert.equal(created.body.strong, false);
  assert.equal(created.body.jwk.x, d.publicJwk.x);
  assert.equal(created.headers['X-Plex-Product'], 'Complexity');

  assert.deepEqual(await auth.checkPin(plex.fetchImpl, d, pin), { status: 'pending' });
  plex.link();
  const linked = await auth.checkPin(plex.fetchImpl, d, pin);
  assert.equal(linked.status, 'linked');
  assert.equal(linked.token.type, 'jwt', 'deviceJWT accepted, so Plex issues a JWT');
  assert.ok(linked.token.expiresAt > Date.now() + 6 * 86400_000);

  assert.equal(auth.needsRefresh(linked.token), false);
  assert.equal(auth.needsRefresh(linked.token, linked.token.expiresAt - 3600_000), true);
  const fresh = await auth.refreshToken(plex.fetchImpl, d);
  assert.equal(fresh.type, 'jwt');
});

test('checkPin reports expiry locally and on 404', async () => {
  const plex = fakePlex();
  const d = createDevice();
  assert.deepEqual(await auth.checkPin(plex.fetchImpl, d, { id: 1, expiresAt: Date.now() - 1 }), { status: 'expired' });
  assert.deepEqual(await auth.checkPin(plex.fetchImpl, d, { id: 999999, expiresAt: Date.now() + 60_000 }), { status: 'expired' });
});

test('legacy tokens are recognised and never refreshed', () => {
  const t = auth.describeToken('abcDEF123');
  assert.deepEqual(t, { value: 'abcDEF123', type: 'legacy' });
  assert.equal(auth.needsRefresh(t), false);
  assert.equal(decodeJwtPayload('abc'), null);
});

test('servers: owned first; API via remote direct; streams local then remote, never relay', async () => {
  const a = server('Zeta', 'aaa', { owned: false });
  const b = server('Basement', 'bbb');
  const notServer = { name: 'Phone', clientIdentifier: 'p', provides: 'client,player', connections: [] };
  const plex = fakePlex({ servers: [a, b, notServer], reachable: new Set(['https://203-0-113-9.bbb.plex.direct:32400']) });
  const d = createDevice();
  const list = await servers.listServers(plex.fetchImpl, d, 'tok');
  assert.deepEqual(list.map((s) => s.name), ['Basement', 'Zeta']);

  const conn = await servers.resolveConnections(plex.fetchImpl, d, list[0], { timeoutMs: 500 });
  assert.equal(conn.apiUri, 'https://203-0-113-9.bbb.plex.direct:32400');
  assert.equal(conn.viaRelay, false);
  assert.deepEqual(conn.streamUris, ['https://192-168-1-5.bbb.plex.direct:32400', 'https://203-0-113-9.bbb.plex.direct:32400']);

  assert.equal(await servers.resolveConnections(plex.fetchImpl, d, list[1], { timeoutMs: 500 }), null, 'unreachable server');
});

test('matchServer by number, exact and partial name', () => {
  const list = [{ name: 'Basement' }, { name: "Mom's Plex" }];
  assert.equal(servers.matchServer(list, { index: 2 }).name, "Mom's Plex");
  assert.equal(servers.matchServer(list, { name: 'basement' }).name, 'Basement');
  assert.equal(servers.matchServer(list, { name: 'moms plex' }).name, "Mom's Plex");
  assert.equal(servers.matchServer(list, { name: 'garage' }), null);
  assert.equal(servers.matchServer(list, { index: 3 }), null);
});
