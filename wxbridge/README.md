# wxbridge

把微信里收到的客户 brief 和附件，自动归到对应项目的文件夹。

你在微信里长按客户那条消息，转发给「微信 ClawBot」。wxbridge 收到后判断它属于哪个项目，
把附件写进 `<项目>/_inbox/<日期>/`，正文汇总进同目录的 `README.md`，然后在微信里回你一条回执。
判错了回一句「改到 heatins」，文件就地挪走，同时它会记住这次的线索，下次自动认得。

## 它在整条链路里的位置

```
客户微信 → 你的微信 → 转发给 ClawBot → wxbridge → <项目>/_inbox/<日期>/
                                          ↓
                                     微信回执（落到哪、几个文件、依据是什么）
```

项目名册直接读 `../bridge/projects.json`，跟 cc-bridge 共用同一份，不另立清单。

## 运行

进程由 pm2 托管，跟 cc-bridge 并列：

```bash
pm2 start start.mjs --name wxbridge --time
```

第一次用、或者会话过期（`errcode -14`）时，扫码重新接上：

```bash
node login.mjs
```

它会把二维码渲染成 `~/.wxbridge/login-qr.png`，用微信扫一扫、手机上点确认，
凭证自动写进 `~/.wxbridge/account.json`，然后 `pm2 restart wxbridge` 换用新凭证。
换账号后旧的长轮询游标会自动清掉，不用手工处理。

看日志：

```bash
pm2 logs wxbridge
```

## 微信里可用的指令

| 指令 | 作用 |
| --- | --- |
| `切到 / 切换到 / 换到 <项目>` | 接下来的转发默认归这个项目，30 分钟内有效 |
| `改到 / 挪到 <项目>` | 上一批判错了，就地挪走，并记住这次的线索 |
| `归档 [项目]` | 把被判成「在跟我说话」而扣住没存的那条真的存下去 |
| `绑定 <关键词> <项目>` | 教它认一个客户名或品牌词 |
| `解绑 <关键词>` | 忘掉一个关键词 |
| `项目列表 <关键词>` | 查名册 |
| `状态` | 当前项目、已学关键词数、待分拣数量 |
| `帮助` | 指令一览 |

也可以在消息开头直接写 `#heatins`，优先级最高。

## 它怎么判断项目

按证据强度从硬到软，谁先命中用谁，回执里会说明依据：

1. 消息里显式写了 `#项目名` 或「切到 X」 —— 把握 100%
2. 命中你教过的关键词 —— 90%
3. 正文或文件名里直接出现了项目名 —— 85%
4. 沿用你刚指定的项目 —— 70%
5. 本地模型（OpenClaw 的 `gpt-5.6-sol`，走 `127.0.0.1:18790`）根据内容推断 —— 60%
6. 都不中，落到待分拣区 `~/.wxbridge/_unsorted/<日期>/`，等你一句「改到 X」

「沿用」必须排在模型前面。你刚说过归哪个项目，那就是最强的意图信号；
让模型排前面的话，它看到「项目」「目录」这类泛指词就会瞎猜一个把你的指定盖掉。

把握低于 80% 时，回执会主动提示可以改判。

纯文字、看着像在跟助理说话的（「你……吗？」这种），不会直接归档，
而是先扣住并回你一句，你说「归档」才真的存。带附件的一律照常归档，不打断。

## 已知边界

这些是微信这个通道本身的限制，不是没做：

- **只有一对一私聊，没有群聊。** 协议里只有 `from_user_id` / `to_user_id`，没有群相关字段，
  所以「拉客户进群挂机器人」这条路走不通。
- **合并转发的聊天记录卡片收不到。** 通道只认文本、图片、语音、视频、文件五类，
  合并转发是另一种复合类型。遇到时回执会明确告诉你「这条没接住」，请逐条转发。
- **语音条微信不允许转发。** 但如果对方直接发语音给 bot，微信服务端会带上转写文本，能收。
- **机器人不能主动发起对话。** `context_token` 由每条入站消息现发，回复必须原样带回，
  所以只能在你说话之后回你，不能凭空推送。

## 凭证与冲突

凭证优先读 `~/.wxbridge/account.json`（`node login.mjs` 扫码后写的），
没有才回落到 OpenClaw 官方微信插件的 `~/.openclaw/openclaw-weixin/accounts/`。

注意：重新扫一次码会让**旧的 bot 会话立即失效**。所以扫码后一定要
`pm2 restart wxbridge`，否则它还拿着作废的 token 空转并反复崩重启。

**同一个 bot token 只能有一个长轮询消费者。** OpenClaw 那边的微信通道必须关着，
否则两个进程抢同一份 sync 游标，消息会随机丢一半。启动时会检查，发现冲突直接拒绝启动。
两个通道当前都已关闭：

```bash
openclaw config get plugins.entries.openclaw-weixin.enabled   # false
openclaw config get plugins.entries.weixin-clawbot.enabled    # false
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WXBRIDGE_OWNER` | 首个跟它说话的人 | 只服务这一个微信用户 |
| `WXBRIDGE_INBOX_DIR` | `_inbox` | 项目里的落点目录名 |
| `WXBRIDGE_UNSORTED_DIR` | `~/.wxbridge/_unsorted` | 待分拣区 |
| `WXBRIDGE_STATE_DIR` | `~/.wxbridge` | 游标、关键词、上一批记录 |
| `WXBRIDGE_STICKY_TTL_MS` | `1800000` | 「切到」的有效期 |
| `WXBRIDGE_MIN_BRIEF_CHARS` | `12` | 没附件的纯文字短于这个长度就不归档，只回一句提示 |
| `WXBRIDGE_MODEL_URL` | `http://127.0.0.1:18790/v1/chat/completions` | 兜底判断用的本地模型 |
| `WXBRIDGE_MODEL` | `openai/gpt-5.6-sol` | 同上 |

## 协议出处

`ilink.mjs` 与 `inbound.mjs` 的端点、AES-128-ECB 媒体解密、item 类型编号，
对齐腾讯官方插件 `@tencent-weixin/openclaw-weixin` 2.4.6（MIT）。

一个容易踩的坑：iLink 的 item 类型是 `TEXT:1 IMAGE:2 VOICE:3 FILE:4 VIDEO:5`，
跟老版微信的 msgtype（3/34/43/49）不是一回事，用错了媒体一个都收不到。
