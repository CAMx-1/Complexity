'use strict';
// Alexa-hosted entry point (lambda/index.js → exports.handler).

const Alexa = require('ask-sdk-core');
const { requestHandlers, ErrorHandler } = require('./src/handlers');
const { storeFromEnv } = require('./src/store');
const { defaultFetch } = require('./src/http');

/**
 * Build the skill. `store` and `fetchImpl` are injectable for tests.
 * `skillId` pins requests to this skill when set (SKILL_ID env, or the value
 * from skill-package once the skill exists).
 */
function buildSkill({ store = storeFromEnv(), fetchImpl = defaultFetch, skillId = process.env.SKILL_ID } = {}) {
  const LoadRecord = {
    async process(h) {
      const userId = Alexa.getUserId(h.requestEnvelope);
      const rec = await store.get(userId);
      const attrs = h.attributesManager.getRequestAttributes();
      attrs.rec = rec;
      attrs.fetch = fetchImpl;
      attrs.userId = userId;
      attrs.recSnapshot = JSON.stringify(rec);
    },
  };

  const SaveRecord = {
    async process(h) {
      const attrs = h.attributesManager.getRequestAttributes();
      if (!attrs.userId) return;
      if (attrs.deleteRecord || (attrs.rec && Object.keys(attrs.rec).length === 0 && attrs.recSnapshot !== '{}')) {
        await store.delete(attrs.userId);
      } else if (JSON.stringify(attrs.rec) !== attrs.recSnapshot) {
        await store.put(attrs.userId, attrs.rec);
      }
    },
  };

  const builder = Alexa.SkillBuilders.custom()
    .addRequestHandlers(...requestHandlers)
    .addErrorHandlers(ErrorHandler)
    .addRequestInterceptors(LoadRecord)
    .addResponseInterceptors(SaveRecord)
    .withCustomUserAgent('complexity/0.1.0');
  if (skillId) builder.withSkillId(skillId);
  return builder.create();
}

let skill;
exports.handler = async (event, context) => {
  if (!skill) skill = buildSkill();
  return skill.invoke(event, context);
};
exports.buildSkill = buildSkill;
