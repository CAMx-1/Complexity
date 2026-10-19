'use strict';
// Touch UI: home screen, server picker, Continue Watching tiles.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSkill } = require('../index');
const { memoryStore } = require('../src/store');
const { fakePlex, server } = require('../testing/fakePlex');

const USER = 'amzn1.ask.account.TOUCH';
const env = (request) => ({
  version: '1.0',
  session: { new: false, sessionId: 's', application: { applicationId: 'a' }, user: { userId: USER } },
  context: { System: { application: { applicationId: 'a' }, user: { userId: USER }, device: { deviceId: 'd', supportedInterfaces: { 'Alexa.Presentation.APL': { runtime: { maxVersion: '2024.2' } } } }, apiEndpoint: 'https://api.amazonalexa.com' } },
  request: { requestId: `r-${Math.random()}`, timestamp: new Date().toISOString(), locale: 'en-US', ...request },
});
const tap = (...args) => ({ type: 'Alexa.Presentation.APL.UserEvent', arguments: args });
const doc = (r) => (r.directives || []).find((d) => d.type === 'Alexa.Presentation.APL.RenderDocument');
const ssml = (r) => (r.outputSpeech && r.outputSpeech.ssml) || '';
const findAll = (n, pred, out = []) => { if (n && typeof n === 'object') { if (pred(n)) out.push(n); Object.values(n).forEach((v) => findAll(v, pred, out)); } return out; };

function setup(servers) {
  const reachable = new Set(servers.map((s) => s.connections.find((c) => !c.local && !c.relay).uri));
  const plex = fakePlex({ servers, reachable });
  const store = memoryStore();
  const skill = buildSkill({ store, fetchImpl: plex.fetchImpl });
  const send = async (req) => (await skill.invoke(env(req))).response;
  return { plex, store, send };
}

test('ready: home screen with logo, hints and tappable Continue Watching (no black screen)', async () => {
  const { send, plex } = setup([server('Basement', 'bbb')]);
  await send({ type: 'LaunchRequest' });
  plex.link();
  const r = await send(tap('pollLink'));
  const d = doc(r);
  assert.equal(d.token, 'home');
  assert.ok(d.document.graphics.logo, 'vector logo included');
  assert.equal(findAll(d.document, (n) => n.type === 'VectorGraphic').length, 1);
  assert.ok(JSON.stringify(d.document).includes('Play The Bear'), 'shows what to say');
  const seq = findAll(d.document, (n) => n.type === 'Sequence')[0];
  assert.equal(seq.data.length, 1);
  assert.equal(seq.data[0].ratingKey, '102');
  assert.match(seq.data[0].image, /\/photo\/:\/transcode\?.*X-Plex-Token=transient-/);
  assert.deepEqual(findAll(seq, (n) => n.type === 'TouchWrapper')[0].onPress[0].arguments, ['home', 'play', '${data.ratingKey}']);
  assert.equal(findAll(d.document, (n) => n.type === 'TouchWrapper' && JSON.stringify(n).includes('Switch server')).length, 0, 'no switch button with one server');

  const relaunch = await send({ type: 'LaunchRequest' });
  assert.equal(doc(relaunch).token, 'home', 'opening the skill again shows home');
});

test('several servers: touch picker; tapping one selects it and shows home', async () => {
  const many = ['Basement', 'Cabin', 'Krazzy', 'Rayflix', 'W11'].map((n, i) => server(n, `s${i}x`, { owned: i === 0 }));
  const { send, store, plex } = setup(many);
  await send({ type: 'LaunchRequest' });
  plex.link();
  const r = await send(tap('pollLink'));
  const d = doc(r);
  assert.equal(d.token, 'servers');
  const seq = findAll(d.document, (n) => n.type === 'Sequence')[0];
  assert.deepEqual(seq.data.map((x) => x.name), ['Basement', 'Cabin', 'Krazzy', 'Rayflix', 'W11']);
  assert.equal(seq.data[0].caption, 'Your server');
  assert.equal(seq.data[1].caption, 'Shared with you');
  assert.deepEqual(findAll(seq, (n) => n.type === 'TouchWrapper')[0].onPress[0].arguments, ['server', 'select', '${data.id}']);
  assert.match(ssml(r), /found 5 Plex servers\. Tap the one to use/);

  const picked = await send(tap('server', 'select', 's2x'));
  assert.equal((await store.get(USER)).server.name, 'Krazzy');
  assert.equal(doc(picked).token, 'home');
  assert.match(ssml(picked), /Connected to Krazzy/);
  const switchBtn = findAll(doc(picked).document, (n) => n.type === 'TouchWrapper' && JSON.stringify(n).includes('Switch server'));
  assert.equal(switchBtn.length, 1, 'switch button shown when there are several servers');
  assert.deepEqual(switchBtn[0].onPress[0].arguments, ['home', 'servers']);

  const picker = await send(tap('home', 'servers'));
  const cur = findAll(doc(picker).document, (n) => n.type === 'Sequence')[0].data.find((x) => x.current);
  assert.equal(cur.name, 'Krazzy', 'current server highlighted');
});

test('tapping a Continue Watching tile starts loading that item', async () => {
  const { send, plex } = setup([server('Basement', 'bbb')]);
  await send({ type: 'LaunchRequest' });
  plex.link();
  await send(tap('pollLink'));
  const r = await send(tap('home', 'play', '200'));
  assert.equal(doc(r).token, 'loading');
  assert.match(ssml(r), /Resuming Dune from 2021/);
});

test('tapping a server that vanished re-shows the picker', async () => {
  const { send, plex } = setup([server('Basement', 'bbb'), server('Cabin', 'ccc', { owned: false })]);
  await send({ type: 'LaunchRequest' });
  plex.link();
  await send(tap('pollLink'));
  const r = await send(tap('server', 'select', 'gone'));
  assert.match(ssml(r), /isn't available any more/);
  assert.equal(doc(r).token, 'servers');
});

test('"ask complexity player to show home" renders the home screen', async () => {
  const { send, plex } = setup([server('Basement', 'bbb')]);
  await send({ type: 'LaunchRequest' });
  plex.link();
  await send(tap('pollLink'));
  const r = await send({ type: 'IntentRequest', intent: { name: 'ShowHomeIntent', confirmationStatus: 'NONE', slots: {} } });
  assert.equal(doc(r).token, 'home');
});
