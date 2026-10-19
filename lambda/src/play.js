'use strict';
// Playback orchestration. Resolves what to play, builds the stream, tracks the
// session on rec.playback, and reports progress to Plex.
//
// rec.playback = {
//   item:        slimmed metadata (ratingKey, type, title, showTitle, season, episode, durationMs, showKey),
//   sessionId:   Plex transcode session,
//   startMs:     where playback started (APL Video source offset; the transcode itself starts at 0),
//   lastPosMs:   last absolute position we know,
//   candidate:   index into playback.streamCandidates(server),
//   state:       'playing' | 'paused',
// }

const lib = require('./plex/library');
const pb = require('./plex/playback');

const RESUME_MIN_MS = 60_000;          // don't bother resuming in the first minute
const WATCHED_FRACTION = 0.9;          // Plex's own threshold for "watched"

/** What a request means, as a play target. Returns { item } or { error } with a speakable reason. */
async function resolve(fetchImpl, rec, req) {
  const { device, server } = rec;
  if (req.kind === 'continue') {
    const deck = await lib.onDeck(fetchImpl, device, server, { limit: 1 });
    return deck[0] ? { item: deck[0] } : { error: 'There is nothing to continue watching on your server.' };
  }
  if (req.kind === 'episode') {
    const shows = await lib.search(fetchImpl, device, server, req.show, { kind: 'show' });
    if (!shows.length) return { error: `I couldn't find a show called ${req.show} on ${server.name}.` };
    const ep = await lib.episodeAt(fetchImpl, device, server, shows[0].ratingKey, req.season, req.episode);
    return ep ? { item: ep } : { error: `${shows[0].title} doesn't have season ${req.season} episode ${req.episode} on ${server.name}.` };
  }
  const results = await lib.search(fetchImpl, device, server, req.title, { kind: req.kind === 'movie' ? 'movie' : req.kind === 'show' ? 'show' : undefined });
  const top = results[0];
  if (!top) return { error: `I couldn't find ${req.title} on ${server.name}.` };
  if (top.type === 'show') {
    const ep = await lib.nextEpisode(fetchImpl, device, server, top.ratingKey);
    return ep ? { item: ep } : { error: `${top.title} has no episodes on ${server.name}.` };
  }
  return { item: top };
}

function startPosition(item, { fromStart = false } = {}) {
  if (fromStart) return 0;
  const off = item.viewOffsetMs || 0;
  const nearEnd = item.durationMs && off > item.durationMs * WATCHED_FRACTION;
  return off >= RESUME_MIN_MS && !nearEnd ? off : 0;
}

/** Start (or restart) a stream for `item` at offsetMs. Mutates rec.playback; returns the URL. */
async function start(fetchImpl, rec, item, offsetMs, { candidate = 0 } = {}) {
  const { device, server } = rec;
  if (rec.playback && rec.playback.sessionId) await pb.stopTranscode(fetchImpl, device, server, rec.playback.sessionId);
  const bases = pb.streamCandidates(server);
  if (candidate >= bases.length) return null;
  const token = await pb.transientToken(fetchImpl, device, server);
  const sessionId = pb.newSessionId();
  const url = pb.hlsUrl({ base: bases[candidate], ratingKey: item.ratingKey, sessionId, clientId: device.clientId, token, quality: (rec.prefs && rec.prefs.quality) || '1080p' });
  rec.playback = {
    item: { ratingKey: item.ratingKey, type: item.type, title: item.title, year: item.year, showTitle: item.showTitle, showKey: item.showKey, season: item.season, episode: item.episode, durationMs: item.durationMs },
    sessionId,
    startMs: offsetMs,
    resumePending: offsetMs > 0, // until the player reports a position near startMs
    lastPosMs: offsetMs,
    candidate,
    state: 'playing',
    startedAt: Date.now(),
  };
  return url;
}

/** Position from an APL currentTime (ms). The stream starts at 0, so it is already absolute. */
function absolute(rec, ms) {
  const t = Number(ms);
  return Number.isFinite(t) && t >= 0 ? t : rec.playback.lastPosMs;
}

/** Handle a player event. Returns an action for the handler: none | ended | retry | exhausted. */
async function onPlayerEvent(fetchImpl, rec, kind, relMs) {
  const p = rec.playback;
  if (!p) return { action: 'none' };
  const { device, server } = rec;
  if (kind === 'failed') {
    const next = p.candidate + 1;
    return next < pb.streamCandidates(server).length ? { action: 'retry', candidate: next } : { action: 'exhausted' };
  }
  const pos = absolute(rec, relMs);
  // Before the resume seek lands the player reports positions near 0. Recording
  // or reporting those would overwrite Plex's resume point (seen on device).
  if (p.resumePending) {
    if (pos >= p.startMs - 5000) p.resumePending = false;
    else if (kind !== 'ended') return { action: 'none' };
  }
  p.lastPosMs = pos;
  const report = (state) => pb.reportTimeline(fetchImpl, device, server, { ratingKey: p.item.ratingKey, state, timeMs: p.lastPosMs, durationMs: p.item.durationMs, sessionId: p.sessionId }).catch(() => {});
  if (kind === 'playing' || kind === 'paused') {
    p.state = kind;
    await report(kind);
    return { action: 'none' };
  }
  if (kind === 'progress') {
    await report(p.state || 'playing');
    return { action: 'none' };
  }
  if (kind === 'ended') {
    await report('stopped');
    await pb.scrobble(fetchImpl, device, server, p.item.ratingKey).catch(() => {});
    await pb.stopTranscode(fetchImpl, device, server, p.sessionId);
    const next = await lib.followingEpisode(fetchImpl, device, server, p.item).catch(() => null);
    rec.playback = null;
    return { action: 'ended', next };
  }
  return { action: 'none' };
}

/** User stopped watching: save position, mark watched if nearly done, free the transcoder. */
async function stop(fetchImpl, rec) {
  const p = rec.playback;
  if (!p) return;
  const { device, server } = rec;
  await pb.reportTimeline(fetchImpl, device, server, { ratingKey: p.item.ratingKey, state: 'stopped', timeMs: p.lastPosMs, durationMs: p.item.durationMs, sessionId: p.sessionId }).catch(() => {});
  if (p.item.durationMs && p.lastPosMs >= p.item.durationMs * WATCHED_FRACTION) await pb.scrobble(fetchImpl, device, server, p.item.ratingKey).catch(() => {});
  await pb.stopTranscode(fetchImpl, device, server, p.sessionId);
  rec.playback = null;
}

module.exports = { resolve, startPosition, start, absolute, onPlayerEvent, stop, RESUME_MIN_MS, WATCHED_FRACTION };
