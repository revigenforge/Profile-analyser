// Optional Claude-powered features. Everything here is skipped gracefully when
// no Anthropic credentials are configured — the rule-based analyser still works.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';

let client = null;
export function aiEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
function getClient() {
  client ??= new Anthropic();
  return client;
}

// Server-side fallback: if a request is declined by safety classifiers, the API
// retries it on Anthropic's recommended fallback model instead of failing.
const FALLBACK_OPTIONS = {
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
};

async function structured(schema, content, { effort = 'medium', maxTokens = 16000 } = {}) {
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: maxTokens,
    ...FALLBACK_OPTIONS,
    output_config: { effort, format: betaZodOutputFormat(schema) },
    messages: [{ role: 'user', content }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error('The AI declined to process this request.');
  }
  if (!response.parsed_output) {
    throw new Error('The AI response could not be parsed.');
  }
  return response.parsed_output;
}

const ExtractedProfile = z.object({
  platform: z.enum(['instagram', 'tiktok', 'youtube', 'x', 'linkedin', 'facebook', 'threads', 'other']).nullable(),
  handle: z.string().nullable(),
  displayName: z.string().nullable(),
  bio: z.string().nullable(),
  website: z.string().nullable(),
  followers: z.number().nullable(),
  following: z.number().nullable(),
  posts: z.number().nullable(),
  totalLikes: z.number().nullable(),
  avgLikes: z.number().nullable(),
  avgComments: z.number().nullable(),
  avgViews: z.number().nullable(),
  verified: z.boolean().nullable(),
  niche: z.string().nullable(),
  notes: z.string().nullable(),
});

const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * Reads profile metrics from screenshots.
 * @param {{buffer: Buffer, mimetype: string}[]} images
 */
export async function extractFromScreenshots(images) {
  const blocks = images
    .filter((img) => SUPPORTED_IMAGE_TYPES.has(img.mimetype))
    .map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mimetype, data: img.buffer.toString('base64') },
    }));
  if (!blocks.length) return null;

  return structured(ExtractedProfile, [
    ...blocks,
    {
      type: 'text',
      text:
        'These are screenshots of a social media creator profile (and possibly insights/analytics screens or individual posts). ' +
        'Extract the profile data you can actually see. Convert abbreviated counts to plain numbers (12.4K → 12400, 1.2M → 1200000). ' +
        'For avgLikes/avgComments/avgViews, average the per-post numbers visible across the screenshots; leave them null if no per-post numbers are visible. ' +
        'Infer niche only from clear evidence (bio, content). Use null for anything not visible — never guess numbers. ' +
        'Put anything noteworthy that does not fit a field (e.g. highlights, pinned content, analytics period) in notes.',
    },
  ]);
}

const Insights = z.object({
  summary: z.string(),
  audienceRead: z.string(),
  contentIdeas: z.array(z.object({ title: z.string(), why: z.string() })),
  growthPlan: z.array(z.object({ timeframe: z.string(), action: z.string() })),
  brandFit: z.string(),
  personalNote: z.string(),
});

/** Turns the deterministic report into a personalised narrative. */
export async function generateInsights(report) {
  const { profile, metrics, categories, recommendations, tier, overall } = report;
  const payload = {
    platform: report.platformLabel,
    handle: profile.handle,
    displayName: profile.displayName,
    bio: profile.bio,
    niche: profile.niche,
    goals: profile.goals,
    followers: profile.followers,
    following: profile.following,
    posts: profile.posts,
    avgLikes: profile.avgLikes,
    avgComments: profile.avgComments,
    avgViews: profile.avgViews,
    postsPerWeek: profile.postsPerWeek,
    tier: tier?.label,
    overallScore: overall,
    metrics,
    categoryScores: Object.fromEntries(categories.map((c) => [c.label, c.score])),
    topRecommendations: recommendations.slice(0, 5).map((r) => r.title),
  };

  return structured(Insights, [
    {
      type: 'text',
      text:
        'You are a creator-growth strategist at RevigenForge, a team that partners with creators to grow their presence. ' +
        'Below is a creator profile with computed scores (0–100, null = no data). Write a concise, specific, encouraging analysis grounded only in this data — ' +
        'do not invent numbers or facts that are not present.\n\n' +
        '- summary: 2–3 sentences on where the creator stands.\n' +
        '- audienceRead: what the numbers suggest about their audience relationship.\n' +
        '- contentIdeas: 4 concrete content ideas tailored to their niche/bio.\n' +
        '- growthPlan: 3 steps for the next 30, 60 and 90 days.\n' +
        '- brandFit: what kinds of brand partnerships they are ready for now, or what to build first.\n' +
        '- personalNote: a warm 1–2 sentence note from the RevigenForge team inviting them to connect and grow together.\n\n' +
        `Profile data:\n${JSON.stringify(payload, null, 2)}`,
    },
  ]);
}
