// 文字注入：先把完整文本写入剪贴板，再对确认仍在前台的目标 App 发送一次 Cmd+V。
// 单次粘贴由目标输入框原子消费，避免分块 Unicode 键盘事件与异步受控输入框竞争光标状态。

import AppKit
import ApplicationServices
import CoreGraphics
import Carbon // IsSecureEventInputEnabled()

final class TextInjector {

    /// 注入结果——如实区分「真打字 / 退剪贴板 / 彻底失败」，供 HUD 与回执使用。
    enum Outcome {
        case typed, copied, failed
        var mode: String { switch self { case .typed: return "type"; case .copied: return "clipboard"; case .failed: return "failed" } }
        var ok: Bool { self != .failed }
    }

    /// 上次弹辅助功能提示的时间——避免连发多条 final 时叠出一堆模态框。
    private var lastPromptAt: Date?

    /// 把整段文字送达，返回真实结果：
    ///  - 焦点是可编辑文本框，且单次 Cmd+V 键盘事件确实发出 → .typed
    ///  - 没权限 / Secure Input / 没输入框 / 打字失败 → 退剪贴板 .copied
    ///  - 连剪贴板都失败 → .failed
    @discardableResult
    func inject(_ text: String) -> Outcome {
        guard !text.isEmpty else { return .failed }
        // 总是先放剪贴板：这样卡片上的「粘贴」按钮对文字也随时可用（聚焦输入框后点一下即贴）。
        let copied = copyToClipboard(text)
        // —— 诊断：把每次注入的关键判定写到 ~/Library/Logs/RemoteInput.log ——
        let trusted = AXIsProcessTrusted()
        let secure = IsSecureEventInputEnabled()
        let st = shouldType()
        let fm = NSWorkspace.shared.frontmostApplication
        let targetPID = fm?.processIdentifier
        rvLog("inject「\(text.prefix(16))」 AX授权=\(trusted) SecureInput=\(secure) shouldType=\(st) 前台=\(fm?.localizedName ?? "?")/\(fm?.bundleIdentifier ?? "?")")
        // 没有辅助功能权限：CGEvent 会被静默丢弃，别假装打字成功（内容已在剪贴板）。
        guard trusted else { promptAccessibilityThrottled(); rvLog(" → 剪贴板（无 AX 授权）"); return copied ? .copied : .failed }
        // Secure Input（密码/安全输入框）开启时，合成键盘事件会被系统静默吞掉 → 仅剪贴板。
        if secure { rvLog(" → 剪贴板（Secure Input 开启）"); return copied ? .copied : .failed }
        // 有可编辑焦点时送达；否则等用户点「粘贴」。长短文本都只走一次 Cmd+V，
        // 不保留任何 Unicode 分块事件路径，避免同类乱序再次出现。
        if st, copied, postCommandPaste(expectedFrontmostPID: targetPID) {
            rvLog(" → 已单次粘贴 ✅"); return .typed
        }
        rvLog(" → 剪贴板（shouldType=\(st)，没识别到可输入焦点/远程前台）")
        return copied ? .copied : .failed
    }

    /// 诊断日志，追加到 ~/Library/Logs/RemoteInput.log。
    private func rvLog(_ s: String) {
        let line = "[\(Date())] \(s)\n"
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/RemoteInput.log")
        guard let data = line.data(using: .utf8) else { return }
        if let h = try? FileHandle(forWritingTo: url) { defer { try? h.close() }; h.seekToEndOfFile(); h.write(data) }
        else { try? data.write(to: url) }
    }

