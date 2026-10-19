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

function fakePlex({ servers = [], reachable = new Set(), username = 'cam', library = sampleLibrary() } = {}) {
  const pins = new Map();
  const keys = new Map(); // clientId -> jwk
  const nonces = new Set();
  const calls = [];
  let nextPin = 1000;
  const state = { linkAs: null, refreshFails: false, library, transientMinted: 0, timeline: [], scrobbled: [], stopped: [], sessions: new Set(), segmentsRequested: [], startDelays: 0, segmentDelays: 0, maxOffset: null };

  // Minimal fetch Response (Node 16 has no global Response).
  const json = (status, body) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };

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
    // Fake PMS library and playback endpoints (shared library for all servers).
    const lib = state.library;
    // HLS transcoder: start.m3u8 authorised by ?X-Plex-Token (transient); session paths need no token.
    const raw = (status, text) => ({ ok: status >= 200 && status < 300, status, text: async () => text });
    if (u.pathname === '/video/:/transcode/universal/start.m3u8') {
      const t = u.searchParams.get('X-Plex-Token') || '';
      if (!t.startsWith('transient-')) return raw(401, 'Unauthorized');
      if (state.startDelays > 0) { state.startDelays -= 1; throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }
      const sid = u.searchParams.get('session');
      state.sessions.add(sid);
      return raw(200, `#EXTM3U\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=7000000,RESOLUTION=1920x1080\nsession/${sid}/base/index.m3u8\n`);
    }
    const sess = u.pathname.match(/^\/video\/:\/transcode\/universal\/session\/([^/]+)\/base\/(.+)$/);
    if (sess) {
      if (!state.sessions.has(sess[1])) return raw(404, 'Not Found');
      if (sess[2] === 'index.m3u8') {
        let body = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n';
        for (let i = 0; i < 1200; i++) body += `#EXTINF:10, nodesc\n${String(i).padStart(5, '0')}.ts\n`;
        return raw(200, body);
      }
      state.segmentsRequested.push(sess[2]);
      if (state.segmentDelays > 0) { state.segmentDelays -= 1; throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }
      return raw(206, 'x'.repeat(1024));
    }
    // Like real PMS (1.42): legacy tokens only; JWTs get 401.
    const authed = !!h['X-Plex-Token'] && !String(h['X-Plex-Token']).startsWith('eyJ');
    if (!authed) return json(401, {});
    if (u.pathname === '/transcode/sessions') {
      return json(200, { MediaContainer: { TranscodeSession: [...state.sessions].map((sid) => ({ key: `/transcode/sessions/${sid}`, maxOffsetAvailable: state.maxOffset })) } });
    }
    if (u.pathname === '/hubs/search') {
      const q = (u.searchParams.get('query') || '').toLowerCase();
      const hit = (t) => t.toLowerCase().includes(q);
      const hubs = ['movie', 'show', 'episode'].map((type) => ({ type, Metadata: lib.items.filter((i) => i.type === type && hit(i.title)) }));
      return json(200, { MediaContainer: { Hub: hubs } });
    }
    const leaves = u.pathname.match(/^\/library\/metadata\/(\w+)\/allLeaves$/);
    if (leaves) return json(200, { MediaContainer: { Metadata: lib.items.filter((i) => i.type === 'episode' && i.grandparentRatingKey === leaves[1]) } });
    const one = u.pathname.match(/^\/library\/metadata\/(\w+)$/);
    if (one) return json(200, { MediaContainer: { Metadata: lib.items.filter((i) => i.ratingKey === one[1]) } });
    if (u.pathname === '/library/onDeck') return json(200, { MediaContainer: { Metadata: lib.onDeck } });
    if (u.pathname === '/security/token') { state.transientMinted += 1; return json(200, { MediaContainer: { token: `transient-${state.transientMinted}` } }); }
    if (u.pathname === '/:/timeline') { state.timeline.push(Object.fromEntries(u.searchParams)); return json(200, {}); }
    if (u.pathname === '/:/scrobble') { state.scrobbled.push(u.searchParams.get('key')); return json(200, {}); }
    if (u.pathname === '/video/:/transcode/universal/stop') { state.stopped.push(u.searchParams.get('session')); return json(200, {}); }
    throw new TypeError(`unexpected fetch ${url}`);
  }

  return { fetchImpl, calls, pins, state, link: (as = username) => { state.linkAs = as; } };
}

function sampleLibrary() {
  const ep = (key, s, e, extra = {}) => ({ ratingKey: key, type: 'episode', title: `Ep ${s}x${e}`, grandparentTitle: 'The Bear', grandparentRatingKey: '100', parentIndex: s, index: e, duration: 1_800_000, grandparentThumb: '/library/metadata/100/thumb/1', ...extra });
  const items = [
    { ratingKey: '100', type: 'show', title: 'The Bear', year: 2022, score: '0.9' },
    ep('101', 1, 1, { viewCount: 1 }),
    ep('102', 1, 2, { viewOffset: 600_000 }),
    ep('103', 1, 3),
    { ratingKey: '200', type: 'movie', title: 'Dune', year: 2021, duration: 9_000_000, viewOffset: 3_600_000, score: '0.8', thumb: '/library/metadata/200/thumb/1' },
    { ratingKey: '201', type: 'movie', title: 'Dune: Part Two', year: 2024, duration: 9_900_000, score: '0.7' },
  ];
  return { items, onDeck: [items[2]] };
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
