# ClaudeVoice · Cloudflare 进阶部署

Cloudflare Worker 是可选项：只有当你需要公网网页面板、Web Push、Telegram，或离开电脑后仍要查看事件时才需要部署。仅做飞书手机提醒时，根目录 `server.js` 已能直推，无需 Worker。

```
你的 Mac:  Claude Code → hook.js ──POST──► Cloudflare Worker
Worker:    Durable Object / SSE → 网页面板
           Web Push / Telegram / 飞书 → 手机提醒
           Edge 神经语音 → 可选 Azure 兜底
```

## 一条命令部署

前提：本机已有 Node，并已在仓库根目录运行过 `node setup.js`。

```bash
cd cloudflare
npx wrangler login
./deploy.sh
```

`deploy.sh` 会自动：

1. 创建或更新 Worker。
2. 生成 VAPID 密钥并设置 Web Push secrets。
3. 复用根 `.env` 的 `HOOK_SECRET`、飞书配置和可选 Azure 配置。
4. 从 Wrangler 的结构化部署输出读取真实 `workers.dev` 地址。
5. 备份并改写 `~/.claude/claudevoice.json`。
6. 备份并改写 `~/.claude/claudevoice-app.json`，同步 TTS 鉴权和 WebSocket 中继。

脚本最后会打印带 `DASH_TOKEN` 的手机面板地址。无需再手工编辑 JSON。

## 可选环境变量

运行脚本前可以导出：

```bash
export DASH_TOKEN="你指定的面板令牌"
export VAPID_SUBJECT="mailto:you@example.com"
export TELEGRAM_BOT_TOKEN="..."
export TELEGRAM_CHAT_ID="..."
```

飞书直推建议先在根目录运行 `node setup.js`，由向导把 `LARK_APP_ID`、`LARK_APP_SECRET`、`LARK_OPEN_ID` 写进 `.env`。部署脚本会自动同步到 Worker。

Azure 语音是可选兜底。在根 `.env` 填写：

```dotenv
AZURE_SPEECH_KEY=
AZURE_SPEECH_REGION=
```

默认 Edge 神经语音无需 key。

## 手机上启用

1. 打开部署脚本打印的 `https://...workers.dev/?token=...`。
2. 浏览器菜单选择“添加到主屏幕”。
3. 从主屏幕打开 ClaudeVoice，点“启用语音播报”。
4. 需要系统级提醒时，再点“开启手机推送”并授权。

iPhone Web Push 需要 iOS 16.4+，且网页必须先添加到主屏幕。

## 本地调试

```bash
cd cloudflare
npx wrangler dev --port 8788
```

私密调试变量放在 `cloudflare/.dev.vars`（已 gitignore），不要把 secret 写进 `wrangler.toml`。

## 常见问题

- **面板 401**：使用部署脚本最后打印的带 token 地址。
- **App 有提示音但没人声**：确认 `~/.claude/claudevoice-app.json` 的 `base` 是 Worker 地址、`token` 与 `HOOK_SECRET` 一致；重新运行 `./deploy.sh` 会自动修复并先备份。
- **手机没弹 Web Push**：确认已添加到主屏幕、从图标启动，并允许系统通知。
- **完成了没反应**：新开 Claude Code 会话，并确认 `~/.claude/claudevoice.json` 的 `url` 以 `/hook` 结尾。
- **Edge 暂时失败**：服务会指数退避重试两次；配置 Azure key 后还会自动兜底。全部失败时 `/tts` 返回 5xx，不会伪装成空 200。
