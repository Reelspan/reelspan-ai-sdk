// Reelspan tools for the Vercel AI SDK: let a model publish to 22 social networks, check results, read analytics and
// manage the schedule. Built on the official `reelspan` client (retries, idempotency keys, big uploads in parts).
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { Reelspan } from 'reelspan';

export const VERSION = '0.1.0';

export const PLATFORMS = ['tiktok', 'youtube', 'instagram', 'facebook', 'x', 'threads', 'linkedin', 'pinterest', 'bluesky', 'reddit', 'google_business', 'telegram', 'discord', 'slack', 'mastodon', 'nostr', 'lemmy', 'devto', 'hashnode', 'wordpress', 'whop', 'listmonk', 'sandbox'] as const;

/** Tools that publish, change or delete something. */
export const WRITE_TOOLS = ['uploadVideo', 'uploadPhotos', 'uploadText', 'uploadDocument', 'retryPost', 'editScheduledPost', 'cancelScheduledPost', 'writeCaptions'] as const;

export type ReelspanToolsOptions = {
  /** Defaults to REELSPAN_API_KEY. */
  apiKey?: string;
  /** Defaults to https://api.reelspan.com. */
  baseUrl?: string;
  /** Your own fetch, for proxies or tests. */
  fetch?: typeof fetch;
  /**
   * Pin every tool to one profile: the model can't post as another, and doesn't need to ask which. Recommended when
   * one app user maps to one Reelspan profile.
   */
  profile?: string;
  /** Only these networks can be posted to. */
  platforms?: readonly string[];
  /** Only tools that read: no posting, editing or cancelling. */
  readOnly?: boolean;
  /** Ask the user before a tool in WRITE_TOOLS runs (AI SDK tool approval). */
  needsApproval?: boolean;
  /** Only these tools. */
  include?: readonly ToolName[];
  /** Never these tools. */
  exclude?: readonly ToolName[];
  /** Wait for each network's result after posting (default true; up to waitTimeoutMs). */
  wait?: boolean;
  /** Default 5 minutes. */
  waitTimeoutMs?: number;
};

export type ToolName =
  | (typeof WRITE_TOOLS)[number]
  | 'listProfiles'
  | 'getPostStatus'
  | 'getPostHistory'
  | 'listScheduledPosts'
  | 'getAnalytics'
  | 'getPostAnalytics'
  | 'getBestTimes'
  | 'getQueueSlots';

type Json = Record<string, any>;

/** Keeps answers small for the model: drops nulls and long raw payloads it doesn't need. */
function compact(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => compact(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === null || x === undefined || k === 'raw' || k === 'usage') continue;
      out[k] = depth > 6 ? '…' : compact(x, depth + 1);
    }
    return out;
  }
  return v;
}

/** Errors come back to the model as data, so it can fix the input or explain, instead of aborting the run. */
async function safe<T>(fn: () => Promise<T>): Promise<unknown> {
  try {
    return compact(await fn());
  } catch (err) {
    const e = err as Error & { status?: number; code?: string | null; body?: Json };
    return { error: true, status: e.status, code: e.code ?? undefined, message: e.message, hint: e.status === 401 ? 'The Reelspan API key is invalid.' : e.status === 404 ? 'Check the profile username or id (listProfiles).' : undefined };
  }
}

