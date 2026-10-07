# cc-bridge · Claude 飞书指挥台

`cc-bridge` 是 Mac 常驻进程：独占指定飞书应用的长连接，默认进入“输入模式”——说话或发文字即进入电脑，图片/文件/视频等附件几秒内攒成一批贴进 Mac 前台窗口。需要给 Claude 下任务时发 `任务 <文字>`，或用 `/task` 持久切换为任务模式；文字与附件都经 RemoteInput relay 交给电脑端 ClaudeVoice.app 写剪贴板并粘贴——cc-bridge 由 PM2 开机拉起，不在桌面会话里，本机没有剪贴板（`pbcopy` / NSPasteboard / AppleScript 全部失败）。所有回执、任务、审批、完成和失败消息都在私聊主聊天流直发，不创建飞书话题。

> 一步步的飞书应用创建、权限、事件订阅与全部环境变量，见 [docs/CONFIGURATION.md](../docs/CONFIGURATION.md) 第 6 节；示例配置 [`.env.example`](.env.example)。

## 架构

```text
主人 飞书私聊
  │ im.message.receive_v1 / card.action.trigger
  ▼
index.mjs + router.mjs ──► sessions.mjs（projects/state/队列）
  │                              │ 每项目 1、全局 3
  │                              ▼
  │                         runner.mjs ──spawn──► claude -p stream-json
  │                              │                    │
  │                              │ permission prompt  │ MCP stdio
  │                              ▼                    ▼
  ├── cards.mjs ◄──────── approval-server.mjs ◄── approve-mcp.mjs（permission_prompt / ask_user）
  ├── stt.mjs ──资源下载 / ffmpeg / 飞书 STT──► 文字路由
  ├── media.mjs ──全类型附件下载 / 产物白名单──► 批次贴图或 Claude
  ├── worker-events.mjs ──noNotify 生命周期事件──► ClaudeVoice Worker / 仅面板 SSE
  │
  └── input 模式 /「注入 」/「/type 」
        └── inject.mjs ──phone WS──► RemoteInput Worker ──► Mac 前台窗口
              ▲ inject_result（App inject_ack 的 Worker 透传）
```

状态写入 `state.json`，采用临时文件 + rename 原子替换；其中 `settings.inputMode` 持久保存 `input`（默认）或 `task`。state v1 会在首次启动时一次性迁移为 `input`，迁移后用户显式 `/task` 的选择仍会持久保存。最近 200 条输入投递记录保存文字或附件路径，供“粘贴/转 Claude”按钮在重启后继续查找。项目种子在 `projects.json`，启动时还会扫描 `CC_WORKSPACE_ROOT`（默认 `~/Projects`）下的一层目录。任务卡 PATCH 仅在内容变化时触发，同一卡片最短间隔 2.5 秒。进程重启后，原先 `running` 的任务会标记失败，不能假装恢复已经丢失的子进程。

## 环境与安装

要求 Node.js >= 18、已安装并登录 `claude`、已安装 PM2。语音功能还要求系统可执行 `ffmpeg`；缺失时进程仍健康运行，并会在收到语音时提示用户。直接依赖只有飞书官方 SDK。

```bash
cd ClaudeVoice/bridge
cp .env.example .env
# 填入真实配置；不要把 .env 提交到版本控制

npm ci
npm test
```

`.env` 变量：

- `LARK_APP_ID / LARK_APP_SECRET / LARK_OPEN_ID`：飞书自建应用与主人 open_id。
- `CC_APPROVAL_PORT`：localhost 审批服务端口，默认 `18791`。
- `CC_APPROVAL_TOKEN`：MCP 子进程访问审批服务的随机令牌。
- `CC_APPROVAL_TIMEOUT_MS`：审批等待超时，默认 10 分钟，超时自动拒绝并 PATCH 终态。
- `CC_AUTO_ALLOW_READONLY`：只读工具和保守白名单 Bash 自动放行，默认 `1`；设为 `0` 恢复全部弹卡。
- `CC_ASK_TIMEOUT_MS`：`ask_user` 等待超时，默认 15 分钟，超时让 Claude 按最佳判断继续。
- `CC_TASK_TIMEOUT_MS`：单轮 Claude 活跃执行超时，默认 45 分钟；审批和 `ask_user` 等待期间暂停计时。
- `CC_GLOBAL_LIMIT`：全局并发，默认 3；每项目固定最多 1。
- `CC_CARD_THROTTLE_MS`：任务卡 PATCH 节流，代码强制不低于 2500ms。
- `CC_SEND_FILES`：完成后自动回传结果中提到的产物，默认 `1`；设为 `0` 关闭。
- `FFMPEG_PATH`：可选，指定 ffmpeg 路径；默认从 `PATH` 查找。
- 飞书入站媒体固定存到当前项目的 `.cc-bridge/incoming/<msgId>/`；启动时清理 24 小时旧目录。旧 `~/.claude/cc-bridge-tmp` 仅保留 Read/Glob 自动放行兼容，不再写入。
- `RELAY_URL / MAC_ID / DEVICE_NAME`：RemoteInput phone-role 注入链路。
- `CV_WORKER_URL / HOOK_SECRET`：Worker `/hook` 地址和共享密钥；事件失败静默，不影响任务主流程。可用 `npm run env:sync-worker` 从项目根 `.env` 安全同步密钥。

