'use strict';
// Drives the real skill (ask-sdk-core) with Alexa request envelopes against a
// fake plex.tv and an in-memory store.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSkill } = require('../index');
const { memoryStore } = require('../src/store');
const { fakePlex, server } = require('../testing/fakePlex');

const USER = 'amzn1.ask.account.TEST';

function envelope(request, { screen = true } = {}) {
  return {
    version: '1.0',
    session: { new: false, sessionId: 'amzn1.echo-api.session.1', application: { applicationId: 'amzn1.ask.skill.test' }, user: { userId: USER } },
    context: {
      System: {
        application: { applicationId: 'amzn1.ask.skill.test' },
        user: { userId: USER },
        device: { deviceId: 'dev1', supportedInterfaces: screen ? { 'Alexa.Presentation.APL': { runtime: { maxVersion: '2024.2' } } } : {} },
        apiEndpoint: 'https://api.amazonalexa.com',
      },
    },
    request: { requestId: `req-${Math.random()}`, timestamp: new Date().toISOString(), locale: 'en-US', ...request },
  };
}
const launch = () => ({ type: 'LaunchRequest' });
const intent = (name, slots = {}, confirmationStatus = 'NONE') => ({
  type: 'IntentRequest',
  dialogState: 'STARTED',
  intent: { name, confirmationStatus, slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, { name: k, value: v }])) },
});
const poll = () => ({ type: 'Alexa.Presentation.APL.UserEvent', token: 'linkScreen', arguments: ['pollLink'] });

function setup(opts) {
  const plex = fakePlex(opts);
  const store = memoryStore();
  const skill = buildSkill({ store, fetchImpl: plex.fetchImpl });
  const send = async (req, env) => (await skill.invoke(envelope(req, env))).response;
  return { plex, store, send };
}

const ssml = (r) => (r.outputSpeech && r.outputSpeech.ssml) || '';
const aplDoc = (r) => (r.directives || []).find((d) => d.type === 'Alexa.Presentation.APL.RenderDocument');

test('launch while unlinked shows and speaks a plex.tv/link code, with screen polling', async () => {
  const { send, store } = setup();
  const r = await send(launch());
  assert.match(ssml(r), /plex\.tv\/link/);
  assert.match(ssml(r), /<say-as interpret-as="spell-out">K7Q\d<\/say-as>/);
  const doc = aplDoc(r);
  assert.ok(doc, 'renders the link screen');
  assert.equal(doc.token, 'linkScreen');
  assert.equal(doc.document.onMount[0].commands[1].type, 'SendEvent');
  assert.equal(r.card.type, 'Simple');
  const rec = await store.get(USER);
  assert.ok(rec.pin && rec.device && !rec.token);
  assert.equal(r.shouldEndSession, false);
});

test('a second launch while linking reuses the same code', async () => {
  const { send, store } = setup();
  await send(launch());
  const first = (await store.get(USER)).pin.code;
  await send(launch());
  assert.equal((await store.get(USER)).pin.code, first);
});

test('screen polling is silent while pending, then completes the link (single server auto-selected)', async () => {
  const srv = server('Basement', 'bbb');
  const { send, store, plex } = setup({ servers: [srv], reachable: new Set(['https://203-0-113-9.bbb.plex.direct:32400']) });
  await send(launch());

  const pending = await send(poll());
  assert.equal(pending.outputSpeech, undefined, 'no speech while waiting');
  assert.equal(aplDoc(pending), undefined, 'keeps the current screen');

  plex.link('cam');
  const done = await send(poll());
  assert.match(ssml(done), /linked as cam/);
  assert.match(ssml(done), /Basement/);
  const rec = await store.get(USER);
  assert.equal(rec.token.type, 'jwt');
  assert.equal(rec.pin, null);
  assert.equal(rec.server.name, 'Basement');
  assert.equal(rec.server.accessToken, 'srv-token-bbb');
  assert.equal(rec.server.apiUri, 'https://203-0-113-9.bbb.plex.direct:32400');

  const status = await send(intent('LinkStatusIntent'));
  assert.match(ssml(status), /signed in to Plex as cam, using the server Basement/);
});

