'use strict';
// Alexa-hosted skills currently run on nodejs16.x, which has no global fetch.
// This is the small subset of fetch that plexRequest uses (method, headers,
// body, timeout → { ok, status, text() }), built on node:https.

const https = require('node:https');
const http = require('node:http');

function nodeFetch(url, { method = 'GET', headers = {}, body, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => text });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Native fetch when available (Node 18+), otherwise the https fallback. */
const defaultFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : nodeFetch;

module.exports = { nodeFetch, defaultFetch };