只读自动放行先做危险否决，再拆分 `; / && / || / |` 等复合命令，只有每一段都完整命中只读白名单才放行。任何输出/进程重定向、命令替换、危险命令、未知段或解析不确定内容都继续弹审批卡。基础白名单位于 `readonly-policy.mjs`；如确需扩展，在 `readonly-allow.json` 增加工具名或同时带 `^`、`$` 的完整 Bash 正则，重启后生效。扩展规则不能覆盖危险否决。

## UI 2.0 素材与卡片

原始生图位于 `assets/src/`，3:1 卡片横幅位于 `assets/banners/`。飞书 `image_key` 缓存在 `assets/img-keys.json`，按 SHA-256 判断内容是否变化，重复执行不会重传：

```bash
npm run assets:upload       # 顺序上传有变化的 banner
npm run test:ui2-lark       # 真发 queued/running/permission/voice/help/done/failed 七类展示卡
```

`img-keys.json` 不存在、解析失败或缺少某个 kind 时，卡片会自动退化为无图版本，不影响任务、审批或按钮回调。

## 部署与常驻

同一飞书 App 只能有一个长连接消费者。如果你之前有别的进程在用同一个飞书应用，先停掉它：

```bash
pm2 start "$PWD/index.mjs" --name cc-bridge
pm2 save
pm2 ls
pm2 logs cc-bridge --lines 100
```

升级或排障：

```bash
pm2 restart cc-bridge
pm2 describe cc-bridge
pm2 logs cc-bridge --lines 200
```

## 命令

| 命令 | 作用 |
|---|---|
| `/projects` / `项目列表` | 项目列表与编号 |
| `/use <名或编号>` / `切到 xx` | 切换当前项目 |
| `/new <项目> <任务>` / `新建 <项目> <任务>` | 指定项目新开 Claude 会话 |
| `/status` / `状态` | 活动任务与排队状态 |
| `/stop [编号]` / `停止 [编号]` | SIGTERM 停止任务 |
| `/clear` / `清空` | 清空当前项目会话记录与待续接选择，不影响运行任务 |
| `/input` / `输入模式` | 切到输入模式；之后语音/文字复制并输入电脑（默认） |
| `/task` / `任务模式` | 切到任务模式；之后语音/文字交给 Claude |
| `/mode default` / `模式 default` | 默认权限模式，权限请求推飞书主聊天流审批卡 |
| `/mode accept` | `--permission-mode acceptEdits`，其余需要的权限仍走审批卡 |
| `/mode yolo` | `--permission-mode bypassPermissions`，不挂审批 MCP |
| `/mode plan` | `--permission-mode plan` |
| `/model <名>` / `模型 <名>` | 覆盖之后新任务的 Claude 模型；`default` 清除 |
| `/sessions` / `会话列表` | 当前项目最近会话 |
| `/resume [n]` / `续会话 [n]` | 选择会话，下一条普通文字以 `--resume` 续接 |
| `/help` / `帮助` | 帮助 |
| `注入 <文字>` / `/type <文字>` | 任意模式强制走 RemoteInput 输入 |
| `任务 <文字>` | 任意模式强制交给 Claude |

任务模式下，普通文字、语音识别文本和附件进入 Claude 媒体管线。语音确认使用小卡展示识别文本，并提供“改为输入到电脑”和模式切换；改道时会停止刚创建且仍活动的 Claude 任务。输入模式下，语音仍先 STT，再按文字输入；文字经 relay 由 App 粘贴进焦点窗口。image/file/media/video/post 内嵌附件下载到当前项目 `.cc-bridge/incoming/<msgId>/`，连续发来的附件停 4 秒没有新的就封成一批（一张卡、“▶️ 现在就贴”可提前封），由 App 逐个贴进前台窗口：图片按 PNG+TIFF 图片数据贴（终端里的 Claude Code 用 Ctrl+V，其余 Cmd+V），其他按文件引用贴。贴进后 10 分钟内的下一句文字 / 语音就是这批的指令：接在附件后面打进去，确认打进去才回车；卡片也可直接点“⏎ 发送”。卡片另有“📋 重新粘贴 / 🤖 转给 Claude”。超过 10MB 的资源下载期间卡片显示进度。

`/` 开头的命令始终按命令处理；只有专用 `/type` 例外，它是强制输入前缀。任务追问不再依赖 thread/root_id：引用回复某任务的任务卡、审批卡、ask_user 卡、完成卡或失败卡，会通过 `parent_id` 与 message_id 映射精准命中该任务；无引用的普通 task 模式消息优先续接最近运行任务，否则续接最近完成且有 `session_id` 的任务；仍无任务时才新建。多任务并行时，任务卡标题均带 `#编号`，用 `/status` 查看全部，并引用对应卡片精准追问。

