import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveConnection, StorageError } from '../lib/storage.js';

const ENV_KEYS = ['GOOGLE_SHEETS_WEBHOOK_URL', 'GOOGLE_SHEETS_SECRET', 'VERCEL', 'DATA_DIR'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const entry = { name: 'Jane', email: 'jane@example.com', handle: '@jane', createdAt: '2026-10-10T00:00:00Z' };

test('refuses to drop sign-ups on Vercel when the sheet is not configured', async () => {
  delete process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  process.env.VERCEL = '1';
  await assert.rejects(saveConnection(entry), StorageError);
});

test('posts to the Apps Script webhook and follows its redirect', async () => {
  let received;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/exec') {
        received = JSON.parse(body);
        // Apps Script replies with a 302 to a content URL that serves the result.
        res.writeHead(302, { Location: '/result' });
        return res.end();
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.method === 'GET' && req.url === '/result' ? { ok: true } : { ok: false }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  try {
    process.env.GOOGLE_SHEETS_WEBHOOK_URL = `http://127.0.0.1:${server.address().port}/exec`;
    process.env.GOOGLE_SHEETS_SECRET = 's3cret';
    await saveConnection(entry);
    assert.equal(received.secret, 's3cret');
    assert.equal(received.entry.email, 'jane@example.com');
  } finally {
    server.close();
  }
});

test('surfaces webhook rejections', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'unauthorised' }));
  });
  await new Promise((r) => server.listen(0, r));
  try {
    process.env.GOOGLE_SHEETS_WEBHOOK_URL = `http://127.0.0.1:${server.address().port}/exec`;
    process.env.GOOGLE_SHEETS_SECRET = 'wrong';
    await assert.rejects(saveConnection(entry), /unauthorised/);
  } finally {
    server.close();
  }
});

test('falls back to a local file in development', async () => {
  delete process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  delete process.env.VERCEL;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rf-'));
  process.env.DATA_DIR = dir;
  // DATA_DIR is read at import time, so re-import a fresh copy of the module.
  const { saveConnection: save } = await import(`../lib/storage.js?fresh=${Date.now()}`);
  await save(entry);
  const lines = (await fs.readFile(path.join(dir, 'connections.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(JSON.parse(lines[0]).email, 'jane@example.com');
  await fs.rm(dir, { recursive: true });
});
