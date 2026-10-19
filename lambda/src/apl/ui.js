'use strict';
// Shared APL building blocks: the Complexity logo (vector, no image hosting
// needed) and touch-friendly buttons and tiles that send UserEvents.

const BG = '#0f1117';
const ACCENT = '#e5a00d';

/** Hexagon "play" mark. Use with { type: 'VectorGraphic', source: 'logo' }. */
const LOGO = {
  type: 'AVG',
  version: '1.2',
  width: 100,
  height: 100,
  items: [
    { type: 'path', pathData: 'M50,3 L91,26.5 L91,73.5 L50,97 L9,73.5 L9,26.5 Z', fill: ACCENT },
    { type: 'path', pathData: 'M50,13 L82,31.5 L82,68.5 L50,87 L18,68.5 L18,31.5 Z', fill: BG },
    { type: 'path', pathData: 'M41,33 L69,50 L41,67 Z', fill: ACCENT },
  ],
};
const graphics = { logo: LOGO };

const logo = (size = '14vh') => ({ type: 'VectorGraphic', source: 'logo', width: size, height: size, scale: 'best-fit' });

/** Pill button. `args` are the UserEvent arguments. */
function button(label, args, { primary = false, id } = {}) {
  return {
    type: 'TouchWrapper',
    ...(id ? { id } : {}),
    onPress: [{ type: 'SendEvent', arguments: args }],
    item: {
      type: 'Frame',
      backgroundColor: primary ? ACCENT : 'rgba(255,255,255,0.12)',
      borderRadius: '5vh',
      paddingLeft: '3vw', paddingRight: '3vw', paddingTop: '1.8vh', paddingBottom: '1.8vh',
      marginRight: '1.5vw', marginTop: '1.5vh',
      item: { type: 'Text', text: label, fontSize: '3.6vh', fontWeight: 'bold', color: primary ? BG : '#ffffff', textAlign: 'center' },
    },
  };
}

/** Poster tile with a caption; tap sends `args`. */
function posterTile({ image, title, caption = '', args, progress }) {
  return {
    type: 'TouchWrapper',
    onPress: [{ type: 'SendEvent', arguments: args }],
    item: {
      type: 'Container',
      width: '17vw',
      marginRight: '2vw',
      items: [
        image
          ? { type: 'Image', source: image, width: '17vw', height: '25.5vw', scale: 'best-fill', borderRadius: '1vh' }
          : { type: 'Frame', width: '17vw', height: '25.5vw', borderRadius: '1vh', backgroundColor: '#22263a', item: { type: 'Text', text: title, color: '#c9ced8', fontSize: '3vh', textAlign: 'center', paddingTop: '8vh' } },
        ...(progress > 0 ? [{
          type: 'Frame', width: '17vw', height: '0.8vh', backgroundColor: 'rgba(255,255,255,0.2)',
          item: { type: 'Frame', width: `${Math.min(100, Math.round(progress * 100))}%`, height: '0.8vh', backgroundColor: ACCENT },
        }] : []),
        { type: 'Text', text: title, fontSize: '3vh', color: '#ffffff', fontWeight: 'bold', maxLines: 1, paddingTop: '1vh' },
        { type: 'Text', text: caption, fontSize: '2.6vh', color: '#9aa1b2', maxLines: 1 },
      ],
    },
  };
}

/** "‹ Back" pill: saves the position, stops the stream, returns to the home screen. */
function backButton() {
  return {
    type: 'TouchWrapper',
    onPress: [{ type: 'SendEvent', arguments: ['nav', 'home'] }],
    item: {
      type: 'Frame', backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: '5vh', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)',
      paddingLeft: '2.4vw', paddingRight: '2.6vw', paddingTop: '1.4vh', paddingBottom: '1.4vh',
      item: { type: 'Text', text: '‹  Back', fontSize: '3.6vh', fontWeight: 'bold', color: '#ffffff' },
    },
  };
}

module.exports = { BG, ACCENT, LOGO, graphics, logo, button, posterTile, backButton };
