'use strict';
// Plex link state machine. Operates on the per-Alexa-user record that the
// handlers load from and save to DynamoDB. Pure apart from `fetchImpl`, so it is
// unit-testable with a fake plex.tv.
//
// Record shape:
// {
//   device:  { clientId, kid, publicJwk, privateKeyPem },
//   pin:     { id, code, expiresAt } | null,           // while linking
//   token:   { value, type: 'jwt'|'legacy', expiresAt? } | null,
//   account: { username, uuid } | null,
//   serverChoices: [{ name, clientIdentifier }] | null, // when >1 server
//   server:  { name, clientIdentifier, owned, accessToken, apiUri, viaRelay, streamUris, resolvedAt } | null,
// }

const auth = require('./plex/auth');
const servers = require('./plex/servers');
const { createDevice } = require('./plex/deviceKey');

const STATUS = Object.freeze({
  UNLINKED: 'unlinked',
  LINKING: 'linking',
  CHOOSE_SERVER: 'choose-server',
  NO_SERVER: 'no-server',
  READY: 'ready',
});

function status(rec, now = Date.now()) {
  if (!rec.token) return rec.pin && rec.pin.expiresAt > now ? STATUS.LINKING : STATUS.UNLINKED;
  if (rec.server) return STATUS.READY;
  if (rec.serverChoices && rec.serverChoices.length) return STATUS.CHOOSE_SERVER;
  return STATUS.NO_SERVER;
}

function ensureDevice(rec) {
  if (!rec.device) rec.device = createDevice();
  return rec.device;
}

/** Start (or reuse a still-valid) PIN. Returns the pin. */
async function startLink(fetchImpl, rec, now = Date.now()) {
  ensureDevice(rec);
  // Reuse an unexpired PIN with at least a minute left so the code on screen doesn't change.
  if (rec.pin && rec.pin.expiresAt - now > 60_000) return rec.pin;
  rec.pin = await auth.createPin(fetchImpl, rec.device);
  return rec.pin;
}

/**
 * Check the PIN. On success stores the token and account, then discovers
 * servers. Returns the new status.
 */
async function pollLink(fetchImpl, rec, now = Date.now()) {
  if (!rec.pin) return status(rec, now);
  const result = await auth.checkPin(fetchImpl, rec.device, rec.pin, now);
  if (result.status === 'expired') { rec.pin = null; return STATUS.UNLINKED; }
  if (result.status === 'pending') return STATUS.LINKING;
  rec.pin = null;
  rec.token = result.token;
  try { rec.account = await auth.getAccount(fetchImpl, rec.device, rec.token.value); } catch { rec.account = null; }
  return discoverServers(fetchImpl, rec);
}

/** (Re)discover servers. Auto-selects when there is exactly one. */
async function discoverServers(fetchImpl, rec) {
  const list = await servers.listServers(fetchImpl, rec.device, rec.token.value);
  rec.server = null;
  rec.serverChoices = null;
  if (!list.length) return STATUS.NO_SERVER;
  if (list.length === 1) return selectServer(fetchImpl, rec, list[0], list);
  rec.serverChoices = list.map((s) => ({ name: s.name, clientIdentifier: s.clientIdentifier, owned: s.owned }));
  return STATUS.CHOOSE_SERVER;
}

/**
 * Select a server (object from listServers, or a { name } / { index } match
 * against serverChoices) and resolve how to reach it.
 * Returns READY, or NO_SERVER if no connection answers.
 */
async function selectServer(fetchImpl, rec, choice, list) {
  const all = list || await servers.listServers(fetchImpl, rec.device, rec.token.value);
  const server = choice && choice.clientIdentifier
    ? all.find((s) => s.clientIdentifier === choice.clientIdentifier)
    : servers.matchServer(all, choice || {});
  if (!server) return null; // caller re-prompts
  const conn = await servers.resolveConnections(fetchImpl, rec.device, server);
  if (!conn) {
    rec.server = null;
    rec.unreachable = { name: server.name, at: Date.now() };
    return STATUS.NO_SERVER;
  }
  rec.unreachable = null;
  rec.serverChoices = null;
  rec.server = {
    name: server.name,
    clientIdentifier: server.clientIdentifier,
    owned: server.owned,
    accessToken: server.accessToken || rec.token.value,
    ...conn,
    resolvedAt: Date.now(),
  };
  return STATUS.READY;
}

/**
 * Make sure the stored token is usable, refreshing a JWT that is close to
 * expiry. Server access tokens are re-fetched after a refresh. Returns false
 * (and clears the link) if the refresh is rejected, meaning the user revoked
 * the device on plex.tv.
 */
async function ensureFreshToken(fetchImpl, rec, now = Date.now()) {
  if (!rec.token) return false;
  if (!auth.needsRefresh(rec.token, now)) return true;
  try {
    rec.token = await auth.refreshToken(fetchImpl, rec.device, now);
  } catch (e) {
    if (e.status === 401 || e.status === 403) { unlink(rec); return false; }
    throw e;
  }
  if (rec.server) {
    const list = await servers.listServers(fetchImpl, rec.device, rec.token.value);
    const s = list.find((x) => x.clientIdentifier === rec.server.clientIdentifier);
    if (s && s.accessToken) rec.server.accessToken = s.accessToken;
  }
  return true;
}

/** Forget everything, including the device key, so a relink registers a fresh device. */
function unlink(rec) {
  for (const k of Object.keys(rec)) delete rec[k];
  return rec;
}

module.exports = { STATUS, status, ensureDevice, startLink, pollLink, discoverServers, selectServer, ensureFreshToken, unlink };
