'use strict';
// Loading screen shown while the stream warms up. It ticks the skill with
// ['load', 'tick']; the skill answers with SetValue commands that move the bar
// and schedule the next tick, then swaps in the player when the stream is ready.
//
// Why the reply schedules the next tick: an ExecuteCommands directive cancels
// whatever is running on the screen's main command sequence, including an
// onMount repeat loop. Seen on an Echo Show 11: only the first tick arrived.

const { APL_VERSION } = require('./link');
const { backButton } = require('./ui');

const TOKEN = 'loading';
const ROOT_ID = 'loadRoot';
const TICK_MS = 3500;
const FIRST_TICK_MS = 1500;

const nextTick = (delay = TICK_MS) => [{ type: 'Idle', delay }, { type: 'SendEvent', arguments: ['load', 'tick'] }];

const ACCENT = '#e5a00d';

function loadingDocument({ title, subtitle = '', posterUrl, artUrl, pct = 3, label = 'Loading…' }) {
  return {
    type: 'APL',
    version: APL_VERSION,
    theme: 'dark',
    settings: { idleTimeout: 180_000 }, // the warm-up may take up to 90 s; default is ~30 s
    onMount: nextTick(FIRST_TICK_MS),
    mainTemplate: {
      parameters: [],
      items: [{
        type: 'Container',
        id: ROOT_ID,
        width: '100vw',
        height: '100vh',
        bind: [{ name: 'pct', value: pct, type: 'number' }, { name: 'label', value: label, type: 'string' }],
        items: [
          { type: 'Frame', position: 'absolute', width: '100vw', height: '100vh', backgroundColor: '#0f1117' },
          ...(artUrl ? [{ type: 'Image', position: 'absolute', width: '100vw', height: '100vh', source: artUrl, scale: 'best-fill', opacity: 0.25 }] : []),
          {
            type: 'Container',
            position: 'absolute',
            width: '100vw',
            height: '100vh',
            direction: 'row',
            alignItems: 'center',
            paddingLeft: '7vw',
            paddingRight: '7vw',
            items: [
              ...(posterUrl ? [{ type: 'Image', source: posterUrl, width: '26vw', height: '58vh', scale: 'best-fit', borderRadius: '1.2vh' }] : []),
              {
                type: 'Container',
                grow: 1,
                shrink: 1,
                paddingLeft: posterUrl ? '5vw' : 0,
                items: [
                  { type: 'Text', text: title, fontSize: '6.5vh', color: '#ffffff', fontWeight: 'bold', maxLines: 2 },
                  { type: 'Text', text: subtitle, fontSize: '3.8vh', color: '#c9ced8', maxLines: 2, paddingTop: '1vh' },
                  {
                    type: 'Frame',
                    width: '100%',
                    height: '1.6vh',
                    borderRadius: '0.8vh',
                    backgroundColor: 'rgba(255,255,255,0.15)',
                    marginTop: '6vh',
                    item: { type: 'Frame', width: '${pct}%', height: '1.6vh', borderRadius: '0.8vh', backgroundColor: ACCENT },
                  },
                  {
                    type: 'Container', direction: 'row', justifyContent: 'spaceBetween', paddingTop: '1.6vh',
                    items: [
                      { type: 'Text', text: '${label}', fontSize: '3.4vh', color: '#c9ced8' },
                      { type: 'Text', text: '${pct}%', fontSize: '3.4vh', color: '#ffffff', fontWeight: 'bold' },
                    ],
                  },
                ],
              },
            ],
          },
          // Drawn last so it sits above the content and receives taps.
          { type: 'Container', position: 'absolute', left: '4vw', top: '4vh', items: [backButton()] },
        ],
      }],
    },
  };
}

/** ExecuteCommands that move the bar without re-rendering. */
function progressDirective(pct, label) {
  return {
    type: 'Alexa.Presentation.APL.ExecuteCommands',
    token: TOKEN,
    commands: [
      { type: 'SetValue', componentId: ROOT_ID, property: 'pct', value: pct },
      { type: 'SetValue', componentId: ROOT_ID, property: 'label', value: label },
      ...nextTick(),
    ],
  };
}

module.exports = { TOKEN, TICK_MS, FIRST_TICK_MS, loadingDocument, progressDirective };
