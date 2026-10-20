'use strict';
// Browsing a show: season picker -> episodes -> play.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSkill } = require('../index');
const { memoryStore } = require('../src/store');
const { fakePlex, server } = require('../testing/fakePlex');

const USER = 'amzn1.ask.account.SHOW';
const REMOTE = 'https://203-0-113-9.bbb.plex.direct:32400';
const env = (request, onScreen) => ({
  version: '1.0',
  session: { new: false, sessionId: 's', application: { applicationId: 'a' }, user: { userId: USER } },
  context: {
    System: { application: { applicationId: 'a' }, user: { userId: USER }, device: { deviceId: 'd', supportedInterfaces: { 'Alexa.Presentation.APL': { runtime: { maxVersion: '2024.2' } } } }, apiEndpoint: 'https://api.amazonalexa.com' },
    ...(onScreen ? { 'Alexa.Presentation.APL': { token: onScreen } } : {}),
  },
  request: { requestId: `r-${Math.random()}`, timestamp: new Date().toISOString(), locale: 'en-US', ...request },
});
const intent = (name, slots = {}) => ({ type: 'IntentRequest', intent: { name, confirmationStatus: 'NONE', slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, { name: k, value: v }])) } });
const tap = (...args) => ({ type: 'Alexa.Presentation.APL.UserEvent', arguments: args });
const doc = (r) => (r.directives || []).find((d) => d.type === 'Alexa.Presentation.APL.RenderDocument');
const ssml = (r) => (r.outputSpeech && r.outputSpeech.ssml) || '';
const findAll = (n, pred, out = []) => { if (n && typeof n === 'object') { if (pred(n)) out.push(n); Object.values(n).forEach((v) => findAll(v, pred, out)); } return out; };
const seqData = (d, type = 'Sequence') => findAll(d.document, (n) => n.type === type && Array.isArray(n.data))[0].data;

function library() {
  const ep = (key, s, e, extra = {}) => ({ ratingKey: key, type: 'episode', title: `Ep ${s}x${e}`, grandparentTitle: 'Severance', grandparentRatingKey: '300', parentIndex: s, index: e, duration: 3_000_000, summary: `Summary ${s}x${e}`, thumb: `/t/${key}`, originallyAvailableAt: '2022-02-18', ...extra });
  const items = [
    { ratingKey: '300', type: 'show', title: 'Severance', year: 2022, score: '0.9', thumb: '/t/300', art: '/a/300' },
    ep('301', 1, 1, { viewCount: 1 }), ep('302', 1, 2, { viewCount: 1 }),
    ep('311', 2, 1, { viewOffset: 1_500_000 }), ep('312', 2, 2),
    ep('390', 0, 1), // a special
    { ratingKey: '400', type: 'show', title: 'Big Season Show', score: '0.5' },
    ...Array.from({ length: 45 }, (_, i) => ({ ratingKey: `4${String(i + 1).padStart(2, '0')}x`, type: 'episode', title: `E${i + 1}`, grandparentTitle: 'Big Season Show', grandparentRatingKey: '400', parentIndex: 1, index: i + 1, duration: 1_200_000 })),
    { ratingKey: '500', type: 'show', title: 'One Season', score: '0.4' },
    { ratingKey: '501', type: 'episode', title: 'Only', grandparentTitle: 'One Season', grandparentRatingKey: '500', parentIndex: 1, index: 1, duration: 1_000_000 },
  ];
  return { items, onDeck: [items[3]] };
}

async function linked() {
  const plex = fakePlex({ servers: [server('Basement', 'bbb')], reachable: new Set([REMOTE]), library: library() });
  const store = memoryStore();
  const skill = buildSkill({ store, fetchImpl: plex.fetchImpl });
  const send = async (req, onScreen) => (await skill.invoke(env(req, onScreen))).response;
  await send({ type: 'LaunchRequest' });
  plex.link();
  await send(tap('pollLink'));
  return { plex, store, send };
}

test('"show episodes of Severance" opens the season picker first', async () => {
  const { send } = await linked();
  const r = await send(intent('ShowEpisodesIntent', { show: 'severance' }));
  assert.match(ssml(r), /Here are the seasons of Severance/);
  const d = doc(r);
  assert.equal(d.token, 'seasons');
  const seasons = seqData(d, 'GridSequence');
  assert.deepEqual(seasons.map((s) => s.title), ['Season 1', 'Season 2', 'Specials'], 'Specials last');
  assert.equal(seasons[0].caption, '2 episodes · ✓ Watched');
  assert.equal(seasons[1].caption, 'Up next', 'first unfinished season highlighted');
  assert.ok(seasons[1].upNext);
  assert.match(seasons[0].image, /\/photo\/:\/transcode\?.*X-Plex-Token=transient-/);
  const tile = findAll(d.document, (n) => n.type === 'TouchWrapper' && JSON.stringify(n.onPress).includes('"season"'))[0];
  assert.deepEqual(tile.onPress[0].arguments, ['show', 'season', '300', '${data.ratingKey}', '0']);
  assert.equal(d.document.settings.idleTimeout, 600_000);
  assert.equal(r.reprompt, undefined);
});

