# RevigenForge — Creator Profile Analyser

A black & white web app (branded with the RevigenForge logo) that analyses a creator's profile and turns it into a clear growth plan, and invites the creator to connect with RevigenForge.

## How it works

1. **Profile link**: paste an Instagram, TikTok, YouTube, X, LinkedIn, Threads or Facebook URL. The server fetches the public page and reads whatever stats it exposes (Open Graph/meta tags, JSON-LD, embedded page data).
2. **Fallback: screenshots & manual input**: many platforms hide stats behind a login. When that happens, the app switches to the manual tab, keeps the platform and handle it detected, and lets the creator:
   - upload up to 6 screenshots (profile, insights, posts). With an Anthropic API key configured, *Read numbers from screenshots* fills the form automatically using Claude vision, and the creator reviews it before analysing.
   - type or correct any numbers (`12.4K` and `1.2M` are accepted).
3. **Report**:
   - an overall score (0–100) and grade, plus the creator's audience tier
   - engagement rate compared against a per-platform benchmark, and monthly follower growth
   - a score for each of seven areas: reach, engagement, follower growth, consistency, profile & bio, content library, authority, shown as a radar chart and as bars
   - status colours for every score: green ▲ Strong (70+), amber ● Fair (45–69), red ▼ Weak (<45). Each colour comes with an icon and a word, so it never relies on colour alone
   - a bio/profile checklist and a prioritised action plan
   - a "where RevigenForge would focus" section
   - a download-as-PDF option (print)

   With a key configured, it also adds personalised AI insights: content ideas, a 30/60/90-day plan, brand readiness and a personal note from the team.
4. **Connect**: the creator can join the RevigenForge network from the report. Submissions are appended to `data/connections.jsonl`.

The rule-based scoring always works. AI is an optional layer on top of it, and if it fails the report still loads.

## Run it

```bash
npm install
npm start            # http://localhost:3000
npm test             # unit tests (parsers + scoring)
```

To enable screenshot reading and AI insights, set `ANTHROPIC_API_KEY` (see `.env.example`). The default model is `claude-opus-5-5`. Requests use server-side fallbacks (`fallbacks: "default"`): if a request is declined, it is retried on Anthropic's recommended fallback model.

## Project layout

```
server.js           Express API + static hosting
lib/platforms.js    URL → platform/handle detection, per-platform benchmarks
lib/scraper.js      Public page fetch (SSRF-guarded) + metric extraction
lib/analyzer.js     Deterministic scoring, checklist, recommendations
lib/ai.js           Optional Claude vision extraction + insights
public/             Front-end (HTML/CSS/JS, no build step)
test/               node:test unit tests
```

## API

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/api/status` | – | `{ aiEnabled }` |
| POST | `/api/analyze/url` | `{ url }` | Scrape + analyse. `422 { fallback: true, partial }` when stats are not public |
| POST | `/api/extract` | multipart `screenshots[]` | Read metrics from screenshots (AI) |
| POST | `/api/analyze/manual` | `{ profile }` | Analyse manually entered data |
| POST | `/api/connect` | `{ name, email, handle, platform, interests, goals }` | Save a creator connection |

## Notes

- Instagram, TikTok and X often serve a login wall to servers, especially from datacenter IPs. In that case the screenshot/manual flow takes over. YouTube and personal sites usually work.
- Connections are stored in a local JSONL file. Swap this for a database or CRM (or send an email notification) before going to production, and add rate limiting to the public endpoints.
