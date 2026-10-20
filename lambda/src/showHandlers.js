'use strict';
// Browse a show: season picker → episodes of a season → play.
// Entry points: "show episodes of The Bear", "show season 2 of The Bear",
// the player's Episodes button, and the Episodes link under home tiles.

const Alexa = require('ask-sdk-core');
const link = require('./link');
const lib = require('./plex/library');
const pb = require('./plex/playback');
const play = require('./play');
const showApl = require('./apl/show');

const rec = (h) => h.attributesManager.getRequestAttributes().rec;
const fetchOf = (h) => h.attributesManager.getRequestAttributes().fetch;
const hasScreen = (h) => !!Alexa.getSupportedInterfaces(h.requestEnvelope)['Alexa.Presentation.APL'];
const isIntent = (h, ...names) => Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
  && names.includes(Alexa.getIntentName(h.requestEnvelope));
const showEvent = (h, action) => Alexa.getRequestType(h.requestEnvelope) === 'Alexa.Presentation.APL.UserEvent'
  && (h.requestEnvelope.request.arguments || [])[0] === 'show'
  && (h.requestEnvelope.request.arguments || [])[1] === action;
const slot = (h, name) => {
  const s = (h.requestEnvelope.request.intent.slots || {})[name];
  return s && s.value ? String(s.value).trim() : undefined;
};

async function ready(h) {
  if (link.status(rec(h)) !== link.STATUS.READY) return false;
  return link.ensureFreshToken(fetchOf(h), rec(h));
}

/** Image helper bound to the user's server and a transient token. */
async function images(h) {
  const r = rec(h);
  const token = await pb.transientToken(fetchOf(h), r.device, r.server).catch(() => null);
  const base = pb.streamCandidates(r.server)[0];
  return (path, size) => (token && path ? pb.imageUrl(base, path, token, size) : '') || '';
}

const mins = (ms) => (ms ? `${Math.round(ms / 60000)} min` : '');
const airDate = (d) => {
  if (!d) return '';
  const t = new Date(`${d}T12:00:00Z`);
  return Number.isNaN(t.getTime()) ? '' : t.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
};

/** Pick the season to highlight: the first one not fully watched. */
function upNextSeason(seasons) {
  const s = seasons.filter((x) => x.index > 0).find((x) => x.watched < x.episodes);
  return s ? s.ratingKey : null;
}

async function renderSeasons(h, showKey, { speak } = {}) {
  const r = rec(h);
  const f = fetchOf(h);
  const [show, seasons] = await Promise.all([
    lib.item(f, r.device, r.server, showKey),
    lib.seasonsOf(f, r.device, r.server, showKey),
  ]);
  if (!show || !seasons.length) return h.responseBuilder.speak(`I couldn't find any episodes for that show on ${r.server.name}.`).getResponse();
  if (seasons.length === 1) return renderEpisodes(h, showKey, seasons[0].ratingKey, 0, { speak, show, seasons });
  const img = await images(h);
  h.responseBuilder.addDirective({
    type: 'Alexa.Presentation.APL.RenderDocument',
    token: showApl.TOKEN.seasons,
    document: showApl.seasonsDocument({
      showKey,
      showTitle: show.title,
      seasons: seasons.map((s) => ({ ...s, image: img(s.thumb || show.thumb, { width: 360, height: 540 }) })),
      artUrl: img(show.art, { width: 1280, height: 720 }),
      nextSeasonKey: upNextSeason(seasons),
    }),
  });
  if (speak) h.responseBuilder.speak(`Here are the seasons of ${show.title}. Pick one to see its episodes.`);
  return h.responseBuilder.getResponse(); // screen stays; no open microphone
}

