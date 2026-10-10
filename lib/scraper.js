// Fetches a public profile page and extracts whatever public metrics it exposes.
// Many platforms hide data behind login walls, so callers must expect partial
// results and fall back to screenshots / manual input.

import dns from 'node:dns/promises';
import net from 'node:net';
import * as cheerio from 'cheerio';
import { detectPlatform, normalizeUrl } from './platforms.js';
import { fetchInstagramProfile } from './instagram.js';

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 12_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export function parseCount(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : null;
  const match = String(raw).trim().replace(/\s/g, '').match(/^([\d.,]+)([KkMmBb])?/);
  if (!match) return null;
  let num = match[1];
  const suffix = match[2]?.toUpperCase();
  if (suffix) {
    num = Number(num.replace(/,/g, '.').replace(/\.(?=.*\.)/g, ''));
  } else {
    // "1,234" or "1.234" (thousand separators) → 1234
    num = Number(/^\d{1,3}([.,]\d{3})+$/.test(num) ? num.replace(/[.,]/g, '') : num.replace(/,/g, ''));
  }
  if (!Number.isFinite(num)) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[suffix] ?? 1;
  return Math.round(num * mult);
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

async function assertPublicHost(hostname) {
  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new ScrapeError('That address is not a public profile URL.', 'blocked_host');
  }
}

export class ScrapeError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function fetchHtml(startUrl) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url.hostname);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new ScrapeError('Unsupported redirect.', 'bad_redirect');
      continue;
    }
    if (!res.ok) {
      throw new ScrapeError(`The platform answered with HTTP ${res.status}.`, 'http_error');
    }
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
    return { html: Buffer.concat(chunks).toString('utf8'), finalUrl: url };
  }
  throw new ScrapeError('Too many redirects.', 'too_many_redirects');
}

const COUNT = '([\\d][\\d.,]*\\s?[KkMmBb]?)';

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) {
      const value = parseCount(m[1]);
      if (value !== null) return value;
    }
  }
  return null;
}

function readJsonLd($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      out.push(...(Array.isArray(data) ? data : [data]));
    } catch {
      /* ignore malformed blocks */
    }
  });
  return out;
}

function interactionCount(entity, type) {
  const stats = [entity?.interactionStatistic ?? entity?.mainEntity?.interactionStatistic].flat().filter(Boolean);
  const stat = stats.find((s) => String(s.interactionType?.['@type'] ?? s.interactionType ?? '').includes(type));
  return stat ? parseCount(stat.userInteractionCount) : null;
}

