'use strict';
// Video playback through the real skill, against the fake plex.tv + PMS.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSkill } = require('../index');
const { memoryStore } = require('../src/store');
const { fakePlex, server } = require('../testing/fakePlex');
const { durationMs } = require('../src/videoHandlers');

const USER = 'amzn1.ask.account.VIDEO';
const REMOTE = 'https://203-0-113-9.bbb.plex.direct:32400';
const LOCAL = 'https://192-168-1-5.bbb.plex.direct:32400';

function envelope(request, { screen = true, onScreen } = {}) {
  const context = {
    System: {
      application: { applicationId: 'amzn1.ask.skill.test' },
      user: { userId: USER },
      device: { deviceId: 'dev1', supportedInterfaces: screen ? { 'Alexa.Presentation.APL': { runtime: { maxVersion: '2024.2' } } } : {} },
      apiEndpoint: 'https://api.amazonalexa.com',
    },
  };
  if (onScreen) context['Alexa.Presentation.APL'] = { token: onScreen };
  return {
    version: '1.0',
    session: { new: false, sessionId: 's', application: { applicationId: 'amzn1.ask.skill.test' }, user: { userId: USER } },
    context,
    request: { requestId: `r-${Math.random()}`, timestamp: new Date().toISOString(), locale: 'en-US', ...request },
  };
}
const intent = (name, slots = {}) => ({ type: 'IntentRequest', intent: { name, confirmationStatus: 'NONE', slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, { name: k, value: v }])) } });
const ev = (...args) => ({ type: 'Alexa.Presentation.APL.UserEvent', token: 'player', arguments: ['video', ...args] });

async function linked() {
  const plex = fakePlex({ servers: [server('Basement', 'bbb')], reachable: new Set([REMOTE]) });
  const store = memoryStore();
  const skill = buildSkill({ store, fetchImpl: plex.fetchImpl });
  const send = async (req, env) => (await skill.invoke(envelope(req, env))).response;
  await send({ type: 'LaunchRequest' });
  plex.link();
  await send({ type: 'Alexa.Presentation.APL.UserEvent', token: 'linkScreen', arguments: ['pollLink'] });
  assert.equal((await store.get(USER)).server.name, 'Basement');
  return { plex, store, send };
}

const tick = () => ({ type: 'Alexa.Presentation.APL.UserEvent', token: 'loading', arguments: ['load', 'tick'] });
/** Send `req`; if it shows the loading screen, tick until the player appears. Keeps the first speech. */
async function through(send, req, env) {
  const first = await send(req, env);
  let r = first;
  for (let i = 0; i < 10 && r.directives && r.directives.some((d) => d.type === 'Alexa.Presentation.APL.RenderDocument' && d.token === 'loading'); i++) {
    do { r = await send(tick()); } while (!(r.directives || []).some((d) => d.type === 'Alexa.Presentation.APL.RenderDocument'));
  }
  return { ...r, outputSpeech: first.outputSpeech || r.outputSpeech, first };
}

const ssml = (r) => (r.outputSpeech && r.outputSpeech.ssml) || '';
const render = (r) => (r.directives || []).find((d) => d.type === 'Alexa.Presentation.APL.RenderDocument');
const videoNode = (r) => {
  const find = (n) => (n && typeof n === 'object') ? (n.type === 'Video' ? n : Object.values(n).map(find).find(Boolean)) : null;
  return find(render(r).document);
};
const videoUrl = (r) => new URL(videoNode(r).source[0].url);
const startOffset = (r) => {
  const root = render(r).document.mainTemplate.items[0];
  return root.bind.find((b) => b.name === 'resumeAt').value;
};

test('"play The Bear" plays the in-progress episode from the remote URI with a transient token', async () => {
  const { send, store, plex } = await linked();
  const r = await through(send, intent('PlayVideoIntent', { title: 'the bear' }));
  assert.match(ssml(r), /Resuming The Bear, season 1 episode 2/);
  assert.equal(render(r).token, 'player');
  const u = videoUrl(r);
  assert.equal(u.origin, REMOTE);
  assert.equal(u.pathname, '/video/:/transcode/universal/start.m3u8');
  assert.equal(u.searchParams.get('path'), '/library/metadata/102');
  assert.equal(u.searchParams.get('offset'), '0', 'transcode always starts at 0 (PMS returns empty segments otherwise)');
  assert.equal(startOffset(r), 600_000, 'resume via the APL source offset');
  assert.equal(u.searchParams.get('X-Plex-Token'), 'transient-1', 'never the long-lived token');
  assert.equal(u.searchParams.get('X-Plex-Platform'), 'Generic');
  assert.equal(r.reprompt, undefined);
  assert.equal(r.shouldEndSession, undefined, 'session stays open, mic closed');
  const p = (await store.get(USER)).playback;
  assert.equal(p.item.ratingKey, '102');
  assert.equal(p.startMs, 600_000);
});

