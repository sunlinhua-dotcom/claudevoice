# ClaudeVoice · Cloudflare 部署（远程收通知）

把通知中转站搬到 Cloudflare 边缘，**永久在线、固定网址**，手机随时收得到。

```
你的 Mac:  Claude Code → hook.js ──POST──► Cloudflare Worker（永久在线）
Worker:    规整事件 → SSE 推给开着的网页 + Web Push 推手机 + 发 Telegram
                   └─ 代理 MiMo TTS（key 作为 Worker secret，不出云端）
你的手机:  装成 PWA → 收 Web Push 弹通知（点开播语音）/ 或直接收 Telegram
```

> 前提：**事件在你 Mac 上产生**（Claude Code 在本地跑）。所以 Mac 要开机联网，把事件发到 Worker；你人在外面用手机从 Worker 收。Mac 关机时本就没有任务，也就没有通知。

---

## 一次性部署（约 10 分钟）

### 0. 准备
- 一个 Cloudflare 账号（免费版即可）
- 本机有 Node。下面命令都用 `npx wrangler`，无需全局安装。

### 1. 进入目录、登录
```bash
cd /Volumes/ProjectsAPFS/CLAUDEVOICE/cloudflare
npx wrangler login          # 浏览器里授权
```

### 2. 生成 Web Push 的 VAPID 密钥
```bash
node scripts/gen-vapid.mjs
```
记下输出的 `VAPID_PUBLIC` 和 `VAPID_PRIVATE`（下一步要用）。

### 3. 设置 secrets
逐条执行（`echo -n` 避免行尾换行混进密钥）：
```bash
echo -n "你的MiMo key"                 | npx wrangler secret put MIMO_API_KEY
echo -n "$(openssl rand -hex 16)"      | npx wrangler secret put HOOK_SECRET   # 记下这个值，第6步要用
echo -n "$(openssl rand -hex 16)"      | npx wrangler secret put DASH_TOKEN    # 记下这个值，访问面板要用
echo -n "上一步的 VAPID_PUBLIC"        | npx wrangler secret put VAPID_PUBLIC
echo -n '上一步的 VAPID_PRIVATE(整个JWK)' | npx wrangler secret put VAPID_PRIVATE
echo -n "mailto:你@邮箱"               | npx wrangler secret put VAPID_SUBJECT
# Telegram（可选，见文末怎么拿）
echo -n "BotFather给的token"           | npx wrangler secret put TELEGRAM_BOT_TOKEN
echo -n "你的chat id"                  | npx wrangler secret put TELEGRAM_CHAT_ID
```
> 公网部署 **务必设 DASH_TOKEN**，否则任何人都能看你的面板、刷你的 MiMo 额度。

### 4. 部署
```bash
npx wrangler deploy
```
部署完会给你网址，形如 `https://claudevoice.<你的子域>.workers.dev`。

### 5. 让 Mac 的 hook 发往 Worker（不再需要本机 server.js）
编辑 `~/.claude/claudevoice.json`：
```json
{ "url": "https://claudevoice.<你的子域>.workers.dev/hook", "secret": "第3步的 HOOK_SECRET" }
```
（全局 hooks 已经装好了，不用重装。改完这一个文件即可。）

### 6. 手机上打开 + 装成 App + 开推送
1. 手机浏览器打开：`https://claudevoice.<你的子域>.workers.dev/?token=第3步的DASH_TOKEN`
2. 浏览器菜单 → **添加到主屏幕**（装成 PWA）。
3. 打开后点 **启用语音播报**，再点 **📱 开启手机推送**，授权通知。
4. 完成。之后任何项目完成/等待，手机会弹通知；点开通知进 App 播语音；同时（若配了）收到 Telegram。

---

## 各通道行为

| 通道 | 何时收到 | 有真人语音吗 |
|---|---|---|
| 网页面板（PWA 开着）| 实时 | ✅ MiMo 语音 + 星际音效 |
| Web Push 系统通知 | 即使没开 App / 浏览器关着 | ❌ 系统提示音；点开通知进 App 才播语音 |
| Telegram | 即使没开 App | ❌ Telegram 提示音 + 文字 |

> 浏览器规定：真人语音必须在打开的页面里才能播。所以"人不在、App 没开"时靠 Web Push / Telegram 弹文字通知把你叫回来，点开就听到语音。

---

## 怎么拿 Telegram 的 token 和 chat id（可选）
1. Telegram 里找 **@BotFather** → `/newbot` → 拿到 `TELEGRAM_BOT_TOKEN`。
2. 给你新建的 bot 发一句话（随便发）。
3. 浏览器打开 `https://api.telegram.org/bot<token>/getUpdates`，里面 `chat.id` 就是 `TELEGRAM_CHAT_ID`。

---

## 本地调试
```bash
cd cloudflare
# .dev.vars 放本地用的 MIMO_API_KEY / HOOK_SECRET 等（已 gitignore）
npx wrangler dev --port 8788
```

## 常见问题
- **手机没弹推送**：确认点过"开启手机推送"且系统允许该网站通知；iOS 需先"添加到主屏幕"再开推送（iOS 16.4+）。
- **面板 401**：网址要带 `?token=你的DASH_TOKEN`。
- **完成了没反应**：确认 `~/.claude/claudevoice.json` 的 `url` 指向 Worker、`secret` 和 `HOOK_SECRET` 一致。
- **自定义域名**：在 wrangler.toml 加 `routes`，或在 Cloudflare 面板给 Worker 绑自定义域。
- **改了音色/措辞**（在根目录 `server.js` 或 `cloudflare/src/worker.js`）后要 `npx wrangler deploy` 重新发布。
