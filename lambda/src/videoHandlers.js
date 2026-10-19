'use strict';
// Video playback handlers: play by title / show / episode, continue watching,
// voice transport, and APL player events.

const Alexa = require('ask-sdk-core');
const link = require('./link');
const play = require('./play');
const lib = require('./plex/library');
const player = require('./apl/player');
const loading = require('./apl/loading');
const warmup = require('./warmup');
const pb = require('./plex/playback');

const rec = (h) => h.attributesManager.getRequestAttributes().rec;
const fetchOf = (h) => h.attributesManager.getRequestAttributes().fetch;
const hasScreen = (h) => !!Alexa.getSupportedInterfaces(h.requestEnvelope)['Alexa.Presentation.APL'];
const isIntent = (h, ...names) => Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
  && names.includes(Alexa.getIntentName(h.requestEnvelope));
const slot = (h, name) => {
  const s = (h.requestEnvelope.request.intent.slots || {})[name];
  return s && s.value ? String(s.value).trim() : undefined;
};
const isPlayerEvent = (h) => Alexa.getRequestType(h.requestEnvelope) === 'Alexa.Presentation.APL.UserEvent'
  && (h.requestEnvelope.request.arguments || [])[0] === 'video';
const playerOnScreen = (h) => {
  const ctx = h.requestEnvelope.context || {};
  const apl = ctx['Alexa.Presentation.APL'];
  return !!(apl && apl.token === player.TOKEN);
};

/** Make sure we're linked with a server; otherwise hand over to the link flow. */
async function ensureReady(h) {
  const r = rec(h);
  if (link.status(r) !== link.STATUS.READY) return false;
  return link.ensureFreshToken(fetchOf(h), r);
}

function subtitleFor(item) {
  if (item.type === 'episode') return `Season ${item.season} · Episode ${item.episode}${item.title ? ` · ${item.title}` : ''}`;
  return item.year ? String(item.year) : '';
}
function titleFor(item) { return item.type === 'episode' ? item.showTitle : item.title; }

/**
 * Start a stream for `item` and show the loading screen. The screen ticks the
 * skill until the stream is warm, then the player replaces it (LoadTickHandler).
 * `lead` is spoken right away.
 */
async function renderLoading(h, item, offsetMs, { lead = '', candidate = 0 } = {}) {
  const r = rec(h);
  const url = await play.start(fetchOf(h), r, item, offsetMs, { candidate });
  if (!url) return null;
  r.playback.state = 'loading';
  r.playback.url = url;
  r.playback.warm = warmup.begin(url, offsetMs);
  const base = pb.streamCandidates(r.server)[candidate];
  const token = r.server.transient && r.server.transient.value;
  h.responseBuilder.addDirective({
    type: 'Alexa.Presentation.APL.RenderDocument',
    token: loading.TOKEN,
    document: loading.loadingDocument({
      title: titleFor(item),
      subtitle: subtitleFor(item),
      posterUrl: pb.imageUrl(base, item.thumb, token, { width: 500, height: 750 }),
      artUrl: pb.imageUrl(base, item.art, token, { width: 1280, height: 720 }),
      pct: r.playback.warm.pct,
      label: 'Waking up your server…',
    }),
  });
  if (lead) h.responseBuilder.speak(lead);
  // No reprompt / shouldEndSession: the session stays open while the screen ticks.
  return h.responseBuilder.getResponse();
}

/** Swap the loading screen for the player once the stream is warm. */
function renderPlayerNow(h) {
  const p = rec(h).playback;
  const item = p.item;
  p.state = 'playing';
  p.warm = null;
  h.responseBuilder.addDirective({
    type: 'Alexa.Presentation.APL.RenderDocument',
    token: player.TOKEN,
    document: player.playerDocument({ url: p.url, title: titleFor(item), subtitle: subtitleFor(item), offsetMs: p.startMs }),
  });
  return h.responseBuilder.getResponse();
}

// Kept for call sites that restart playback (start over, next, retry).
const renderPlayer = renderLoading;

async function playRequest(h, req) {
  const { startOrResume } = require('./handlers'); // lazy: avoid a require cycle
  if (!hasScreen(h)) {
    return h.responseBuilder.speak('Video needs an Echo device with a screen, like the Echo Show.').withShouldEndSession(true).getResponse();
  }
  if (!(await ensureReady(h))) return startOrResume(h);
  const r = rec(h);
  const found = await play.resolve(fetchOf(h), r, req);
  if (found.error) return h.responseBuilder.speak(found.error).reprompt('What would you like to watch?').getResponse();
  const item = found.item;
  const offset = play.startPosition(item, { fromStart: req.fromStart });
  const verb = offset > 0 ? 'Resuming' : 'Playing';
  return renderPlayer(h, item, offset, { lead: `${verb} ${lib.describe(item)}.` });
}

