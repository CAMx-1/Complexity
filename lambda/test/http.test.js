'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { nodeFetch } = require('../src/http');

test('nodeFetch (Node 16 fallback): method, headers, body, status, timeout', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/slow') return; // never answers
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(req.url === '/missing' ? 404 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, token: req.headers['x-plex-token'], body }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const ok = await nodeFetch(`${base}/x`, { method: 'POST', headers: { 'X-Plex-Token': 't1', 'Content-Type': 'application/json' }, body: '{"a":1}' });
    assert.equal(ok.ok, true);
    assert.deepEqual(JSON.parse(await ok.text()), { method: 'POST', token: 't1', body: '{"a":1}' });
    const nf = await nodeFetch(`${base}/missing`);
    assert.equal(nf.ok, false);
    assert.equal(nf.status, 404);
    await assert.rejects(nodeFetch(`${base}/slow`, { timeoutMs: 200 }), /timeout/);
  } finally {
    srv.closeAllConnections && srv.closeAllConnections();
    srv.close();
  }
});
