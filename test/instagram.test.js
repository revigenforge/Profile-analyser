import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchInstagramProfile, mapBusinessDiscovery, mapWebProfile, postsPerWeek } from '../lib/instagram.js';

const realFetch = globalThis.fetch;
const ENV = ['META_ACCESS_TOKEN', 'META_IG_USER_ID'];
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const day = 86_400_000;
const t0 = Date.parse('2026-10-01T12:00:00Z');

const businessDiscovery = {
  username: 'janedoe', name: 'Jane Doe', biography: 'Fitness coach', website: 'https://jane.fit',
  followers_count: 24500, follows_count: 410, media_count: 320,
  media: { data: [
    { like_count: 900, comments_count: 40, timestamp: new Date(t0).toISOString() },
    { like_count: 1100, comments_count: 60, timestamp: new Date(t0 - 2 * day).toISOString() },
    { comments_count: 50, timestamp: new Date(t0 - 4 * day).toISOString() }, // likes hidden
  ] },
};

test('postsPerWeek uses the span between posts', () => {
  assert.equal(postsPerWeek([t0, t0 - 7 * day, t0 - 14 * day]), 1);
  assert.equal(postsPerWeek([t0, t0 - day]), null); // too few posts
});

test('mapBusinessDiscovery computes averages and ignores hidden likes', () => {
  const p = mapBusinessDiscovery(businessDiscovery);
  assert.equal(p.followers, 24500);
  assert.equal(p.avgLikes, 1000);
  assert.equal(p.avgComments, 50);
  assert.equal(p.postsPerWeek, 3.5);
  assert.equal(p.website, 'https://jane.fit');
});

test('mapWebProfile reads the public profile shape', () => {
  const p = mapWebProfile({
    username: 'chef', full_name: 'Chef Sam', biography: 'Recipes', is_verified: true,
    edge_followed_by: { count: 48200 }, edge_follow: { count: 12 },
    edge_owner_to_timeline_media: { count: 300, edges: [
      { node: { edge_liked_by: { count: 2000 }, edge_media_to_comment: { count: 80 }, is_video: true, video_view_count: 30000, taken_at_timestamp: t0 / 1000 } },
      { node: { edge_liked_by: { count: 1000 }, edge_media_to_comment: { count: 20 }, is_video: false, taken_at_timestamp: (t0 - 3 * day) / 1000 } },
      { node: { edge_liked_by: { count: 1500 }, edge_media_to_comment: { count: 50 }, is_video: false, taken_at_timestamp: (t0 - 6 * day) / 1000 } },
    ] },
  });
  assert.equal(p.followers, 48200);
  assert.equal(p.avgLikes, 1500);
  assert.equal(p.avgViews, 30000);
  assert.equal(p.verified, true);
  assert.ok(p.postsPerWeek > 2);
});

test('prefers Business Discovery when configured', async () => {
  process.env.META_ACCESS_TOKEN = 'tok';
  process.env.META_IG_USER_ID = '1784';
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return json(200, { business_discovery: businessDiscovery, id: '1784' });
  };
  const result = await fetchInstagramProfile('janedoe');
  assert.equal(result.source, 'instagram-graph-api');
  assert.match(decodeURIComponent(calls[0]), /graph\.facebook\.com\/v\d+\.\d+\/1784\?fields=business_discovery\.username\(janedoe\)/);
  assert.equal(calls.length, 1);
});

test('falls back to the web endpoint, then gives up cleanly', async () => {
  process.env.META_ACCESS_TOKEN = 'tok';
  process.env.META_IG_USER_ID = '1784';
  globalThis.fetch = async (url) => (String(url).includes('graph.facebook.com')
    ? json(400, { error: { message: 'Invalid user id' } }) // e.g. personal account
    : json(200, { data: { user: { username: 'x', edge_followed_by: { count: 900 }, edge_owner_to_timeline_media: { count: 5, edges: [] } } } }));
  const ok = await fetchInstagramProfile('x');
  assert.equal(ok.source, 'instagram-web');
  assert.equal(ok.profile.followers, 900);

  globalThis.fetch = async () => json(401, { message: 'Please wait a few minutes' });
  const failed = await fetchInstagramProfile('x');
  assert.equal(failed.profile, null);
  assert.deepEqual(failed.attempts.map((a) => a.source), ['instagram-graph-api', 'instagram-web']);
  assert.match(failed.attempts[0].error, /Invalid user id|HTTP 401/);
  assert.equal((await fetchInstagramProfile('bad name!')).profile, null);
});

test('reports when the Meta API is not configured', async () => {
  delete process.env.META_ACCESS_TOKEN;
  globalThis.fetch = async () => json(429, {});
  const r = await fetchInstagramProfile('someone');
  assert.equal(r.profile, null);
  assert.match(r.attempts[0].error, /Not configured/);
  assert.match(r.attempts[1].error, /HTTP 429/);
});
