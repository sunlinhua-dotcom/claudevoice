<div align="center">

<img src="assets/og-card.png" alt="ClaudeVoice — Claude Code 的语音 + 手机提醒" width="820">

<h1>ClaudeVoice</h1>

**一听就知道：哪个 Claude Code 会话刚做完，或者正在默默等你。**
给每个 Claude Code 项目装上全局语音 + 手机提醒。免费、默认免 key、装一次全局生效。

[![macOS 13+](https://img.shields.io/badge/macOS-13%2B-0b0d24?logo=apple&logoColor=white)](#-原生-macos-app)
[![免费 · 免 key](https://img.shields.io/badge/TTS-免费%20%C2%B7%20免%20API%20key-7c8cff)](#-安装)
[![Node ≥14](https://img.shields.io/badge/Node-%E2%89%A514-3c873a?logo=node.js&logoColor=white)](#-安装)
[![License: MIT](https://img.shields.io/github/license/sunlinhua-dotcom/claudevoice?color=8b93c7)](LICENSE)
[![Stars](https://img.shields.io/github/stars/sunlinhua-dotcom/claudevoice?style=social)](https://github.com/sunlinhua-dotcom/claudevoice/stargazers)

[English](README.md) · **简体中文**

</div>

---

## 痛点

你丢给 Claude Code 一个任务，转头看 Slack 或切到另一个仓库，然后开始等。其实两分钟后它可能已经**做完**，你却十分钟才发现；更糟的是，它**停下来等授权**，安安静静地卡在那里，而你还以为它在忙。

**ClaudeVoice 把每个 Claude Code 会话变成「能听见」的。** 项目完成或需要你时，它马上说出**哪个项目**、**发生了什么**，还可以顺手推到手机。

<div align="center">
<img src="assets/demo.gif" alt="ClaudeVoice 指挥台正在播报，手机同时收到提醒" width="880">
<br><sub>指挥台播报哪个项目需要你，手机同时收到提醒。</sub>
</div>

## ⚡ 安装

复制这一条命令：

```bash
curl -fsSL https://raw.githubusercontent.com/sunlinhua-dotcom/claudevoice/main/install.sh | bash
```

安装器会检查 Git 和 Node 14+，下载或更新 `~/ClaudeVoice`，运行全局 hook 安装向导，并在 macOS 上询问是否安装预编译菜单栏 App。重复运行也安全。

**或者：** 打开 [GitHub Releases](https://github.com/sunlinhua-dotcom/claudevoice/releases)，下载 `ClaudeVoice.app.zip`，解压后双击 App。如果这是第一次安装，仍需运行一次 `node setup.js`，让 Claude Code 拥有全局 hooks，并为 App 生成本机配置。

然后启动零依赖本机服务：

```bash
cd ~/ClaudeVoice
node server.js
```

打开 <http://localhost:8787>，或使用菜单栏 App，再新开一个 Claude Code 会话，完成一条小任务测试。

## 为什么你会喜欢

- 🔊 **免费开口播报。** 默认微软 Edge 神经语音：不用 API key、不用注册、零费用。
- 🌐 **全局生效。** hooks 在 `~/.claude`，每个项目和每个新开的会话都自动接入。
- 🎨 **一眼、一耳分清。** 每个项目固定颜色，并分配茉莉、冰糖、白桦、苏打四种音色之一。
- 📱 **手机提醒不强制上云。** 本机 server 就能直接发飞书卡片。
- 🖥️ **原生 macOS App。** 不开浏览器标签页，也能播放电影感提示音和语音。
- 🛡️ **永不卡住 Claude。** ClaudeVoice 离线时，hook 也会快速退出，Claude Code 照常继续。
- 🧩 **本机服务零依赖。** 只用 Node 内置模块。

## 工作原理

<div align="center">
<img src="assets/flow.png" alt="Claude Code → hook.js → 本机 server 或 Worker → 语音面板和手机提醒" width="900">
</div>

- **触发** —— Claude Code 全局 hooks 在 `Stop`、`Notification`、`SubagentStop`（默认静音）时触发。
- **`hook.js`** —— 转发事件后立即退出。
- **本机 server 或 Worker** —— 用 SSE 广播，并通过 `Edge → 配置后可用的 Azure` 合成语音。
- **面板与 Mac App** —— 播报事件；飞书、Web Push 或 Telegram 负责手机提醒。

## 📱 手机提醒

### 首选：飞书直推，只需本机 server

无需部署 Worker。运行 `node setup.js`，飞书问题选**是**，按向导完成：

1. 打开[飞书开放平台应用控制台](https://open.feishu.cn/app)，创建企业自建应用。
2. 开通 `im:message` 和 `contact:user.id:readonly`。
3. 创建并发布一个应用版本，让权限真正生效。
4. 复制 App ID 和 App Secret。
5. 把它们和你的飞书手机号粘贴进向导。脚本会获取 tenant token，把手机号解析成 `open_id`，再将 `LARK_APP_ID`、`LARK_APP_SECRET`、`LARK_OPEN_ID` 写入 `.env`。
6. 启动 `node server.js`。任务完成、等待输入、请求授权都会变成飞书卡片。

查询失败时，检查应用是否已发布、两个权限是否已生效，以及手机号是否属于当前飞书企业。

### 进阶：Cloudflare Worker

需要公网面板、PWA/Web Push、Telegram，或离开电脑后仍想访问时再用：

```bash
cd cloudflare
npx wrangler login
./deploy.sh
```

脚本会部署、设置 secrets、解析真实 `workers.dev` URL、备份两份 ClaudeVoice JSON，并自动切换 hook、Mac App TTS 和 relay，无需手改配置。详见 [cloudflare/README.md](cloudflare/README.md)。

## 🖥️ 原生 macOS App

### 优先下载

从 [Releases](https://github.com/sunlinhua-dotcom/claudevoice/releases) 下载 `ClaudeVoice.app.zip`，解压后移到 `/Applications`。Release 是兼容 Apple Silicon 与 Intel 的 universal App。

Release 使用 ad-hoc 签名，尚未公证；首次启动可能需要**右键 → 打开**。一键安装器会自动清除 quarantine。手动方式：

```bash
xattr -dr com.apple.quarantine /Applications/ClaudeVoice.app
```

App 首启会读取 `~/.claude/claudevoice-app.json`。如果文件不存在，它会自动从 `~/.claude/claudevoice.json` 派生 `base` 与 `/tts` 鉴权 secret。

### 源码编译

```bash
cd mac-app
./build.sh                 # 编译并安装到 /Applications
./build.sh --no-install    # 只编译到 mac-app/build，不安装、不重启
```

脚本直接使用 `swiftc`，要求 macOS 13+。未配置 relay 时，远程输入会优雅停用，语音播报不受影响。

## 🤖 用手机远程指挥 Claude Code

`bridge/`（**cc-bridge**）是独立的进阶常驻进程：在飞书私聊里用语音或文字发任务、用卡片批准工具、多会话并行、接收产物文件。它需要单独的飞书配置。详见 [bridge/README.md](bridge/README.md)。

## 配置

`setup.js` 会创建可直接运行的 `.env`。常用可选项：

| 变量 | 含义 |
|---|---|
| `TTS_ENGINE` | 默认 `edge` |
| `TTS_VOICE` | 默认显示音色 `茉莉` |
| `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | 可选 Azure 兜底 |
| `USER_NAME` | 播报时称呼你的名字 |
| `PORT` / `HOST` | 本机服务地址；端口默认 `8787` |
| `HOOK_SECRET` | 自动生成的 hook 与 Mac App TTS 共享密钥 |
| `DASH_TOKEN` | 面板放公网前必须设置 |
| `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_OPEN_ID` | 飞书直推 |

把 `projects.example.json` 复制成 `projects.json`，可固定项目名、颜色和音色：

```json
{
  "web-app": { "name": "我的网站", "color": "#46e0b0", "voice": "茉莉" },
  "api": { "name": "接口服务", "color": "#ffcd5b", "voice": "白桦" }
}
```

## 老实说

ClaudeVoice 对自己现在的样子不藏着掖着：

- **macOS 优先。** hook 转发和网页面板是跨平台的；原生 App、系统横幅和部分总结行为更偏 macOS。
- **中文优先的音色与 UI。** Edge 支持更多语言，但内置四音色体验按中文打磨。
- **必须有播放器处于活动状态。** 网页标签页或菜单栏 App 负责真正出声；飞书、Web Push、Telegram 提供手机侧文字提醒。
- **Edge TTS 是非官方的。** 它使用微软公开朗读端点：免费免 key，但没有 SLA。服务会指数退避重试两次，可选 Azure 是官方兜底；全部失败时返回 5xx，绝不会用空 200 假装成功。
- **Release App 尚未公证。** 当前是 ad-hoc 签名，Gatekeeper 可能要求右键 → 打开。

## 路线图

- [x] GitHub 一条命令安装
- [x] universal macOS Release App
- [x] 一条命令部署 Worker 并自动切换配置
- [ ] 公证过的 macOS Release
- [ ] 一等公民级可选英文音色包
- [ ] Linux / Windows 原生通知

欢迎提想法和 issue，或者[给仓库点个 star](https://github.com/sunlinhua-dotcom/claudevoice)一起跟进。

## 参与贡献

欢迎 PR 和 issue。英文音色、更多官方 TTS 后端、平台支持、安装器加固和 UI 打磨，都是很好的切入点。

## 许可

[MIT](LICENSE) © 2026 Sun Linhua

<div align="center">

**如果 ClaudeVoice 让你少盯一个终端，[给它点个 ⭐](https://github.com/sunlinhua-dotcom/claudevoice) —— 真的会帮到我。**

</div>
