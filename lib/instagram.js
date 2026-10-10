// Instagram profile data from free sources, in order of reliability:
//  1. Meta Graph API "Business Discovery" — official, needs RevigenForge's own
//     Instagram professional account + token (META_ACCESS_TOKEN, META_IG_USER_ID).
//     Works for any creator/business account; personal accounts are not visible.
//  2. Instagram's public web profile endpoint — no setup, but Instagram often
//     blocks it from cloud/datacenter IPs, so it is best-effort only.
// Both return recent posts, so engagement and posting frequency are computed too.

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';
const TIMEOUT_MS = 10_000;
const DAY_MS = 86_400_000;

export function businessDiscoveryConfigured() {
  return Boolean(process.env.META_ACCESS_TOKEN && process.env.META_IG_USER_ID);
}

const average = (values) => {
  const nums = values.filter((v) => Number.isFinite(v));
  return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
};

/** Posts per week from post timestamps (ms), using the span between oldest and newest. */
export function postsPerWeek(timestamps) {
  const ts = timestamps.filter(Number.isFinite).sort((a, b) => a - b);
  if (ts.length < 3) return null;
  const spanDays = (ts[ts.length - 1] - ts[0]) / DAY_MS;
  if (spanDays < 1) return null;
  return Math.round(((ts.length - 1) / spanDays) * 7 * 10) / 10;
}

/** Maps a Graph API business_discovery object to our profile fields. Exported for tests. */
export function mapBusinessDiscovery(bd) {
  const media = bd.media?.data ?? [];
  return {
    handle: bd.username ?? null,
    displayName: bd.name ?? null,
    bio: bd.biography ?? null,
    website: bd.website ?? null,
    avatarUrl: bd.profile_picture_url ?? null,
    followers: bd.followers_count ?? null,
    following: bd.follows_count ?? null,
    posts: bd.media_count ?? null,
    // like_count is omitted when the creator hides likes.
    avgLikes: average(media.map((m) => m.like_count)),
    avgComments: average(media.map((m) => m.comments_count)),
    postsPerWeek: postsPerWeek(media.map((m) => Date.parse(m.timestamp))),
  };
}

/** Maps Instagram's web_profile_info user object to our profile fields. Exported for tests. */
export function mapWebProfile(user) {
  const edges = user.edge_owner_to_timeline_media?.edges ?? [];
  const nodes = edges.map((e) => e.node ?? {});
  const views = nodes.filter((n) => n.is_video).map((n) => n.video_view_count);
  return {
    handle: user.username ?? null,
    displayName: user.full_name || null,
    bio: user.biography || null,
    website: user.external_url || null,
    avatarUrl: user.profile_pic_url_hd ?? user.profile_pic_url ?? null,
    followers: user.edge_followed_by?.count ?? null,
    following: user.edge_follow?.count ?? null,
    posts: user.edge_owner_to_timeline_media?.count ?? null,
    verified: user.is_verified ?? null,
    avgLikes: average(nodes.map((n) => n.edge_liked_by?.count ?? n.edge_media_preview_like?.count)),
    avgComments: average(nodes.map((n) => n.edge_media_to_comment?.count)),
    avgViews: average(views),
    postsPerWeek: postsPerWeek(nodes.map((n) => (n.taken_at_timestamp ? n.taken_at_timestamp * 1000 : NaN))),
  };
}

async function fromBusinessDiscovery(username) {
  const fields =
    `business_discovery.username(${username}){username,name,biography,website,profile_picture_url,` +
    'followers_count,follows_count,media_count,media.limit(12){like_count,comments_count,timestamp}}';
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(process.env.META_IG_USER_ID)}`);
  url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', process.env.META_ACCESS_TOKEN);
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.business_discovery) {
    // Personal (non-professional) accounts and unknown usernames land here.
    throw new Error(`Business Discovery: ${body.error?.message ?? `HTTP ${res.status}`}`);
  }
  return mapBusinessDiscovery(body.business_discovery);
}

async function fromWebProfile(username) {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      // Public app id used by instagram.com's own web client.
      'x-ig-app-id': '936619743392459',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Accept: 'application/json',
    },
  });
  const body = await res.json().catch(() => null);
  const user = body?.data?.user;
  if (!res.ok || !user) throw new Error(`Web profile: HTTP ${res.status}`);
  return mapWebProfile(user);
}

/**
 * Returns `{ profile, source, attempts }`; `profile` is null when no free source
 * could read the account. `attempts` lists each source tried and why it failed,
 * so the UI can show what went wrong. Never throws.
 */
export async function fetchInstagramProfile(username) {
  const clean = String(username ?? '').replace(/^@/, '').trim();
  const attempts = [];
  if (!/^[A-Za-z0-9._]{1,30}$/.test(clean)) {
    return { profile: null, source: null, attempts: [{ source: 'instagram', error: `"${clean}" is not a valid Instagram username` }] };
  }

  const sources = [];
  if (businessDiscoveryConfigured()) {
    sources.push(['instagram-graph-api', fromBusinessDiscovery]);
  } else {
    attempts.push({ source: 'instagram-graph-api', error: 'Not configured (META_ACCESS_TOKEN / META_IG_USER_ID missing)' });
  }
  sources.push(['instagram-web', fromWebProfile]);

  for (const [source, fn] of sources) {
    try {
      const profile = await fn(clean);
      if (profile.followers !== null) return { profile, source, attempts };
      attempts.push({ source, error: 'No follower count in response' });
    } catch (err) {
      console.warn(`Instagram ${source} failed for @${clean}: ${err.message}`);
      attempts.push({ source, error: err.message });
    }
  }
  return { profile: null, source: null, attempts };
}
