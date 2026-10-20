'use strict';
// Browsing a show, in two steps:
//   1. Season picker: a grid of season posters with episode/watched counts.
//   2. Episodes of the chosen season: a tappable list.
// Shows with a single season go straight to step 2.
//
// UserEvents:
//   ['show', 'seasons', showKey]                     season picker (Back from episodes)
//   ['show', 'season', showKey, seasonKey, page]     episodes of a season (page for long seasons)
//   ['show', 'play', ratingKey]                      play an episode
//   ['nav', 'home']                                  Back from the season picker
//
// Long seasons are paged (PAGE_SIZE rows) to stay well inside Alexa's response
// size limit; rows are a single data-bound template.

const { APL_VERSION } = require('./link');
const { BG, ACCENT, graphics, backButton } = require('./ui');

const TOKEN = { seasons: 'seasons', episodes: 'episodes' };
const PAGE_SIZE = 20; // ~14 KB per page with real data, well under Alexa response limits

const pill = (label, args) => ({
  type: 'TouchWrapper',
  onPress: [{ type: 'SendEvent', arguments: args }],
  item: {
    type: 'Frame', backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: '4vh',
    paddingLeft: '2.4vw', paddingRight: '2.4vw', paddingTop: '1.3vh', paddingBottom: '1.3vh', marginLeft: '0.8vw', marginRight: '0.8vw',
    item: { type: 'Text', text: label, fontSize: '3.2vh', fontWeight: 'bold', color: '#ffffff', maxLines: 1 },
  },
});

function page(items, { artUrl } = {}) {
  return {
    type: 'APL',
    version: APL_VERSION,
    theme: 'dark',
    graphics,
    settings: { idleTimeout: 600_000 }, // browsing can take a while; device default is ~30 s
    mainTemplate: {
      parameters: [],
      items: [{
        type: 'Container',
        width: '100vw',
        height: '100vh',
        items: [
          { type: 'Frame', position: 'absolute', width: '100vw', height: '100vh', backgroundColor: BG },
          ...(artUrl ? [{ type: 'Image', position: 'absolute', width: '100vw', height: '100vh', source: artUrl, scale: 'best-fill', opacity: 0.18 }] : []),
          ...items,
        ],
      }],
    },
  };
}

const header = (title, subtitle, backArgs) => ({
  type: 'Container', direction: 'row', alignItems: 'center', paddingLeft: '4vw', paddingRight: '4vw', paddingTop: '4vh', paddingBottom: '2vh',
  items: [
    backButton(backArgs),
    {
      type: 'Container', paddingLeft: '2vw', grow: 1, shrink: 1,
      items: [
        { type: 'Text', text: title, fontSize: '5.2vh', fontWeight: 'bold', color: '#ffffff', maxLines: 1 },
        ...(subtitle ? [{ type: 'Text', text: subtitle, fontSize: '3vh', color: '#9aa1b2', maxLines: 1 }] : []),
      ],
    },
  ],
});

/**
 * Step 1: season posters. `seasons`: [{ ratingKey, title, episodes, watched, image }]
 */
function seasonsDocument({ showKey, showTitle, seasons, artUrl, nextSeasonKey }) {
  const tile = {
    type: 'TouchWrapper',
    onPress: [{ type: 'SendEvent', arguments: ['show', 'season', showKey, '${data.ratingKey}', '0'] }],
    item: {
      type: 'Container',
      width: '20vw',
      paddingRight: '3vw',
      paddingBottom: '3vh',
      items: [
        {
          type: 'Frame', borderRadius: '1.2vh',
          borderWidth: '${data.upNext ? 3 : 0}', borderColor: ACCENT,
          item: { type: 'Image', source: '${data.image}', width: '20vw', height: '30vw', scale: 'best-fill', borderRadius: '1.2vh' },
        },
        { type: 'Text', text: '${data.title}', fontSize: '3.4vh', fontWeight: 'bold', color: '#ffffff', maxLines: 1, paddingTop: '1vh' },
        { type: 'Text', text: '${data.caption}', fontSize: '2.7vh', color: "${data.upNext ? '" + ACCENT + "' : '#9aa1b2'}", maxLines: 1 },
      ],
    },
  };
  const data = seasons.map((s) => ({
    ratingKey: s.ratingKey,
    title: s.title,
    image: s.image || '',
    upNext: s.ratingKey === nextSeasonKey,
    caption: s.ratingKey === nextSeasonKey
      ? 'Up next'
      : `${s.episodes} episode${s.episodes === 1 ? '' : 's'}${s.watched >= s.episodes && s.episodes ? ' · ✓ Watched' : s.watched ? ` · ${s.watched} watched` : ''}`,
  }));
  return page([
    header(showTitle, `${seasons.length} season${seasons.length === 1 ? '' : 's'} · tap one to see its episodes`),
    {
      type: 'GridSequence',
      grow: 1,
      paddingLeft: '4vw',
      paddingTop: '1vh',
      childWidth: '23vw',
      childHeight: '48vw',
      scrollDirection: 'vertical',
      data,
      items: [tile],
    },
  ], { artUrl });
}

