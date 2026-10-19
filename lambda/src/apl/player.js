'use strict';
// Full-screen APL video player for Echo Show.
//
// Tap the video to pause and show the controls: ‹ Back (to the home screen),
// « 10s, Play, 30s », and Next episode › for episodes.
//
// Events sent to the skill (Alexa.Presentation.APL.UserEvent arguments):
//   ['nav', 'home']                                Back button
//   ['video', 'playing'|'paused', currentTimeMs, ratingKey]   on play / pause
//   ['video', 'progress', currentTimeMs, ratingKey]           every PROGRESS_SECONDS while playing
//   ['video', 'ended', currentTimeMs, ratingKey]              track finished
//   ['video', 'next', currentTimeMs, ratingKey]               Next episode button
// The ratingKey makes every event self-describing: the screen can outlive the
// skill's session, so the skill must be able to pick playback back up from an
// event alone (seen on an Echo Show 11: the session ended minutes into an
// episode and the end-of-episode event arrived with no playback on record).
//   ['video', 'failed']                            stream could not be played
// The stream always starts at 0, and resume uses the source `offset`, so
// currentTime is the absolute position in the title.

const { APL_VERSION } = require('./link');
const { backButton } = require('./ui');

const TOKEN = 'player';
const PLAYER_ID = 'player';
const ROOT_ID = 'root';
const PROGRESS_SECONDS = 20;

// How long the screen (and the skill session) may stay up without touch or
// voice. The device default is about 30 s: on an Echo Show 11, playback was
// cut off 30-50 s in with SessionEndedRequest USER_INITIATED. Long enough for
// a feature film; the skill still ends the session at the end of a title.
const IDLE_TIMEOUT_MS = 4 * 3600 * 1000;

const media = (command, extra = {}) => ({ type: 'ControlMedia', componentId: PLAYER_ID, command, ...extra });

const button = (label, commands) => ({
  type: 'TouchWrapper',
  onPress: commands,
  item: {
    type: 'Frame', backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: '6vh', paddingLeft: '3vw', paddingRight: '3vw', paddingTop: '1.6vh', paddingBottom: '1.6vh', marginLeft: '1.5vw', marginRight: '1.5vw',
    item: { type: 'Text', text: label, fontSize: '4.2vh', color: '#ffffff', fontWeight: 'bold' },
  },
});

/**
 * @param {{ url: string, title: string, subtitle?: string, offsetMs?: number }} p
 */
function playerDocument({ url, title, subtitle = '', offsetMs = 0, ratingKey = '', hasNext = false }) {
  const send = (...args) => ({ type: 'SendEvent', arguments: ['video', ...args, String(ratingKey)] });
  return {
    type: 'APL',
    version: APL_VERSION,
    theme: 'dark',
    settings: { idleTimeout: IDLE_TIMEOUT_MS },
    mainTemplate: {
      parameters: [],
      items: [{
        type: 'Container',
        id: ROOT_ID,
        width: '100vw',
        height: '100vh',
        bind: [
          { name: 'pos', value: 0, type: 'number' },
          { name: 'paused', value: false, type: 'boolean' },
          // Resume: the Echo Show 11 ignored the source `offset` and started at 0,
          // so we seek once on the first onPlay instead.
          { name: 'resumeAt', value: Math.max(0, Math.round(offsetMs)), type: 'number' },
        ],
        items: [
          { type: 'Frame', position: 'absolute', width: '100vw', height: '100vh', backgroundColor: '#000000' },
          {
            type: 'Video',
            id: PLAYER_ID,
            position: 'absolute',
            width: '100vw',
            height: '100vh',
            scale: 'best-fit',
            autoplay: true,
            audioTrack: 'foreground',
            source: [{ url, description: title }],
            // The progress loop starts from onPlay: voice commands (ExecuteCommands)
            // cancel running sequences, and every resume fires onPlay again.
            onPlay: [
              { type: 'ControlMedia', componentId: PLAYER_ID, command: 'seek', value: '${resumeAt - event.currentTime}', when: '${resumeAt > 0 && event.currentTime < resumeAt - 5000}' },
              { type: 'SetValue', componentId: ROOT_ID, property: 'resumeAt', value: 0 },
              { type: 'SetValue', componentId: ROOT_ID, property: 'paused', value: false },
              send('playing', '${event.currentTime}'),
              { type: 'Sequential', repeatCount: 100000, commands: [{ type: 'Idle', delay: PROGRESS_SECONDS * 1000 }, send('progress', '${pos}')] },
            ],
            onPause: [{ type: 'SetValue', componentId: ROOT_ID, property: 'paused', value: true }, send('paused', '${event.currentTime}')],
            onEnd: [send('ended', '${event.currentTime}')],
            onTimeUpdate: [{ type: 'SetValue', componentId: ROOT_ID, property: 'pos', value: '${event.currentTime}' }],
            onTrackFail: [send('failed')],
          },
          // Tap anywhere: toggle play/pause.
          {
            type: 'TouchWrapper',
            position: 'absolute',
            width: '100vw',
            height: '100vh',
            onPress: [media('pause', { when: '${!paused}' }), media('play', { when: '${paused}' })],
          },
          // Paused overlay: title + seek buttons.
          {
            type: 'Container',
            position: 'absolute',
            width: '100vw',
            height: '100vh',
            opacity: '${paused ? 1 : 0}',
            display: '${paused ? "normal" : "invisible"}',
            justifyContent: 'spaceBetween',
            items: [
              {
                type: 'Container', direction: 'row', alignItems: 'center', paddingLeft: '4vw', paddingTop: '4vh', paddingRight: '5vw', backgroundColor: 'rgba(0,0,0,0.45)', paddingBottom: '3vh',
                items: [
                  backButton(),
                  {
                    type: 'Container', grow: 1, shrink: 1, paddingLeft: '2vw',
                    items: [
                      { type: 'Text', text: title, fontSize: '5vh', color: '#ffffff', fontWeight: 'bold', maxLines: 1 },
                      { type: 'Text', text: subtitle, fontSize: '3.4vh', color: '#c9ced8', maxLines: 1 },
                    ],
                  },
                ],
              },
              {
                type: 'Container', direction: 'row', justifyContent: 'center', paddingBottom: '7vh',
                items: [
                  button('« 10s', [media('seek', { value: -10000 })]),
                  button('Play', [media('play')]),
                  button('30s »', [media('seek', { value: 30000 })]),
                  // Episodes: skip to the next one (saves this position first).
                  ...(hasNext ? [button('Next episode ›', [send('next', '${pos}')])] : []),
                ],
              },
            ],
          },
        ],
      }],
    },
  };
}

/** ExecuteCommands directive targeting the player (voice transport). */
function controlDirective(command, extra = {}) {
  return { type: 'Alexa.Presentation.APL.ExecuteCommands', token: TOKEN, commands: [media(command, extra)] };
}

module.exports = { TOKEN, PLAYER_ID, PROGRESS_SECONDS, IDLE_TIMEOUT_MS, playerDocument, controlDirective };
