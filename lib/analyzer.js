// Deterministic scoring engine. Works with whatever data is available and
// reports how confident it is, so partial scrapes still produce a report.

import { PLATFORMS, platformInfo } from './platforms.js';

const NUMERIC_FIELDS = [
  'followers', 'following', 'posts', 'avgLikes', 'avgComments',
  'avgViews', 'avgShares', 'postsPerWeek', 'totalLikes', 'newFollowers30d',
];
// Net follower change can be negative (an account can lose followers).
const SIGNED_FIELDS = new Set(['newFollowers30d']);

const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, n));
const round = (n, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
const has = (v) => v !== null && v !== undefined && Number.isFinite(v);

export function normalizeProfile(raw = {}) {
  const profile = { ...raw };
  for (const field of NUMERIC_FIELDS) {
    const value = raw[field];
    if (value === '' || value === null || value === undefined) {
      profile[field] = null;
    } else {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
      profile[field] = Number.isFinite(n) && (n >= 0 || SIGNED_FIELDS.has(field)) ? n : null;
    }
  }
  for (const field of ['platform', 'handle', 'displayName', 'bio', 'niche', 'website', 'goals', 'url']) {
    profile[field] = typeof raw[field] === 'string' ? raw[field].trim() || null : null;
  }
  profile.platform = profile.platform && PLATFORMS[profile.platform.toLowerCase()] ? profile.platform.toLowerCase() : 'other';
  profile.verified = raw.verified === true || raw.verified === 'true' || raw.verified === 'on';
  return profile;
}

export function audienceTier(followers) {
  if (!has(followers)) return null;
  if (followers < 1_000) return { key: 'emerging', label: 'Emerging (< 1K)' };
  if (followers < 10_000) return { key: 'nano', label: 'Nano (1K – 10K)' };
  if (followers < 100_000) return { key: 'micro', label: 'Micro (10K – 100K)' };
  if (followers < 500_000) return { key: 'mid', label: 'Mid-tier (100K – 500K)' };
  if (followers < 1_000_000) return { key: 'macro', label: 'Macro (500K – 1M)' };
  return { key: 'mega', label: 'Mega (1M+)' };
}

export function engagementRate(p) {
  if (!has(p.followers) || p.followers === 0) return null;
  if (p.platform === 'youtube' || p.platform === 'tiktok') {
    // Video-first platforms: interactions per view is the fairer signal when views are known.
    if (has(p.avgViews) && p.avgViews > 0 && (has(p.avgLikes) || has(p.avgComments))) {
      return ((p.avgLikes ?? 0) + (p.avgComments ?? 0) + (p.avgShares ?? 0)) / p.avgViews * 100;
    }
  }
  if (!has(p.avgLikes) && !has(p.avgComments)) return null;
  return ((p.avgLikes ?? 0) + (p.avgComments ?? 0) + (p.avgShares ?? 0)) / p.followers * 100;
}

/** Monthly follower growth in %, based on net new followers over the last 30 days. */
export function growthRate(p) {
  if (!has(p.newFollowers30d) || !has(p.followers)) return null;
  const start = p.followers - p.newFollowers30d;
  if (start <= 0) return null;
  return (p.newFollowers30d / start) * 100;
}

function scoreGrowth(rate) {
  if (rate === null) return null;
  // Shrinking → below 40. 0.5%/mo → ~50, 2% → ~67, 5% → ~85, 10%+ → 100.
  if (rate <= 0) return round(clamp(35 + rate * 5));
  return round(clamp(40 + (60 * Math.log10(1 + rate)) / Math.log10(11)));
}

function scoreReach(p) {
  if (!has(p.followers)) return null;
  // Log scale: 100 → 20, 1K → 40, 10K → 60, 100K → 80, 1M+ → 100
  let score = clamp(Math.log10(Math.max(p.followers, 1)) * 20 - 20);
  if (has(p.avgViews) && p.followers > 0) {
    const viewRatio = p.avgViews / p.followers;
    score = clamp(score * 0.7 + clamp(viewRatio * 100) * 0.3);
  }
  return round(score);
}

function scoreEngagement(p, rate) {
  if (rate === null) return null;
  const benchmark = platformInfo(p.platform).engagementBenchmark;
  // Hitting the benchmark → 70, double the benchmark → 100.
  return round(clamp((rate / benchmark) * 70, 0, 100));
}

function scoreConsistency(p) {
  if (!has(p.postsPerWeek)) return null;
  const ideal = platformInfo(p.platform).idealPostsPerWeek;
  const ratio = p.postsPerWeek / ideal;
  if (ratio > 2.5) return 80; // very high volume can dilute quality
  return round(clamp(ratio * 100));
}

const CTA_PATTERN = /(dm|email|contact|book|shop|link|subscribe|join|download|collab|inquir|business)/i;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.]+/;

