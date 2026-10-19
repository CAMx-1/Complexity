'use strict';
// In-memory fake of the plex.tv endpoints the link flow uses, plus /identity on
// fake servers. It verifies device JWT signatures against the JWK registered at
// PIN creation, as plex.tv does.

const crypto = require('node:crypto');

function verifyJwt(jwt, jwk) {
  const [h, p, s] = jwt.split('.');
  const key = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
  const ok = crypto.verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  return ok ? { header: JSON.parse(Buffer.from(h, 'base64url')), payload: JSON.parse(Buffer.from(p, 'base64url')) } : null;
}

function makeJwt(expSeconds) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'EdDSA', typ: 'JWT' })}.${enc({ exp: expSeconds, sub: 'user' })}.sig`;
}

function fakePlex({ servers = [], reachable = new Set(), username = 'cam' } = {}) {
  const pins = new Map();
  const keys = new Map(); // clientId -> jwk
  const nonces = new Set();
  const calls = [];
  let nextPin = 1000;
  const state = { linkAs: null, refreshFails: false };

  const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  async function fetchImpl(url, opts = {}) {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const h = opts.headers || {};
    const clientId = h['X-Plex-Client-Identifier'];
    calls.push({ method, path: u.pathname, url, headers: h, body: opts.body ? JSON.parse(opts.body) : undefined });

    if (u.host === 'clients.plex.tv') {
      if (method === 'POST' && u.pathname === '/api/v2/pins') {
        const body = JSON.parse(opts.body);
        if (!clientId) return json(400, { error: 'missing client id' });
        if (body.jwk) keys.set(clientId, body.jwk);
        const id = nextPin++;
        const pin = { id, code: `K7Q${id % 10}`, clientIdentifier: clientId, expiresIn: 900, expiresAt: new Date(Date.now() + 900_000).toISOString(), authToken: null };
        pins.set(id, pin);
        return json(201, pin);
      }
      const m = u.pathname.match(/^\/api\/v2\/pins\/(\d+)$/);
      if (method === 'GET' && m) {
        const pin = pins.get(Number(m[1]));
        if (!pin || pin.clientIdentifier !== clientId) return json(404, { error: 'not found' });
        if (!state.linkAs) return json(200, pin);
        // Like plex.tv: return a JWT only when the deviceJWT verifies, else a legacy token.
        const dj = u.searchParams.get('deviceJWT');
        const v = dj && keys.has(clientId) ? verifyJwt(dj, keys.get(clientId)) : null;
        const good = v && v.payload.aud === 'plex.tv' && v.payload.iss === clientId && v.header.kid === keys.get(clientId).kid;
        return json(200, { ...pin, authToken: good ? makeJwt(Math.floor(Date.now() / 1000) + 7 * 86400) : 'legacy-token-abc' });
      }
      if (method === 'GET' && u.pathname === '/api/v2/auth/nonce') {
        const nonce = crypto.randomUUID(); nonces.add(nonce); return json(200, { nonce });
      }
      if (method === 'POST' && u.pathname === '/api/v2/auth/token') {
        if (state.refreshFails) return json(401, { error: 'revoked' });
        const { jwt } = JSON.parse(opts.body);
        const v = verifyJwt(jwt, keys.get(clientId));
        if (!v || !nonces.has(v.payload.nonce)) return json(401, { error: 'bad jwt' });
        nonces.delete(v.payload.nonce);
        return json(200, { authToken: makeJwt(Math.floor(Date.now() / 1000) + 7 * 86400) });
      }
      if (method === 'GET' && u.pathname === '/api/v2/user') {
        return h['X-Plex-Token'] ? json(200, { username, uuid: 'u-1' }) : json(401, {});
      }
      if (method === 'GET' && u.pathname === '/api/v2/resources') {
        if (!h['X-Plex-Token']) return json(401, {});
        return json(200, servers);
      }
      return json(404, {});
    }

    // Fake PMS /identity on any connection URI.
    if (u.pathname === '/identity') {
      const origin = `${u.protocol}//${u.host}`;
      if (!reachable.has(origin)) throw new TypeError('fetch failed');
      const srv = servers.find((s) => (s.connections || []).some((c) => c.uri === origin));
      return json(200, { MediaContainer: { machineIdentifier: srv && srv.clientIdentifier } });
    }
    throw new TypeError(`unexpected fetch ${url}`);
  }

  return { fetchImpl, calls, pins, state, link: (as = username) => { state.linkAs = as; } };
}

const server = (name, id, { owned = true, conns } = {}) => ({
  name,
  clientIdentifier: id,
  provides: 'server',
  owned,
  accessToken: `srv-token-${id}`,
  connections: conns || [
    { protocol: 'https', uri: `https://192-168-1-5.${id}.plex.direct:32400`, local: true, relay: false },
    { protocol: 'https', uri: `https://203-0-113-9.${id}.plex.direct:32400`, local: false, relay: false },
    { protocol: 'https', uri: `https://relay-1.${id}.plex.direct:8443`, local: false, relay: true },
  ],
});

module.exports = { fakePlex, server, verifyJwt };
