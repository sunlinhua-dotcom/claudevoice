# ClaudeVoice — developer guide

Short orientation for contributors (and for coding agents working in this repo).
User-facing setup lives in [README.md](README.md); every configuration variable is listed in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## What is where

| Path | What it is |
|---|---|
| `hook.js` | Global Claude Code hook forwarder (`Stop` / `Notification` / `SubagentStop`). Zero dependencies, always exits fast. |
| `server.js` | Optional self-hosted local server (SSE panel + Edge/Azure TTS + direct Feishu push). Node built-ins only. |
| `cloudflare/` | Cloudflare Worker + Durable Object "Hub" (SSE, Web Push, Telegram, Feishu, Workers AI summaries, TTS, relay WebSocket) and `deploy.sh`. |
| `public/` | Web panel / PWA served by both `server.js` and the Worker. |
| `shared/speech.cjs` | Speech layer shared by the three hosts: voice assignment, name pronunciation, sentence templates, summary cleanup. |
| `mac-app/` | Menu-bar app (Swift, built with `swiftc`, no Xcode project): local playback, dictation, text/paste injection, pairing QR, optional box sync. |
| `bridge/` | **cc-bridge** — drives Claude Code from a Feishu private chat (tasks, approval cards, voice, attachments, remote input). ESM, PM2 daemon. |
| `wxbridge/` | Files WeChat briefs/attachments into `<project>/_inbox/`. ESM, PM2 daemon. |
| `tools/sfx/` | Local generator for per-project notification sounds (Stable Audio Open Small). |
| `tools/cvname` | Hot-edit project pronunciations on a deployed Worker without redeploying. |
| `names.json` | Project display-name / pronunciation table, read by `hook.js`, `server.js`, the Worker (bundled at deploy time) and `tools/sfx`. |
| `test/`, `bridge/test/` | `node --test` suites. Files named `*.test.mjs` are unit tests; other `.mjs` files in `bridge/test/` are live smoke scripts. |

Event flow: `hook.js` → `POST <worker or server>/hook` → normalise event → `buildSpeak`
(`shared/speech.cjs` for the template, Workers AI for the summary) → SSE broadcast + Web Push /
Telegram / Feishu; the panel or Mac app then calls `/tts` for audio.

## Commands

```bash
npm test                                          # root suite: speech layer, hook detaching, Worker cache / rate limit / SSE
cd bridge && npm ci && npm test                   # cc-bridge suite
cd cloudflare && npx wrangler deploy --dry-run    # bundle check for the Worker (the real "does it build" test)
cd mac-app && ./build.sh --no-install             # macOS only; builds without installing
```

`bridge/package.json` also has many `test:*` scripts. Those talk to real Feishu / a real relay / real
apps and need credentials in `bridge/.env`; do not run them unattended.

## Pitfalls specific to this repo

- **CJS and ESM are mixed.** The root `package.json` has no `"type": "module"`, so `hook.js`,
  `server.js` and `setup.js` are CommonJS, while `bridge/`, `wxbridge/` and
  `cloudflare/src/worker.js` are ESM. The shared speech layer is therefore `shared/speech.cjs`.
- **`node --check cloudflare/src/worker.js` proves nothing** — it parses the file as CJS. Use
  `npx wrangler deploy --dry-run`.
- **`shared/speech.cjs` must stay pure**: no `fs`, no `fetch`, no `process.env`, no module-level
  state. It is bundled verbatim into the Worker by esbuild, and side effects blow up at the edge.
- **In `worker.js`, import it as a default and destructure** (`import speech from '../../shared/speech.cjs'`).
  Named imports from a local `.cjs` are unreliable under esbuild interop.
- **Voice overrides are accepted as-is.** `assignVoice(key, override)` honours names outside the
  built-in pool; the Worker's `resolveVoiceEdge` is the safety net (only names in `EDGE_VOICE_MAP`
  or the `zh-CN-XxxNeural` shape pass, everything else falls back to XiaoxiaoNeural).
- **Spoken alerts are never English.** If no Chinese summary is available the fallback sentence is
  used on purpose.
- **cc-bridge has no clipboard.** Under PM2 it is not in a desktop session, so `pbcopy` / AppleScript
  fail. Clipboard and paste actions are delegated to `ClaudeVoice.app` through `inject_key`
  (`cv:` + JSON), see `bridge/inject.mjs` (`buildMacCommand`) and `mac-app/ItemPaster.swift`.
  After changing `mac-app/`, rebuild with `mac-app/build.sh` and restart the app.
- **One Feishu app = one long-connection consumer.** Never run two processes with the same
  `LARK_APP_ID` (for example cc-bridge and an older listener).
- **One WeChat bot token = one long-poll consumer.** Same rule for `wxbridge`.
- Do not run `node server.js` on a port that something else already owns; the default is 8787.

## Rules for contributions

- Pronunciation / phrasing changes go in `shared/speech.cjs` only, never copy them into hosts.
- Secrets never go into the repo, logs or test fixtures. Use the `*.example` files for new settings
  and document every new variable in `docs/CONFIGURATION.md`.
- Add or update a test for behaviour changes; keep the two suites green (`npm test` in the root
  and in `bridge/`).
- Run `npx wrangler deploy --dry-run` before sending a PR that touches `cloudflare/`.
