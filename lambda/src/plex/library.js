'use strict';
// Library lookups against the selected server (rec.server.apiUri with the
// server access token). Response shapes checked against PMS 1.42.

const { plexRequest } = require('./client');

const api = (fetchImpl, device, server, path) =>
  plexRequest(fetchImpl, `${server.apiUri}${path}`, { clientId: device.clientId, token: server.accessToken, timeoutMs: 8000 });

const meta = (res) => (res && res.MediaContainer && res.MediaContainer.Metadata) || [];

const norm = (s) => String(s || '').toLowerCase().replace(/['’]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
  .replace(/^(the|a|an) /, '');

/** Reduce a PMS metadata item to what the skill needs. */
function slim(m) {
  return {
    ratingKey: String(m.ratingKey),
    type: m.type,
    title: m.title,
    year: m.year,
    showTitle: m.grandparentTitle,
    showKey: m.grandparentRatingKey ? String(m.grandparentRatingKey) : undefined,
    season: m.parentIndex,
    episode: m.index,
    summary: m.summary,
    durationMs: m.duration,
    viewOffsetMs: m.viewOffset || 0,
    viewCount: m.viewCount || 0,
    thumb: m.type === 'episode' ? (m.grandparentThumb || m.thumb) : m.thumb,
    art: m.art || m.grandparentArt,
  };
}

/** Spoken label: "The Bear, season 5 episode 2" / "Dune (2021)". */
function describe(item) {
  if (item.type === 'episode') return `${item.showTitle}, season ${item.season} episode ${item.episode}${item.title ? `, ${item.title}` : ''}`;
  return item.year ? `${item.title} from ${item.year}` : item.title;
}

/**
 * Search movies, shows and episodes. `kind` limits to 'movie' | 'show'.
 * Exact (normalised) title matches win; otherwise Plex's own ordering and score.
 */
async function search(fetchImpl, device, server, query, { kind, limit = 10 } = {}) {
  const q = encodeURIComponent(query);
  const res = await api(fetchImpl, device, server, `/hubs/search?query=${q}&limit=${limit}&includeCollections=0&includeExternalMedia=0`);
  const hubs = (res && res.MediaContainer && res.MediaContainer.Hub) || [];
  const wanted = kind ? [kind] : ['movie', 'show', 'episode'];
  const items = [];
  for (const h of hubs) {
    if (!wanted.includes(h.type)) continue;
    for (const m of h.Metadata || []) items.push({ ...slim(m), score: Number(m.score) || 0 });
  }
  const want = norm(query);
  const rank = (i) => (norm(i.title) === want ? 2 : norm(i.title).startsWith(want) ? 1 : 0) * 10
    + (i.type === 'episode' ? 0 : 1) // prefer a movie/show over a same-named episode
    + i.score;
  return items.sort((a, b) => rank(b) - rank(a));
}

async function episodesOf(fetchImpl, device, server, showKey) {
  return meta(await api(fetchImpl, device, server, `/library/metadata/${encodeURIComponent(showKey)}/allLeaves`)).map(slim);
}

/** In-progress episode, else first unwatched, else the first episode (rewatch). */
function pickNextEpisode(episodes) {
  if (!episodes.length) return null;
  return episodes.find((e) => e.viewOffsetMs > 0 && e.viewCount === 0)
    || episodes.find((e) => e.viewCount === 0)
    || episodes[0];
}

async function nextEpisode(fetchImpl, device, server, showKey) {
  return pickNextEpisode(await episodesOf(fetchImpl, device, server, showKey));
}

async function episodeAt(fetchImpl, device, server, showKey, season, episode) {
  const eps = await episodesOf(fetchImpl, device, server, showKey);
  return eps.find((e) => Number(e.season) === Number(season) && Number(e.episode) === Number(episode)) || null;
}

/** The episode after `item` in its show, or null at the end. */
async function followingEpisode(fetchImpl, device, server, item) {
  if (item.type !== 'episode' || !item.showKey) return null;
  const eps = await episodesOf(fetchImpl, device, server, item.showKey);
  const i = eps.findIndex((e) => e.ratingKey === item.ratingKey);
  return i >= 0 && i + 1 < eps.length ? eps[i + 1] : null;
}

async function onDeck(fetchImpl, device, server, { limit = 10 } = {}) {
  return meta(await api(fetchImpl, device, server, `/library/onDeck?X-Plex-Container-Start=0&X-Plex-Container-Size=${limit}`)).map(slim);
}

async function item(fetchImpl, device, server, ratingKey) {
  const m = meta(await api(fetchImpl, device, server, `/library/metadata/${encodeURIComponent(ratingKey)}`))[0];
  return m ? slim(m) : null;
}

module.exports = { search, episodesOf, pickNextEpisode, nextEpisode, episodeAt, followingEpisode, onDeck, item, describe, slim, norm };
