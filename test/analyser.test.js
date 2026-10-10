import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform } from '../lib/platforms.js';
import { parseCount, extractProfile } from '../lib/scraper.js';
import { analyzeProfile, engagementRate, audienceTier } from '../lib/analyzer.js';

test('detectPlatform recognises common profile URLs', () => {
  assert.deepEqual(
    [detectPlatform('instagram.com/revigenforge/').platform, detectPlatform('instagram.com/revigenforge/').handle],
    ['instagram', 'revigenforge'],
  );
  assert.equal(detectPlatform('https://www.youtube.com/@MrBeast').handle, 'MrBeast');
  assert.equal(detectPlatform('https://www.tiktok.com/@creator?lang=en').handle, 'creator');
  assert.equal(detectPlatform('https://twitter.com/jack').platform, 'x');
  assert.equal(detectPlatform('https://www.linkedin.com/in/jane-doe/').handle, 'jane-doe');
  assert.equal(detectPlatform('https://instagram.com/p/abc123').handle, null);
  assert.equal(detectPlatform('https://linktr.ee/someone').platform, 'other');
  assert.equal(detectPlatform('not a url'), null);
});

test('parseCount handles abbreviations and separators', () => {
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('12.4K'), 12400);
  assert.equal(parseCount('1.2M'), 1200000);
  assert.equal(parseCount('3 B'), 3000000000);
  assert.equal(parseCount('987'), 987);
  assert.equal(parseCount('n/a'), null);
});

test('extractProfile reads Instagram meta description', () => {
  const html = `<html><head>
    <meta property="og:title" content="Jane Doe (@janedoe) • Instagram photos and videos">
    <meta property="og:description" content="12.5K Followers, 340 Following, 210 Posts - See Instagram photos and videos from Jane Doe (@janedoe)">
  </head></html>`;
  const { profile } = extractProfile(html, 'instagram');
  assert.equal(profile.followers, 12500);
  assert.equal(profile.following, 340);
  assert.equal(profile.posts, 210);
  assert.equal(profile.displayName, 'Jane Doe');
});

test('extractProfile reads TikTok embedded stats', () => {
  const html = '<script>{"nickname":"Chef Sam","signature":"Quick recipes \\ud83c\\udf73","followerCount":48200,"followingCount":12,"heartCount":1500000,"videoCount":320}</script>';
  const { profile } = extractProfile(html, 'tiktok');
  assert.equal(profile.followers, 48200);
  assert.equal(profile.posts, 320);
  assert.equal(profile.totalLikes, 1500000);
  assert.equal(profile.displayName, 'Chef Sam');
  assert.match(profile.bio, /Quick recipes/);
});

test('extractProfile reads YouTube subscriber text', () => {
  const html = '<meta property="og:title" content="Tech Tom"><script>"subscriberCountText":{"simpleText":"1.23M subscribers"},"videosCountText":{"runs":[{"text":"845 videos"}]}</script>';
  const { profile } = extractProfile(html, 'youtube');
  assert.equal(profile.followers, 1230000);
  assert.equal(profile.posts, 845);
});

test('engagement rate and tiers', () => {
  assert.equal(engagementRate({ platform: 'instagram', followers: 10000, avgLikes: 280, avgComments: 20 }), 3);
  assert.equal(engagementRate({ platform: 'instagram', followers: 10000 }), null);
  assert.equal(audienceTier(42_000).key, 'micro');
  assert.equal(audienceTier(null), null);
});

test('analyzeProfile produces a full report from rich data', () => {
  const report = analyzeProfile({
    platform: 'instagram',
    handle: 'janedoe',
    displayName: 'Jane | Fitness Coach',
    bio: 'Helping busy mums get strong 💪 DM "PLAN" for coaching · collab: jane@example.com',
    niche: 'fitness',
    website: 'https://jane.fit',
    followers: '24500',
    following: '410',
    posts: '320',
    avgLikes: '980',
    avgComments: '64',
    postsPerWeek: '4',
  });
  assert.ok(report.overall >= 70, `expected strong score, got ${report.overall}`);
  assert.equal(report.confidence, 100);
  assert.equal(report.tier.key, 'micro');
  assert.ok(report.profileChecks.every((c) => c.ok));
  assert.ok(report.strengths.length > 0);
  assert.equal(report.revigenforge.length, 3);
});

test('analyzeProfile copes with sparse data and recommends fixes', () => {
  const report = analyzeProfile({ platform: 'tiktok', followers: 800 });
  assert.equal(typeof report.overall, 'number');
  assert.ok(report.confidence < 50);
  assert.ok(report.recommendations.some((r) => r.area === 'engagement'));
  assert.equal(analyzeProfile({}).overall, null);
});