function scoreProfile(p) {
  if (!p.bio && !p.displayName && !p.website) return null;
  const checks = profileChecks(p);
  const passed = checks.filter((c) => c.ok).length;
  return round((passed / checks.length) * 100);
}

export function profileChecks(p) {
  const bio = p.bio ?? '';
  const limit = platformInfo(p.platform).bioLimit;
  return [
    { key: 'bio', label: 'Has a bio', ok: bio.length > 0 },
    { key: 'bioLength', label: 'Bio uses the space well', ok: bio.length >= Math.min(60, limit * 0.4) },
    { key: 'cta', label: 'Clear call-to-action', ok: CTA_PATTERN.test(bio) },
    { key: 'contact', label: 'Contact / business email visible', ok: EMAIL_PATTERN.test(bio) || /email|contact/i.test(bio) },
    { key: 'link', label: 'Link in bio / website', ok: Boolean(p.website) || /https?:\/\/|\.\w{2,}\//i.test(bio) },
    { key: 'niche', label: 'Niche is clearly stated', ok: Boolean(p.niche) },
    { key: 'name', label: 'Recognisable display name', ok: Boolean(p.displayName) },
  ];
}

function scoreLibrary(p) {
  if (!has(p.posts)) return null;
  // 0 → 0, 30 → ~50, 150 → ~75, 500+ → ~100
  return round(clamp(Math.log10(p.posts + 1) / Math.log10(500) * 100));
}

function scoreAuthority(p) {
  if (!has(p.followers) || !has(p.following)) return null;
  const ratio = p.following === 0 ? p.followers : p.followers / p.following;
  let score = clamp(Math.log10(Math.max(ratio, 0.01) * 10) * 33);
  if (p.verified) score = clamp(score + 15);
  return round(score);
}

const WEIGHTS = {
  reach: 0.15,
  engagement: 0.25,
  growth: 0.15,
  consistency: 0.15,
  profile: 0.12,
  library: 0.09,
  authority: 0.09,
};

const CATEGORY_LABELS = {
  reach: 'Audience Reach',
  engagement: 'Engagement',
  growth: 'Follower Growth',
  consistency: 'Posting Consistency',
  profile: 'Profile & Bio',
  library: 'Content Library',
  authority: 'Authority',
};

function grade(score) {
  if (score >= 85) return { letter: 'A', label: 'Standout presence' };
  if (score >= 70) return { letter: 'B', label: 'Strong & growing' };
  if (score >= 55) return { letter: 'C', label: 'Solid foundation' };
  if (score >= 40) return { letter: 'D', label: 'Needs focus' };
  return { letter: 'E', label: 'Early stage' };
}

function recommendations(p, scores, rate, checks, growth) {
  const info = platformInfo(p.platform);
  const recs = [];
  const add = (priority, area, title, detail) => recs.push({ priority, area, title, detail });

  if (scores.engagement !== null && scores.engagement < 55) {
    add('high', 'engagement', 'Lift your engagement rate',
      `Your engagement rate is ${round(rate, 2)}% vs a ${info.engagementBenchmark}% benchmark on ${info.label}. ` +
      'End posts with a direct question, reply to every comment in the first hour, and lean into formats that invite saves and shares.');
  }
  if (scores.engagement === null) {
    add('medium', 'engagement', 'Track your average likes & comments',
      'Add your average likes, comments and views per post so we can benchmark engagement — it is the #1 metric brands look at.');
  }
  if (scores.growth !== null && scores.growth < 55) {
    add('high', 'growth', growth <= 0 ? 'Turn follower loss around' : 'Speed up follower growth',
      `You grew ${round(growth, 2)}% in the last 30 days. Ride 1–2 trends a week in your niche, add a follow hook to your best-performing format, and collaborate with a creator of similar size each month.`);
  }
  if (scores.growth === null) {
    add('low', 'growth', 'Track your monthly follower growth',
      'Add how many followers you gained in the last 30 days (it is in your insights) so we can measure momentum.');
  }
  if (scores.consistency !== null && scores.consistency < 70) {
    add('high', 'consistency', 'Post on a predictable schedule',
      `You post ~${p.postsPerWeek}×/week; ${info.label} rewards about ${info.idealPostsPerWeek}×/week. ` +
      'Batch-create content once a week and schedule it so the algorithm (and your audience) learn when to expect you.');
  }
  const fixTitles = {
    bio: 'Write a bio',
    bioLength: 'Make your bio work harder',
    cta: 'Add a call-to-action',
    contact: 'Make yourself easy to contact',
    link: 'Add a link in bio',
    niche: 'Define your niche',
    name: 'Optimise your display name',
  };
  for (const check of checks.filter((c) => !c.ok)) {
    const detail = {
      bio: 'Write a bio that says who you help and what they get from following you.',
      bioLength: `Use more of your ${info.bioLimit}-character bio: niche, proof (results, features), and what to do next.`,
      cta: 'Add a call-to-action ("DM COLLAB", "Grab the free guide ↓", "Subscribe for weekly…").',
      contact: 'Show a business email — brands skip creators they cannot contact quickly.',
      link: 'Add a link in bio (portfolio, media kit or link hub) so interest turns into action.',
      niche: 'Define your niche in one line. Clear positioning converts visitors into followers faster.',
      name: 'Use a searchable display name, e.g. "Name | Fitness Coach".',
    }[check.key];
    add(check.key === 'cta' || check.key === 'contact' ? 'high' : 'medium', 'profile', fixTitles[check.key], detail);
  }
  if (scores.library !== null && scores.library < 45) {
    add('medium', 'library', 'Build a deeper content library',
      'New visitors binge a profile before following. Aim for at least 30 strong posts and pin your 3 best performers.');
  }
  if (scores.authority !== null && scores.authority < 40) {
    add('low', 'authority', 'Rebalance follower / following ratio',
      'Following far more accounts than follow you can look like follow-for-follow. Trim inactive follows and focus on your niche.');
  }
  if (scores.reach !== null && scores.reach < 60) {
    add('medium', 'reach', 'Expand discovery',
      'Collaborate with creators in adjacent niches, use trending audio/topics weekly, and cross-post short-form clips to a second platform.');
  }
  const order = { high: 0, medium: 1, low: 2 };
  return recs.sort((a, b) => order[a.priority] - order[b.priority]);
}

function strengths(scores, rate, p, growth) {
  const out = [];
  if (scores.growth >= 70) out.push(`You are growing ${round(growth, 1)}% a month — strong momentum.`);
  if (scores.engagement >= 70) out.push(`Engagement of ${round(rate, 2)}% beats the ${platformInfo(p.platform).label} benchmark — your audience genuinely cares.`);
  if (scores.reach >= 70) out.push('Your audience size gives you real leverage with brands and collaborators.');
  if (scores.consistency >= 80) out.push('You post consistently — the hardest habit for most creators.');
  if (scores.profile >= 80) out.push('Your profile is clear and conversion-ready.');
  if (scores.library >= 70) out.push('A deep content library keeps new visitors watching.');
  if (scores.authority >= 70) out.push('Healthy follower-to-following ratio signals authority.');
  return out;
}

const REVIGENFORGE_SUPPORT = {
  engagement: 'Community & engagement playbooks',
  growth: 'Growth sprints and trend-led content',
  consistency: 'Content calendar and batching support',
  profile: 'Profile, bio and media-kit makeover',
  library: 'Content pillars and series planning',
  authority: 'Positioning and personal-brand strategy',
  reach: 'Collab matching and cross-platform growth',
};

export function analyzeProfile(raw) {
  const p = normalizeProfile(raw);
  const rate = engagementRate(p);
  const growth = growthRate(p);
  const checks = profileChecks(p);
  const scores = {
    reach: scoreReach(p),
    engagement: scoreEngagement(p, rate),
    growth: scoreGrowth(growth),
    consistency: scoreConsistency(p),
    profile: scoreProfile(p),
    library: scoreLibrary(p),
    authority: scoreAuthority(p),
  };

  const available = Object.entries(scores).filter(([, s]) => s !== null);
  const weightSum = available.reduce((sum, [k]) => sum + WEIGHTS[k], 0);
  const overall = weightSum > 0
    ? round(available.reduce((sum, [k, s]) => sum + s * WEIGHTS[k], 0) / weightSum)
    : null;
  const confidence = round(weightSum * 100);

  const categories = Object.keys(WEIGHTS).map((key) => ({
    key,
    label: CATEGORY_LABELS[key],
    score: scores[key],
    weight: WEIGHTS[key],
  }));

  const weakest = categories
    .filter((c) => c.score !== null)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map((c) => ({ area: c.label, support: REVIGENFORGE_SUPPORT[c.key] }));

  return {
    profile: p,
    platformLabel: platformInfo(p.platform).label,
    overall,
    grade: overall === null ? null : grade(overall),
    confidence,
    tier: audienceTier(p.followers),
    metrics: {
      engagementRate: rate === null ? null : round(rate, 2),
      engagementBenchmark: platformInfo(p.platform).engagementBenchmark,
      growthRate: growth === null ? null : round(growth, 2),
      followerRatio: has(p.followers) && has(p.following) && p.following > 0 ? round(p.followers / p.following, 1) : null,
      viewsPerFollower: has(p.avgViews) && has(p.followers) && p.followers > 0 ? round(p.avgViews / p.followers, 2) : null,
      idealPostsPerWeek: platformInfo(p.platform).idealPostsPerWeek,
    },
    categories,
    profileChecks: checks,
    strengths: strengths(scores, rate, p, growth),
    recommendations: recommendations(p, scores, rate, checks, growth),
    revigenforge: weakest,
    generatedAt: new Date().toISOString(),
  };
}
