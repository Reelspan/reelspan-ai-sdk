# @reelspan/ai-sdk

[Reelspan](https://reelspan.com) tools for the [Vercel AI SDK](https://ai-sdk.dev). Let a model publish videos,
photos, text and PDFs to TikTok, YouTube, Instagram, Facebook, X, Threads, LinkedIn, Pinterest, Bluesky, Reddit and
12 more networks, check how each went, retry failures, manage the schedule and read analytics.

```bash
npm install @reelspan/ai-sdk ai zod
```

```ts
import { generateText, stepCountIs } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { reelspanTools } from '@reelspan/ai-sdk';

const { text } = await generateText({
  model: anthropic('claude-sonnet-5-5'),
  tools: reelspanTools(), // reads REELSPAN_API_KEY
  stopWhen: stepCountIs(8),
  prompt: 'Post https://cdn.example.com/launch.mp4 to TikTok and YouTube for acme tomorrow at 9am New York time, with a caption that fits each.',
});
```

Works with AI SDK 5, 6 and 7, any model provider, `generateText`, `streamText` and agents.

## Tools

| Tool | |
|---|---|
| `listProfiles` | Profiles and their connected networks |
| `uploadVideo` | Video from a URL (Drive/Dropbox links work) or library media id |
| `uploadPhotos` | One photo or a carousel, with alt text |
| `uploadText` | Text; long text becomes a thread on X and Bluesky |
| `uploadDocument` | A PDF as a LinkedIn document |
| `getPostStatus`, `retryPost`, `getPostHistory` | After posting |
| `listScheduledPosts`, `editScheduledPost`, `cancelScheduledPost` | The schedule |
| `getAnalytics`, `getPostAnalytics`, `getBestTimes` | How it did, when to post |
| `getQueueSlots` | The profile's next free queue slots |
| `writeCaptions` | Captions written for each network (one AI credit) |

Every posting tool takes `scheduledDate` + `timezone`, `addToQueue`, `firstComment` and `settings` for network options
(`{"privacy_level": "PUBLIC_TO_EVERYONE", "reddit_subreddit": "videos"}`; Upload-Post field names work too).

## Options

```ts
reelspanTools({
  apiKey: process.env.REELSPAN_API_KEY,
  profile: user.reelspanProfile,      // pin to one profile: the model can't post as anyone else
  platforms: ['linkedin', 'x'],       // only these networks, enforced in the schema
  readOnly: true,                     // no posting, editing or cancelling
  needsApproval: true,                // ask before any tool that writes (AI SDK tool approval)
  include: ['uploadText', 'getPostStatus'],
  exclude: ['cancelScheduledPost'],
  wait: true,                         // wait for each network's result after posting (default)
  waitTimeoutMs: 300_000,
});
```

`WRITE_TOOLS` lists the tools that publish or change something, if you'd rather handle approval yourself.

## Behaviour

- Posts carry an idempotency key and network errors are retried, so a retried step never double-posts.
- Answers are trimmed (no raw network payloads) to save tokens.
- API errors are returned to the model as `{ error, status, code, message, hint }`, so it can fix the input or tell
  the user, instead of throwing out of the run.

## Links

[API reference](https://reelspan.com/docs) · [MCP server](https://github.com/Reelspan/reelspan-mcp) ·
[Node SDK](https://github.com/Reelspan/reelspan-node)

MIT licensed. Security reports: see [SECURITY.md](SECURITY.md).
