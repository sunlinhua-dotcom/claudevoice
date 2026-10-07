# ClaudeVoice configuration reference

ClaudeVoice has several independent parts. You only configure the ones you use. Every file below
has a ready-to-copy example in this repository.

| Part | What it does | Config lives in | Example file |
|---|---|---|---|
| Hook (`hook.js`) | Forwards Claude Code events | `~/.claude/claudevoice.json` + env | `config/claudevoice.json.example` |
| Local server (`server.js`) | Panel, TTS, direct Feishu push | `./.env` | `.env.example` |
| Cloudflare Worker | Public panel, Web Push, Telegram, Feishu, relay | Wrangler secrets + `[vars]` | `cloudflare/wrangler.toml`, `cloudflare/.dev.vars.example` |
| Mac app | Local voice, dictation, remote-input target, box sync | `~/.claude/claudevoice-app.json`, `~/.config/claudevoice/xiaozhi.json` | `config/claudevoice-app.json.example`, `config/xiaozhi.json.example` |
| cc-bridge (`bridge/`) | Drive Claude Code from Feishu (text, voice, approvals, files) | `bridge/.env`, `bridge/projects.json` | `bridge/.env.example`, `bridge/projects.example.json` |
| wxbridge (`wxbridge/`) | File WeChat briefs into project folders | env vars, `~/.wxbridge/` | `wxbridge/.env.example` |
| Project names | How each project is shown and pronounced | `names.json`, `projects.json` | `names.json`, `projects.example.json` |
| CloudCLI web link (optional) | Deep links to a self-hosted web UI | `CC_WEB_URL` / `webUrl` | see section 9 |
| Sound cues (`tools/sfx`) | Per-project notification sounds | `~/.claude/cv-cues/` | n/a |

Rule of thumb: **secrets never go in the repo**. Local files are gitignored (`.env`,
`bridge/.env`, `projects.json`, `bridge/projects.json`, `bridge/state.json`, `cloudflare/.dev.vars`).

---

## 1. Hook (`hook.js`)

`node setup.js` writes `~/.claude/claudevoice.json` and merges the hooks into `~/.claude/settings.json`
(after a backup). By hand:

```json
{ "url": "http://127.0.0.1:8787/hook", "secret": "<HOOK_SECRET>", "projectRoots": ["/Users/you/Projects"], "webUrl": "" }
```

- `url` - local server (`http://127.0.0.1:8787/hook`) or your Worker (`https://<name>.<you>.workers.dev/hook`).
- `secret` - must equal `HOOK_SECRET` on the receiving side.
- `webUrl` - optional CloudCLI web UI address (section 9); `node setup.js` asks for it and may leave it out.
- `projectRoots` - optional. When `cwd` is under one of these, the project name is the first path
  segment below the root (default roots: your home folder and `~/Desktop`).

Environment variables (all optional):

| Variable | Effect |
|---|---|
| `CLAUDEVOICE_URL`, `CLAUDEVOICE_SECRET` | Override `url` / `secret` from the JSON file |
| `CLAUDEVOICE_NATIVE=0` | Disable the macOS notification banner |
| `CLAUDEVOICE_VOICE=0` | Disable the local fallback voice |
| `CLAUDEVOICE_LARK=1` | Force Feishu push even for sessions started from a web UI |
| `CLAUDEVOICE_ORIGIN=web\|desktop` | Force how the session origin is classified (tests / escape hatch) |
| `CC_BRIDGE=1` | Set by cc-bridge for the Claude children it spawns; the hook then exits silently |
| `CLAUDEVOICE_IMSG_BIN` | Path to an executable that receives one argument (a text line). When set, long tasks (see below) call it after finishing - use it to send an iMessage, Slack message, `ntfy`, etc. **Unset = feature off.** |
| `CLAUDEVOICE_IMSG_MIN_SECS` | Only notify for turns longer than this (default `120`) |
| `CLAUDEVOICE_IMSG=0` | Turn that notifier off even if the binary is set |
| `CC_WEB_URL` | Base URL of your Claude Code web UI (see section 9). Overrides `webUrl` in `claudevoice.json`; an empty value disables links. Unset everywhere = **no link in the notification** |

Sub-agent completion is controlled by `CV_SUBAGENT` (`silent` default / `voice` / `off`) on the
server or Worker.

