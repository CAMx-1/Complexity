'use strict';
// APL documents for the Plex link flow. Sized in viewport units so they scale
// from Echo Show 5 up to the Echo Show 11 (1920×1200).

const APL_VERSION = '2023.3';
const TOKEN = { link: 'linkScreen', status: 'statusScreen' };

const { BG, ACCENT, graphics, logo } = require('./ui');

const frame = (items) => ({
  type: 'Container',
  width: '100vw',
  height: '100vh',
  direction: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  paddingLeft: '6vw',
  paddingRight: '6vw',
  items: [{ type: 'Frame', position: 'absolute', width: '100vw', height: '100vh', backgroundColor: BG }, ...items],
});

const text = (t, { size = '4vh', color = '#c9ced8', weight = 'normal', top = 0, align = 'center' } = {}) => ({
  type: 'Text', text: t, fontSize: size, color, fontWeight: weight, textAlign: align, paddingTop: top, maxLines: 3,
});

/**
 * Link screen: the PIN in large type plus instructions. While mounted, it
 * sends a `pollLink` UserEvent every `pollSeconds`, so the skill notices the
 * link without the user saying anything.
 */
function linkDocument({ code, pollSeconds = 5, maxPolls = 150 }) {
  const spaced = code.split('').join(' ');
  return {
    type: 'APL',
    version: APL_VERSION,
    theme: 'dark',
    graphics,
    onMount: [{
      type: 'Sequential',
      repeatCount: maxPolls,
      commands: [{ type: 'Idle', delay: pollSeconds * 1000 }, { type: 'SendEvent', arguments: ['pollLink'] }],
    }],
    mainTemplate: {
      parameters: [],
      items: [frame([
        logo('12vh'),
        text('Link your Plex account', { size: '5vh', color: '#ffffff', weight: 'bold' }),
        text('On your phone or computer, go to', { top: '4vh' }),
        text('plex.tv/link', { size: '6vh', color: ACCENT, weight: 'bold', top: '1vh' }),
        text('and enter this code', { top: '3vh' }),
        text(spaced, { size: '16vh', color: '#ffffff', weight: 'bold', top: '1vh' }),
        text('This screen updates automatically once you have entered the code.', { size: '3vh', color: '#7d8494', top: '4vh' }),
      ])],
    },
  };
}

/** Generic status screen (linked, choose server, problem…). */
function statusDocument({ title, lines = [], hint }) {
  return {
    type: 'APL',
    version: APL_VERSION,
    theme: 'dark',
    graphics,
    mainTemplate: {
      parameters: [],
      items: [frame([
        logo('14vh'),
        text(title, { size: '6vh', color: '#ffffff', weight: 'bold' }),
        ...lines.map((l, i) => text(l, { size: '4.5vh', top: i === 0 ? '4vh' : '1.5vh' })),
        ...(hint ? [text(hint, { size: '3.2vh', color: ACCENT, top: '5vh' })] : []),
      ])],
    },
  };
}

module.exports = { APL_VERSION, TOKEN, linkDocument, statusDocument };