async function renderEpisodes(h, showKey, seasonKey, pageIndex = 0, { speak, show, seasons } = {}) {
  const r = rec(h);
  const f = fetchOf(h);
  const [showItem, seasonList, eps] = await Promise.all([
    show || lib.item(f, r.device, r.server, showKey),
    seasons || lib.seasonsOf(f, r.device, r.server, showKey),
    lib.seasonEpisodes(f, r.device, r.server, seasonKey),
  ]);
  const season = seasonList.find((s) => s.ratingKey === seasonKey);
  if (!showItem || !season) return h.responseBuilder.speak("That season isn't available any more.").getResponse();
  const total = eps.length;
  const pages = Math.max(1, Math.ceil(total / showApl.PAGE_SIZE));
  const p = Math.min(Math.max(0, pageIndex | 0), pages - 1);
  const img = await images(h);
  const rows = eps.slice(p * showApl.PAGE_SIZE, (p + 1) * showApl.PAGE_SIZE).map((e) => ({
    ratingKey: e.ratingKey,
    label: `${e.episode}. ${e.title || `Episode ${e.episode}`}`,
    meta: [mins(e.durationMs), airDate(e.airDate)].filter(Boolean).join(' · '),
    summary: (e.summary || '').slice(0, 160),
    image: img(e.episodeThumb, { width: 400, height: 225 }),
    progress: e.viewCount === 0 && e.durationMs && e.viewOffsetMs ? Math.min(100, Math.round((e.viewOffsetMs / e.durationMs) * 100)) : 0,
    watched: e.viewCount > 0,
  }));
  h.responseBuilder.addDirective({
    type: 'Alexa.Presentation.APL.RenderDocument',
    token: showApl.TOKEN.episodes,
    document: showApl.episodesDocument({
      showKey,
      showTitle: showItem.title,
      seasonTitle: season.title,
      seasonKey,
      episodes: rows,
      pageIndex: p,
      total,
      artUrl: img(showItem.art, { width: 1280, height: 720 }),
      singleSeason: seasonList.length === 1,
    }),
  });
  if (speak) h.responseBuilder.speak(`${showItem.title}, ${season.title}. Tap an episode to play it.`);
  return h.responseBuilder.getResponse();
}

/** "show episodes of The Bear" / "show season 2 of The Bear" */
const ShowEpisodesIntentHandler = {
  canHandle: (h) => isIntent(h, 'ShowEpisodesIntent'),
  async handle(h) {
    const { startOrResume } = require('./handlers');
    if (!hasScreen(h)) return h.responseBuilder.speak('Browsing episodes needs an Echo device with a screen.').withShouldEndSession(true).getResponse();
    if (!(await ready(h))) return startOrResume(h);
    const r = rec(h);
    const name = slot(h, 'show');
    if (!name) return h.responseBuilder.speak('Which show?').reprompt('Say, for example, show episodes of The Bear.').getResponse();
    const shows = await lib.search(fetchOf(h), r.device, r.server, name, { kind: 'show' });
    if (!shows.length) return h.responseBuilder.speak(`I couldn't find a show called ${name} on ${r.server.name}.`).reprompt('Which show?').getResponse();
    const showKey = shows[0].ratingKey;
    const seasonNo = Number.parseInt(slot(h, 'season'), 10);
    if (Number.isInteger(seasonNo)) {
      const seasons = await lib.seasonsOf(fetchOf(h), r.device, r.server, showKey);
      const s = seasons.find((x) => x.index === seasonNo);
      if (!s) return h.responseBuilder.speak(`${shows[0].title} doesn't have a season ${seasonNo} on ${r.server.name}.`).getResponse();
      return renderEpisodes(h, showKey, s.ratingKey, 0, { speak: true, seasons });
    }
    return renderSeasons(h, showKey, { speak: true });
  },
};

/** Season picker (also Back from an episode list, and the player's / home's Episodes button). */
const SeasonsEventHandler = {
  canHandle: (h) => showEvent(h, 'seasons'),
  async handle(h) {
    const { startOrResume } = require('./handlers');
    if (!(await ready(h))) return startOrResume(h);
    const r = rec(h);
    if (r.playback) await play.stop(fetchOf(h), r); // opened from the player: save and free the stream
    return renderSeasons(h, String(h.requestEnvelope.request.arguments[2]));
  },
};

const SeasonEventHandler = {
  canHandle: (h) => showEvent(h, 'season'),
  async handle(h) {
    const { startOrResume } = require('./handlers');
    if (!(await ready(h))) return startOrResume(h);
    const [, , showKey, seasonKey, pageArg] = h.requestEnvelope.request.arguments;
    return renderEpisodes(h, String(showKey), String(seasonKey), Number.parseInt(pageArg, 10) || 0);
  },
};

const EpisodeTapHandler = {
  canHandle: (h) => showEvent(h, 'play'),
  async handle(h) {
    const { startOrResume } = require('./handlers');
    const { renderLoading } = require('./videoHandlers');
    if (!(await ready(h))) return startOrResume(h);
    const r = rec(h);
    const ep = await lib.item(fetchOf(h), r.device, r.server, String(h.requestEnvelope.request.arguments[2]));
    if (!ep) return h.responseBuilder.speak("I couldn't find that episode any more.").getResponse();
    const off = play.startPosition(ep);
    return renderLoading(h, ep, off, { lead: `${off > 0 ? 'Resuming' : 'Playing'} ${lib.describe(ep)}.` });
  },
};

const showHandlers = [ShowEpisodesIntentHandler, SeasonsEventHandler, SeasonEventHandler, EpisodeTapHandler];

module.exports = { showHandlers, upNextSeason };
