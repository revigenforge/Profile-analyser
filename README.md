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
4. **Connect**: the creator can join the RevigenForge network from the report. Submissions are added as rows in a Google Sheet. In local development without a sheet configured, they go to `data/connections.jsonl`.

The rule-based scoring always works. AI is an optional layer on top of it, and if it fails the report still loads.

## Run it

```bash
npm install
npm start            # http://localhost:3000
npm test             # unit tests (parsers + scoring)
```

To enable screenshot reading and AI insights, set `ANTHROPIC_API_KEY` (see `.env.example`). The default model is `claude-opus-5-5`. Requests use server-side fallbacks (`fallbacks: "default"`): if a request is declined, it is retried on Anthropic's recommended fallback model.

## Deploy to Vercel

### 1. Set up the Google Sheet (≈5 minutes)
1. Create a Google Sheet, e.g. *RevigenForge Creator Connections*.
2. **Extensions → Apps Script**. Delete what's there, paste in [`google-sheets/Code.gs`](google-sheets/Code.gs), and save.
3. **Project Settings (⚙) → Script Properties → Add property**: name `SECRET`, value a long random string. To generate one, run `openssl rand -hex 24` in a terminal.
4. **Deploy → New deployment →** type **Web app**. Set *Execute as*: **Me** and *Who has access*: **Anyone**. Authorise when asked, then copy the **Web app URL** (it ends in `/exec`).

The first sign-up creates a `Connections` tab with these columns: Submitted at, Name, Email, Handle, Platform, Interests, Score, Message.

### 2. Deploy
1. Import this GitHub repo at [vercel.com/new](https://vercel.com/new). There's no build step, and `vercel.json` already configures everything.
2. In **Settings → Environment Variables**, add:
   - `GOOGLE_SHEETS_WEBHOOK_URL`: the `/exec` URL from step 1
   - `GOOGLE_SHEETS_SECRET`: the same secret as the Apps Script `SECRET`
   - `ANTHROPIC_API_KEY` (optional): turns on screenshot reading and AI insights
3. Deploy, then submit the Connect form once to check that a row appears in the sheet.

How it runs on Vercel:
- `public/` is served as static files.
- All `/api/*` requests go to one function (`api/index.js`, which wraps the Express app) with a 60-second limit for the AI calls.
- Screenshots are shrunk in the browser to stay under Vercel's 4.5 MB request limit.
- If the sheet variables are missing on Vercel, the Connect form shows an error instead of silently losing sign-ups.

## Instagram links (free Meta API)

Instagram blocks normal page requests from servers, so it needs a data source. The app tries these in order:

1. **Meta Business Discovery API** (official, free, reliable). It uses RevigenForge's own Instagram account to look up any **creator or business** account and returns followers, following, posts, bio, website, and likes and comments on the last 12 posts. Engagement rate and posts per week are then calculated automatically.
2. **Instagram's public web endpoint** (free, no setup). Instagram often blocks it from cloud servers, so it only works sometimes.
3. **Screenshots / manual entry**, if both of the above fail. This also covers *personal* Instagram accounts, which Meta's API can't see.

### One-time setup for option 1
1. **RevigenForge's Instagram account → Professional.** In the Instagram app: *Settings → Account type and tools → Switch to professional account*. Then connect it to a Facebook Page: *Facebook Page settings → Linked accounts → Instagram*.
2. **Create a Meta app** at [developers.facebook.com](https://developers.facebook.com/apps): *Create app → Business*. Add the **Instagram** product and choose *API setup with Facebook login*. The app can stay in Development mode, since only your own account uses it.
3. **Get a token** in the [Graph API Explorer](https://developers.facebook.com/tools/explorer). Select your app, click *Generate Access Token*, and grant `instagram_basic`, `pages_show_list`, `pages_read_engagement` and `business_management`.
4. **Find your Instagram user ID.** In the Explorer, run `me/accounts?fields=name,instagram_business_account` and copy the `instagram_business_account.id`.
5. **Make the token last.** Explorer tokens expire in about 1 hour. In the [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/), click *Extend Access Token* to get a 60-day token. For a token that never expires, create a **System User** in Meta Business Settings and generate its token with the same permissions.
6. **Add to Vercel's environment variables:**
   - `META_ACCESS_TOKEN`: the token
   - `META_IG_USER_ID`: the ID from step 4

   Then redeploy.

Limits: around 200 lookups per hour, and only creator/business accounts can be looked up. If you use a 60-day token, renew it before it expires; after that, lookups quietly fall back to screenshots.

## Project layout

```
server.js           Express API + static hosting
lib/platforms.js    URL → platform/handle detection, per-platform benchmarks
lib/scraper.js      Public page fetch (SSRF-guarded) + metric extraction
lib/instagram.js    Instagram via Meta Business Discovery / public web endpoint
lib/analyzer.js     Deterministic scoring, checklist, recommendations
lib/ai.js           Optional Claude vision extraction + insights
lib/storage.js      Google Sheet (Apps Script webhook) / local-file storage
api/index.js        Vercel function entry
google-sheets/      Apps Script to paste into your Google Sheet
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

- TikTok and X often serve a login wall to servers, especially from datacenter IPs. In that case the screenshot/manual flow takes over. Instagram works through the Meta API above. YouTube and personal sites usually work.
- Add rate limiting to the public endpoints before heavy traffic. Vercel's Firewall rate-limit rules work for this.
