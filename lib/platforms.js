// Platform detection and per-platform benchmarks used by the analyser.

export const PLATFORMS = {
  instagram: {
    label: 'Instagram',
    hosts: ['instagram.com'],
    // Typical engagement rate (likes + comments / followers, %) by healthy accounts.
    engagementBenchmark: 3,
    // Recommended posts per week for steady growth.
    idealPostsPerWeek: 4,
    bioLimit: 150,
  },
  tiktok: {
    label: 'TikTok',
    hosts: ['tiktok.com'],
    engagementBenchmark: 5,
    idealPostsPerWeek: 5,
    bioLimit: 80,
  },
  youtube: {
    label: 'YouTube',
    hosts: ['youtube.com', 'youtu.be'],
    engagementBenchmark: 4,
    idealPostsPerWeek: 2,
    bioLimit: 1000,
  },
  x: {
    label: 'X (Twitter)',
    hosts: ['x.com', 'twitter.com'],
    engagementBenchmark: 1,
    idealPostsPerWeek: 10,
    bioLimit: 160,
  },
  linkedin: {
    label: 'LinkedIn',
    hosts: ['linkedin.com'],
    engagementBenchmark: 2,
    idealPostsPerWeek: 3,
    bioLimit: 220,
  },
  facebook: {
    label: 'Facebook',
    hosts: ['facebook.com', 'fb.com'],
    engagementBenchmark: 1,
    idealPostsPerWeek: 4,
    bioLimit: 255,
  },
  threads: {
    label: 'Threads',
    hosts: ['threads.net', 'threads.com'],
    engagementBenchmark: 3,
    idealPostsPerWeek: 7,
    bioLimit: 150,
  },
  other: {
    label: 'Other',
    hosts: [],
    engagementBenchmark: 3,
    idealPostsPerWeek: 3,
    bioLimit: 200,
  },
};

const RESERVED_PATHS = new Set([
  'p', 'reel', 'reels', 'explore', 'stories', 'watch', 'shorts', 'video',
  'status', 'in', 'company', 'channel', 'c', 'user', 'pub', 'profile.php', 'tv',
]);

export function normalizeUrl(input) {
  if (typeof input !== 'string') return null;
  let value = input.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!url.hostname.includes('.')) return null;
    return url;
  } catch {
    return null;
  }
}

export function detectPlatform(input) {
  const url = input instanceof URL ? input : normalizeUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, '');
  const platform = Object.entries(PLATFORMS).find(([, p]) =>
    p.hosts.some((h) => host === h || host.endsWith(`.${h}`)),
  )?.[0] ?? 'other';

  const segments = url.pathname.split('/').filter(Boolean);
  let handle = null;

  if (platform === 'youtube') {
    const at = segments.find((s) => s.startsWith('@'));
    if (at) handle = at.slice(1);
    else if (['channel', 'c', 'user'].includes(segments[0]) && segments[1]) handle = segments[1];
  } else if (platform === 'linkedin') {
    if (['in', 'company'].includes(segments[0]) && segments[1]) handle = segments[1];
  } else if (platform === 'facebook' && segments[0] === 'profile.php') {
    handle = url.searchParams.get('id');
  } else if (segments[0] && !RESERVED_PATHS.has(segments[0].toLowerCase())) {
    handle = segments[0].replace(/^@/, '');
  }

  return { platform, handle: handle ? decodeURIComponent(handle) : null, url: url.toString() };
}

export function platformInfo(platform) {
  return PLATFORMS[platform] ?? PLATFORMS.other;
}
