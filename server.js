import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeProfile } from './lib/analyzer.js';
import { scrapeProfile, ScrapeError } from './lib/scraper.js';
import { aiEnabled, extractFromScreenshots, generateInsights } from './lib/ai.js';
import { detectPlatform } from './lib/platforms.js';
import { saveConnection } from './lib/storage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(here, 'public')));

// Vercel caps a request body at 4.5 MB, so the browser shrinks screenshots before
// upload (see public/app.js) and we keep the server limit just under that.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 6, fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)),
});

async function withInsights(report) {
  if (!aiEnabled()) return { ...report, insights: null };
  try {
    return { ...report, insights: await generateInsights(report) };
  } catch (err) {
    console.error('AI insights failed:', err.message);
    return { ...report, insights: null, insightsError: 'AI insights are unavailable right now.' };
  }
}

/** Manual values override scraped / extracted ones when provided. */
function mergeProfiles(...sources) {
  const merged = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value !== null && value !== undefined && value !== '') merged[key] = value;
    }
  }
  return merged;
}

function fallbackMessage(platform, loginWall) {
  if (platform === 'instagram') {
    return "Instagram didn't share this account's stats with us. This happens with personal (non-creator) accounts or when Instagram limits requests. " +
      'Upload a screenshot of the profile page (and your Insights overview if you have one), or type your numbers below.';
  }
  if (loginWall) {
    return `${platform === 'other' ? 'This site' : 'The platform'} hides profile stats behind a login. Upload screenshots or enter your stats instead.`;
  }
  return "We couldn't read public stats from that link. Upload screenshots or enter your stats instead.";
}

app.get('/api/status', (_req, res) => {
  res.json({ ok: true, aiEnabled: aiEnabled() });
});

app.post('/api/analyze/url', async (req, res) => {
  const { url, extra } = req.body ?? {};
  try {
    const scraped = await scrapeProfile(url);
    if (!scraped.usable) {
      return res.status(422).json({
        fallback: true,
        error: fallbackMessage(scraped.platform, scraped.loginWall),
        partial: { platform: scraped.platform, handle: scraped.handle, url: scraped.url, ...scraped.profile },
      });
    }
    const profile = mergeProfiles(
      { platform: scraped.platform, handle: scraped.handle, url: scraped.url },
      scraped.profile,
      extra,
    );
    const report = await withInsights(analyzeProfile(profile));
    res.json({ source: scraped.source, missing: scraped.missing, report });
  } catch (err) {
    const detected = typeof url === 'string' ? detectPlatform(url) : null;
    const status = err instanceof ScrapeError && err.code === 'invalid_url' ? 400 : 422;
    if (!(err instanceof ScrapeError)) console.error('Scrape failed:', err.message);
    res.status(status).json({
      fallback: status === 422,
      error: err instanceof ScrapeError && err.code === 'invalid_url'
        ? err.message
        : fallbackMessage(detected?.platform, false),
      partial: detected ? { platform: detected.platform, handle: detected.handle, url: detected.url } : null,
    });
  }
});

app.post('/api/extract', upload.array('screenshots', 6), async (req, res) => {
  if (!req.files?.length) {
    return res.status(400).json({ error: 'Upload at least one PNG, JPG, WEBP or GIF screenshot.' });
  }
  if (!aiEnabled()) {
    return res.status(503).json({
      error: 'Automatic screenshot reading is not enabled on this server. Please type the numbers from your screenshots below.',
    });
  }
  try {
    const extracted = await extractFromScreenshots(req.files);
    res.json({ extracted });
  } catch (err) {
    console.error('Screenshot extraction failed:', err.message);
    res.status(502).json({ error: "We couldn't read those screenshots. Please enter the numbers manually." });
  }
});

app.post('/api/analyze/manual', async (req, res) => {
  const profile = req.body?.profile;
  if (!profile || typeof profile !== 'object') {
    return res.status(400).json({ error: 'Missing profile data.' });
  }
  const base = analyzeProfile(profile);
  if (base.overall === null) {
    return res.status(400).json({ error: 'Add at least your follower count or bio so we have something to analyse.' });
  }
  res.json({ source: 'manual', report: await withInsights(base) });
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

app.post('/api/connect', async (req, res) => {
  const body = req.body ?? {};
  const entry = {
    name: clip(body.name, 120),
    email: clip(body.email, 200),
    handle: clip(body.handle, 120),
    platform: clip(body.platform, 40),
    goals: clip(body.goals, 2000),
    interests: Array.isArray(body.interests) ? body.interests.slice(0, 10).map((i) => clip(i, 80)) : [],
    score: Number.isFinite(body.score) ? body.score : null,
    createdAt: new Date().toISOString(),
  };
  if (!entry.name || !EMAIL.test(entry.email)) {
    return res.status(400).json({ error: 'Please add your name and a valid email.' });
  }
  try {
    await saveConnection(entry);
  } catch (err) {
    console.error('Saving connection failed:', err.message);
    return res.status(502).json({ error: "We couldn't save your details just now. Please try again in a moment." });
  }
  res.json({ ok: true });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Screenshots are too large. Please upload smaller images.' : 'Up to 6 screenshots, please.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => {
    console.log(`RevigenForge Profile Analyser → http://localhost:${PORT}`);
    console.log(aiEnabled() ? 'AI insights: enabled' : 'AI insights: disabled (set ANTHROPIC_API_KEY to enable)');
  });
}
