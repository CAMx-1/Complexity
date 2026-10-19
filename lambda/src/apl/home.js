'use strict';
// Home screen (shown whenever the skill is open and idle) and the touch
// server picker.
//
// UserEvents:
//   ['home', 'play', ratingKey]       tap a Continue Watching tile
//   ['home', 'servers']               open the server picker
//   ['home', 'help']                  spoken help
//   ['server', 'select', machineId]   pick a server

const { APL_VERSION } = require('./link');
const { BG, ACCENT, graphics, logo, button, posterTile } = require('./ui');

const TOKEN = { home: 'home', servers: 'servers' };

const screen = (items) => ({
  type: 'Container',
  width: '100vw',
  height: '100vh',
  items: [{ type: 'Frame', position: 'absolute', width: '100vw', height: '100vh', backgroundColor: BG }, ...items],
});

/**
 * @param {{ serverName: string, username?: string, multipleServers?: boolean,
 *           onDeck?: Array<{ ratingKey, title, caption, image, progress }> }} p
 */
function homeDocument({ serverName, username, multipleServers = false, onDeck = [] }) {
  const header = {
    type: 'Container',
    direction: 'row',
    alignItems: 'center',
    paddingLeft: '5vw', paddingRight: '5vw', paddingTop: '5vh',
    items: [
      logo('11vh'),
      {
        type: 'Container', paddingLeft: '2vw', grow: 1,
        items: [
          { type: 'Text', text: 'Complexity Player', fontSize: '5.5vh', fontWeight: 'bold', color: '#ffffff' },
          { type: 'Text', text: `Connected to ${serverName}${username ? ` · ${username}` : ''}`, fontSize: '3vh', color: '#9aa1b2', maxLines: 1 },
        ],
      },
      ...(multipleServers ? [button('Switch server', ['home', 'servers'])] : []),
    ],
  };
  const hint = {
    type: 'Container', paddingLeft: '5vw', paddingRight: '5vw', paddingTop: '3vh',
    items: [
      { type: 'Text', text: 'Ready to watch. Try saying:', fontSize: '3.2vh', color: '#c9ced8' },
      { type: 'Text', text: '“Play The Bear” · “Play the movie Dune” · “Continue watching”', fontSize: '3.8vh', color: ACCENT, fontWeight: 'bold', maxLines: 2, paddingTop: '0.6vh' },
    ],
  };
  const row = onDeck.length ? [
    { type: 'Text', text: 'Continue watching', fontSize: '3.6vh', fontWeight: 'bold', color: '#ffffff', paddingLeft: '5vw', paddingTop: '4vh', paddingBottom: '1.5vh' },
    {
      type: 'Sequence',
      scrollDirection: 'horizontal',
      width: '100vw',
      height: '46vw',
      paddingLeft: '5vw',
      data: onDeck,
      items: [posterTile({ image: '${data.image}', title: '${data.title}', caption: '${data.caption}', args: ['home', 'play', '${data.ratingKey}'] })],
    },
  ] : [
    { type: 'Text', text: 'Nothing in progress. Ask for any movie or show on your server.', fontSize: '3.2vh', color: '#9aa1b2', paddingLeft: '5vw', paddingTop: '5vh' },
  ];
  return {
    type: 'APL',
    version: APL_VERSION,
    theme: 'dark',
    graphics,
    mainTemplate: { parameters: [], items: [screen([{ type: 'ScrollView', width: '100vw', height: '100vh', item: { type: 'Container', items: [header, hint, ...row] } }])] },
  };
}

/**
 * Touch list of servers. `choices`: [{ name, clientIdentifier, owned }].
 * `currentId` highlights the server in use.
 */
function serverPickerDocument({ choices, currentId, title = 'Choose a Plex server' }) {
  const rowItem = {
    type: 'TouchWrapper',
    onPress: [{ type: 'SendEvent', arguments: ['server', 'select', '${data.id}'] }],
    item: {
      type: 'Frame',
      backgroundColor: "${data.current ? 'rgba(229,160,13,0.22)' : 'rgba(255,255,255,0.08)'}",
      borderRadius: '1.5vh',
      borderWidth: "${data.current ? 2 : 0}",
      borderColor: ACCENT,
      marginBottom: '1.6vh',
      item: {
        type: 'Container', direction: 'row', alignItems: 'center', paddingLeft: '3vw', paddingRight: '3vw', paddingTop: '2.4vh', paddingBottom: '2.4vh',
        items: [
          { type: 'Text', text: '${data.number}', fontSize: '4vh', color: ACCENT, fontWeight: 'bold', width: '6vw' },
          {
            type: 'Container', grow: 1, shrink: 1,
            items: [
              { type: 'Text', text: '${data.name}', fontSize: '4.2vh', color: '#ffffff', fontWeight: 'bold', maxLines: 1 },
              { type: 'Text', text: '${data.caption}', fontSize: '2.8vh', color: '#9aa1b2', maxLines: 1 },
            ],
          },
          { type: 'Text', text: "${data.current ? 'In use' : 'Tap to use'}", fontSize: '2.8vh', color: '#c9ced8' },
        ],
      },
    },
  };
  const data = choices.map((c, i) => ({
    id: c.clientIdentifier,
    number: String(i + 1),
    name: c.name,
    caption: c.owned ? 'Your server' : 'Shared with you',
    current: c.clientIdentifier === currentId,
  }));
  return {
    type: 'APL',
    version: APL_VERSION,
    theme: 'dark',
    graphics,
    mainTemplate: {
      parameters: [],
      items: [screen([{
        type: 'Container', width: '100vw', height: '100vh', paddingLeft: '6vw', paddingRight: '6vw', paddingTop: '5vh',
        items: [
          { type: 'Container', direction: 'row', alignItems: 'center', items: [logo('9vh'), { type: 'Text', text: title, fontSize: '5vh', fontWeight: 'bold', color: '#ffffff', paddingLeft: '2vw' }] },
          { type: 'Text', text: 'Tap a server, or say its name or number.', fontSize: '3vh', color: '#9aa1b2', paddingTop: '1vh', paddingBottom: '2.5vh' },
          { type: 'Sequence', grow: 1, data, items: [rowItem] },
        ],
      }])],
    },
  };
}

module.exports = { TOKEN, homeDocument, serverPickerDocument };
