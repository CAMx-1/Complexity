'use strict';
// Minimal Plex HTTP client: standard X-Plex-* headers, JSON in/out, timeouts.
// `fetchImpl` is injectable so tests can run without the network.

const PRODUCT = 'Complexity';
const VERSION = '0.1.0';
const PLEX_TV = 'https://clients.plex.tv';

class PlexError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'PlexError';
    this.status = status;
    this.body = body;
  }
}

/** Headers every plex.tv / PMS request should carry for this device. */
function plexHeaders(clientId, extra = {}) {
  return {
    Accept: 'application/json',
    'X-Plex-Product': PRODUCT,
    'X-Plex-Version': VERSION,
    'X-Plex-Client-Identifier': clientId,
    'X-Plex-Platform': 'Alexa',
    'X-Plex-Device': 'Echo Show',
    'X-Plex-Device-Name': `${PRODUCT} (Alexa)`,
    ...extra,
  };
}

/**
 * JSON request helper. Throws PlexError on non-2xx; returns parsed JSON
 * (or null for empty bodies).
 */
async function plexRequest(fetchImpl, url, { method = 'GET', clientId, token, body, timeoutMs = 8000 } = {}) {
  const headers = plexHeaders(clientId, token ? { 'X-Plex-Token': token } : {});
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) throw new PlexError(`Plex ${method} ${new URL(url).pathname} failed: HTTP ${res.status}`, res.status, data);
  return data;
}

module.exports = { PRODUCT, VERSION, PLEX_TV, PlexError, plexHeaders, plexRequest };
