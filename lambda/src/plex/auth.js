'use strict';
// Plex sign-in for a voice device, no account linking needed:
//   1. createPin()   POST /api/v2/pins with our public JWK -> 4-char code
//   2. user enters the code at https://plex.tv/link
//   3. checkPin()    GET /api/v2/pins/{id}?deviceJWT=… -> authToken (JWT, ~7 days)
//   4. refreshToken() nonce flow: GET /auth/nonce, sign, POST /auth/token
// If Plex falls back to a legacy (non-JWT) token, it is long-lived and needs no refresh.
//
// JWT is OFF by default: Plex Media Server (verified on 1.42.2, Oct 2026) only
// accepts legacy tokens, and /api/v2/resources hands back JWT server tokens
// when called with a JWT, which PMS also rejects (HTTP 401). Without a `jwk` on
// the PIN, plex.tv issues a legacy token that works everywhere. Flip USE_JWT
// once PMS supports JWTs.
const USE_JWT = false;

const { PLEX_TV, plexRequest } = require('./client');
const { signDeviceJwt, decodeJwtPayload } = require('./deviceKey');
const { aplText } = require('../safe');

// Scopes requested when exchanging a nonce for a fresh JWT. Taken from Plex's
// developer forum examples; adjust if plex.tv rejects or narrows them.
const TOKEN_SCOPE = 'username,email,friendly_name,admin,shared_user';
const REFRESH_MARGIN_MS = 24 * 3600 * 1000; // refresh when <1 day left

async function createPin(fetchImpl, device, { jwt = USE_JWT } = {}) {
  const pin = await plexRequest(fetchImpl, `${PLEX_TV}/api/v2/pins`, {
    method: 'POST',
    clientId: device.clientId,
    body: jwt ? { strong: false, jwk: device.publicJwk } : { strong: false },
  });
  if (!pin || !pin.id || !pin.code) throw new Error('Plex did not return a PIN');
  const expiresAt = pin.expiresAt ? Date.parse(pin.expiresAt) : Date.now() + (pin.expiresIn || 900) * 1000;
  return { id: pin.id, code: String(pin.code).toUpperCase(), expiresAt };
}

/** Returns { status: 'pending' | 'linked' | 'expired', token? }. */
async function checkPin(fetchImpl, device, pin, now = Date.now(), { jwt = USE_JWT } = {}) {
  if (now >= pin.expiresAt) return { status: 'expired' };
  const query = jwt ? `?deviceJWT=${encodeURIComponent(signDeviceJwt(device, {}, { now }))}` : '';
  let res;
  try {
    res = await plexRequest(fetchImpl, `${PLEX_TV}/api/v2/pins/${encodeURIComponent(pin.id)}${query}`, { clientId: device.clientId });
  } catch (e) {
    if (e.status === 404) return { status: 'expired' };
    throw e;
  }
  if (!res || !res.authToken) return { status: 'pending' };
  return { status: 'linked', token: describeToken(res.authToken) };
}

/** Normalise a token into what we persist. */
function describeToken(authToken) {
  const payload = decodeJwtPayload(authToken);
  return payload && payload.exp
    ? { value: authToken, type: 'jwt', expiresAt: payload.exp * 1000 }
    : { value: authToken, type: 'legacy' };
}

function needsRefresh(token, now = Date.now()) {
  return token.type === 'jwt' && token.expiresAt - now < REFRESH_MARGIN_MS;
}

/** Exchange a signed nonce for a new Plex JWT. Works even after the old JWT expired. */
async function refreshToken(fetchImpl, device, now = Date.now()) {
  const { nonce } = await plexRequest(fetchImpl, `${PLEX_TV}/api/v2/auth/nonce`, { clientId: device.clientId });
  const jwt = signDeviceJwt(device, { nonce, scope: TOKEN_SCOPE }, { now });
  const res = await plexRequest(fetchImpl, `${PLEX_TV}/api/v2/auth/token`, {
    method: 'POST',
    clientId: device.clientId,
    body: { jwt },
  });
  const value = res && (res.authToken || res.auth_token);
  if (!value) throw new Error('Plex did not return a refreshed token');
  return describeToken(value);
}

/** Basic account info for confirmation ("Linked as cameron"). */
async function getAccount(fetchImpl, device, tokenValue) {
  const u = await plexRequest(fetchImpl, `${PLEX_TV}/api/v2/user`, { clientId: device.clientId, token: tokenValue });
  return { username: aplText(u.username || u.title || u.friendlyName || 'your account'), uuid: u.uuid };
}

module.exports = { USE_JWT, createPin, checkPin, describeToken, needsRefresh, refreshToken, getAccount, TOKEN_SCOPE };
