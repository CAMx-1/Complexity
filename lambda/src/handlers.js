'use strict';
// Alexa handlers for the Plex sign-in path. The persisted user record is
// loaded by an interceptor into requestAttributes.rec and saved afterwards
// (see index.js).

const Alexa = require('ask-sdk-core');
const link = require('./link');
const apl = require('./apl/link');

const { STATUS } = link;
const LINK_URL = 'plex.tv/link';

const rec = (h) => h.attributesManager.getRequestAttributes().rec;
const fetchOf = (h) => h.attributesManager.getRequestAttributes().fetch;
const hasScreen = (h) => !!Alexa.getSupportedInterfaces(h.requestEnvelope)['Alexa.Presentation.APL'];
const spell = (code) => `<say-as interpret-as="spell-out">${code}</say-as>`;
const isIntent = (h, ...names) => Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
  && names.includes(Alexa.getIntentName(h.requestEnvelope));

function render(h, document, token) {
  if (hasScreen(h)) {
    h.responseBuilder.addDirective({ type: 'Alexa.Presentation.APL.RenderDocument', token, document });
  }
}

function choicesSpeech(choices) {
  const names = choices.map((c, i) => `${i + 1}, ${c.name}`);
  return `I found ${choices.length} Plex servers: ${names.join('; ')}. Which one should I use? You can say the name or the number.`;
}

/** Build the response that matches the record's current state. */
function respondForStatus(h, st, { justLinked = false, prefix = '' } = {}) {
  const r = rec(h);
  const rb = h.responseBuilder;
  // speak() replaces earlier speech, so callers pass any lead-in as `prefix`.
  const say = (t) => rb.speak(`${prefix}${t}`);
  const who = r.account && r.account.username ? ` as ${r.account.username}` : '';

  switch (st) {
    case STATUS.LINKING: {
      const { code } = r.pin;
      render(h, apl.linkDocument({ code }), apl.TOKEN.link);
      rb.withSimpleCard('Link your Plex account', `Go to https://${LINK_URL} and enter code ${code}`);
      if (hasScreen(h)) {
        // No reprompt: a reprompt closes the session when it times out, which
        // stops the screen's pollLink events. With shouldEndSession left
        // undefined, the session stays open while the link screen is shown.
        return say(`To link Plex, go to ${LINK_URL} on your phone or computer and enter the code ${spell(code)}. Again, that's ${spell(code)}. This screen will update when you are done.`)
          .getResponse();
      }
      return say(`To link Plex, go to ${LINK_URL} on your phone or computer and enter the code ${spell(code)}. Again, that's ${spell(code)}. Then say: I entered the code.`)
        .reprompt(`When you have entered the code ${spell(code)} at ${LINK_URL}, say: I entered the code.`)
        .getResponse();
    }
    case STATUS.CHOOSE_SERVER: {
      const lines = r.serverChoices.map((c, i) => `${i + 1}.  ${c.name}${c.owned ? '' : '  (shared)'}`);
      render(h, apl.statusDocument({ title: justLinked ? `Linked${who}` : 'Choose a Plex server', lines, hint: 'Say the server name or number' }), apl.TOKEN.status);
      const s = choicesSpeech(r.serverChoices);
      return say(`${justLinked ? `Your Plex account is linked${who}. ` : ''}${s}`).reprompt(s).getResponse();
    }
    case STATUS.NO_SERVER: {
      const name = r.unreachable && r.unreachable.name;
      const msg = name
        ? `I can see the server ${name}, but I couldn't reach it from the internet. In Plex, open Settings, Remote Access, and make sure it says fully accessible outside your network. Then open the skill again.`
        : `Your Plex account${who} doesn't have any servers I can use. Set up Plex Media Server, or ask the owner to share theirs, then open the skill again.`;
      render(h, apl.statusDocument({ title: name ? `Can't reach ${name}` : 'No Plex servers found', lines: [name ? 'Check Settings → Remote Access in Plex' : 'Sign in to a Plex Media Server first'] }), apl.TOKEN.status);
      return say(msg).withShouldEndSession(true).getResponse();
    }
    case STATUS.READY: {
      const s = r.server;
      render(h, apl.statusDocument({
        title: justLinked ? `Linked${who}` : 'Complexity',
        lines: [`Connected to ${s.name}`],
        hint: 'Try: "play The Bear" · "continue watching" · "play the movie Dune"',
      }), apl.TOKEN.status);
      const lead = justLinked ? `You're all set. Plex is linked${who}, and I'll use the server ${s.name}.` : `Connected to ${s.name}.`;
      return say(`${lead} What would you like to watch? You can say a movie or show, or continue watching.`)
        .reprompt('What would you like to do?')
        .getResponse();
    }
    default: // UNLINKED shouldn't reach here; callers start a link first
      return say('Something went wrong starting the Plex link. Please try again.').withShouldEndSession(true).getResponse();
  }
}

