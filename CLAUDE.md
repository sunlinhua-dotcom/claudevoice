# CLAUDEVOICE · 给新会话看的一页纸

Claude Code 的全局语音 / 网页通知台。一次任务结束或停下等输入，hook 把事件发到云端 Worker，
Worker 决定念什么、用谁的声音，再同时推给网页面板、Web Push 和 iMessage。
另外挂了两个常驻服务：飞书指挥台（cc-bridge）和微信归档（wxbridge）。

**开工前先读这里，别去读 `LOG.md` 那些台账**——它们已经归到 `docs/archive/`，是历史不是现状，
49KB 的流水账读一遍就是几万 token。真要查历史再按需 `grep` 那个目录。

---

## 1. 活的链路 vs 睡着的链路

| 位置 | 是什么 | 状态 |
|---|---|---|
| `hook.js` | 全局 hook 转发器，`~/.claude/settings.json` 里挂着 | **活**，每次任务都跑 |
| `cloudflare/src/worker.js` + `public/` | Worker + Hub（Durable Object）+ Workers AI 总结 + Edge/Azure TTS + 面板 + Web Push | **活**，通知全走这条 |
| `shared/speech.cjs` | 播报话术层：音色分配 / 名字读法 / 句子模板 / 摘要清洗 | **活**，三个宿主共用 |
| `bridge/` | cc-bridge，飞书私聊远程驱动 Claude Code | **活**，PM2 常驻 |
| `wxbridge/` | 微信客户 brief 自动归档到 `<项目>/_inbox/` | **活**，PM2 常驻 |
| `mac-app/` | 菜单栏 App：本机播报、听写、文本注入 | **活**，装在 `/Applications` |
| `server.js` | 自托管版 Worker（不依赖 Cloudflare 的那条路） | **睡着**，见下面红线 |
| `names.json` | 项目名读音表，三处都读它 | 活，改完要么 deploy 要么 `tools/cvname` 热改 |
| `tools/sfx/cv-sfx` | 本地生成每个项目专属提示音（Stable Audio Open Small，不联网） | 按需 |
| `marketing/`、`assets/` | 开源发布用的素材 | 静态 |

事件流：`hook.js` → `POST <worker>/event` → `normalizeEvent` → `buildSpeak`（`shared/speech.cjs` 出模板，
Workers AI 出摘要）→ Hub 广播 SSE + Web Push；网页面板再回头调 `/tts` 拿音频。

## 2. 红线（继承 0721.md §0，别自己放宽）

- **不要启动本地 `server.js`**：通知已全走云端，且 8787 被 shenhuaGOAL 的 uvicorn 占着。
- **`wrangler deploy` 要 BRIGHT 明确点头**，那是对外的生产变更。自查一律 `--dry-run`。
- **`git commit` 同样要明确要求**（2026-09-06 这轮已授权：纳入 `wxbridge/`、`tools/sfx/`、`shared/`、`test/`）。
- **不改 RemoteVoice 仓库** `/Volumes/ProjectsAPFS/ZCODE/REMOTEVOICE`，只读对照。
- **不启动 `rv-feishu`**：同一个飞书 App 只允许一个长连接消费者，现在是 cc-bridge 独占。
- **运行中别直接改 `bridge/state.json`**：先 `pm2 stop cc-bridge` → 改 → start。
- **密钥不进日志 / 报告 / 版本控制**：`bridge/.env`、根 `.env`、`~/.claude/claudevoice.json` 里的 hook secret。
  引用时只写路径，别 `cat` 明文进输出。
- **别删 `docs/archive/0718.md`**。
- 全局红线（不关 Shadowrocket 等）见 `~/.claude/CLAUDE.md`，这里不重抄。

## 3. 命令（够用就这些）

```bash
npm test                              # shared/speech.cjs 的 20 条回归
cd bridge && npm test                 # cc-bridge 100 条
cd cloudflare && npx wrangler deploy --dry-run   # 验 worker.js 能打包（node --check 对它无效，见 §4）
pm2 status                            # cc-bridge / wxbridge 是否还活着
node tools/cvname <项目> <读音>        # 热改读音表，免部署
```

`bridge/package.json` 里另有二十来条 `test:*`，都是要真发飞书 / 真开 App 的实机验收，
别在无人值守时跑。

## 4. 这个仓库特有的坑

- **CJS / ESM 是混的**：根 `package.json` 没有 `"type": "module"`，所以 `server.js`、`hook.js` 是 CJS，
  而 `bridge/`、`cloudflare/src/worker.js` 是 ESM。共用层因此写成 `shared/speech.cjs`——
  哪天根目录加上 `"type": "module"` 也不会把它连坐。
- **`node --check cloudflare/src/worker.js` 不算验证**：它按 CJS 解析一个 ESM 文件。用 `wrangler deploy --dry-run`。
- **`shared/speech.cjs` 里不许有 I/O**：没有 fs、没有 fetch、没有 env、没有全局状态。
  它要被 esbuild 原样打进 Worker，任何副作用都会在边缘炸。
- **worker.js 里从它取值必须走默认导入再解构**（`import speech from '../../shared/speech.cjs'`）：
  本地 `.cjs` 的具名导入在 esbuild 的互操作下不可靠。
- **音色 override 一律照收**：`assignVoice(key, override)` 不在内置池里的也认，云端由 `resolveVoiceEdge`
  兜底（只放行 `EDGE_VOICE_MAP` 里的名字或 `zh-CN-XxxNeural` 形状，其余退回 XiaoxiaoNeural）。
  以前 worker 那份偷偷丢弃未知 override，导致同一份 `projects.json` 本地和云端念出两种声音。
- **播报绝不念英文**：拿不到中文摘要就退回定型句（`doneFallback`），这是有意的，不是缺陷。

## 5. 省 token 的做法（这仓库容易踩）

1. **先看这一页，别 `cat` 大文件**。`docs/archive/` 整个目录 ~118KB，`LOG.md` 一个就 49KB。
2. **`server.js` / `worker.js` 都是六七百行，别整读**。找东西用 `grep -n`，改动用 `sed -n` 取片段。
3. **话术只改 `shared/speech.cjs` 一处**，别再往三个宿主里各写一份——那正是这轮合并掉的东西。
4. **验证走测试，别靠人肉听**：`npm test` 加 `bridge` 那 100 条不到 6 秒，比发一次真事件便宜得多。
5. **实机验收（真发飞书 / 真播报）留到最后一次做完**，别每改一行就来一轮。
6. 上下文过 120k 就 `/compact`，这是全局规则，本仓库尤其容易在读日志时冲上去。

## 6. 历史在哪

- `0721.md`（仓库根，SessionStart 钩子按 mtime 自动读）：断点续档，含 §4「下一步」清单。
- `docs/archive/`：`LOG.md`、`Progress.md`、`bugs.md`、`BUG.md`、`logs.md`、`CONTEXT.md`、`0718.md`
  七份台账，加 `opensource-bak/` 下 2026-07-15 开源发布前的五个快照。除 `BUG.md` 外都不进 git，只留底。