const episodeRow = {
  type: 'TouchWrapper',
  onPress: [{ type: 'SendEvent', arguments: ['show', 'play', '${data.ratingKey}'] }],
  item: {
    type: 'Container',
    direction: 'row',
    alignItems: 'center',
    paddingTop: '1.4vh', paddingBottom: '1.4vh',
    items: [
      {
        type: 'Container',
        width: '22vw',
        items: [
          { type: 'Image', source: '${data.image}', width: '22vw', height: '12.4vw', scale: 'best-fill', borderRadius: '1vh' },
          {
            type: 'Frame', width: '22vw', height: '0.8vh', backgroundColor: 'rgba(255,255,255,0.18)', display: "${data.progress > 0 ? 'normal' : 'none'}",
            item: { type: 'Frame', width: '${data.progress}%', height: '0.8vh', backgroundColor: ACCENT },
          },
        ],
      },
      {
        type: 'Container',
        grow: 1, shrink: 1,
        paddingLeft: '2.5vw',
        items: [
          {
            type: 'Container', direction: 'row', alignItems: 'center',
            items: [
              { type: 'Text', text: '${data.label}', fontSize: '3.6vh', fontWeight: 'bold', color: '#ffffff', maxLines: 1, grow: 1, shrink: 1 },
              { type: 'Text', text: "${data.watched ? '✓ Watched' : ''}", fontSize: '2.8vh', color: ACCENT, paddingLeft: '1vw' },
            ],
          },
          { type: 'Text', text: '${data.meta}', fontSize: '2.7vh', color: '#9aa1b2', maxLines: 1, paddingTop: '0.4vh' },
          { type: 'Text', text: '${data.summary}', fontSize: '2.8vh', color: '#c9ced8', maxLines: 2, paddingTop: '0.6vh' },
        ],
      },
    ],
  },
};

/**
 * Step 2: one season's episodes. `episodes`: [{ ratingKey, label, meta, summary, image, progress, watched }]
 * `singleSeason`: Back goes home instead of to the season picker.
 */
function episodesDocument({ showKey, showTitle, seasonTitle, seasonKey, episodes, pageIndex = 0, total = episodes.length, artUrl, singleSeason = false }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const footer = {
    type: 'Container', direction: 'row', justifyContent: 'center', paddingTop: '2vh', paddingBottom: '6vh',
    items: pages > 1 ? [
      ...(pageIndex > 0 ? [pill('‹ Earlier', ['show', 'season', showKey, seasonKey, String(pageIndex - 1)])] : []),
      { type: 'Text', text: `Episodes ${pageIndex * PAGE_SIZE + 1}–${Math.min(total, (pageIndex + 1) * PAGE_SIZE)} of ${total}`, fontSize: '3vh', color: '#9aa1b2', paddingTop: '1.3vh', paddingLeft: '1vw', paddingRight: '1vw' },
      ...(pageIndex < pages - 1 ? [pill('More ›', ['show', 'season', showKey, seasonKey, String(pageIndex + 1)])] : []),
    ] : [],
  };
  return page([
    header(showTitle, `${seasonTitle} · ${total} episode${total === 1 ? '' : 's'}`, singleSeason ? undefined : ['show', 'seasons', showKey]),
    {
      type: 'Sequence', grow: 1, paddingLeft: '4vw', paddingRight: '4vw',
      data: episodes,
      items: [episodeRow],
      lastItem: footer,
    },
  ], { artUrl });
}

module.exports = { TOKEN, PAGE_SIZE, seasonsDocument, episodesDocument };
