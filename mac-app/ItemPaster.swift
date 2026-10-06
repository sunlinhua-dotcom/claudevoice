// 飞书附件批量粘贴。cc-bridge 由 PM2 在后台拉起，没有桌面会话，也就拿不到剪贴板（连 pbcopy 都失败）；
// 剪贴板和粘贴只能交给常驻桌面的本 App 来做。指令搭中继的 inject_key 通道过来，中继不认识也会原样转发：
//   key = "cv:" + {"op":"paste_items","items":[{"path":…,"kind":"image"|"file"}]}
//   key = "cv:" + {"op":"paste_text","text":…}
// 回执塞进 inject_ack 的 mode 字段（中继只透传 id / ok / mode）："cv:" + {"pasted","total","app","reason"}。

import AppKit
import ApplicationServices
import CoreGraphics
import Carbon // IsSecureEventInputEnabled()

final class ItemPaster {

    struct Result {
        var pasted = 0
        var total = 0
        var app = ""
        var reason = ""
        var ok: Bool { total > 0 && pasted == total }
        var ackMode: String {
            let payload: [String: Any] = ["pasted": pasted, "total": total, "app": app, "reason": reason]
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return ItemPaster.prefix + "{}" }
            return ItemPaster.prefix + json
        }
    }

    static let prefix = "cv:"

    /// 终端里的 Claude Code 只认 Ctrl+V 贴图（Cmd+V 只会贴文字）；其余 App 一律 Cmd+V。
    static let terminalBundles: Set<String> = [
        "com.apple.terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "dev.warp.warp-stable",
        "com.github.wez.wezterm", "net.kovidgoyal.kitty", "org.alacritty", "co.zeit.hyper",
    ]

    /// 不该收粘贴的系统界面，与 TextInjector 的名单一致。
    static let denyBundles: Set<String> = [
        "com.apple.finder", "com.apple.dock", "com.apple.loginwindow",
        "com.apple.systemuiserver", "com.apple.controlcenter", "com.apple.spotlight",
        "com.apple.wallpaper", "com.apple.notificationcenterui",
    ]

    private struct Target { let pid: pid_t; let name: String; let bundle: String }

    /// 串行队列：一批图要逐张贴、每张之间要等，不能堵主线程，也不能两批交错。
    private let queue = DispatchQueue(label: "com.claudevoice.itempaster")

    /// 不是 "cv:" 开头的按键返回 nil，交回 TextInjector 的老逻辑。
    static func parse(_ key: String) -> [String: Any]? {
        guard key.hasPrefix(prefix),
              let data = String(key.dropFirst(prefix.count)).data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["op"] is String else { return nil }
        return object
    }

    func run(_ command: [String: Any], completion: @escaping (Result) -> Void) {
        queue.async {
            let result: Result
            switch command["op"] as? String {
            case "paste_items":
                let items = (command["items"] as? [[String: Any]] ?? []).compactMap { raw -> (path: String, isImage: Bool)? in
                    guard let path = raw["path"] as? String, !path.isEmpty else { return nil }
                    return (path, (raw["kind"] as? String) == "image")
                }
                result = self.pasteItems(items)
            case "paste_text":
                result = self.pasteText(command["text"] as? String ?? "")
            default:
                result = Result(reason: "不认识的指令")
            }
            completion(result)
        }
    }

    private func currentTarget() -> (Target?, String) {
        guard AXIsProcessTrusted() else { return (nil, "ClaudeVoice 没有辅助功能权限") }
        if IsSecureEventInputEnabled() { return (nil, "电脑正处在密码输入状态，系统不让模拟按键") }
        guard let app = NSWorkspace.shared.frontmostApplication else { return (nil, "找不到前台窗口") }
        let bundle = (app.bundleIdentifier ?? "").lowercased()
        let name = app.localizedName ?? bundle
        if bundle.isEmpty || Self.denyBundles.contains(bundle) { return (nil, "前台是「\(name)」，不是输入窗口") }
        return (Target(pid: app.processIdentifier, name: name, bundle: bundle), "")
    }

    private func pasteItems(_ items: [(path: String, isImage: Bool)]) -> Result {
        var result = Result(total: items.count)
        guard !items.isEmpty else { result.reason = "没有可贴的附件"; return result }
        let (found, why) = currentTarget()
        guard let target = found else { result.reason = why; return result }
        result.app = target.name
        let terminal = Self.terminalBundles.contains(target.bundle)
        for (index, item) in items.enumerated() {
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid else {
                result.reason = "前台窗口中途切走了"
                break
            }
            // 外接盘上的文件要「可移除的宗卷」授权；读不到就停，别贴一个打不开的引用。
            guard FileHandle(forReadingAtPath: item.path) != nil else {
                result.reason = "读不到第 \(index + 1) 个附件（可能要在 系统设置 → 隐私与安全性 → 文件与文件夹 给 ClaudeVoice 开「可移除的宗卷」）"
                break
            }
            let asImage = item.isImage && writeImage(item.path)
            if !asImage && !writeFileURL(item.path) {
                result.reason = "第 \(index + 1) 个附件写不进剪贴板"
                break
            }
            Thread.sleep(forTimeInterval: 0.05)
            guard postPaste(control: terminal && asImage) else {
                result.reason = "按键事件发不出去"
                break
            }
            result.pasted += 1
            // 等目标 App 把这次粘贴读完再换下一张，否则几张都会贴成最后那张。
            // 终端里的 Claude Code 收到 Ctrl+V 后要另起进程读剪贴板，所以等得久一些。
            Thread.sleep(forTimeInterval: terminal ? 1.5 : 0.6)
        }
        return result
    }

    private func pasteText(_ text: String) -> Result {
        var result = Result(total: 1)
        guard !text.isEmpty else { result.reason = "文字为空"; return result }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        guard pasteboard.setString(text, forType: .string) else { result.reason = "剪贴板写入失败"; return result }
        let (found, why) = currentTarget()
        guard let target = found else { result.reason = why + "（文字已放进剪贴板）"; return result }
        result.app = target.name
        Thread.sleep(forTimeInterval: 0.05)
        guard postPaste(control: false) else { result.reason = "按键事件发不出去（文字已放进剪贴板）"; return result }
        Thread.sleep(forTimeInterval: 0.15)
        result.pasted = 1
        return result
    }

    /// 同时放 PNG 和 TIFF：终端里的 Claude Code 读 PNG，Electron / 浏览器两种都认。
    private func writeImage(_ path: String) -> Bool {
        guard let image = NSImage(contentsOfFile: path), let tiff = image.tiffRepresentation else { return false }
        let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.declareTypes(png == nil ? [.tiff] : [.png, .tiff], owner: nil)
        var ok = pasteboard.setData(tiff, forType: .tiff)
        if let png { ok = pasteboard.setData(png, forType: .png) && ok }
        return ok
    }

    private func writeFileURL(_ path: String) -> Bool {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        return pasteboard.writeObjects([NSURL(fileURLWithPath: path)])
    }

    private func postPaste(control: Bool) -> Bool {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else { return false }
        let flags: CGEventFlags = control ? .maskControl : .maskCommand
        down.flags = flags
        up.flags = flags
        down.post(tap: .cgSessionEventTap)
        up.post(tap: .cgSessionEventTap)
        return true
    }
}
