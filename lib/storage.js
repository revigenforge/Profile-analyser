// Stores creator connection requests.
// Production (Vercel): appends a row to a Google Sheet through an Apps Script
// web app (see google-sheets/Code.gs). Local dev without that configured:
// appends to data/connections.jsonl.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(here, '..', 'data');

export class StorageError extends Error {}

export function sheetsConfigured() {
  return Boolean(process.env.GOOGLE_SHEETS_WEBHOOK_URL && process.env.GOOGLE_SHEETS_SECRET);
}

async function appendToSheet(entry) {
  // Apps Script reads the body only (no custom headers), so the secret travels in it.
  // Apps Script answers with a 302 to googleusercontent.com; fetch follows it as a GET.
  const res = await fetch(process.env.GOOGLE_SHEETS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret: process.env.GOOGLE_SHEETS_SECRET, entry }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new StorageError(`Google Sheet webhook returned non-JSON (HTTP ${res.status}). Check the Apps Script deployment access is "Anyone".`);
  }
  if (!res.ok || !body.ok) {
    throw new StorageError(`Google Sheet webhook rejected the row: ${body.error ?? `HTTP ${res.status}`}`);
  }
}

export async function saveConnection(entry) {
  if (sheetsConfigured()) return appendToSheet(entry);
  if (process.env.VERCEL) {
    // Vercel's filesystem is not persistent — refuse rather than silently lose sign-ups.
    throw new StorageError('GOOGLE_SHEETS_WEBHOOK_URL and GOOGLE_SHEETS_SECRET must be set on Vercel.');
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(path.join(DATA_DIR, 'connections.jsonl'), `${JSON.stringify(entry)}\n`);
}