test('movie resume, "play the movie", and transient token reuse', async () => {
  const { send, plex } = await linked();
  const r = await through(send, intent('PlayMovieIntent', { title: 'dune' }));
  assert.match(ssml(r), /Resuming Dune from 2021/);
  assert.equal(startOffset(r), 3_600_000);
  await through(send, intent('PlayMovieIntent', { title: 'dune part two' }));
  assert.equal(plex.state.transientMinted, 1, 'transient token cached on the server record');
});

test('specific episode, continue watching, and not-found', async () => {
  const { send } = await linked();
  const ep = await through(send, intent('PlayEpisodeIntent', { show: 'the bear', season: '1', episode: '3' }));
  assert.match(ssml(ep), /Playing The Bear, season 1 episode 3/);
  assert.equal(videoUrl(ep).searchParams.get('path'), '/library/metadata/103');

  const cont = await through(send, intent('ContinueWatchingIntent'));
  assert.match(ssml(cont), /Resuming The Bear, season 1 episode 2/);

  const missing = await through(send, intent('PlayVideoIntent', { title: 'zzz' }));
  assert.match(ssml(missing), /couldn't find zzz on Basement/);
  assert.equal(render(missing), undefined);

  const noEp = await through(send, intent('PlayEpisodeIntent', { show: 'the bear', season: '9', episode: '9' }));
  assert.match(ssml(noEp), /doesn't have season 9 episode 9/);
});

test('progress, pause and stop are reported to Plex with absolute positions', async () => {
  const { send, store, plex } = await linked();
  await through(send, intent('PlayVideoIntent', { title: 'the bear' })); // resumes at 600 s
  const quiet = await send(ev('progress', 630_000));
  assert.equal(quiet.outputSpeech, undefined);
  await send(ev('paused', 645_000));
  const t = plex.state.timeline;
  assert.deepEqual(t.map((x) => [x.state, x.time, x.ratingKey]), [['playing', '630000', '102'], ['paused', '645000', '102']]);

  const sid = (await store.get(USER)).playback.sessionId;
  const stop = await send(intent('AMAZON.StopIntent'), { onScreen: 'player' });
  assert.equal(stop.shouldEndSession, true);
  assert.equal(plex.state.timeline.at(-1).state, 'stopped');
  assert.equal(plex.state.timeline.at(-1).time, '645000');
  assert.ok(plex.state.stopped.includes(sid), 'transcode session stopped');
  assert.equal((await store.get(USER)).playback, null);
});

test('failed stream retries on the LAN URI, then explains', async () => {
  const { send } = await linked();
  await through(send, intent('PlayVideoIntent', { title: 'dune' }));
  const retry = await through(send, ev('failed'));
  assert.equal(videoUrl(retry).origin, LOCAL);
  assert.equal(startOffset(retry), 3_600_000, 'resumes at the last known position');
  const gaveUp = await through(send, ev('failed'));
  assert.match(ssml(gaveUp), /couldn't play that stream from Basement.*Remote Access/);
  assert.equal(gaveUp.shouldEndSession, true);
});

test('episode end scrobbles and auto-plays the next one; last episode ends', async () => {
  const { send, plex } = await linked();
  await through(send, intent('PlayEpisodeIntent', { show: 'the bear', season: '1', episode: '2' }));
  const next = await through(send, ev('ended', 1_200_000));
  assert.deepEqual(plex.state.scrobbled, ['102']);
  assert.match(ssml(next), /Up next: The Bear, season 1 episode 3/);
  assert.equal(videoUrl(next).searchParams.get('path'), '/library/metadata/103');
  const end = await through(send, ev('ended', 1_800_000));
  assert.match(ssml(end), /That's the end/);
});

test('voice transport while the player is on screen', async () => {
  const { send } = await linked();
  await through(send, intent('PlayVideoIntent', { title: 'dune' }));
  const on = { onScreen: 'player' };
  const cmd = (r) => r.directives[0].commands[0];
  assert.deepEqual(cmd(await send(intent('AMAZON.PauseIntent'), on)), { type: 'ControlMedia', componentId: 'player', command: 'pause' });
  assert.equal(cmd(await send(intent('AMAZON.ResumeIntent'), on)).command, 'play');
  assert.equal(cmd(await send(intent('SkipForwardIntent', { duration: 'PT2M' }), on)).value, 120_000);
  assert.equal(cmd(await send(intent('SkipBackIntent'), on)).value, -10_000);
  const over = await through(send, intent('AMAZON.StartOverIntent'), on);
  assert.equal(startOffset(over), 0);
});

test('next episode by voice', async () => {
  const { send } = await linked();
  await through(send, intent('PlayEpisodeIntent', { show: 'the bear', season: '1', episode: '1' }));
  const r = await through(send, intent('AMAZON.NextIntent'), { onScreen: 'player' });
  assert.match(ssml(r), /Next: The Bear, season 1 episode 2/);
});

test('session end while watching saves the position', async () => {
  const { send, store, plex } = await linked();
  await through(send, intent('PlayVideoIntent', { title: 'dune' }));
  await send(ev('progress', 3_660_000));
  await send({ type: 'SessionEndedRequest', reason: 'USER_INITIATED' });
  assert.equal(plex.state.timeline.at(-1).state, 'stopped');
  assert.equal(plex.state.timeline.at(-1).time, '3660000');
  assert.equal((await store.get(USER)).playback, null);
});

test('voice-only devices are told video needs a screen; unlinked users get the link flow', async () => {
  const { send } = await linked();
  const r = await through(send, intent('PlayVideoIntent', { title: 'dune' }), { screen: false });
  assert.match(ssml(r), /needs an Echo device with a screen/);

  const plex = fakePlex();
  const skill = buildSkill({ store: memoryStore(), fetchImpl: plex.fetchImpl });
  const fresh = (await skill.invoke(envelope(intent('PlayVideoIntent', { title: 'dune' })))).response;
  assert.match(ssml(fresh), /plex\.tv\/link/);
});

test('AMAZON.DURATION parsing', () => {
  assert.equal(durationMs('PT30S', 1), 30_000);
  assert.equal(durationMs('PT1M30S', 1), 90_000);
  assert.equal(durationMs('PT1H', 1), 3_600_000);
  assert.equal(durationMs(undefined, 10_000), 10_000);
  assert.equal(durationMs('P1D', 5), 5);
});

test('transport with nothing playing', async () => {
  const { send } = await linked();
  const r = await send(intent('AMAZON.PauseIntent'));
  assert.match(ssml(r), /Nothing is playing/);
});

test('an early currentTime of 0 does not overwrite the resume position', async () => {
  const { send, store, plex } = await linked();
  await through(send, intent('PlayMovieIntent', { title: 'dune' })); // resumes at 3600 s
  await send(ev('playing', 0)); // fired before the offset is applied
  assert.equal((await store.get(USER)).playback.lastPosMs, 3_600_000);
});

test('play shows a loading screen at once, then the bar moves while the server wakes up', async () => {
  const { send, plex } = await linked();
  plex.state.startDelays = 2;    // disk spinning up: start.m3u8 times out twice
  plex.state.segmentDelays = 1;  // first segment still transcoding
  const first = await send(intent('PlayVideoIntent', { title: 'the bear' }));
  assert.match(ssml(first), /Resuming The Bear/);
  const doc = render(first);
  assert.equal(doc.token, 'loading', 'loading screen first, no waiting on Plex');
  assert.ok(!plex.calls.some((c) => c.path === '/video/:/transcode/universal/start.m3u8'), 'stream not touched in the first response');
  assert.deepEqual(doc.document.onMount.map((c) => c.type), ['Idle', 'SendEvent'], 'first tick from onMount');
  assert.equal(doc.document.onMount[1].arguments[1], 'tick');

  const pcts = [];
  let r;
  for (let i = 0; i < 8; i++) {
    r = await send(tick());
    const set = (r.directives || []).find((d) => d.type === 'Alexa.Presentation.APL.ExecuteCommands');
    if (set) {
      pcts.push(set.commands[0].value);
      // ExecuteCommands cancels the screen's running commands, so each reply must schedule the next tick.
      assert.deepEqual(set.commands.slice(-2).map((c) => c.type), ['Idle', 'SendEvent']);
      assert.deepEqual(set.commands.at(-1).arguments, ['load', 'tick']);
    }
    if (render(r)) break;
  }
  assert.ok(pcts.length >= 3, `progress updates: ${pcts}`);
  assert.deepEqual([...pcts].sort((a, b) => a - b), pcts, 'percentage only goes up');
  assert.equal(render(r).token, 'player');
  assert.equal(plex.state.segmentsRequested.at(-1), '00060.ts', 'warmed the segment covering the 600 s resume point');
  assert.equal(startOffset(r), 600_000, 'resume point handed to the player');
});

test('loading gives up after the deadline with a clear message', async () => {
  const { send, store, plex } = await linked();
  await send(intent('PlayMovieIntent', { title: 'dune' }));
  const rec = await store.get(USER);
  rec.playback.warm.startedAt = Date.now() - 120_000;
  rec.server.streamUris = []; // no LAN fallback to try
  await store.put(USER, rec);
  plex.state.startDelays = 99;
  const r = await send(tick());
  assert.match(ssml(r), /didn't start the stream in time/);
  assert.equal(r.shouldEndSession, true);
  assert.equal((await store.get(USER)).playback, null);
});

test('stale loading ticks after stop are ignored', async () => {
  const { send } = await linked();
  await send(intent('PlayMovieIntent', { title: 'dune' }));
  await send(intent('AMAZON.StopIntent'));
  const r = await send(tick());
  assert.equal(r.outputSpeech, undefined);
  assert.equal((r.directives || []).length, 0);
});

test('segmentFor picks the segment covering a time', () => {
  const { segmentFor } = require('../src/warmup');
  const pl = '#EXTM3U\n#EXTINF:10, nodesc\n00000.ts\n#EXTINF:10, nodesc\n00001.ts\n#EXTINF:4.5, nodesc\n00002.ts\n';
  assert.equal(segmentFor(pl, 0), '00000.ts');
  assert.equal(segmentFor(pl, 19.9), '00001.ts');
  assert.equal(segmentFor(pl, 22), '00002.ts');
  assert.equal(segmentFor(pl, 999), '00002.ts', 'past the end: last segment');
});

test('player progress loop is started from onPlay (survives voice commands)', async () => {
  const { send } = await linked();
  const r = await through(send, intent('PlayMovieIntent', { title: 'dune' }));
  const v = videoNode(r);
  const loop = v.onPlay.find((c) => c.type === 'Sequential');
  assert.ok(loop, 'loop in onPlay');
  assert.deepEqual(loop.commands[1].arguments, ['video', 'progress', '${pos}']);
  assert.equal(render(r).document.mainTemplate.items[0].onMount, undefined, 'no onMount loop that ExecuteCommands would kill');
});

test('back button (and "go back") saves the position, stops the stream and shows home', async () => {
  const { send, store, plex } = await linked();
  await through(send, intent('PlayMovieIntent', { title: 'dune' }));
  await send(ev('progress', 3_700_000));
  const sid = (await store.get(USER)).playback.sessionId;
  const r = await send({ type: 'Alexa.Presentation.APL.UserEvent', token: 'player', arguments: ['nav', 'home'] });
  assert.equal(render(r).token, 'home');
  assert.equal(plex.state.timeline.at(-1).state, 'stopped');
  assert.equal(plex.state.timeline.at(-1).time, '3700000');
  assert.ok(plex.state.stopped.includes(sid));
  assert.equal((await store.get(USER)).playback, null);

  await through(send, intent('PlayMovieIntent', { title: 'dune' }));
  const v = await send(intent('BackToMenuIntent'), { onScreen: 'player' });
  assert.equal(render(v).token, 'home');

  // From the loading screen too
  await send(intent('PlayMovieIntent', { title: 'dune' }));
  const l = await send({ type: 'Alexa.Presentation.APL.UserEvent', token: 'loading', arguments: ['nav', 'home'] });
  assert.equal(render(l).token, 'home');
  assert.equal((await store.get(USER)).playback, null);
});

test('player and loading screens both have a Back button', () => {
  const find = (n, out = []) => { if (n && typeof n === 'object') { if (n.type === 'TouchWrapper' && JSON.stringify(n.onPress) === JSON.stringify([{ type: 'SendEvent', arguments: ['nav', 'home'] }])) out.push(n); Object.values(n).forEach((x) => find(x, out)); } return out; };
  assert.equal(find(require('../src/apl/player').playerDocument({ url: 'u', title: 't' })).length, 1);
  assert.equal(find(require('../src/apl/loading').loadingDocument({ title: 't' })).length, 1);
});

test('resume is a one-time relative seek on the first onPlay', async () => {
  const { send } = await linked();
  const r = await through(send, intent('PlayMovieIntent', { title: 'dune' }));
  const v = videoNode(r);
  assert.equal(v.source[0].offset, undefined, 'no source offset (ignored on Echo Show 11)');
  const seek = v.onPlay[0];
  assert.equal(seek.type, 'ControlMedia');
  assert.equal(seek.command, 'seek');
  assert.equal(seek.value, '${resumeAt - event.currentTime}');
  assert.match(seek.when, /resumeAt > 0/);
  assert.deepEqual(v.onPlay[1], { type: 'SetValue', componentId: 'root', property: 'resumeAt', value: 0 }, 'only once');
  assert.equal(startOffset(r), 3_600_000);
});

test('player and loading screens set a long idleTimeout (device default cut playback at ~30 s)', () => {
  const p = require('../src/apl/player').playerDocument({ url: 'u', title: 't' });
  assert.ok(p.settings.idleTimeout >= 3 * 3600 * 1000);
  const l = require('../src/apl/loading').loadingDocument({ title: 't' });
  assert.ok(l.settings.idleTimeout >= 120_000);
});