## 2. Local server (`server.js`)

`node setup.js` creates `.env`. All variables are in [`.env.example`](../.env.example) with a comment each.
The server needs no `npm install`. Do not expose it to the internet without `DASH_TOKEN`.

Feishu direct push (no Worker): create an enterprise self-built app at <https://open.feishu.cn/app>,
enable the bot, grant `im:message` and `contact:user.id:readonly`, publish a version, then put
`LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_OPEN_ID` in `.env` (the setup wizard can look up your `open_id`
from your mobile number). Alternative: a group custom-bot webhook in `LARK_WEBHOOK_URL`
(+ `LARK_WEBHOOK_SECRET` if signing is on).

## 3. Cloudflare Worker (`cloudflare/`)

```bash
cd cloudflare
npx wrangler login
./deploy.sh        # deploys, sets secrets from ../.env, rewrites ~/.claude/claudevoice*.json
```

`wrangler.toml` contains **no account identifiers**: Wrangler uses the account you are logged in
with. If you have several accounts, add `account_id = "<your account id>"` at the top. To serve the
panel from your own domain instead of `workers.dev`, add a `routes` entry (see the comments in the file).

Secrets (set with `npx wrangler secret put NAME`; `deploy.sh` sets the starred ones for you):

| Secret | Purpose |
|---|---|
| `HOOK_SECRET` * | Shared secret between the hook / Mac app / bridge and the Worker |
| `DASH_TOKEN` * | Token for the panel (`/?token=...`) |
| `VAPID_PUBLIC`, `VAPID_PRIVATE`, `VAPID_SUBJECT` * | Web Push keys (`cloudflare/scripts/gen-vapid.mjs`); subject like `mailto:you@example.com` |
| `UNLOCK_PASSWORD` | Optional phone-panel password; unset = `/unlock` always refuses |
| `USER_NAME`, `USER_ALIASES` | Name used in spoken alerts (default `Dev`) and comma-separated alternates |
| `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` * | Optional Azure TTS fallback |
| `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_OPEN_ID` * | Feishu bot DM |
| `LARK_WEBHOOK_URL`, `LARK_WEBHOOK_SECRET` * | Feishu group-bot fallback |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` * | Telegram push |
| `DASH_URL` | Public panel URL for the Feishu card button |
| `CV_SUBAGENT` | `silent` / `voice` / `off` |
| `XIAOZHI_ANNOUNCE_URL`, `XIAOZHI_ANNOUNCE_TOKEN` | Optional: announce done / waiting / permission / failed events on your own xiaozhi-style voice-box server (see section 5). Unset = off |

Plain `[vars]` in `wrangler.toml`: `TTS_ENGINE` (`edge`), `TTS_VOICE` (default display voice).
`names.json` is **bundled at deploy time**; edit it and redeploy, or hot-edit a running Worker with
`tools/cvname`.

Local development: copy `cloudflare/.dev.vars.example` to `cloudflare/.dev.vars`, then `npx wrangler dev --port 8788`.
`npx wrangler deploy --dry-run` bundles without deploying.

## 4. Project names and pronunciation

- `names.json` (repo root) - display name and spoken form per project directory name. The shipped
  file only contains examples; replace them. Unknown projects are split into words automatically
  and the Worker can ask you (Feishu DM) how to read them.
- `projects.json` (copy `projects.example.json`) - optional per-project colour and voice
  (`茉莉` / `白桦` / `冰糖` / `苏打`).
- `tools/cvname <project> <reading> [display name]` - hot-edits a deployed Worker
  (reads `base` and `token` from `~/.claude/claudevoice-app.json`).

## 5. Mac app (`mac-app/`)

Build: `cd mac-app && ./build.sh` (macOS 13+, `swiftc` only). Releases are ad-hoc signed.

`~/.claude/claudevoice-app.json` (see `config/claudevoice-app.json.example`): `base` (server or Worker
URL), `token` (= `HOOK_SECRET`), `panelToken` (= `DASH_TOKEN`), `relay` (`wss://<worker>/ws`, enables
remote input and the pairing QR). When the file is missing the app derives `base` / `token` from
`~/.claude/claudevoice.json`.

