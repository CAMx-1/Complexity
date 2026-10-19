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

// Uses AWS SDK v3 when installed (Node 20+ runtimes), otherwise the AWS SDK v2
// that the Lambda nodejs16.x runtime ships with (Alexa-hosted today).
function dynamoStore({ tableName, region }) {
  let v3 = null;
  try { v3 = { ...require('@aws-sdk/client-dynamodb'), ...require('@aws-sdk/lib-dynamodb') }; } catch { v3 = null; }
  let get; let put; let del;
  if (v3) {
    const doc = v3.DynamoDBDocumentClient.from(new v3.DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
    get = (p) => doc.send(new v3.GetCommand(p));
    put = (p) => doc.send(new v3.PutCommand(p));
    del = (p) => doc.send(new v3.DeleteCommand(p));
  } else {
    const AWS = require('aws-sdk'); // provided by the nodejs16.x Lambda runtime
    const doc = new AWS.DynamoDB.DocumentClient({ region, convertEmptyValues: true });
    get = (p) => doc.get(p).promise();
    put = (p) => doc.put(p).promise();
    del = (p) => doc.delete(p).promise();
  }
  // Store the record as a JSON string: avoids DynamoDB marshalling quirks
  // (empty strings, nulls, nested arrays) across both SDKs.
  return {
    kind: v3 ? 'dynamodb-v3' : 'dynamodb-v2',
    async get(id) {
      const out = await get({ TableName: tableName, Key: { id } });
      const raw = out.Item && out.Item.rec;
      if (!raw) return {};
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    },
    async put(id, rec) { await put({ TableName: tableName, Item: { id, rec: JSON.stringify(rec), updatedAt: Date.now() } }); },
    async delete(id) { await del({ TableName: tableName, Key: { id } }); },
  };
}

function storeFromEnv(env = process.env) {
  return env.DYNAMODB_PERSISTENCE_TABLE_NAME
    ? dynamoStore({ tableName: env.DYNAMODB_PERSISTENCE_TABLE_NAME, region: env.DYNAMODB_PERSISTENCE_REGION })
    : memoryStore();
}

module.exports = { memoryStore, dynamoStore, storeFromEnv };