const PlayVideoIntentHandler = {
  canHandle: (h) => isIntent(h, 'PlayVideoIntent', 'PlayMovieIntent', 'PlayShowIntent'),
  handle(h) {
    const name = Alexa.getIntentName(h.requestEnvelope);
    const title = slot(h, 'title');
    if (!title) return h.responseBuilder.speak('What would you like to watch?').reprompt('Say, for example, play Dune.').getResponse();
    const kind = name === 'PlayMovieIntent' ? 'movie' : name === 'PlayShowIntent' ? 'show' : 'any';
    return playRequest(h, { kind, title });
  },
};

const PlayEpisodeIntentHandler = {
  canHandle: (h) => isIntent(h, 'PlayEpisodeIntent'),
  handle(h) {
    const show = slot(h, 'show');
    const season = Number.parseInt(slot(h, 'season'), 10);
    const episode = Number.parseInt(slot(h, 'episode'), 10);
    if (!show || !Number.isInteger(season) || !Number.isInteger(episode)) {
      return h.responseBuilder.speak('Tell me the show, season and episode, for example: play season 2 episode 3 of The Bear.').reprompt('Which episode?').getResponse();
    }
    return playRequest(h, { kind: 'episode', show, season, episode, fromStart: false });
  },
};

const ContinueWatchingIntentHandler = {
  canHandle: (h) => isIntent(h, 'ContinueWatchingIntent'),
  handle: (h) => playRequest(h, { kind: 'continue' }),
};

// ---- Voice transport (only meaningful while our player is on screen) ----

const control = (h, command, extra, speech) => {
  h.responseBuilder.addDirective(player.controlDirective(command, extra));
  if (speech) h.responseBuilder.speak(speech);
  return h.responseBuilder.getResponse();
};

