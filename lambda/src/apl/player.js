'use strict';
// Full-screen APL video player for Echo Show.
//
// Events sent to the skill (Alexa.Presentation.APL.UserEvent arguments):
//   ['video', 'playing'|'paused', currentTimeMs]   on play / pause
//   ['video', 'progress', currentTimeMs]           every PROGRESS_SECONDS while mounted
//   ['video', 'ended', currentTimeMs]              track finished
//   ['video', 'failed']                            stream could not be played
// The stream always starts at 0, and resume uses the source `offset`, so
// currentTime is the absolute position in the title.

const { APL_VERSION } = require('./link');

const TOKEN = 'player';
const PLAYER_ID = 'player';
const ROOT_ID = 'root';
const PROGRESS_SECONDS = 20;

const send = (...args) => ({ type: 'SendEvent', arguments: ['video', ...args] });
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
function playerDocument({ url, title, subtitle = '', offsetMs = 0 }) {
  return {
    type: 'APL',
    version: APL_VERSION,
    theme: 'dark',
    mainTemplate: {
      parameters: [],
      items: [{
        type: 'Container',
        id: ROOT_ID,
        width: '100vw',
        height: '100vh',
        bind: [{ name: 'pos', value: 0, type: 'number' }, { name: 'paused', value: false, type: 'boolean' }],
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
            source: [{ url, description: title, offset: Math.max(0, Math.round(offsetMs)) }],
            // The progress loop starts from onPlay: voice commands (ExecuteCommands)
            // cancel running sequences, and every resume fires onPlay again.
            onPlay: [
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
                type: 'Container', paddingLeft: '5vw', paddingTop: '5vh', paddingRight: '5vw', backgroundColor: 'rgba(0,0,0,0.45)', paddingBottom: '3vh',
                items: [
                  { type: 'Text', text: title, fontSize: '5vh', color: '#ffffff', fontWeight: 'bold', maxLines: 1 },
                  { type: 'Text', text: subtitle, fontSize: '3.4vh', color: '#c9ced8', maxLines: 1 },
                ],
              },
              {
                type: 'Container', direction: 'row', justifyContent: 'center', paddingBottom: '7vh',
                items: [
                  button('« 10s', [media('seek', { value: -10000 })]),
                  button('Play', [media('play')]),
                  button('30s »', [media('seek', { value: 30000 })]),
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

module.exports = { TOKEN, PLAYER_ID, PROGRESS_SECONDS, playerDocument, controlDirective };