async function startOrResume(h) {
  const r = rec(h);
  let st = link.status(r);
  if (st === STATUS.UNLINKED) {
    const relink = r.relinkReason === 'token-upgrade';
    delete r.relinkReason;
    await link.startLink(fetchOf(h), r);
    if (relink) return respondForStatus(h, STATUS.LINKING, { prefix: 'I need you to link Plex once more, so I can talk to your server. ' });
    st = STATUS.LINKING;
  } else if (st === STATUS.LINKING) {
    st = await link.pollLink(fetchOf(h), r); // maybe they already entered it
    if (st === STATUS.UNLINKED) { await link.startLink(fetchOf(h), r); st = STATUS.LINKING; }
    else if (st !== STATUS.LINKING) return respondForStatus(h, st, { justLinked: true });
  } else if (st === STATUS.READY) {
    if (!(await link.ensureFreshToken(fetchOf(h), r))) return startOrResume(h);
  }
  return respondForStatus(h, st);
}

const LaunchHandler = {
  canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === 'LaunchRequest',
  handle: startOrResume,
};

const LinkAccountIntentHandler = {
  canHandle: (h) => isIntent(h, 'LinkAccountIntent'),
  async handle(h) {
    if (link.status(rec(h)) === STATUS.READY) {
      return h.responseBuilder.speak(`Plex is already linked and connected to ${rec(h).server.name}. To link a different account, say: unlink Plex.`).reprompt('What would you like to do?').getResponse();
    }
    return startOrResume(h);
  },
};

/** "I entered the code" — or the APL screen's periodic pollLink event. */
async function checkLink(h, { silentIfPending }) {
  const r = rec(h);
  if (link.status(r) !== STATUS.LINKING) {
    return silentIfPending ? h.responseBuilder.getResponse() : startOrResume(h);
  }
  const st = await link.pollLink(fetchOf(h), r);
  if (st === STATUS.LINKING) {
    if (silentIfPending) return h.responseBuilder.getResponse(); // keep the screen, say nothing
    return h.responseBuilder
      .speak(`I don't see it yet. Make sure you entered ${spell(r.pin.code)} at ${LINK_URL}, then tell me when you're done.`)
      .reprompt('Say: I entered the code, when you are done.')
      .getResponse();
  }
  if (st === STATUS.UNLINKED) { // PIN expired: issue a fresh one
    await link.startLink(fetchOf(h), r);
    return respondForStatus(h, STATUS.LINKING, { prefix: 'That code expired, so here is a new one. ' });
  }
  return respondForStatus(h, st, { justLinked: true });
}

const CheckLinkIntentHandler = {
  canHandle: (h) => isIntent(h, 'CheckLinkIntent'),
  handle: (h) => checkLink(h, { silentIfPending: false }),
};

const PollLinkEventHandler = {
  canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === 'Alexa.Presentation.APL.UserEvent'
    && (h.requestEnvelope.request.arguments || [])[0] === 'pollLink',
  handle: (h) => checkLink(h, { silentIfPending: true }),
};

const SelectServerIntentHandler = {
  canHandle: (h) => isIntent(h, 'SelectServerIntent'),
  async handle(h) {
    const r = rec(h);
    if (!r.token) return startOrResume(h);
    const slots = h.requestEnvelope.request.intent.slots || {};
    const name = slots.serverName && slots.serverName.value;
    const num = slots.serverNumber && Number.parseInt(slots.serverNumber.value, 10);
    const st = await link.selectServer(fetchOf(h), r, { name, index: Number.isInteger(num) ? num : undefined });
    if (st === null) {
      if (!r.serverChoices) await link.discoverServers(fetchOf(h), r);
      if (link.status(r) !== STATUS.CHOOSE_SERVER) return respondForStatus(h, link.status(r));
      return respondForStatus(h, STATUS.CHOOSE_SERVER, { prefix: `I couldn't find a server called ${name || 'that'}. ` });
    }
    return respondForStatus(h, st, { justLinked: false });
  },
};

const SwitchServerIntentHandler = {
  canHandle: (h) => isIntent(h, 'SwitchServerIntent'),
  async handle(h) {
    const r = rec(h);
    if (!r.token) return startOrResume(h);
    const st = await link.discoverServers(fetchOf(h), r);
    if (st === STATUS.READY) {
      return h.responseBuilder.speak(`You only have one server, ${r.server.name}, so I'll keep using it.`).reprompt('What would you like to do?').getResponse();
    }
    return respondForStatus(h, st);
  },
};

