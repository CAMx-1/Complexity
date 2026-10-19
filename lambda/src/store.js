'use strict';
// Per-Alexa-user record storage.
// Alexa-hosted skills provide a DynamoDB table (partition key "id", string) and
// expose its name and region as DYNAMODB_PERSISTENCE_TABLE_NAME and
// DYNAMODB_PERSISTENCE_REGION. Without those variables (local runs and tests)
// an in-memory store is used. AWS encrypts the table at rest; on top of that,
// tokens are never logged.

function memoryStore() {
  const m = new Map();
  return {
    kind: 'memory',
    async get(id) { return m.has(id) ? JSON.parse(m.get(id)) : {}; },
    async put(id, rec) { m.set(id, JSON.stringify(rec)); },
    async delete(id) { m.delete(id); },
  };
}

function dynamoStore({ tableName, region }) {
  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
  return {
    kind: 'dynamodb',
    async get(id) {
      const out = await doc.send(new GetCommand({ TableName: tableName, Key: { id } }));
      return (out.Item && out.Item.rec) || {};
    },
    async put(id, rec) { await doc.send(new PutCommand({ TableName: tableName, Item: { id, rec, updatedAt: Date.now() } })); },
    async delete(id) { await doc.send(new DeleteCommand({ TableName: tableName, Key: { id } })); },
  };
}

function storeFromEnv(env = process.env) {
  return env.DYNAMODB_PERSISTENCE_TABLE_NAME
    ? dynamoStore({ tableName: env.DYNAMODB_PERSISTENCE_TABLE_NAME, region: env.DYNAMODB_PERSISTENCE_REGION })
    : memoryStore();
}

module.exports = { memoryStore, dynamoStore, storeFromEnv };
