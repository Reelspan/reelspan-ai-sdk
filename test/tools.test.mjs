// Calls the tools against a stand-in fetch (no network): inputs, what is sent, filters, pinned profile, errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { reelspanTools, WRITE_TOOLS } from '../dist/index.js';

const seen = [];
function fakeFetch(routes) {
  return async (url, init = {}) => {
    const u = new URL(url);
    let body = init.body;
    if (body instanceof FormData) body = Object.fromEntries([...body.keys()].map((k) => [k, body.getAll(k).length > 1 ? body.getAll(k) : body.get(k)]));
    else if (typeof body === 'string') body = JSON.parse(body);
    seen.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers, body });
    const [status, json] = routes[`${init.method} ${u.pathname}`] ?? [404, { message: 'Not found', error_code: 'NOT_FOUND' }];
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  };
}
const routes = {
  'GET /v1/profiles': [200, { profiles: [{ username: 'acme', display_name: 'Acme', social_accounts: { tiktok: { u: 1 }, x: '' } }, { username: 'other', social_accounts: {} }] }],
  'POST /v1/posts/text': [202, { success: true, request_id: 'req_1' }],
  'GET /v1/posts/status': [200, { status: 'completed', results: [{ platform: 'x', success: true, url: 'https://x.com/1', raw: { big: true } }] }],
  'POST /v1/posts/video': [202, { success: true, job_id: 'job_1' }],
};
const opts = (o = {}) => ({ apiKey: 'rs_test', fetch: fakeFetch(routes), ...o });
const run = (t, input) => t.execute(input, { toolCallId: '1', messages: [] });

test('every tool is there, with schemas', () => {
  const tools = reelspanTools(opts());
  assert.equal(Object.keys(tools).length, 16);
  for (const t of Object.values(tools)) {
    assert.equal(typeof t.description, 'string');
    assert.equal(typeof t.execute, 'function');
    assert.ok(t.inputSchema);
  }
});

test('uploadText posts, waits and returns compact results', async () => {
  const r = await run(reelspanTools(opts()).uploadText, { profile: 'acme', platforms: ['x'], caption: 'Hello', firstComment: 'link' });
  assert.deepEqual(r, { request_id: 'req_1', status: 'completed', results: [{ platform: 'x', success: true, url: 'https://x.com/1' }] });
  const sent = seen.find((s) => s.path === '/v1/posts/text');
  assert.deepEqual(sent.body.platform, ['x']);
  assert.equal(sent.body.user, 'acme');
  assert.equal(sent.body.first_comment, 'link');
  assert.equal(sent.headers.authorization, 'Bearer rs_test');
  assert.ok(sent.headers['idempotency-key']);
  assert.match(sent.headers['x-reelspan-client'], /^ai-sdk\//);
});

test('a pinned profile removes the field and is always used', async () => {
  const tools = reelspanTools(opts({ profile: 'acme' }));
  assert.equal(tools.uploadVideo.inputSchema.shape.profile, undefined);
  await run(tools.uploadVideo, { profile: 'other', platforms: ['tiktok'], videoUrl: 'https://cdn.example.com/a.mp4', scheduledDate: '2026-12-01T09:00:00Z' });
  const sent = seen.findLast((s) => s.path === '/v1/posts/video');
  assert.equal(sent.body.user, 'acme');
  assert.equal(sent.body.video, 'https://cdn.example.com/a.mp4');
  const list = await run(tools.listProfiles, {});
  assert.deepEqual(list, [{ username: 'acme', name: 'Acme', networks: ['tiktok'] }]);
});

test('allowed networks are enforced by the schema', () => {
  const t = reelspanTools(opts({ platforms: ['x', 'linkedin'] })).uploadText;
  assert.equal(t.inputSchema.safeParse({ profile: 'a', platforms: ['tiktok'], caption: 'hi' }).success, false);
  assert.equal(t.inputSchema.safeParse({ profile: 'a', platforms: ['x'], caption: 'hi' }).success, true);
});

test('read-only, include, exclude and approval', () => {
  const ro = reelspanTools(opts({ readOnly: true }));
  for (const w of WRITE_TOOLS) assert.equal(ro[w], undefined);
  assert.ok(ro.getAnalytics);
  assert.deepEqual(Object.keys(reelspanTools(opts({ include: ['listProfiles', 'uploadText'] }))).sort(), ['listProfiles', 'uploadText']);
  assert.equal(reelspanTools(opts({ exclude: ['cancelScheduledPost'] })).cancelScheduledPost, undefined);
  const ap = reelspanTools(opts({ needsApproval: true }));
  assert.equal(ap.uploadText.needsApproval, true);
  assert.equal(ap.listProfiles.needsApproval, undefined);
});

test('API errors come back as data the model can act on', async () => {
  const r = await run(reelspanTools(opts()).getPostAnalytics, { requestId: 'nope' });
  assert.equal(r.error, true);
  assert.equal(r.status, 404);
  assert.equal(r.code, 'NOT_FOUND');
  const missing = await run(reelspanTools(opts()).uploadVideo, { profile: 'a', platforms: ['tiktok'] });
  assert.match(missing.message, /videoUrl or mediaId/);
});

test('CommonJS build loads', () => {
  const require = createRequire(import.meta.url);
  assert.equal(typeof require('../dist/index.cjs').reelspanTools, 'function');
});
