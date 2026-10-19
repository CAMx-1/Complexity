'use strict';
// Stream warm-up. A cold library disk or a busy transcoder can take longer
// than Alexa's ~8 s response limit, which made the first "play" attempts fail.
// So the skill answers at once with a loading screen and then, on each screen
// tick (one short network step per tick), gets the stream ready:
//
//   start    GET start.m3u8          creates the transcode session; blocks while the disk spins up
//   index    GET session index.m3u8  segment list; find the segment covering the start position
//   segment  GET that segment, bytes 0-1023   returns once PMS has transcoded it
//   ready    hand the same (now warm) URL to the Echo
//
// Verified on PMS 1.42.2: repeating start.m3u8 with the same session id reuses
// the session, so a tick that times out can simply retry. Segment paths need no
// token. Range requests on segments return 206.

const { plexRaw, plexRequest } = require('./plex/client');

const STEP_TIMEOUT_MS = 2200;      // tick = step (≤2.2 s) + optional status probe (≤0.8 s), under the 3.5 s tick interval
const GIVE_UP_MS = 90_000;

const PHASES = ['start', 'index', 'segment', 'ready'];
const LABEL = {
  start: 'Waking up your server…',
  index: 'Starting the stream…',
  segment: 'Preparing video…',
  ready: 'Ready',
};

function begin(startUrl, startMs, now = Date.now()) {
  return { phase: 'start', startUrl, startMs, startedAt: now, tries: 0, pct: 3 };
}

/** Pick the segment that covers `atSec` from a media playlist. */
function segmentFor(playlist, atSec) {
  const lines = String(playlist).split('\n').map((l) => l.trim()).filter(Boolean);
  let t = 0; let last = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXTINF:([0-9.]+)/.exec(lines[i]);
    if (!m) continue;
    const uri = lines[i + 1] && !lines[i + 1].startsWith('#') ? lines[i + 1] : null;
    if (!uri) continue;
    const d = Number(m[1]);
    last = uri;
    if (atSec < t + d) return uri;
    t += d;
  }
  return last;
}

const dirOf = (url) => url.slice(0, url.lastIndexOf('/') + 1);
const isTimeout = (e) => /timeout|aborted/i.test((e && e.message) || '') || (e && (e.name === 'TimeoutError' || e.name === 'AbortError'));

/** Optional: transcoder progress for the percentage. Admin-only on PMS; failures are ignored. */
async function transcodeAhead(fetchImpl, rec, w) {
  try {
    const res = await plexRequest(fetchImpl, `${rec.server.apiUri}/transcode/sessions`, { clientId: rec.device.clientId, token: rec.server.accessToken, timeoutMs: 800 });
    const s = ((res && res.MediaContainer && res.MediaContainer.TranscodeSession) || []).find((x) => String(x.key || '').includes(rec.playback.sessionId));
    if (!s || s.maxOffsetAvailable == null) return null;
    return Number(s.maxOffsetAvailable) - w.startMs / 1000; // seconds transcoded past the start point
  } catch { return null; }
}

/**
 * Advance one step. Mutates rec.playback.warm.
 * Returns { phase, pct, label, ready, failed }.
 */
async function tick(fetchImpl, rec, now = Date.now()) {
  const w = rec.playback && rec.playback.warm;
  if (!w) return { failed: true };
  if (w.phase === 'ready') return view(w);
  if (now - w.startedAt > GIVE_UP_MS) { w.phase = 'failed'; return { ...view(w), failed: true }; }
  w.tries += 1;
  try {
    if (w.phase === 'start') {
      const r = await plexRaw(fetchImpl, w.startUrl, { timeoutMs: STEP_TIMEOUT_MS });
      if (!r.ok) throw Object.assign(new Error(`start ${r.status}`), { status: r.status });
      const sub = r.text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      if (!sub) throw new Error('no variant in master playlist');
      w.indexUrl = dirOf(w.startUrl.split('?')[0]) + sub;
      advance(w, 'index');
    } else if (w.phase === 'index') {
      const r = await plexRaw(fetchImpl, w.indexUrl, { timeoutMs: STEP_TIMEOUT_MS });
      if (!r.ok) throw Object.assign(new Error(`index ${r.status}`), { status: r.status });
      const seg = segmentFor(r.text, w.startMs / 1000);
      if (!seg) throw new Error('empty media playlist');
      w.segmentUrl = dirOf(w.indexUrl) + seg;
      advance(w, 'segment');
    } else if (w.phase === 'segment') {
      const r = await plexRaw(fetchImpl, w.segmentUrl, { headers: { Range: 'bytes=0-1023' }, timeoutMs: STEP_TIMEOUT_MS });
      if ((r.status === 206 || r.status === 200) && r.text.length > 0) advance(w, 'ready');
      else throw Object.assign(new Error(`segment ${r.status}`), { status: r.status });
    }
  } catch (e) {
    // Timeouts mean "still waking up / transcoding": creep the bar and try again next tick.
    if (!isTimeout(e) && e.status && e.status >= 400 && e.status !== 404) { w.phase = 'failed'; return { ...view(w), failed: true }; }
    creep(w);
  }
  if (w.phase === 'segment') {
    const ahead = await transcodeAhead(fetchImpl, rec, w);
    if (ahead != null) w.pct = Math.max(w.pct, Math.min(95, 60 + Math.round(Math.max(0, ahead) * 3.5)));
  }
  return view(w);
}

const FLOOR = { start: 3, index: 35, segment: 55, ready: 100 };
const CEIL = { start: 32, index: 52, segment: 95, ready: 100 };

function advance(w, phase) { w.phase = phase; w.tries = 0; w.pct = Math.max(w.pct, FLOOR[phase]); }
function creep(w) { w.pct = Math.min(CEIL[w.phase] || 95, w.pct + (w.phase === 'start' ? 4 : 6)); }
function view(w) { return { phase: w.phase, pct: w.pct, label: LABEL[w.phase] || 'Loading…', ready: w.phase === 'ready', failed: w.phase === 'failed' }; }

module.exports = { begin, tick, segmentFor, PHASES, STEP_TIMEOUT_MS, GIVE_UP_MS };
