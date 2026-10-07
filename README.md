<div align="center">

<img src="assets/og-card.png" alt="ClaudeVoice — voice & phone alerts for Claude Code" width="820">

<h1>ClaudeVoice</h1>

**Hear which Claude Code session just finished — or is quietly waiting on you.**
Global voice + phone alerts for every Claude Code project. Free, keyless by default, one install.

[![macOS 13+](https://img.shields.io/badge/macOS-13%2B-0b0d24?logo=apple&logoColor=white)](#-native-macos-app)
[![TTS: free, no API key](https://img.shields.io/badge/TTS-free%20%C2%B7%20no%20API%20key-7c8cff)](#-install)
[![Node ≥14](https://img.shields.io/badge/Node-%E2%89%A514-3c873a?logo=node.js&logoColor=white)](#-install)
[![License: MIT](https://img.shields.io/github/license/sunlinhua-dotcom/claudevoice?color=8b93c7)](LICENSE)
[![Stars](https://img.shields.io/github/stars/sunlinhua-dotcom/claudevoice?style=social)](https://github.com/sunlinhua-dotcom/claudevoice/stargazers)

**English** · [简体中文](README.zh-CN.md)

</div>

---

## The problem

You start a Claude Code task, switch to Slack or another repo, and then wait. The agent may have **finished** two minutes later, but you do not notice for ten. Or worse, it **stopped for approval** and sits there silently while you think it is still working.

**ClaudeVoice makes every Claude Code session audible.** The moment a project finishes or needs you, it says *which project* and *what happened*, then optionally pings your phone.

<div align="center">
<img src="assets/demo.gif" alt="ClaudeVoice command deck speaking while a phone receives an alert" width="880">
<br><sub>The command deck speaks which project needs you, while your phone gets the alert.</sub>
</div>

## ⚡ Install

Copy one command:

```bash
curl -fsSL https://raw.githubusercontent.com/sunlinhua-dotcom/claudevoice/main/install.sh | bash
```

The installer checks Git and Node 14+, downloads or updates `~/ClaudeVoice`, runs the global-hook setup wizard, and on macOS offers to install the prebuilt menubar app. It is safe to run again.

**Or:** open [GitHub Releases](https://github.com/sunlinhua-dotcom/claudevoice/releases), download `ClaudeVoice.app.zip`, unzip it, and double-click the app. On a first-ever install, still run `node setup.js` once so Claude Code has global hooks and the app has its local configuration.

Then start the zero-dependency local service:

```bash
cd ~/ClaudeVoice
node server.js
```

Open <http://localhost:8787>, or use the menubar app, then start a **new** Claude Code session and finish a small task.

## Why you will like it

- 🔊 **Speaks for free.** Microsoft Edge neural speech is the default: no API key, account, or fee.
- 🌐 **Global.** Hooks live under `~/.claude`, so every project and every newly opened session is covered.
- 🎨 **Easy to distinguish.** Each project gets a stable color and one of four voices: 茉莉, 冰糖, 白桦, or 苏打.
- 📱 **Phone alerts without mandatory cloud deployment.** The local server can send Feishu cards directly.
- 🖥️ **Native macOS app.** A cinematic chime and spoken line play without keeping a browser tab open.
- 🛡️ **Never blocks Claude.** If ClaudeVoice is offline, the hook exits quickly and Claude Code continues.
- 🧩 **Zero server dependencies.** The local server uses Node built-ins only.

## How it works

<div align="center">
<img src="assets/flow.png" alt="Claude Code → hook.js → local server or Worker → voice panel and phone alert" width="900">
</div>

- **Trigger** — Claude Code global hooks fire on `Stop`, `Notification`, and `SubagentStop` (silent by default).
- **`hook.js`** — forwards the event and exits immediately.
- **Local server or Worker** — broadcasts over SSE and synthesizes speech through `Edge → Azure when configured`.
- **Panel and Mac app** — speak the event; Feishu, Web Push, or Telegram can carry the phone alert.

## 📱 Phone notifications

### Recommended: direct Feishu push, local server only

No Worker is required. Run `node setup.js`, answer **yes** to Feishu, and follow the wizard:

1. Open the [Feishu Open Platform app console](https://open.feishu.cn/app) and create an enterprise custom app.
2. Grant `im:message` and `contact:user.id:readonly`.
3. Create and publish an app version so the permissions take effect.
4. Copy the App ID and App Secret.
5. Paste those plus your Feishu mobile number into the wizard. It obtains a tenant token, resolves the number to `open_id`, and writes `LARK_APP_ID`, `LARK_APP_SECRET`, and `LARK_OPEN_ID` to `.env`.
6. Start `node server.js`. Completion, waiting, and permission events now arrive as Feishu cards.

If lookup fails, confirm the app is published, both permissions are active, and the mobile number belongs to the current Feishu organization.

### Advanced: Cloudflare Worker

Use this when you want a public panel, PWA/Web Push, Telegram, or access while away from your Mac:

```bash
cd cloudflare
npx wrangler login
./deploy.sh
```

The script deploys, configures secrets, parses the real `workers.dev` URL, backs up both ClaudeVoice JSON files, and switches the hook, Mac app TTS, and relay automatically. See [cloudflare/README.md](cloudflare/README.md).

## 🖥️ Native macOS app

### Download first

Download `ClaudeVoice.app.zip` from [Releases](https://github.com/sunlinhua-dotcom/claudevoice/releases), unzip it, and move the app to `/Applications`. The release is a universal app for Apple Silicon and Intel.

Because releases are ad-hoc signed rather than notarized, first launch may require **right-click → Open**. The one-command installer removes quarantine automatically. Manual alternative:

```bash
xattr -dr com.apple.quarantine /Applications/ClaudeVoice.app
```

On first launch, the app reads `~/.claude/claudevoice-app.json`. If it is absent, it derives `base` and the `/tts` secret automatically from `~/.claude/claudevoice.json`.

### Build from source

```bash
cd mac-app
./build.sh                 # build and install to /Applications
./build.sh --no-install    # build only to mac-app/build; do not install or restart
```

This uses `swiftc` directly and requires macOS 13+. If relay configuration is absent, remote input stays disabled gracefully while speech continues normally.

## 🤖 Drive Claude Code from your phone

`bridge/` (**cc-bridge**) is a separate power-user daemon for controlling Claude Code from a Feishu private chat: send tasks by voice or text, approve tools with cards, run multiple sessions, and receive files. It needs its own Feishu setup. See [bridge/README.md](bridge/README.md).

## Configuration

`setup.js` creates a working `.env`. Common optional values:

| Variable | Meaning |
|---|---|
| `TTS_ENGINE` | `edge` by default |
| `TTS_VOICE` | Default display voice, `茉莉` |
| `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | Optional Azure fallback |
| `USER_NAME` | The name used in spoken alerts |
| `PORT` / `HOST` | Local service address; port defaults to `8787` |
| `HOOK_SECRET` | Auto-generated hook and Mac app TTS secret |
| `DASH_TOKEN` | Required before exposing the panel publicly |
| `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_OPEN_ID` | Direct Feishu push |

Copy `projects.example.json` to `projects.json` to pin project names, colors, and voices:

```json
{
  "web-app": { "name": "Web app", "color": "#46e0b0", "voice": "茉莉" },
  "api": { "name": "API", "color": "#ffcd5b", "voice": "白桦" }
}
```

## Everything else (full feature map)

ClaudeVoice is a small family of parts; each is optional and has its own example config. The complete
variable-by-variable reference is [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

| Part | What it gives you | Start here |
|---|---|---|
| `hook.js` + `server.js` | Voice/phone alerts from any Claude Code session | this README, `.env.example`, `config/claudevoice.json.example` |
| `cloudflare/` | Public panel, PWA/Web Push, Telegram, Feishu, WebSocket relay | [cloudflare/README.md](cloudflare/README.md), `cloudflare/wrangler.toml` |
| `mac-app/` | Menu-bar app: voice, dictation, paste-into-cursor, optional voice-box sync | `config/claudevoice-app.json.example`, `config/xiaozhi.json.example` |
| `bridge/` (cc-bridge) | Drive Claude Code from a Feishu chat: voice/text tasks, approval cards, files, remote input | [bridge/README.md](bridge/README.md), `bridge/.env.example` |
| `wxbridge/` | Auto-file WeChat client briefs and attachments into project folders | [wxbridge/README.md](wxbridge/README.md), `wxbridge/.env.example` |
| CloudCLI web link (optional) | Deep links from notifications and Feishu cards into your self-hosted [CloudCLI](https://github.com/siteboon/claudecodeui) web UI; off unless `CC_WEB_URL` is set | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) section 9 |
| `tools/sfx`, `tools/cvname` | Per-project sound cues; hot-edit pronunciations on a live Worker | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) sections 4 and 8 |
| `names.json`, `projects.example.json` | How each project is displayed and pronounced | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) section 4 |

## Honest notes

ClaudeVoice is honest about what it is today:

- **macOS-first.** Hook forwarding and the web panel are cross-platform; the native app, banners, and some summarization behavior are macOS-oriented.
- **Chinese-first voices and UI.** Edge supports more languages, but the bundled four-voice experience is tuned for Chinese.
- **Some player must be active.** The web tab or menubar app produces spoken audio. Feishu, Web Push, and Telegram provide the phone-side text alert.
- **Edge TTS is unofficial.** It uses Microsoft's public read-aloud endpoint: free and keyless, but without an SLA. The service retries twice with exponential backoff; optional Azure is the supported fallback. Total failure returns 5xx, never an empty success.
- **The release app is not notarized yet.** It is ad-hoc signed, so Gatekeeper may require right-click → Open.

## Roadmap

- [x] One-command GitHub install
- [x] Packaged universal macOS Release app
- [x] One-command Worker deploy with automatic config switching
- [ ] Notarized macOS release
- [ ] First-class selectable English voice pack
- [ ] Linux and Windows native notifiers

Ideas and issues are welcome — or [star the repo](https://github.com/sunlinhua-dotcom/claudevoice) to follow along.

## Contributing

See [AGENTS.md](AGENTS.md) for the architecture, test commands and repo-specific pitfalls. PRs and issues are welcome. English voices, additional supported TTS backends, platform support, installer hardening, and UI polish are good places to start.

## License

[MIT](LICENSE) © 2026 Sun Linhua

<div align="center">

**If ClaudeVoice saves you from babysitting one more terminal, [give it a ⭐](https://github.com/sunlinhua-dotcom/claudevoice) — it genuinely helps.**

</div>
