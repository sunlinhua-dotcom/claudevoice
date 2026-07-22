import Cocoa
import ServiceManagement
import ApplicationServices
import QuartzCore
import Darwin

func appLog(_ s: String) {
    let line = "[\(Date())] \(s)\n"
    let p = "/tmp/claudevoice-app.log"
    if let h = FileHandle(forWritingAtPath: p) {
        h.seekToEndOfFile(); if let d = line.data(using: .utf8) { h.write(d) }; try? h.close()
    } else { try? line.write(toFile: p, atomically: true, encoding: .utf8) }
}

func appConfig() -> (base: String, token: String) {
    let p = (NSHomeDirectory() as NSString).appendingPathComponent(".claude/claudevoice-app.json")
    if let d = try? Data(contentsOf: URL(fileURLWithPath: p)),
       let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
        return ((j["base"] as? String) ?? "", (j["token"] as? String) ?? "")
    }
    return ("", "")
}

let KICON: [String: String] = ["done": "✅", "waiting": "⏳", "permission": "🔐", "notification": "🔔", "subagent": "🧩"]
let KLABEL: [String: String] = ["done": "已完成", "waiting": "等待输入", "permission": "需要授权", "notification": "通知", "subagent": "子任务"]

// 串行播放器：提示音 + MiMo 语音，顺序播、不重叠
final class Player {
    let queue = OperationQueue()
    var muted = false
    var idle = true   // 队列空闲标志：一波密集事件里只在第一条放音效，避免音效连发像警报
    let cfg: (base: String, token: String)
    init(_ c: (base: String, token: String)) { cfg = c; queue.maxConcurrentOperationCount = 1 }

    func enqueue(_ ev: [String: Any], delete path: String?) {
        queue.addOperation { [weak self] in
            guard let self = self else { return }
            self.playOne(ev)
            if let p = path { try? FileManager.default.removeItem(atPath: p) }
            if self.queue.operationCount <= 1 { self.idle = true }   // 队列已排空 → 下一波重新允许音效
        }
    }
    private func playOne(_ ev: [String: Any]) {
        if muted { return }
        guard let speak = ev["speak"] as? String, !speak.isEmpty else { return }
        let knd = ev["kind"] as? String ?? ""
        if idle { idle = false; appLog("音效播放 [\(knd)]"); chime(knd) }   // 一波里只第一条放音效
        else { appLog("音效跳过·密集事件 [\(knd)]") }
        guard let data = fetchTTS(text: speak, voice: ev["voice"] as? String ?? "", style: ev["style"] as? String ?? "") else { return }
        let tmp = NSTemporaryDirectory() + "cv_\(UUID().uuidString).mp3"
        do { try data.write(to: URL(fileURLWithPath: tmp)) } catch { return }
        afplay(tmp)
        try? FileManager.default.removeItem(atPath: tmp)
    }
    private func chime(_ kind: String) {
        let file = (kind == "done" || kind == "subagent") ? "chime-done.wav" : "chime-alert.wav"
        let p = (Bundle.main.resourcePath ?? "") + "/" + file
        if FileManager.default.fileExists(atPath: p) { afplay(p) }
        else { afplay("/System/Library/Sounds/Hero.aiff") }   // 兜底
    }
    private func afplay(_ path: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/afplay")
        p.arguments = [path]
        do { try p.run(); p.waitUntilExit() } catch {}
    }
    private func fetchTTS(text: String, voice: String, style: String) -> Data? {
        guard let url = URL(string: cfg.base + "/tts") else { return nil }
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.setValue(cfg.token, forHTTPHeaderField: "X-CV-Token")
        r.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text, "voice": voice, "style": style, "format": "mp3"])
        let sem = DispatchSemaphore(value: 0); var out: Data?
        URLSession.shared.dataTask(with: r) { d, resp, _ in
            if let h = resp as? HTTPURLResponse, h.statusCode == 200 { out = d }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 60)
        return out
    }
}