const PauseResumeHandler = {
  canHandle: (h) => isIntent(h, 'AMAZON.PauseIntent', 'AMAZON.ResumeIntent') && playerOnScreen(h),
  handle: (h) => control(h, Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.PauseIntent' ? 'pause' : 'play'),
};

/** ISO-8601 duration (AMAZON.DURATION, e.g. PT30S, PT2M) → ms. */
function durationMs(iso, fallbackMs) {
  const m = /^P(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)$/.exec(String(iso || ''));
  if (!m) return fallbackMs;
  const ms = ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
  return ms > 0 ? ms : fallbackMs;
}

const SeekHandler = {
  canHandle: (h) => isIntent(h, 'SkipForwardIntent', 'SkipBackIntent') && playerOnScreen(h),
  handle(h) {
    const back = Alexa.getIntentName(h.requestEnvelope) === 'SkipBackIntent';
    const ms = durationMs(slot(h, 'duration'), back ? 10_000 : 30_000);
    return control(h, 'seek', { value: back ? -ms : ms });
  },
};

const StartOverHandler = {
  canHandle: (h) => isIntent(h, 'AMAZON.StartOverIntent') && playerOnScreen(h) && !!rec(h).playback,
  async handle(h) {
    const item = rec(h).playback.item;
    return renderPlayer(h, item, 0, { lead: 'Starting over.' });
  },
};

const NextEpisodeHandler = {
  canHandle: (h) => isIntent(h, 'AMAZON.NextIntent') && !!rec(h).playback,
  async handle(h) {
    const r = rec(h);
    const next = await lib.followingEpisode(fetchOf(h), r.device, r.server, r.playback.item);
    if (!next) return h.responseBuilder.speak("That's the last episode I have.").getResponse();
    await play.stop(fetchOf(h), r);
    return renderPlayer(h, next, play.startPosition(next), { lead: `Next: ${lib.describe(next)}.` });
  },
};

const StopPlaybackHandler = {
  canHandle: (h) => isIntent(h, 'AMAZON.StopIntent', 'AMAZON.CancelIntent') && !!rec(h).playback,
  async handle(h) {
    await play.stop(fetchOf(h), rec(h));
    return h.responseBuilder.withShouldEndSession(true).getResponse();
  },
};

/** Session closed while a stream was active: save the position and free the transcoder. */
const PlaybackSessionEndedHandler = {
  canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === 'SessionEndedRequest' && !!rec(h).playback,
  async handle(h) {
    await play.stop(fetchOf(h), rec(h));
    return h.responseBuilder.getResponse();
  },
};

const HomePlayTapHandler = {
  canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === 'Alexa.Presentation.APL.UserEvent'
    && (h.requestEnvelope.request.arguments || [])[0] === 'home'
    && (h.requestEnvelope.request.arguments || [])[1] === 'play',
  async handle(h) {
    const { startOrResume } = require('./handlers');
    if (!(await ensureReady(h))) return startOrResume(h);
    const r = rec(h);
    const item = await lib.item(fetchOf(h), r.device, r.server, h.requestEnvelope.request.arguments[2]);
    if (!item) return h.responseBuilder.speak("I couldn't find that on your server any more.").getResponse();
    if (item.type === 'show') {
      const ep = await lib.nextEpisode(fetchOf(h), r.device, r.server, item.ratingKey);
      if (!ep) return h.responseBuilder.speak(`${item.title} has no episodes.`).getResponse();
      return renderLoading(h, ep, play.startPosition(ep), { lead: `Playing ${lib.describe(ep)}.` });
    }
    const off = play.startPosition(item);
    return renderLoading(h, item, off, { lead: `${off > 0 ? 'Resuming' : 'Playing'} ${lib.describe(item)}.` });
  },
};

const LoadTickHandler = {
  canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === 'Alexa.Presentation.APL.UserEvent'
    && (h.requestEnvelope.request.arguments || [])[0] === 'load',
  async handle(h) {
    const r = rec(h);
    const p = r.playback;
    if (!p || !p.warm) return h.responseBuilder.getResponse(); // stale tick (already playing or stopped)
    const st = await warmup.tick(fetchOf(h), r);
    if (st.ready) return renderPlayerNow(h);
    if (st.failed) {
      const next = p.candidate + 1;
      if (next < pb.streamCandidates(r.server).length) return renderLoading(h, p.item, p.startMs, { candidate: next });
      const name = r.server.name;
      await play.stop(fetchOf(h), r);
      return h.responseBuilder
        .speak(`${name} didn't start the stream in time. Check that the server is awake and Remote Access is on, then try again.`)
        .withShouldEndSession(true)
        .getResponse();
    }
    h.responseBuilder.addDirective(loading.progressDirective(st.pct, st.label));
    return h.responseBuilder.getResponse();
  },
};

const PlayerEventHandler = {
  canHandle: isPlayerEvent,
  async handle(h) {
    const [, kind, value] = h.requestEnvelope.request.arguments;
    const r = rec(h);
    if (!r.server || !r.device) return h.responseBuilder.getResponse();
    const out = await play.onPlayerEvent(fetchOf(h), r, kind, value);
    if (out.action === 'retry') {
      const item = r.playback.item;
      return renderPlayer(h, item, r.playback.lastPosMs, { candidate: out.candidate });
    }
    if (out.action === 'exhausted') {
      await play.stop(fetchOf(h), r);
      return h.responseBuilder
        .speak(`I couldn't play that stream from ${r.server.name}. The Echo has to reach the server directly, so check that Plex Remote Access is on and its port is open.`)
        .withShouldEndSession(true)
        .getResponse();
    }
    if (out.action === 'ended') {
      if (out.next) return renderPlayer(h, out.next, play.startPosition(out.next), { lead: `Up next: ${lib.describe(out.next)}.` });
      return h.responseBuilder.speak("That's the end.").withShouldEndSession(true).getResponse();
    }
    return h.responseBuilder.getResponse(); // keep playing, say nothing
  },
};

/** Transport commands with no player on screen. */
const NothingPlayingHandler = {
  canHandle: (h) => isIntent(h, 'AMAZON.PauseIntent', 'AMAZON.ResumeIntent', 'AMAZON.NextIntent', 'AMAZON.StartOverIntent', 'SkipForwardIntent', 'SkipBackIntent'),
  handle: (h) => h.responseBuilder.speak("Nothing is playing right now. What would you like to watch?").reprompt('Say a movie or show, or continue watching.').getResponse(),
};

const videoHandlers = [
  HomePlayTapHandler, LoadTickHandler, PlayerEventHandler, PauseResumeHandler, SeekHandler, StartOverHandler, NextEpisodeHandler,
  StopPlaybackHandler, PlaybackSessionEndedHandler,
  PlayVideoIntentHandler, PlayEpisodeIntentHandler, ContinueWatchingIntentHandler, NothingPlayingHandler,
];

module.exports = { videoHandlers, durationMs };
