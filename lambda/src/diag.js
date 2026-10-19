'use strict';
// Temporary field diagnostics. Keeps the last 40 request summaries in one
// store item (`__diag__`) so problems seen on a real Echo can be read back.
//
// What is recorded: request type, intent name, UserEvent arguments (tick/video
// event names, ratingKeys), APL runtime errors, handler error messages,
// durations, and the response shape (directive types, whether the session
// ends). Never tokens, URLs, or user/device IDs.
//
// Read back with SMAPI invoke-skill-end-point (developer-only) using a
// UserEvent whose arguments are ['__diag', 'dump']; the buffer comes back in
// sessionAttributes.

const KEY = '__diag__';
const MAX = 40;

const clip = (s, n = 160) => (s == null ? s : String(s).slice(0, n));

function summarizeRequest(env) {
  const r = (env && env.request) || {};
  const out = { type: r.type };
  if (r.intent) out.intent = r.intent.name;
  if (r.type === 'Alexa.Presentation.APL.UserEvent') out.args = (r.arguments || []).map((a) => clip(a, 40));
  if (r.type === 'Alexa.Presentation.APL.RuntimeError') out.aplErrors = (r.errors || []).map((e) => ({ type: e.type, reason: e.reason, message: clip(e.message, 240) }));
  if (r.type === 'SessionEndedRequest') out.ended = { reason: r.reason, error: r.error && { type: r.error.type, message: clip(r.error.message, 240) } };
  if (r.type === 'System.ExceptionEncountered') out.exception = { error: r.error && { type: r.error.type, message: clip(r.error.message, 240) }, cause: r.cause && r.cause.requestId ? 'see request' : undefined };
  const apl = env && env.context && env.context['Alexa.Presentation.APL'];
  if (apl) out.screen = apl.token;
  const vp = env && env.context && env.context.Viewport;
  if (vp) out.viewport = { w: vp.pixelWidth, h: vp.pixelHeight, dpi: vp.dpi, shape: vp.shape, apl: vp.presentationType };
  return out;
}

function summarizeResponse(res) {
  if (!res) return null;
  return {
    speech: clip(res.outputSpeech && res.outputSpeech.ssml, 90),
    directives: (res.directives || []).map((d) => `${d.type.split('.').pop()}:${d.token || ''}`),
    end: res.shouldEndSession,
  };
}

async function record(store, entry) {
  try {
    const cur = await store.get(KEY);
    const list = Array.isArray(cur.entries) ? cur.entries : [];
    list.push({ at: new Date().toISOString(), ...entry });
    await store.put(KEY, { entries: list.slice(-MAX) });
  } catch { /* diagnostics must never break the skill */ }
}

async function dump(store) {
  try { return (await store.get(KEY)).entries || []; } catch { return []; }
}

const isDumpRequest = (env) => {
  const r = env && env.request;
  return r && r.type === 'Alexa.Presentation.APL.UserEvent' && Array.isArray(r.arguments) && r.arguments[0] === '__diag';
};

module.exports = { record, dump, summarizeRequest, summarizeResponse, isDumpRequest, KEY };