/** Extracts profile fields from raw HTML. Exported for tests. */
export function extractProfile(html, platform) {
  const $ = cheerio.load(html);
  const meta = (name) =>
    $(`meta[property="${name}"]`).attr('content') ?? $(`meta[name="${name}"]`).attr('content') ?? null;

  const ogTitle = meta('og:title') ?? $('title').first().text() ?? null;
  const ogDescription = meta('og:description') ?? meta('description');
  const text = `${ogDescription ?? ''}\n${html}`;

  const profile = {
    displayName: null,
    bio: null,
    avatarUrl: meta('og:image'),
    followers: null,
    following: null,
    posts: null,
    totalLikes: null,
    verified: /"is_verified":\s*true|"verified":\s*true/.test(html) || null,
  };

  const jsonLd = readJsonLd($);
  const person = jsonLd.find((e) => /Person|Organization|ProfilePage/.test(String(e['@type'])));
  if (person) {
    const entity = person.mainEntity ?? person;
    profile.displayName = entity.name ?? entity.alternateName ?? null;
    profile.bio = entity.description ?? null;
    profile.followers = interactionCount(person, 'Follow');
  }

  switch (platform) {
    case 'instagram': {
      // "1,234 Followers, 56 Following, 78 Posts - See Instagram photos and videos from Name (@handle)"
      profile.followers ??= firstMatch(text, [new RegExp(`${COUNT}\\s+Followers`, 'i'), /"edge_followed_by":\{"count":(\d+)/]);
      profile.following ??= firstMatch(text, [new RegExp(`${COUNT}\\s+Following`, 'i'), /"edge_follow":\{"count":(\d+)/]);
      profile.posts ??= firstMatch(text, [new RegExp(`${COUNT}\\s+Posts`, 'i')]);
      const name = ogTitle?.match(/^(.*?)\s*\(@/);
      if (name) profile.displayName ??= name[1].trim();
      const bio = html.match(/"biography":"((?:[^"\\]|\\.)*)"/);
      if (bio) profile.bio ??= JSON.parse(`"${bio[1]}"`);
      break;
    }
    case 'tiktok': {
      profile.followers ??= firstMatch(text, [/"followerCount":(\d+)/, new RegExp(`${COUNT}\\s+Followers`, 'i')]);
      profile.following ??= firstMatch(text, [/"followingCount":(\d+)/, new RegExp(`${COUNT}\\s+Following`, 'i')]);
      profile.totalLikes ??= firstMatch(text, [/"heartCount":(\d+)/, new RegExp(`${COUNT}\\s+Likes`, 'i')]);
      profile.posts ??= firstMatch(text, [/"videoCount":(\d+)/]);
      const sig = html.match(/"signature":"((?:[^"\\]|\\.)*)"/);
      if (sig) profile.bio ??= JSON.parse(`"${sig[1]}"`);
      const nick = html.match(/"nickname":"((?:[^"\\]|\\.)*)"/);
      if (nick) profile.displayName ??= JSON.parse(`"${nick[1]}"`);
      break;
    }
    case 'youtube': {
      profile.followers ??= firstMatch(text, [new RegExp(`${COUNT}\\s+subscribers`, 'i')]);
      profile.posts ??= firstMatch(text, [new RegExp(`${COUNT}\\s+videos`, 'i')]);
      break;
    }
    default: {
      profile.followers ??= firstMatch(text, [
        new RegExp(`${COUNT}\\s+(?:Followers|subscribers|connections)`, 'i'),
      ]);
      profile.following ??= firstMatch(text, [new RegExp(`${COUNT}\\s+Following`, 'i')]);
      profile.posts ??= firstMatch(text, [new RegExp(`${COUNT}\\s+(?:Posts|Tweets|videos)`, 'i')]);
    }
  }

  profile.displayName ??= ogTitle?.replace(/\s*[-|•].*$/, '').trim() || null;
  // Platform meta descriptions often prepend the stats; keep only the human bio.
  if (!profile.bio && ogDescription && !/Followers|subscribers|See Instagram/i.test(ogDescription)) {
    profile.bio = ogDescription;
  }

  const loginWall = /(log ?in|sign ?in) to (see|continue|view)|loginForm|"isLoggedIn":false.*"requireLogin"/i.test(html)
    && profile.followers === null;

  return { profile, loginWall };
}

const REQUIRED_FIELDS = ['followers', 'posts', 'bio'];

export async function scrapeProfile(input) {
  const url = normalizeUrl(input);
  if (!url) throw new ScrapeError('Please enter a valid profile link.', 'invalid_url');
  const detected = detectPlatform(url);

  // Instagram serves a login wall to servers, so try its data endpoints first.
  if (detected.platform === 'instagram' && detected.handle) {
    const ig = await fetchInstagramProfile(detected.handle);
    if (ig) {
      return {
        platform: 'instagram',
        handle: ig.profile.handle ?? detected.handle,
        url: detected.url,
        profile: ig.profile,
        source: ig.source,
        loginWall: false,
        missing: REQUIRED_FIELDS.filter((f) => ig.profile[f] === null || ig.profile[f] === undefined),
        usable: true,
      };
    }
  }

  const { html, finalUrl } = await fetchHtml(url);
  const { profile, loginWall } = extractProfile(html, detected.platform);

  const missing = REQUIRED_FIELDS.filter((f) => profile[f] === null || profile[f] === undefined);
  return {
    platform: detected.platform,
    handle: detected.handle,
    url: finalUrl.toString(),
    profile,
    source: 'page',
    loginWall,
    missing,
    // We can run a meaningful analysis only when we found at least the audience size.
    usable: profile.followers !== null,
  };
}