    /// 是否应该"打字"（而不是存剪贴板）。
    private func shouldType() -> Bool {
        // 1) 焦点确实是文本输入元素 → 一定打字（原生 app + 部分 Electron/网页）。
        let sys = AXUIElementCreateSystemWide()
        var focused: CFTypeRef?
        if AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
           let el = focused, CFGetTypeID(el) == AXUIElementGetTypeID() {
            let element = el as! AXUIElement
            var roleObj: CFTypeRef?
            AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleObj)
            let role = (roleObj as? String) ?? ""
            if role.contains("TextField") || role.contains("TextArea") || role == "AXComboBox" || role == "AXSearchField" { return true }
            var settable: DarwinBoolean = false
            if AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue { return true }
            var sel: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &sel) == .success { return true }
        }
        // 2) 否则：只要你正前台是个常规 App（正在用的窗口），就直接打字——
        //    覆盖 Claude/浏览器/聊天/UU 远程等 AX 不规范的 App。只排除桌面/访达/Dock 这类不该打字的系统界面。
        if let app = NSWorkspace.shared.frontmostApplication {
            let bid = (app.bundleIdentifier ?? "").lowercased()
            let deny: Set<String> = [
                "com.apple.finder", "com.apple.dock", "com.apple.loginwindow",
                "com.apple.systemuiserver", "com.apple.controlcenter", "com.apple.spotlight",
                "com.apple.wallpaper", "com.apple.notificationcenterui",
            ]
            if !bid.isEmpty && !deny.contains(bid) { return true }
        }
        return false
    }

    @discardableResult
    private func copyToClipboard(_ text: String) -> Bool {
        let pb = NSPasteboard.general
        pb.clearContents()
        return pb.setString(text, forType: .string)
    }

    /// 对同一个前台 App 发送一次 Cmd+V，并给目标输入框短暂时间提交粘贴状态。
    private func postCommandPaste(expectedFrontmostPID: pid_t?) -> Bool {
        guard let expectedFrontmostPID else { return false }
        // NSPasteboard 写入是同步的；短暂让出主线程，避免目标 App 在变更通知前收到 Cmd+V。
        Thread.sleep(forTimeInterval: 0.03)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == expectedFrontmostPID,
              let src = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: false) else { return false }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cgSessionEventTap)
        up.post(tap: .cgSessionEventTap)
        Thread.sleep(forTimeInterval: 0.15)
        return true
    }

    /// 注入一个功能键（enter/tab/esc…）到当前焦点窗口——卡片「回车」按钮用来"提交"。
    /// 按键没法退剪贴板，缺权限/Secure Input/未知键 → .failed。
    func pressKey(_ key: String) -> Outcome {
        let k = key.lowercased()
        guard AXIsProcessTrusted() else { promptAccessibilityThrottled(); return .failed }
        if IsSecureEventInputEnabled() { return .failed }
        // "paste" = 无条件 Cmd+V（卡片按钮，用户已手动聚焦）；
        // "autopaste" = 仅在有可编辑焦点/常规前台 App 时才 Cmd+V（自动，像文字注入那样；没合适焦点就不贴，留给按钮）。
        if k == "paste" || k == "autopaste" {
            if k == "autopaste" && !shouldType() { return .copied }   // 没焦点：内容已在剪贴板，等用户点「粘贴」
            let targetPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
            return postCommandPaste(expectedFrontmostPID: targetPID) ? .typed : .failed
        }
        let map: [String: CGKeyCode] = ["enter": 36, "return": 36, "tab": 48, "escape": 53, "esc": 53]
        guard let code = map[k],
              let src = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) else { return .failed }
        down.post(tap: .cgSessionEventTap)
        up.post(tap: .cgSessionEventTap)
        return .typed
    }

    /// 是否已具备辅助功能权限。
    static var isAuthorized: Bool { AXIsProcessTrusted() }

    /// 节流版提示：30s 内最多弹一次，避免连发多条 final 叠出一堆模态框阻塞主线程。
    private func promptAccessibilityThrottled() {
        if let t = lastPromptAt, Date().timeIntervalSince(t) < 30 { return }
        lastPromptAt = Date()
        promptAccessibility()
    }

    private func promptAccessibility() {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = "需要“辅助功能”权限"
            alert.informativeText = "ClaudeVoice 需要辅助功能权限才能把语音识别的文字输入到当前窗口。请前往 系统设置 → 隐私与安全性 → 辅助功能，开启 ClaudeVoice。"
            alert.addButton(withTitle: "打开系统设置")
            alert.addButton(withTitle: "稍后")
            if alert.runModal() == .alertFirstButtonReturn {
                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
            }
        }
    }

}