// 监听本地队列目录，新文件顺序交给播放器
final class QueueWatcher {
    let dir: String
    let onFile: (String) -> Void
    var seen = Set<String>()
    var timer: Timer?
    init(dir: String, onFile: @escaping (String) -> Void) { self.dir = dir; self.onFile = onFile }
    func start() {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        if let files = try? FileManager.default.contentsOfDirectory(atPath: dir) {
            for f in files where f.hasSuffix(".json") { try? FileManager.default.removeItem(atPath: dir + "/" + f) }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.scan() }
        appLog("watching \(dir)")
    }
    func scan() {
        guard let files = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return }
        for f in files.filter({ $0.hasSuffix(".json") }).sorted() where !seen.contains(f) {
            seen.insert(f); onFile(dir + "/" + f)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var statusItem: NSStatusItem!
    var player: Player!
    var watcher: QueueWatcher!
    let cfg = appConfig()
    var recent: [[String: Any]] = []
    private let relayClient = RelayClient()
    private let injector = TextInjector()
    private let defaults = UserDefaults.standard
    private var llmOn = true
    private var pairingWC: PairingWindowController?
    private var pulsing = false
    private var remoteConnectionTitle = "状态：未连接"
    private var remotePeerTitle = "对端：等待手机"
    private var pairedDeviceCount = 0
    private var lastInjectedText = "——"
    private var relayUrl: String {
        get { RelayClient.resolveRelayURL(defaults.string(forKey: "relayUrl")) }
        set { defaults.set(newValue, forKey: "relayUrl") }
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        appLog("launched. base=\(cfg.base) tokenLen=\(cfg.token.count)")
        migrateRemoteVoiceDefaultsIfNeeded()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.imagePosition = .imageOnly
        statusItem.button?.toolTip = "ClaudeVoice"
        setSaturnIcon()
        let menu = NSMenu(); menu.delegate = self
        statusItem.menu = menu

        player = Player(cfg)
        let dir = (NSHomeDirectory() as NSString).appendingPathComponent(".claude/cv-queue")
        watcher = QueueWatcher(dir: dir) { [weak self] path in
            guard let self = self,
                  let d = FileManager.default.contents(atPath: path),
                  let ev = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else {
                try? FileManager.default.removeItem(atPath: path); return
            }
            self.recordRecent(ev)
            appLog("queued: \(ev["project"] ?? "?") \(ev["kind"] ?? "?")")
            self.player.enqueue(ev, delete: path)
        }
        watcher.start()
        setupRemoteInput()
    }

    func applicationWillTerminate(_ notification: Notification) {
        appLog("terminating")
        relayClient.disconnect()
        DictationHUD.shared.teardown()
        watcher?.timer?.invalidate()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        return true
    }

    func recordRecent(_ ev: [String: Any]) {
        DispatchQueue.main.async { self.recent.insert(ev, at: 0); if self.recent.count > 6 { self.recent.removeLast() } }
    }
    func resPath(_ name: String) -> String { (Bundle.main.resourcePath ?? ".") + "/" + name }
    func hhmm(_ ev: [String: Any]) -> String {
        guard let ts = ev["ts"] as? Double else { return "" }
        let f = DateFormatter(); f.dateFormat = "HH:mm"; return f.string(from: Date(timeIntervalSince1970: ts / 1000))
    }

    func setSaturnIcon() {
        guard let btn = statusItem?.button else { return }
        stopPulse()
        btn.contentTintColor = nil
        if let img = NSImage(contentsOfFile: resPath("menubar.png")) {
            img.size = NSSize(width: 18, height: 18)
            img.isTemplate = true
            btn.image = img
            btn.title = ""
        } else {
            btn.image = nil
            btn.title = "◑"
        }
    }

    func setRecordingIcon() {
        guard let btn = statusItem?.button else { return }
        let cfg = NSImage.SymbolConfiguration(pointSize: 16, weight: .medium)
        let img = NSImage(systemSymbolName: "mic.fill", accessibilityDescription: "Listening")?
            .withSymbolConfiguration(cfg)
        img?.isTemplate = false
        btn.title = ""
        btn.image = img
        btn.contentTintColor = .systemRed
        startPulse()
    }

    func startPulse() {
        guard !pulsing, let btn = statusItem?.button else { return }
        pulsing = true
        btn.wantsLayer = true
        let anim = CABasicAnimation(keyPath: "opacity")
        anim.fromValue = 1.0
        anim.toValue = 0.35
        anim.duration = 0.7
        anim.autoreverses = true
        anim.repeatCount = .infinity
        anim.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        btn.layer?.add(anim, forKey: "recordingPulse")
    }

    func stopPulse() {
        pulsing = false
        statusItem?.button?.layer?.removeAnimation(forKey: "recordingPulse")
    }

    // 每次打开菜单时重建，展示最近播报
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let header = NSMenuItem(title: "ClaudeVoice · 语音播报", action: nil, keyEquivalent: ""); header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        let lbl = NSMenuItem(title: "", action: nil, keyEquivalent: ""); lbl.isEnabled = false
        lbl.attributedTitle = NSAttributedString(string: "最近播报", attributes: [.font: NSFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: NSColor.tertiaryLabelColor])
        menu.addItem(lbl)
        if recent.isEmpty {
            let e = NSMenuItem(title: "", action: nil, keyEquivalent: ""); e.isEnabled = false
            e.attributedTitle = NSAttributedString(string: "  还没有播报", attributes: [.foregroundColor: NSColor.secondaryLabelColor, .font: NSFont.systemFont(ofSize: 12)])
            menu.addItem(e)
        } else {
            for (i, ev) in recent.prefix(3).enumerated() {
                let it = NSMenuItem(title: "", action: #selector(replayRecent(_:)), keyEquivalent: "")
                it.target = self; it.tag = i; it.attributedTitle = recentAttr(ev)
                menu.addItem(it)
            }
        }
        menu.addItem(.separator())

        let mute = NSMenuItem(title: player.muted ? "🔔 取消静音" : "🔕 静音", action: #selector(toggleMute), keyEquivalent: "")
        mute.target = self; menu.addItem(mute)
        let test = NSMenuItem(title: "▶ 测试播报", action: #selector(testSpeak), keyEquivalent: ""); test.target = self; menu.addItem(test)
        let panel = NSMenuItem(title: "🖥 打开网页面板", action: #selector(openPanel), keyEquivalent: ""); panel.target = self; menu.addItem(panel)
        let login = NSMenuItem(title: loginOn() ? "🚀 开机自启 ✓" : "🚀 开机自启", action: #selector(toggleLogin), keyEquivalent: ""); login.target = self; menu.addItem(login)
        menu.addItem(.separator())

        let remoteHeader = NSMenuItem(title: "", action: nil, keyEquivalent: ""); remoteHeader.isEnabled = false
        remoteHeader.attributedTitle = NSAttributedString(string: "远程输入", attributes: [.font: NSFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: NSColor.tertiaryLabelColor])
        menu.addItem(remoteHeader)
        let conn = NSMenuItem(title: remoteConnectionTitle, action: nil, keyEquivalent: ""); conn.isEnabled = false; menu.addItem(conn)
        let peer = NSMenuItem(title: remotePeerTitle, action: nil, keyEquivalent: ""); peer.isEnabled = false; menu.addItem(peer)
        let pairing = NSMenuItem(title: "配对 / 设备…", action: #selector(openPairing), keyEquivalent: ""); pairing.target = self; menu.addItem(pairing)
        let devices = NSMenuItem(title: "已配对设备：\(pairedDeviceCount)", action: nil, keyEquivalent: ""); devices.isEnabled = false; menu.addItem(devices)
        let last = NSMenuItem(title: "最近注入：\(shortMenuText(lastInjectedText, limit: 42))", action: nil, keyEquivalent: ""); last.isEnabled = false; menu.addItem(last)
        let llm = NSMenuItem(title: "标点纠错：\(llmOn ? "开" : "关")", action: #selector(toggleLlm), keyEquivalent: ""); llm.target = self; menu.addItem(llm)
        let relay = NSMenuItem(title: "服务器地址：\(relayUrl)", action: #selector(editRelay), keyEquivalent: ""); relay.target = self; menu.addItem(relay)
        let reconnect = NSMenuItem(title: "重新连接", action: #selector(reconnectRelay), keyEquivalent: "r"); reconnect.target = self; menu.addItem(reconnect)
        menu.addItem(.separator())

        let quit = NSMenuItem(title: "退出 ClaudeVoice", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); menu.addItem(quit)
    }

    func recentAttr(_ ev: [String: Any]) -> NSAttributedString {
        let kind = ev["kind"] as? String ?? ""
        let proj = ev["project"] as? String ?? "?"
        let icon = KICON[kind] ?? "🔔"
        let label = KLABEL[kind] ?? kind
        var detail = (ev["detail"] as? String) ?? (ev["speak"] as? String) ?? ""
        detail = detail.replacingOccurrences(of: "\n", with: " ")
        if detail.count > 40 { detail = String(detail.prefix(40)) + "…" }
        let tint: NSColor = ["done": NSColor.systemGreen, "permission": NSColor.systemPink, "waiting": NSColor.systemOrange, "notification": NSColor.systemBlue, "subagent": NSColor.systemPurple][kind] ?? NSColor.labelColor
        let s = NSMutableAttributedString()
        let para = NSMutableParagraphStyle(); para.lineSpacing = 2; para.paragraphSpacing = 2
        s.append(NSAttributedString(string: "\(icon) \(proj)  ", attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .semibold), .paragraphStyle: para]))
        s.append(NSAttributedString(string: "\(label)  \(hhmm(ev))\n", attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: tint, .paragraphStyle: para]))
        s.append(NSAttributedString(string: "    " + detail, attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: para]))
        return s
    }

    @objc func replayRecent(_ sender: NSMenuItem) {
        let i = sender.tag
        if i >= 0 && i < recent.count { player.enqueue(recent[i], delete: nil) }
    }
    @objc func toggleMute() { player.muted.toggle() }
    @objc func testSpeak() {
        let ev: [String: Any] = ["speak": "这是一条测试播报，语音清晰、顺序播放。", "voice": "mimo_default", "style": "语气自然。", "kind": "done", "project": "测试", "ts": Date().timeIntervalSince1970 * 1000, "detail": "点菜单里的测试播报触发。"]
        recordRecent(ev); player.enqueue(ev, delete: nil)
    }
    @objc func openPanel() {
        if let u = URL(string: cfg.base + "/?token=" + cfg.token) { NSWorkspace.shared.open(u) }
    }
    func loginOn() -> Bool { if #available(macOS 13.0, *) { return SMAppService.mainApp.status == .enabled }; return false }
    @objc func toggleLogin() {
        if #available(macOS 13.0, *) {
            do { if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() } } catch {}
        }
    }

    func migrateRemoteVoiceDefaultsIfNeeded() {
        guard let legacy = UserDefaults(suiteName: "com.remotevoice.input") else { return }
        var migrated: [String] = []
        if (defaults.string(forKey: MacIdentity.defaultsKey) ?? "").isEmpty,
           let macId = legacy.string(forKey: MacIdentity.defaultsKey), !macId.isEmpty {
            defaults.set(macId, forKey: MacIdentity.defaultsKey)
            migrated.append("macId=\(String(macId.prefix(8)))…")
        }
        if (defaults.string(forKey: "relayUrl") ?? "").isEmpty,
           let url = legacy.string(forKey: "relayUrl"), !url.isEmpty {
            defaults.set(url, forKey: "relayUrl")
            migrated.append("relayUrl")
        }
        defaults.synchronize()
        if migrated.isEmpty {
            appLog("remote input defaults ready macId=\(String(MacIdentity.current.prefix(8))) relay=\(relayUrl)")
        } else {
            appLog("remote input migrated defaults: \(migrated.joined(separator: ", ")) relay=\(relayUrl)")
        }
    }

    func setupRemoteInput() {
        relayClient.macId = MacIdentity.current
        relayClient.onState = { [weak self] state in self?.handleRelayState(state) }
        relayClient.onEvent = { [weak self] event in self?.handleRelayEvent(event) }
        requestAccessibilityPromptOnce()
        appLog("remote input connecting macId=\(String(MacIdentity.current.prefix(8))) relay=\(relayUrl)")
        relayClient.connect(to: relayUrl)
    }

    func requestAccessibilityPromptOnce() {
        guard !AXIsProcessTrusted() else { return }
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
        appLog("remote input requested AX permission prompt")
    }

    func handleRelayState(_ state: RelayClient.State) {
        DispatchQueue.main.async {
            switch state {
            case .connecting:
                self.remoteConnectionTitle = "状态：连接中…"
            case .connected:
                self.remoteConnectionTitle = "状态：已连接"
                appLog("remote input connected macId=\(String(MacIdentity.current.prefix(8)))")
            case .disconnected:
                self.remoteConnectionTitle = "状态：未连接"
                self.remotePeerTitle = "对端：等待手机"
                self.setSaturnIcon()
                DictationHUD.shared.hide()
            }
        }
    }

    func handleRelayEvent(_ event: RelayClient.Event) {
        DispatchQueue.main.async {
            switch event {
            case .macReady(let macId):
                self.remotePeerTitle = "对端：等待手机"
                self.setSaturnIcon()
                self.pairingWC?.refreshIfOpen()
                appLog("remote input mac_ready macId=\(String(macId.prefix(8)))")
            case .shortCode(let code):
                self.pairingWC?.applyShortCode(code)
            case .devices(let list):
                self.pairedDeviceCount = list.count
                self.pairingWC?.applyDevices(list)
                appLog("remote input devices=\(list.count)")
            case .unpaired:
                self.remotePeerTitle = "对端：已被移除，请重新扫码"
                DictationHUD.shared.hide()
                self.setSaturnIcon()
            case .assign(let code):
                self.remotePeerTitle = "配对码：\(code)"
            case .paired(let peer):
                if peer == "phone" {
                    self.remotePeerTitle = "对端：手机已就绪"
                    self.setSaturnIcon()
                    self.relayClient.send(["type": "config", "llm_postprocess": self.llmOn])
                    appLog("remote input paired peer=phone macId=\(String(MacIdentity.current.prefix(8)))")
                }
            case .peerGone:
                self.remotePeerTitle = "对端：已断开"
                DictationHUD.shared.hide()
                self.setSaturnIcon()
            case .config(let llm):
                self.llmOn = llm
            case .partial(let text):
                self.setRecordingIcon()
                DictationHUD.shared.showPartial(text)
            case .final(let text, let injectId):
                self.setSaturnIcon()
                if text.isEmpty {
                    DictationHUD.shared.hide()
                    return
                }
                self.lastInjectedText = text
                let outcome = self.injector.inject(text)
                switch outcome {
                case .typed:
                    DictationHUD.shared.showFinal(text)
                case .copied:
                    DictationHUD.shared.showFinal("📋 已复制：\(text)")
                case .failed:
                    DictationHUD.shared.showFinal("⚠️ 注入失败：\(text)")
                }
                appLog("remote input injected id=\(injectId ?? "-") mode=\(outcome.mode) ok=\(outcome.ok)")
                if let injectId {
                    self.relayClient.send(["type": "inject_ack", "id": injectId, "ok": outcome.ok, "mode": outcome.mode])
                }
            case .key(let key, let injectId):
                let outcome = self.injector.pressKey(key)
                if outcome.mode == "type" {
                    DictationHUD.shared.showFinal(key.lowercased().contains("paste") ? "📋 已粘贴" : "⏎ 回车")
                }
                appLog("remote input key id=\(injectId ?? "-") key=\(key) mode=\(outcome.mode) ok=\(outcome.ok)")
                if let injectId {
                    self.relayClient.send(["type": "inject_ack", "id": injectId, "ok": outcome.ok, "mode": outcome.mode])
                }
            case .error(let msg):
                DictationHUD.shared.showFinal("⚠️ \(msg)")
                appLog("remote input error \(msg)")
            }
        }
    }

    func shortMenuText(_ text: String, limit: Int) -> String {
        let cleaned = text.replacingOccurrences(of: "\n", with: " ")
        if cleaned.count <= limit { return cleaned }
        return String(cleaned.prefix(limit)) + "…"
    }

    @objc func openPairing() {
        if pairingWC == nil {
            pairingWC = PairingWindowController(relay: relayClient, relayUrl: relayUrl)
        }
        pairingWC?.showAndRequest()
    }

    @objc func toggleLlm() {
        llmOn.toggle()
        relayClient.send(["type": "config", "llm_postprocess": llmOn])
        appLog("remote input llm_postprocess=\(llmOn)")
    }

    @objc func editRelay() {
        let alert = NSAlert()
        alert.messageText = "中继服务器地址"
        alert.informativeText = "WebSocket URL，例如 wss://your-host/ws"
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        input.stringValue = relayUrl
        alert.accessoryView = input
        alert.addButton(withTitle: "保存")
        alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn {
            let value = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { return }
            relayUrl = value
            pairingWC?.close()
            pairingWC = nil
            appLog("remote input relay changed \(value)")
            relayClient.connect(to: value)
        }
    }

    @objc func reconnectRelay() {
        appLog("remote input reconnect requested")
        relayClient.connect(to: relayUrl)
    }
}

// 单实例保护：抢一个文件锁，抢不到=已有实例在跑 → 直接退出，避免同一条事件被两个进程各播一遍
let cvLockPath = (NSHomeDirectory() as NSString).appendingPathComponent(".claude/cv-app.lock")
let cvLockFD = open(cvLockPath, O_CREAT | O_RDWR, 0o644)
if cvLockFD == -1 || flock(cvLockFD, LOCK_EX | LOCK_NB) != 0 {
    appLog("已有实例在运行，本次启动退出（单实例锁）")
    exit(0)
}
// cvLockFD 故意不关闭：进程存活期间一直持锁，退出时内核自动释放

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
