'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ssmlSafe, aplText, redact, isSafeServerUri } = require('../src/safe');
const { buildSkill } = require('../index');
const { memoryStore } = require('../src/store');
const { fakePlex, server } = require('../testing/fakePlex');

test('ssmlSafe escapes Plex text but keeps our own tags', () => {
  assert.equal(ssmlSafe('<speak>Playing Law & Order.</speak>'), '<speak>Playing Law &amp; Order.</speak>');
  assert.equal(ssmlSafe('<speak>code <say-as interpret-as="spell-out">K7QX</say-as></speak>'), '<speak>code <say-as interpret-as="spell-out">K7QX</say-as></speak>');
  assert.equal(ssmlSafe('<speak>x <audio src="https://evil/a.mp3"/> y</speak>'), '<speak>x &lt;audio src="https://evil/a.mp3"/&gt; y</speak>', 'injected tags neutralised');
  assert.equal(ssmlSafe('<speak>A &amp; B</speak>'), '<speak>A &amp; B</speak>', 'no double escaping');
  assert.equal(ssmlSafe('<speak>1 < 2 > 0</speak>'), '<speak>1 &lt; 2 &gt; 0</speak>');
});

test('aplText neutralises APL expressions in Plex text', () => {
  assert.equal(aplText('${environment.agentName}'), '$\u200B{environment.agentName}');
  assert.equal(aplText('Normal $5 title'), 'Normal $5 title');
  assert.equal(aplText(undefined), undefined);
});

test('redact strips URLs, plex.direct hosts, IPs and tokens', () => {
  const r = redact('getaddrinfo ENOTFOUND 67-55-1-2.abc123.plex.direct at https://67-55-1-2.abc.plex.direct:29276/x?X-Plex-Token=secret 10.0.0.5');
  assert.ok(!/67-55|abc123|secret|10\.0\.0\.5|https?:/.test(r), r);
});

test('isSafeServerUri: https public hosts only', () => {
  for (const ok of ['https://1-2-3-4.abc.plex.direct:32400', 'https://plex.example.com', 'https://8.8.8.8:32400']) assert.ok(isSafeServerUri(ok), ok);
  for (const bad of ['http://plex.example.com', 'https://127.0.0.1:9001', 'https://169.254.169.254/latest', 'https://10.0.0.2', 'https://192.168.1.5:32400', 'https://172.20.0.1', 'https://localhost', 'https://[::1]:32400', 'https://user:pw@plex.example.com', 'not a url']) assert.ok(!isSafeServerUri(bad), bad);
});

const USER = 'amzn1.ask.account.SEC';
const env = (request) => ({
  version: '1.0', session: { new: false, sessionId: 's', application: { applicationId: 'a' }, user: { userId: USER } },
  context: { System: { application: { applicationId: 'a' }, user: { userId: USER }, device: { deviceId: 'd', supportedInterfaces: { 'Alexa.Presentation.APL': {} } }, apiEndpoint: 'x' } },
  request: { requestId: 'r', timestamp: new Date().toISOString(), locale: 'en-US', ...request },
});

test('end to end: "&" in a title gives valid SSML; ${…} in a shared server name is inert; unsafe URIs are dropped', async () => {
  const lib = { items: [{ ratingKey: '9', type: 'movie', title: 'Law & Order ${user.id}', year: 1990, duration: 1000, score: '1' }], onDeck: [] };
  const evil = server('${environment.agentName} & <audio src="x"/>', 'eee', { owned: false });
  evil.connections.push({ protocol: 'https', uri: 'https://169.254.169.254', local: false, relay: false });
  const plex = fakePlex({ servers: [evil], reachable: new Set(['https://203-0-113-9.eee.plex.direct:32400']), library: lib });
  const store = memoryStore();
  const skill = buildSkill({ store, fetchImpl: plex.fetchImpl });
  const send = async (req) => (await skill.invoke(env(req))).response;
  await send({ type: 'LaunchRequest' });
  plex.link();
  const linked = await send({ type: 'Alexa.Presentation.APL.UserEvent', arguments: ['pollLink'] });
  const ssml = linked.outputSpeech.ssml;
  assert.ok(!ssml.includes('<audio'), 'no injected audio tag');
  assert.ok(ssml.includes('&amp;'), '& escaped');
  const docText = JSON.stringify((linked.directives || []).find((d) => d.type.endsWith('RenderDocument')).document);
  assert.ok(!docText.includes('${environment.agentName}'), 'server name expression neutralised');
  const rec = await store.get(USER);
  assert.ok(!JSON.stringify(rec.server).includes('169.254'), 'metadata-range URI dropped');
  assert.ok(!plex.calls.some((c) => c.url.includes('169.254')), 'never contacted');

  const play = await send({ type: 'IntentRequest', intent: { name: 'PlayMovieIntent', confirmationStatus: 'NONE', slots: { title: { name: 'title', value: 'law' } } } });
  assert.match(play.outputSpeech.ssml, /Law &amp; Order/);
  const loading = JSON.stringify(play.directives.find((d) => d.type.endsWith('RenderDocument')).document);
  assert.ok(!loading.includes('${user.id}'), 'title expression neutralised');
});