const LinkStatusIntentHandler = {
  canHandle: (h) => isIntent(h, 'LinkStatusIntent'),
  handle(h) {
    const r = rec(h);
    const st = link.status(r);
    if (st !== STATUS.READY) return startOrResume(h);
    const who = r.account && r.account.username ? ` as ${r.account.username}` : '';
    const via = r.server.viaRelay ? ' through Plex Relay, which is too slow for video, so check Remote Access' : '';
    return h.responseBuilder.speak(`You're signed in to Plex${who}, using the server ${r.server.name}${via}.`).reprompt('What would you like to do?').getResponse();
  },
};

const UnlinkIntentHandler = {
  canHandle: (h) => isIntent(h, 'UnlinkIntent'),
  handle(h) {
    const intent = h.requestEnvelope.request.intent;
    if (intent.confirmationStatus === 'DENIED') {
      return h.responseBuilder.speak('Okay, Plex stays linked.').reprompt('What would you like to do?').getResponse();
    }
    if (intent.confirmationStatus !== 'CONFIRMED') {
      return h.responseBuilder.addDelegateDirective(intent).getResponse(); // model asks "Are you sure…?"
    }
    link.unlink(rec(h));
    render(h, apl.statusDocument({ title: 'Plex unlinked', lines: ['Open the skill again to link an account'] }), apl.TOKEN.status);
    return h.responseBuilder
      .speak(`Done. I've removed your Plex sign-in from this skill. You can also remove Complexity from Authorized Devices in your Plex account settings.`)
      .withShouldEndSession(true)
      .getResponse();
  },
};

const HelpHandler = {
  canHandle: (h) => isIntent(h, 'AMAZON.HelpIntent'),
  handle(h) {
    const st = link.status(rec(h));
    if (st === STATUS.LINKING) return respondForStatus(h, st);
    return h.responseBuilder
      .speak('Complexity plays video from your Plex server. Try: play The Bear, play the movie Dune, play season 2 episode 3 of a show, or continue watching. While a video plays you can say pause, resume, skip forward 30 seconds, go back 10 seconds, next episode, or stop. You can also switch server or unlink Plex.')
      .reprompt('What would you like to do?')
      .getResponse();
  },
};

const StopHandler = {
  canHandle: (h) => isIntent(h, 'AMAZON.StopIntent', 'AMAZON.CancelIntent'),
  handle: (h) => h.responseBuilder.speak('Goodbye.').withShouldEndSession(true).getResponse(),
};

const FallbackHandler = {
  canHandle: (h) => isIntent(h, 'AMAZON.FallbackIntent'),
  handle: (h) => h.responseBuilder.speak("Sorry, I didn't get that. Say help to hear what I can do.").reprompt('What would you like to do?').getResponse(),
};

const SessionEndedHandler = {
  canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === 'SessionEndedRequest',
  handle: (h) => h.responseBuilder.getResponse(),
};

/** Skill disabled in the Alexa app: delete everything we stored for the user. */
const SkillDisabledHandler = {
  canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === 'AlexaSkillEvent.SkillDisabled',
  async handle(h) {
    link.unlink(rec(h));
    h.attributesManager.getRequestAttributes().deleteRecord = true;
    return h.responseBuilder.getResponse();
  },
};

/**
 * Short spoken reason. PlexError messages contain only the method, path and
 * HTTP status (never query strings or tokens); anything else is generic.
 */
function reasonFor(error) {
  if (!error) return '';
  if (error.name === 'PlexError' && error.status) {
    const m = /^Plex (\w+) (\S+) failed/.exec(error.message || '');
    const where = m ? m[2].split('/').filter(Boolean).slice(0, 2).join(' ') : 'the server';
    return `Plex answered ${error.status} for ${where}.`;
  }
  if (/timeout|aborted/i.test(error.message || '') || error.name === 'TimeoutError' || error.name === 'AbortError') return 'The server took too long to answer.';
  return 'The server could not be reached.';
}

const ErrorHandler = {
  canHandle: () => true,
  handle(h, error) {
    // Never log tokens: only the message and status.
    console.error('handler error:', error && error.message, error && error.status);
    return h.responseBuilder
      .speak(`Sorry, I couldn't talk to Plex just now. ${reasonFor(error)} Please try again in a moment.`)
      .withShouldEndSession(true)
      .getResponse();
  },
};

const { videoHandlers } = require('./videoHandlers');

const requestHandlers = [
  ...videoHandlers, // first: playback-specific Stop/SessionEnded take precedence
  LaunchHandler, LinkAccountIntentHandler, CheckLinkIntentHandler, PollLinkEventHandler,
  SelectServerIntentHandler, SwitchServerIntentHandler, LinkStatusIntentHandler, UnlinkIntentHandler,
  HelpHandler, StopHandler, FallbackHandler, SessionEndedHandler, SkillDisabledHandler,
];

module.exports = { requestHandlers, ErrorHandler, startOrResume };