test('tapping a season shows its episodes; Back returns to the season picker', async () => {
  const { send } = await linked();
  await send(intent('ShowEpisodesIntent', { show: 'severance' }));
  const r = await send(tap('show', 'season', '300', '300-s2', '0'));
  const d = doc(r);
  assert.equal(d.token, 'episodes');
  const eps = seqData(d);
  assert.deepEqual(eps.map((e) => e.label), ['1. Ep 2x1', '2. Ep 2x2']);
  assert.equal(eps[0].progress, 50, 'in-progress bar');
  assert.equal(eps[0].meta, '50 min · Feb 18, 2022');
  assert.equal(eps[0].summary, 'Summary 2x1');
  assert.match(eps[0].image, /X-Plex-Token=transient-/);
  const back = findAll(d.document, (n) => n.type === 'TouchWrapper' && JSON.stringify(n).includes('Back'))[0];
  assert.deepEqual(back.onPress[0].arguments, ['show', 'seasons', '300']);
  assert.equal(doc(await send(tap('show', 'seasons', '300'))).token, 'seasons');

  const s1 = seqData(doc(await send(tap('show', 'season', '300', '300-s1', '0'))));
  assert.ok(s1.every((e) => e.watched), 'watched marks');
});

test('tapping an episode starts loading it (resuming where left off)', async () => {
  const { send } = await linked();
  const r = await send(tap('show', 'play', '311'));
  assert.equal(doc(r).token, 'loading');
  assert.match(ssml(r), /Resuming Severance, season 2 episode 1/);
});

test('"show season 2 of Severance" jumps straight to that season; unknown season explains', async () => {
  const { send } = await linked();
  const r = await send(intent('ShowEpisodesIntent', { show: 'severance', season: '2' }));
  assert.equal(doc(r).token, 'episodes');
  assert.match(ssml(r), /Severance, Season 2/);
  const bad = await send(intent('ShowEpisodesIntent', { show: 'severance', season: '9' }));
  assert.match(ssml(bad), /doesn't have a season 9/);
  const none = await send(intent('ShowEpisodesIntent', { show: 'nothing like this' }));
  assert.match(ssml(none), /couldn't find a show called nothing like this/);
});

test('single-season shows skip the picker; Back goes home', async () => {
  const { send } = await linked();
  const r = await send(intent('ShowEpisodesIntent', { show: 'one season' }));
  assert.equal(doc(r).token, 'episodes');
  const back = findAll(doc(r).document, (n) => n.type === 'TouchWrapper' && JSON.stringify(n).includes('Back'))[0];
  assert.deepEqual(back.onPress[0].arguments, ['nav', 'home']);
});

test('long seasons are paged 20 at a time', async () => {
  const { send } = await linked();
  const r = await send(intent('ShowEpisodesIntent', { show: 'big season show' }));
  const d = doc(r);
  assert.equal(seqData(d).length, 20);
  const more = findAll(d.document, (n) => n.type === 'TouchWrapper' && JSON.stringify(n).includes('More'))[0];
  assert.deepEqual(more.onPress[0].arguments, ['show', 'season', '400', '400-s1', '1']);
  const p3 = doc(await send(tap('show', 'season', '400', '400-s1', '2')));
  assert.deepEqual(seqData(p3).map((e) => e.label).slice(0, 2), ['41. E41', '42. E42']);
  assert.equal(seqData(p3).length, 5);
  assert.ok(JSON.stringify(p3.document).includes('Episodes 41–45 of 45'));
  assert.ok(!JSON.stringify(p3.document).includes('More ›'), 'no More on the last page');
});

test('player Episodes button saves the position, stops the stream and opens the picker', async () => {
  const { send, store, plex } = await linked();
  let r = await send(tap('show', 'play', '311'));
  for (let i = 0; i < 10 && !(doc(r) && doc(r).token === 'player'); i++) r = await send(tap('load', 'tick'));
  const btn = findAll(doc(r).document, (n) => n.type === 'TouchWrapper' && JSON.stringify(n).includes('"Episodes"'))[0];
  assert.deepEqual(btn.onPress[0].arguments, ['show', 'seasons', '300']);
  await send({ type: 'Alexa.Presentation.APL.UserEvent', arguments: ['video', 'progress', '1600000', '311'] });
  const sid = (await store.get(USER)).playback.sessionId;
  const picker = await send(tap('show', 'seasons', '300'));
  assert.equal(doc(picker).token, 'seasons');
  assert.equal(plex.state.timeline.at(-1).state, 'stopped');
  assert.equal(plex.state.timeline.at(-1).time, '1600000');
  assert.ok(plex.state.stopped.includes(sid));
  assert.equal((await store.get(USER)).playback, null);
});

test('home Continue Watching tiles have an Episodes link for episodes', async () => {
  const { send } = await linked();
  const r = await send({ type: 'LaunchRequest' });
  const d = doc(r);
  assert.equal(d.token, 'home');
  const tile = seqData(d)[0];
  assert.equal(tile.showKey, '300');
  const link = findAll(d.document, (n) => n.type === 'TouchWrapper' && JSON.stringify(n).includes('Episodes ›'))[0];
  assert.deepEqual(link.onPress[0].arguments, ['show', 'seasons', '${data.showKey}']);
});
