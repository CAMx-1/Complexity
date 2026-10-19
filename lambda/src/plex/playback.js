'use strict';
// Stream URLs and playback reporting.
//
// Verified against PMS 1.42.2:
//   - /security/token?type=delegation&scope=all → { MediaContainer: { token } } (48 h, dies on restart)
//   - start.m3u8 with the transient token returns a master playlist whose
//     session/… sub-playlist and .ts segments load WITHOUT a token, so only
//     the first URL carries a credential.
//   - With the client-profile extra below, output is H.264 High@4.0 + AAC-LC
//     1080p in MPEG-TS, which Echo devices play.
//   - Starting a transcode at offset>0 returned empty 188-byte segments
//     (seen on device: black screen). Starting at 0 and letting the player seek
//     works: PMS transcodes the requested segment on demand. So the URL always
//     starts at 0 and resume is done by the APL Video source `offset`.

const crypto = require('node:crypto');
const { plexRequest, PRODUCT } = require('./client');

const TRANSIENT_TTL_MS = 12 * 3600 * 1000; // re-mint well inside Plex's 48 h

const PROFILE_EXTRA = [
  'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac)',
  'add-limitation(scope=videoCodec&scopeName=h264&type=upperBound&name=video.level&value=41)',
].join('+');

const QUALITY = {
  original: { maxVideoBitrate: 20000, videoResolution: '1920x1080' },
  '1080p': { maxVideoBitrate: 8000, videoResolution: '1920x1080' },
  '720p': { maxVideoBitrate: 4000, videoResolution: '1280x720' },
};

/** Cached transient token on the server record; minted on demand. */
async function transientToken(fetchImpl, device, server, { now = Date.now(), force = false } = {}) {
  if (!force && server.transient && server.transient.expiresAt > now) return server.transient.value;
  const res = await plexRequest(fetchImpl, `${server.apiUri}/security/token?type=delegation&scope=all`, {
    clientId: device.clientId, token: server.accessToken,
  });
  const value = res && res.MediaContainer && res.MediaContainer.token;
  if (!value) throw new Error('Plex did not return a transient token');
  server.transient = { value, expiresAt: now + TRANSIENT_TTL_MS };
  return value;
}

/** Order stream bases for the Echo: the remote URI the backend proved reachable, then LAN ones. */
function streamCandidates(server) {
  const out = [];
  if (server.apiUri && !server.viaRelay) out.push(server.apiUri);
  for (const u of server.streamUris || []) if (!out.includes(u)) out.push(u);
  return out;
}

function newSessionId() { return crypto.randomUUID(); }

/** Universal-transcoder HLS URL for a movie/episode, starting at offsetMs. */
function hlsUrl({ base, ratingKey, sessionId, clientId, token, quality = '1080p' }) {
  const q = QUALITY[quality] || QUALITY['1080p'];
  const p = new URLSearchParams({
    path: `/library/metadata/${ratingKey}`,
    protocol: 'hls',
    directPlay: '0',
    directStream: '1',
    mediaIndex: '0',
    partIndex: '0',
    fastSeek: '1',
    offset: '0',
    videoResolution: q.videoResolution,
    maxVideoBitrate: String(q.maxVideoBitrate),
    videoQuality: '100',
    subtitles: 'burn',
    session: sessionId,
    'X-Plex-Session-Identifier': sessionId,
    'X-Plex-Client-Identifier': clientId,
    'X-Plex-Product': PRODUCT,
    // PMS picks the transcode profile by platform; unknown names (e.g. "Alexa") get HTTP 400.
    'X-Plex-Platform': 'Generic',
    'X-Plex-Device': 'Echo Show',
    'X-Plex-Client-Profile-Extra': PROFILE_EXTRA,
    'X-Plex-Token': token,
  });
  return `${base}/video/:/transcode/universal/start.m3u8?${p.toString()}`;
}

/** Report playback state so Continue Watching stays in sync. state: playing|paused|stopped. */
async function reportTimeline(fetchImpl, device, server, { ratingKey, state, timeMs, durationMs, sessionId }) {
  const p = new URLSearchParams({
    ratingKey: String(ratingKey),
    key: `/library/metadata/${ratingKey}`,
    state,
    time: String(Math.max(0, Math.round(timeMs || 0))),
    duration: String(Math.round(durationMs || 0)),
    'X-Plex-Session-Identifier': sessionId || '',
  });
  return plexRequest(fetchImpl, `${server.apiUri}/:/timeline?${p.toString()}`, { clientId: device.clientId, token: server.accessToken, timeoutMs: 5000 });
}

async function scrobble(fetchImpl, device, server, ratingKey) {
  return plexRequest(fetchImpl, `${server.apiUri}/:/scrobble?identifier=com.plexapp.plugins.library&key=${encodeURIComponent(ratingKey)}`, {
    clientId: device.clientId, token: server.accessToken, timeoutMs: 5000,
  });
}

async function stopTranscode(fetchImpl, device, server, sessionId) {
  try {
    await plexRequest(fetchImpl, `${server.apiUri}/video/:/transcode/universal/stop?session=${encodeURIComponent(sessionId)}`, {
      clientId: device.clientId, token: server.accessToken, timeoutMs: 4000,
    });
  } catch { /* already gone */ }
}

/** Poster/art through the photo transcoder (small, HTTPS, token in URL is the transient one). */
function imageUrl(base, path, token, { width = 600, height = 900 } = {}) {
  if (!path) return undefined;
  const p = new URLSearchParams({ width: String(width), height: String(height), minSize: '1', upscale: '1', url: path, 'X-Plex-Token': token });
  return `${base}/photo/:/transcode?${p.toString()}`;
}

module.exports = { transientToken, streamCandidates, newSessionId, hlsUrl, reportTimeline, scrobble, stopTranscode, imageUrl, QUALITY, PROFILE_EXTRA };