Build / signing environment variables (`build.sh`, `notarize.sh`):

| Variable | Meaning |
|---|---|
| `CV_ARCH` | `arm64` or `x86_64` (CI builds both and merges with `lipo`) |
| `OUT_DIR` | Output directory for `--no-install` builds |
| `CV_USE_DEVID=1`, `CV_SIGN_ID` | Sign with a Developer ID certificate instead of ad-hoc |
| `RV_SIGN_ID`, `RV_KCPASS` | Name and password of an optional local self-signed identity in `~/Library/Keychains/remoteinput-signing.keychain-db` (keeps macOS privacy grants stable across rebuilds) |
| `CV_TEAM_ID` | **Required for `notarize.sh`**: your Apple Developer Team ID |
| `CV_NOTARY_PROFILE`, `CV_APP_PATH` | Keychain profile name (default `claudevoice`) and app path for notarization |

Optional **box sync** - speak in step with your own xiaozhi-style ESP32 voice box server: create
`~/.config/claudevoice/xiaozhi.json` (see `config/xiaozhi.json.example`; `bases`, `device_id`, `token`
required) and set `XIAOZHI_ANNOUNCE_URL` / `XIAOZHI_ANNOUNCE_TOKEN` on the Worker. Without the file the
feature is disabled.

## 6. cc-bridge: drive Claude Code from Feishu

Requirements: Node >= 18, `claude` CLI installed and logged in, PM2 (`npm i -g pm2`), `ffmpeg` for voice messages.

1. **Create the Feishu app.** <https://open.feishu.cn/app> > create enterprise self-built app > enable
   *Bot*. Permissions: send/receive/patch messages (`im:message`), receive direct messages, download and upload
   images and files (`im:resource`), speech recognition (`speech_to_text:speech`) and
   `contact:user.id:readonly`. When a call fails the Feishu console names the exact missing scope - add it and
   publish a new version.
2. **Events and callbacks.** Event subscription mode: *long connection*. Subscribe to
   `im.message.receive_v1`; in callbacks enable *long connection* and subscribe to `card.action.trigger`.
   Publish a version.
3. **Find your `open_id`.** Message the bot once and read it from the log, or use the Feishu API
   explorer (user id type `open_id`). It looks like `ou_` followed by letters/digits.
4. **Configure.**
   ```bash
   cd bridge
   cp .env.example .env            # fill LARK_APP_ID / LARK_APP_SECRET / LARK_OPEN_ID, CC_APPROVAL_TOKEN
   cp projects.example.json projects.json   # optional: list projects explicitly
   npm ci && npm test
   ```
   Projects are the union of `projects.json`, the repo itself, and every sub-directory of
   `CC_WORKSPACE_ROOT` (default `~/Projects`).
5. **Run.** `pm2 start index.mjs --name cc-bridge && pm2 save`. One Feishu app can have only one
   long-connection consumer, so stop any other process that uses the same app first.
6. **Talk to it.** Send `/help` to the bot. Voice and text go to the computer ("input mode", needs the
   relay below) or to Claude (`/task`).

Optional pieces (all in `bridge/.env`, see the commented example):

- **Remote input / voice-to-cursor**: deploy the Worker (section 3), install the Mac app, pair it, then set
  `RELAY_URL=wss://<worker>/ws`, `MAC_ID` (from the Mac app pairing window, or
  `defaults read com.claudevoice.app rv.macId`) and `DEVICE_NAME`. Without them the bridge runs in task-only mode.
