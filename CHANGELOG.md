# Changelog

## 0.1.0

First release.

- `reelspanTools()`: 16 tools for the Vercel AI SDK (v5, v6, v7): publish video, photos, text and documents; post
  status, retry, history; scheduled posts (list, edit, cancel); analytics (profile, history, post, best times); queue
  slots; AI captions; profiles.
- `profile` pins every tool to one profile (the field disappears from the schemas); `platforms` limits the networks in
  the schema itself; `readOnly`, `include`, `exclude`, `needsApproval`.
- Posts wait for each network's result by default; answers are trimmed for the model, and API errors come back as
  data with a hint instead of ending the run.
- ESM and CommonJS with types; the Reelspan client is bundled in.
