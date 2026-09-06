# BUG 记录表 · CLAUDEVOICE

> 记录项目开发过程中遇到的所有 BUG。

## 状态图例
🔴 未处理 / 🟡 修复中 / 🟢 已修复 / ⚪ 忽略

## 严重程度图例
P0 阻断 / P1 严重 / P2 一般 / P3 轻微

## BUG 列表

### BUG-0001 · 飞书桥注入长文本时碎片倒序移至末尾
- 状态：🟢
- 严重程度：P1
- 描述：飞书桥“注入电脑输入框”把完整正确的剪贴板文本注入前台应用时，部分换行附近碎片从原位消失并以倒序追加到全文末尾。
- 复现步骤：从飞书桥向 Mac 前台输入框注入 773 字节多行 UTF-8 文本；观察「会要」「1」「D」「按」「看到」离开原位并以「看到\n按\nD1会要」出现在末尾。
- 原因分析：`mac-app/TextInjector.swift` 的 `cgType()` 把整段文字切成每块 ≤10 个 UTF-16 单元，
  复用同一个 CGEvent 反复改 payload 并**无间隔**连发（773 字节约 30 组 keyDown/keyUp）。
  目标输入框（Electron/受控 textarea）的光标状态是异步刷新的，跟不上这个速率，
  迟到的块落到过期光标位置——表现为碎片被挪到全文末尾。与飞书、剪贴板、接力均无关。
- 修复方案：文本已经完整写入剪贴板，改为对「确认仍在前台的同一个 PID」发送一次 Cmd+V，
  单次事件由输入框原子消费，不存在分块乱序。Unicode 分块打字函数及其所有生产入口均已删除，
  长短文本都只走一次 Cmd+V。
- 验证：`INJECT_ITERATIONS=5 npm run test:text-inject-order` 经真实 relay 注入 TextEdit，
  5/5 次读回 sha256 与源文本完全一致（9362c435…fd48，773 字节）；「会要」「1. 一键」
  「DeepSeek」「按照我的」「能够看到完整」均在原位，末尾没有「看到\n按\nD1会要」；注入日志为
  「→ 已单次粘贴 ✅」。bridge 全量测试 86/86 通过。

### BUG-0002 · TextEdit 验收完成后测试进程未自然退出
- 状态：🟢
- 严重程度：P3
- 描述：首轮真实 relay 验收断言已通过，但 WebSocket 关闭握手让 Node 测试进程残留，TextEdit App 也仍可见。
- 复现步骤：运行 `INJECT_ITERATIONS=5 npm run test:text-inject-order`，观察结果打印后进程未立即退出。
- 原因分析：`RelayInjector.close()` 发起正常 WebSocket close；测试场景仍可能等待对端关闭握手。测试 finally 只关闭文档，没有退出 TextEdit App。
- 修复方案：测试 finally 在调用 `close()` 后终止专用测试 WebSocket，并用 AppleScript `quit saving no` 退出 TextEdit。
- 验证：修正后 5 轮真实验收自然以退出码 0 结束，且 `pgrep -x TextEdit` 无进程。