- **Lifecycle events to the panel**: `CV_WORKER_URL` + `HOOK_SECRET` (same as the Worker's).
- **Session links** in cards and `/sessions`: set `CC_WEB_URL` (section 9). Unset = no "open cockpit" button, no link lines, `/status` does not probe the web UI.
- **Card banners**: `npm run assets:upload` uploads `bridge/assets/banners/*.png` to your Feishu app and
  writes `bridge/assets/img-keys.json` (gitignored). Without it the cards simply have no banner image.
- Tuning: `CC_GLOBAL_LIMIT`, `CC_TASK_TIMEOUT_MS`, `CC_APPROVAL_TIMEOUT_MS`, `CC_ASK_TIMEOUT_MS`,
  `CC_AUTO_ALLOW_READONLY`, `CC_SEND_FILES`, `CC_CARD_THROTTLE_MS`, `FFMPEG_PATH`.

Security notes: only `LARK_OPEN_ID` can drive the bridge; `/mode yolo` skips all tool approvals; received
files live under `<project>/.cc-bridge/incoming/` (cleaned after 24 h).

## 7. wxbridge: WeChat briefs into project folders

Requirements: Node >= 20, PM2.

```bash
cd wxbridge && npm ci
node login.mjs                      # scan the QR with WeChat; writes ~/.wxbridge/account.json
pm2 start start.mjs --name wxbridge --time
```

It reads the project list from `../bridge/projects.json` (run cc-bridge once or copy
`bridge/projects.example.json` to `bridge/projects.json`). All settings are optional environment
variables, documented in [`wxbridge/.env.example`](../wxbridge/.env.example). Details of the commands you
can send in WeChat and the project-detection order are in [`wxbridge/README.md`](../wxbridge/README.md).
Only one process may poll a given bot token.

## 8. Per-project sound cues (`tools/sfx`)

Optional and fully offline: generates a short "done" and "alert" sound for every project in `names.json`
with Stable Audio Open Small.

```bash
python3 -m venv .venv && . .venv/bin/activate        # any virtualenv works
pip install stable-audio-tools torch
# put the model files here (download them from Hugging Face yourself):
#   ~/.cache/cv-sfx/model/model_config.json and model.safetensors   (stabilityai/stable-audio-open-small)
#   ~/.cache/cv-sfx/t5-base/                                       (google-t5/t5-base)
tools/sfx/cv-sfx batch      # writes ~/.claude/cv-cues/<project>-done.wav / -alert.wav
tools/sfx/cv-sfx list       # which timbre each project got
```

Requires `ffmpeg`. If you are behind a slow link to Hugging Face, set `HF_ENDPOINT` yourself.

## 9. CloudCLI web link (optional)

**What it does.** If you self-host a Claude Code web UI, ClaudeVoice can deep-link into it:

- the "finished / failed" notification line sent by the optional notifier (`CLAUDEVOICE_IMSG_BIN`) ends with `<URL>/session/<session id>`;
- cc-bridge Feishu cards get an "open cockpit" button for the task's session, and `/sessions` lists a link per session.

**Without it nothing breaks.** With no URL configured no link is generated anywhere: cards simply have no such button,
messages have no link line, and `/status` does not probe for the web UI.

**How to get one.**

1. Self-host [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) (CloudCLI) on the machine where Claude Code runs; it listens on port 3001 by default.
2. Make it reachable from your phone: a Cloudflare Tunnel (`cloudflared tunnel` with an ingress rule to `http://127.0.0.1:3001`) or Tailscale Funnel
   (`tailscale funnel 3001`). Protect it with its own login; it can run commands on your machine.
3. The deep link format is `<URL>/session/<session id>`, so give ClaudeVoice only the base URL, for example `https://cc.example.com`.

**Where to set it.**

| Where | Setting | Used by |
|---|---|---|
| `node setup.js` (asks, blank = skip) | writes `CC_WEB_URL` to the root `.env` and `webUrl` to `~/.claude/claudevoice.json` | the hook (notification line) |
| `~/.claude/claudevoice.json` | `"webUrl": "https://cc.example.com"` | the hook (Claude Code does not load `.env`, so this file or the env var is what the hook sees) |
| `bridge/.env` | `CC_WEB_URL=https://cc.example.com` | cc-bridge cards, `/sessions`, `/status`, `/help` |
| Cloudflare Worker | nothing - the Worker does not create these links | |

Environment variable `CC_WEB_URL` always wins over `webUrl` in the JSON file.

## 10. Troubleshooting quick list

- *Nothing is spoken* - open the panel or start the Mac app; something must be playing audio.
- *401 on the panel* - use the URL printed by `deploy.sh` (it includes `?token=`).
- *Hook does nothing* - check `url` ends with `/hook` and `secret` equals `HOOK_SECRET`; start a **new** Claude session.
- *Bridge says "missing LARK_APP_ID"* - `bridge/.env` is read from the `bridge/` directory, not the repo root.
- *Bridge connects but no messages arrive* - the app version with the event subscription is not published, or another process holds the long connection.