export function reelspanTools(options: ReelspanToolsOptions = {}): Record<ToolName, Tool> {
  const client = new Reelspan({ apiKey: options.apiKey, baseUrl: options.baseUrl, fetch: options.fetch, headers: { 'x-reelspan-client': `ai-sdk/${VERSION}` } });
  const allowed = (options.platforms?.length ? options.platforms : PLATFORMS) as readonly string[];
  const wait = options.wait ?? true;
  const waitTimeoutMs = options.waitTimeoutMs ?? 300_000;

  const platformsField = z
    .array(z.enum(allowed as [string, ...string[]]))
    .min(1)
    .describe('Networks to post to');
  const profileField = z.string().describe('The profile username (from listProfiles)');
  const withProfile = <T extends z.ZodRawShape>(shape: T) => (options.profile ? z.object(shape) : z.object({ profile: profileField, ...shape }));
  const who = (input: { profile?: string }) => options.profile ?? (input.profile as string);

  const postShape = {
    platforms: platformsField,
    caption: z.string().optional().describe('Caption, post text or YouTube title. Long text becomes a thread on X and Bluesky.'),
    description: z.string().optional().describe('Longer description where the network has one (YouTube, Pinterest, Reddit)'),
    scheduledDate: z.string().optional().describe('Publish later: ISO-8601 date-time. Leave out to post now.'),
    timezone: z.string().optional().describe('IANA timezone for scheduledDate, e.g. America/New_York'),
    addToQueue: z.boolean().optional().describe('Take the profile’s next free queue slot instead of a time'),
    firstComment: z.string().optional(),
    settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional().describe('Network settings, e.g. {"privacy_level":"PUBLIC_TO_EVERYONE","reddit_subreddit":"videos","pinterest_board_id":"123"}'),
  };
  type PostInput = { profile?: string; platforms: string[]; caption?: string; description?: string; scheduledDate?: string; timezone?: string; addToQueue?: boolean; firstComment?: string; settings?: Json };
  const common = (i: PostInput) => ({
    user: who(i),
    platforms: i.platforms,
    title: i.caption,
    description: i.description,
    scheduledDate: i.scheduledDate,
    timezone: i.timezone,
    addToQueue: i.addToQueue,
    firstComment: i.firstComment,
    extra: i.settings,
    async: true,
  });
  const finish = async (r: Json) => {
    if (!wait || r.job_id || !r.request_id || (r.results && Object.keys(r.results).length)) return r;
    return { request_id: r.request_id, ...(await client.posts.wait(r.request_id, { timeoutMs: waitTimeoutMs })) };
  };

  const write = { needsApproval: options.needsApproval || undefined } as const;

  const all: Record<ToolName, Tool> = {
    listProfiles: tool({
      description: 'List Reelspan profiles (brands) and which networks each has connected. Call this first to find the profile username.',
      inputSchema: z.object({}),
      execute: () =>
        safe(async () => {
          const r = await client.profiles.list();
          const rows = r.profiles.map((p) => ({ username: p.username, name: p.display_name, networks: Object.entries(p.social_accounts ?? {}).filter(([, v]) => v).map(([k]) => k) }));
          return options.profile ? rows.filter((p) => p.username === options.profile) : rows;
        }),
    }),

    uploadVideo: tool({
      description: 'Publish (or schedule) a video to one or more networks. The video is a public URL (Google Drive and Dropbox share links work) or a mediaId from the library.',
      inputSchema: withProfile({ ...postShape, videoUrl: z.string().optional().describe('Public https URL of the video'), mediaId: z.string().optional().describe('Library media id instead of a URL'), thumbnailUrl: z.string().optional() }),
      ...write,
      execute: (i: PostInput & { videoUrl?: string; mediaId?: string; thumbnailUrl?: string }) =>
        safe(async () => {
          if (!i.videoUrl && !i.mediaId) return { error: true, message: 'Give videoUrl or mediaId.' };
          return finish(await client.posts.video({ ...common(i), video: i.videoUrl, videoMediaId: i.mediaId, thumbnail: i.thumbnailUrl }));
        }),
    }),

    uploadPhotos: tool({
      description: 'Publish (or schedule) one photo or a carousel (in order) to one or more networks, from public URLs or library media ids.',
      inputSchema: withProfile({ ...postShape, photoUrls: z.array(z.string()).optional().describe('Public https URLs, in carousel order'), mediaIds: z.array(z.string()).optional(), altTexts: z.array(z.string()).optional().describe('Alt text per photo, in order') }),
      ...write,
      execute: (i: PostInput & { photoUrls?: string[]; mediaIds?: string[]; altTexts?: string[] }) =>
        safe(async () => {
          if (!i.photoUrls?.length && !i.mediaIds?.length) return { error: true, message: 'Give photoUrls or mediaIds.' };
          return finish(await client.posts.photos({ ...common(i), photos: i.photoUrls, photoMediaIds: i.mediaIds, altTexts: i.altTexts }));
        }),
    }),

    uploadText: tool({
      description: 'Publish (or schedule) a text post. Long text becomes a thread on X and Bluesky.',
      inputSchema: withProfile({ ...postShape, caption: z.string().min(1).describe('The post text') }),
      ...write,
      execute: (i: PostInput) => safe(async () => finish(await client.posts.text(common(i)))),
    }),

    uploadDocument: tool({
      description: 'Publish a PDF (or PPT/DOCX) to LinkedIn as a swipeable document.',
      inputSchema: withProfile({ ...postShape, platforms: platformsField.default(['linkedin']), caption: z.string().min(1).describe('The document title'), documentUrl: z.string().describe('Public https URL of the PDF') }),
      ...write,
      execute: (i: PostInput & { documentUrl: string }) => safe(async () => finish(await client.posts.document({ ...common(i), document: i.documentUrl }))),
    }),

    getPostStatus: tool({
      description: 'Each network’s result for a post: by request_id, or job_id for a scheduled post.',
      inputSchema: z.object({ requestId: z.string().optional(), jobId: z.string().optional() }),
      execute: (i: { requestId?: string; jobId?: string }) => safe(() => client.posts.status(i)),
    }),

    retryPost: tool({
      description: 'Send the networks that failed again, with the media Reelspan already has. Optionally change settings (e.g. a shorter caption) for this try.',
      inputSchema: z.object({ requestId: z.string(), platforms: z.array(z.string()).optional().describe('Only these; default every failed one'), settings: z.record(z.string(), z.string()).optional() }),
      ...write,
      execute: (i: { requestId: string; platforms?: string[]; settings?: Record<string, string> }) => safe(() => client.posts.retry(i.requestId, { platforms: i.platforms, fields: i.settings })),
    }),

    getPostHistory: tool({
      description: 'Recent posts, one row per network, newest first.',
      inputSchema: z.object({ profile: z.string().optional(), platform: z.string().optional(), status: z.enum(['success', 'failed']).optional(), limit: z.union([z.literal(10), z.literal(20), z.literal(50)]).optional() }),
      execute: (i: { profile?: string; platform?: string; status?: 'success' | 'failed'; limit?: 10 | 20 | 50 }) =>
        safe(async () => (await client.posts.history({ profile_username: options.profile ?? i.profile, platform: i.platform, status: i.status, limit: i.limit ?? 20 })).history),
    }),

    listScheduledPosts: tool({
      description: 'Posts waiting for their scheduled time.',
      inputSchema: z.object({ profile: z.string().optional() }),
      execute: (i: { profile?: string }) => safe(() => client.scheduled.list({ profile_username: options.profile ?? i.profile })),
    }),

    editScheduledPost: tool({
      description: 'Change the time, timezone or caption of a scheduled post.',
      inputSchema: z.object({ jobId: z.string(), scheduledDate: z.string().optional(), timezone: z.string().optional(), caption: z.string().optional(), description: z.string().optional() }),
      ...write,
      execute: (i: { jobId: string; scheduledDate?: string; timezone?: string; caption?: string; description?: string }) =>
        safe(() => client.scheduled.edit(i.jobId, { scheduled_date: i.scheduledDate, timezone: i.timezone, title: i.caption, description: i.description })),
    }),

    cancelScheduledPost: tool({
      description: 'Cancel a scheduled post so it is never published.',
      inputSchema: z.object({ jobId: z.string(), withLaterRepeats: z.boolean().optional().describe('Also cancel the later posts of a repeating series') }),
      ...write,
      execute: (i: { jobId: string; withLaterRepeats?: boolean }) => safe(() => client.scheduled.cancel(i.jobId, { withLaterRepeats: i.withLaterRepeats })),
    }),

    getAnalytics: tool({
      description: 'Followers, reach and engagement of a profile per network; with days, day-by-day history.',
      inputSchema: withProfile({ platforms: z.array(z.string()).optional(), days: z.number().int().min(1).max(365).optional().describe('Return a day-by-day history of this many days') }),
      execute: (i: { profile?: string; platforms?: string[]; days?: number }) => safe(() => (i.days ? client.analytics.history(who(i), { days: i.days, platforms: i.platforms }) : client.analytics.account(who(i), i.platforms))),
    }),

    getPostAnalytics: tool({
      description: 'Views, likes, comments and shares of one post, by request_id.',
      inputSchema: z.object({ requestId: z.string(), platform: z.string().optional() }),
      execute: (i: { requestId: string; platform?: string }) => safe(() => client.analytics.post(i.requestId, i.platform)),
    }),

    getBestTimes: tool({
      description: 'The best hours to post for a profile, from its own past engagement.',
      inputSchema: withProfile({ timezone: z.string().optional(), platforms: z.array(z.string()).optional() }),
      execute: (i: { profile?: string; timezone?: string; platforms?: string[] }) => safe(() => client.analytics.bestTimes(who(i), { timezone: i.timezone, platforms: i.platforms })),
    }),

    getQueueSlots: tool({
      description: 'The next free slots in a profile’s posting queue.',
      inputSchema: withProfile({ count: z.number().int().min(1).max(50).optional() }),
      execute: (i: { profile?: string; count?: number }) => safe(() => client.queue.preview(who(i), i.count)),
    }),

    writeCaptions: tool({
      description: 'Write a caption for each network from a short description of the post (uses one Reelspan AI credit).',
      inputSchema: z.object({ text: z.string().describe('What the post is about'), platforms: z.array(z.string()).optional(), language: z.string().optional() }),
      ...write,
      execute: (i: { text: string; platforms?: string[]; language?: string }) => safe(() => client.ai.writeCaptions({ text: i.text, platforms: i.platforms, language: i.language, kind: 'text' })),
    }),
  };

  const writes = new Set<string>(WRITE_TOOLS);
  return Object.fromEntries(
    Object.entries(all).filter(([name]) => {
      if (options.include?.length && !options.include.includes(name as ToolName)) return false;
      if (options.exclude?.includes(name as ToolName)) return false;
      if (options.readOnly && writes.has(name)) return false;
      return true;
    }),
  ) as Record<ToolName, Tool>;
}

export default reelspanTools;