test('voice-only device: "I entered the code" completes the link', async () => {
  const srv = server('Basement', 'bbb');
  const { send, plex } = setup({ servers: [srv], reachable: new Set(['https://203-0-113-9.bbb.plex.direct:32400']) });
  const r = await send(launch(), { screen: false });
  assert.equal(aplDoc(r), undefined);
  assert.match(ssml(r), /say: I entered the code/);

  const notYet = await send(intent('CheckLinkIntent'), { screen: false });
  assert.match(ssml(notYet), /I don't see it yet/);

  plex.link();
  const ok = await send(intent('CheckLinkIntent'), { screen: false });
  assert.match(ssml(ok), /all set/);
});

test('several servers: asks, then picks by number or name', async () => {
  const a = server('Basement', 'bbb');
  const b = server('Cabin', 'ccc', { owned: false });
  const { send, store, plex } = setup({ servers: [a, b], reachable: new Set(['https://203-0-113-9.bbb.plex.direct:32400', 'https://203-0-113-9.ccc.plex.direct:32400']) });
  await send(launch());
  plex.link();
  const ask = await send(poll());
  assert.match(ssml(ask), /I found 2 Plex servers: 1, Basement; 2, Cabin/);
  assert.equal((await store.get(USER)).server, null);

  const bad = await send(intent('SelectServerIntent', { serverName: 'garage' }));
  assert.match(ssml(bad), /couldn't find a server called garage/);

  const pick = await send(intent('SelectServerIntent', { serverNumber: '2' }));
  assert.match(ssml(pick), /Connected to Cabin/);
  assert.equal((await store.get(USER)).server.clientIdentifier, 'ccc');

  await send(intent('SwitchServerIntent'));
  const byName = await send(intent('SelectServerIntent', { serverName: 'basement' }));
  assert.match(ssml(byName), /Connected to Basement/);
});

test('unreachable server explains Remote Access', async () => {
  const { send, plex } = setup({ servers: [server('Basement', 'bbb')], reachable: new Set() });
  await send(launch());
  plex.link();
  const r = await send(poll());
  assert.match(ssml(r), /couldn't reach it from the internet.*Remote Access/);
  assert.equal(r.shouldEndSession, true);
});

test('expired JWT is refreshed on launch; a revoked device relinks', async () => {
  const { send, store, plex } = setup({ servers: [server('Basement', 'bbb')], reachable: new Set(['https://203-0-113-9.bbb.plex.direct:32400']) });
  await send(launch());
  plex.link();
  await send(poll());

  const rec = await store.get(USER);
  rec.token.expiresAt = Date.now() + 1000; // about to expire
  await store.put(USER, rec);
  const r = await send(launch());
  assert.match(ssml(r), /Connected to Basement/);
  assert.ok((await store.get(USER)).token.expiresAt > Date.now() + 6 * 86400_000, 'refreshed');
  assert.ok(plex.calls.some((c) => c.path === '/api/v2/auth/token'));

  const rec2 = await store.get(USER);
  rec2.token.expiresAt = Date.now() + 1000;
  await store.put(USER, rec2);
  plex.state.refreshFails = true;
  const relink = await send(launch());
  assert.match(ssml(relink), /plex\.tv\/link/, 'starts a fresh link');
});

test('unlink needs confirmation, then deletes the record', async () => {
  const { send, store, plex } = setup({ servers: [server('Basement', 'bbb')], reachable: new Set(['https://203-0-113-9.bbb.plex.direct:32400']) });
  await send(launch());
  plex.link();
  await send(poll());

  const ask = await send(intent('UnlinkIntent'));
  assert.equal(ask.directives[0].type, 'Dialog.Delegate');
  const no = await send(intent('UnlinkIntent', {}, 'DENIED'));
  assert.match(ssml(no), /stays linked/);
  assert.ok((await store.get(USER)).token);

  const yes = await send(intent('UnlinkIntent', {}, 'CONFIRMED'));
  assert.match(ssml(yes), /removed your Plex sign-in/);
  assert.deepEqual(await store.get(USER), {});
});

test('SkillDisabled event deletes stored data', async () => {
  const { send, store } = setup();
  await send(launch());
  assert.ok((await store.get(USER)).device);
  await send({ type: 'AlexaSkillEvent.SkillDisabled', body: { userInformationPersistenceStatus: 'NOT_PERSISTED' } });
  assert.deepEqual(await store.get(USER), {});
});

test('Plex outage gives a spoken error, no token in logs', async () => {
  const store = memoryStore();
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try {
    const skill = buildSkill({ store, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    const r = (await skill.invoke(envelope(launch()))).response;
    assert.match(ssml(r), /couldn't talk to Plex/);
  } finally { console.error = orig; }
  assert.ok(logs.length && logs.every((l) => !/token/i.test(l.replace('handler error', ''))));
});