Claude 遇到需要用户拍板的 2-6 项多选决策时可调用 MCP `ask_user`。bridge 会在主聊天流直发选项卡，按钮回调使用 `cc.ask`；也可引用对应卡片回复选项文本、序号（`1/2/3…`）或自定义答案。存在审批 pending 时，短文本 `允许/同意/批准/好/可以/ok/yes/y` 与 `拒绝/不行/不可以/别/no/n` 等效点击最新审批按钮，命中后不会再进入 Claude 或电脑输入。没有 pending 时这些文字仍按当前模式正常路由。审批卡与决策卡处理后都会在原主流卡片上 PATCH 为终态。

Claude 完成后，bridge 会从结果文字提取绝对路径或项目相对路径，验证真实文件只位于当前项目或 `/tmp`，去重后最多回传 3 个。图片支持 png/jpg/jpeg/gif/webp 且不超过 10MB；其他文件不超过 20MB，均通过 `im.message.create` 在主聊天流直发。

## 自测

```bash
npm test                 # 路由、语音/图片、路径安全、卡片、上传与 relay 幂等
npm run test:claude      # 新会话 + --resume 冒烟（要求 Claude 登录有效）
npm run test:approval    # MCP 审批 allow / deny 往返
npm run test:ask-user    # 真 Claude stream-json 调用 ask_user，并模拟按钮选择 B
npm run test:lark        # 真发联调任务卡、PATCH、完成卡
npm run test:p0-lark     # 真发新版审批卡与 ask_user 卡到 主人 主聊天流
npm run test:m3-lark     # 合成音频真调 STT，并真上传/发送图片和文件
npm run test:ui2-lark    # 真发 UI 2.0 七类卡片
npm run test:input-clipboard # 模拟 input 文字消息，pbpaste 逐字读回（需桌面 pasteboard）
npm run test:input-relay # 临时 phone 发 inject_text 并等待真实 inject_result
npm run test:input-lark  # 向 主人 主聊天流真发注明测试的四按钮回执卡
npm run test:attachment-clipboard # 本机造 PDF/PNG，写入并打印 clipboard info 读回证据
npm run test:attachment-paste # 模拟附件粘贴按钮，真实发送 relay Cmd+V 并等待 ACK
npm run test:attachment-lark # 向 主人 真发注明测试的新版附件回执卡
npm run test:readonly-task # input 默认下用“任务 ”前缀真跑 pm2 list | cat，检查 stream-json 与零审批卡
npm run assets:upload    # banner SHA-256 缓存上传
```

## 用户验证三步

1. 默认无需切换，直接发一条文字和一条语音；两条都应出现主聊天流输入回执卡，relay 有焦点时卡片最终 PATCH 为“已注入”。点“粘贴到光标处”和“回车”确认按键动作。
2. 在回执卡点“转给 Claude”，应出现新任务卡；点模式按钮或发 `/task`，应收到简短确认。任务模式再发语音，应出现带“改为输入到电脑”的语音确认卡；点击后活动任务停止并生成输入回执。
3. 验证强制前缀：任务模式发 `注入 测试` 仍输入电脑；输入模式发 `任务 列出项目根目录，只读` 仍创建 Claude 任务；`/status` 等命令在两种模式都正常。
4. input 模式连发三张图：只出一张批次卡，几秒后三张依次贴进前台输入框；再回一句文字，应接在图后并回车，卡片变“📤 已发送”。PDF 应按文件引用贴入。切到 task 模式重发附件，应继续进入 Claude 媒体任务。
5. 多任务并行时，引用回复目标任务的任意卡片做精准追问；不引用时应自动续接最近运行任务，若无运行任务则续接最近完成且可 resume 的会话。任务卡、完成/失败卡和命令响应均应平铺在私聊主聊天流，不出现“回复话题”入口。

## 安全与限制

- 只有 `LARK_OPEN_ID` 对应的 主人 可驱动任务；其他人只收到“此机器人仅服务主人”。
- 日志只输出 App/open_id 打码值，不输出 Secret、审批 token 或 relay device token。
- cc-bridge 进程内不碰剪贴板；贴图 / 贴文字指令是 `inject_key` 的 `cv:` + JSON（中继原样转发，见 `inject.mjs` 的 `buildMacCommand`），App 结果塞回 `inject_ack.mode`。路径只作为 JSON 字段，不拼进任何命令字符串。
- 图片/文件位于项目内 `.cc-bridge/incoming/`，会保留至启动清理窗口（24 小时），且仓库 `.gitignore` 已忽略 `.cc-bridge/`。
- 产物路径必须在项目目录或 `/tmp`；symlink 指向目录外会被拒绝。
- `yolo` 会绕过审批，仅适用于主人明确接受风险的任务。
