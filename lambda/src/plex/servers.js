'use strict';
// Discover the user's Plex servers through plex.tv and work out how to reach
// each one.
//
// Two different consumers need a connection:
//   - the skill backend (AWS Lambda) makes API calls, so it needs a *remote*
//     connection reachable from the internet;
//   - the Echo plays the stream itself, and is usually on the same LAN as the
//     server, so a *local* plex.direct URI may work for streaming and avoids
//     the WAN round trip. M0 checks this on the device.

const { PLEX_TV, plexRequest } = require('./client');

/** List servers the account can use (owned first, then shared). */
async function listServers(fetchImpl, device, tokenValue) {
  const resources = await plexRequest(fetchImpl, `${PLEX_TV}/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=0`, {
    clientId: device.clientId,
    token: tokenValue,
  });
  return (Array.isArray(resources) ? resources : [])
    .filter((r) => String(r.provides || '').split(',').includes('server'))
    .map((r) => ({
      name: r.name,
      clientIdentifier: r.clientIdentifier,
      owned: !!r.owned,
      accessToken: r.accessToken,
      connections: (r.connections || []).filter((c) => c.protocol === 'https' && c.uri),
    }))
    .sort((a, b) => Number(b.owned) - Number(a.owned) || a.name.localeCompare(b.name));
}

/** Probe a connection with GET /identity. Resolves true when it answers for the right server. */
async function probe(fetchImpl, device, server, uri, timeoutMs) {
  try {
    const res = await plexRequest(fetchImpl, `${uri}/identity`, { clientId: device.clientId, token: server.accessToken, timeoutMs });
    const id = res && (res.MediaContainer ? res.MediaContainer.machineIdentifier : res.machineIdentifier);
    return !id || id === server.clientIdentifier;
  } catch {
    return false;
  }
}

/**
 * Resolve connections for a server. The API URI must be reachable from here
 * (remote direct first, relay as a last resort). Stream URIs are ordered for
 * the Echo: local, then remote direct. Relay is never used for video.
 */
async function resolveConnections(fetchImpl, device, server, { timeoutMs = 4000 } = {}) {
  const remote = server.connections.filter((c) => !c.local && !c.relay);
  const relay = server.connections.filter((c) => c.relay);
  const local = server.connections.filter((c) => c.local && !c.relay);

  const checks = await Promise.all([...remote, ...relay].map(async (c) => ({ c, ok: await probe(fetchImpl, device, server, c.uri, timeoutMs) })));
  const reachable = checks.filter((x) => x.ok).map((x) => x.c);
  const api = reachable.find((c) => !c.relay) || reachable.find((c) => c.relay);
  if (!api) return null;
  const directRemote = reachable.filter((c) => !c.relay);
  return {
    apiUri: api.uri,
    viaRelay: !!api.relay,
    streamUris: [...local.map((c) => c.uri), ...directRemote.map((c) => c.uri)],
  };
}

/** Match a spoken server name or 1-based number against the list. */
function matchServer(servers, { name, index } = {}) {
  if (Number.isInteger(index) && index >= 1 && index <= servers.length) return servers[index - 1];
  if (!name) return null;
  const norm = (s) => String(s).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const want = norm(name);
  return servers.find((s) => norm(s.name) === want)
    || servers.find((s) => norm(s.name).includes(want) || want.includes(norm(s.name)))
    || null;
}

module.exports = { listServers, resolveConnections, matchServer };
