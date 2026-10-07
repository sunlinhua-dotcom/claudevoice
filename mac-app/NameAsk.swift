import Cocoa
import QuartzCore
import UserNotifications

// 新项目读音询问：优先用系统通知（横幅自带回复输入框，直接回一句读音就写回服务端）。
//
// 前提是 App 必须用 Developer ID 签名：TeamIdentifier 为空的自签名 App 会被
// UNUserNotificationCenter 直接拒掉，报 "Notifications are not allowed for
// this application"。build.sh 已改成优先找 Developer ID。
// 万一没证书或用户拒了通知权限，退回自绘的通知样式浮层（贴右上角同一位置，
// 零权限、必定弹得出来），功能不丢。
/// borderless 的 NSWindow 默认 canBecomeKey=false，那样面板上的输入框收不到键盘。
/// 配合 .nonactivatingPanel，它能拿到键盘焦点又不把 App 抢到前台。
final class AskPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

final class NameAsk: NSObject {
    static let shared = NameAsk()

    private let askedKey = "cvNameAsked"          // 弹过的项目，避免同一个反复打扰
    private let categoryId = "CV_NAME_ASK"
    private let replyId = "CV_NAME_REPLY"
    private let laterId = "CV_NAME_LATER"
    private var base = ""
    private var token = ""
    private var panel: NSPanel?

    /// 还没定读音的项目：key + 兜底读音
    private(set) var pending: [(key: String, guess: String)] = []
    var onPendingChanged: (() -> Void)?

    func setup(base: String, token: String) {
        self.base = base
        self.token = token
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let reply = UNTextInputNotificationAction(
            identifier: replyId, title: "设定读音", options: [],
            textInputButtonTitle: "保存", textInputPlaceholder: "例如：本地的 Spark 算力")
        let later = UNNotificationAction(identifier: laterId, title: "以后再说", options: [])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: categoryId, actions: [reply, later],
                                   intentIdentifiers: [], options: [])
        ])
        center.requestAuthorization(options: [.alert, .sound]) { granted, err in
            appLog("name-ask notifications granted=\(granted) err=\(err?.localizedDescription ?? "-")")
        }
        fetchServerPending()
    }

    /// 有系统通知权限就走原生横幅（自带回复框），否则退回自绘面板。
    private func deliver(key: String, guess: String) {
        UNUserNotificationCenter.current().getNotificationSettings { st in
            DispatchQueue.main.async {
                switch st.authorizationStatus {
                case .authorized, .provisional:
                    self.postBanner(key: key, guess: guess)
                default:
                    appLog("name-ask fallback to panel (auth=\(st.authorizationStatus.rawValue))")
                    self.showPanel(key: key, guess: guess)
                }
            }
        }
    }

    private func postBanner(key: String, guess: String) {
        let c = UNMutableNotificationContent()
        c.title = "新项目 \(key)"
        c.subtitle = "该怎么念？"
        c.body = "现在按兜底规则念作「\(guess)」。回一句正确读音即可，只要听着对，用同音字也行。"
        c.sound = .default
        c.categoryIdentifier = categoryId
        c.userInfo = ["key": key]
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "cv-name-\(key)", content: c, trigger: nil)) { err in
            if let err = err {
                appLog("name-ask banner failed: \(err.localizedDescription)")
                DispatchQueue.main.async { self.showPanel(key: key, guess: guess) }
            }
        }
    }

    // MARK: - 触发

    /// 每条播报都过一遍；只有「读音表里没有」的才问。
    func consider(_ ev: [String: Any]) {
        guard (ev["unknownName"] as? Bool) == true else { return }
        guard let key = (ev["projectKey"] as? String)?.trimmingCharacters(in: .whitespaces),
              !key.isEmpty, key != "unknown" else { return }
        note(key: key, guess: (ev["project"] as? String) ?? key)
    }

    /// 启动时把服务端攒着的待确认拉回来，App 没开时出现的新项目也不会漏问。
    private func fetchServerPending() {
        guard !base.isEmpty, let u = URL(string: base + "/pending") else { return }
        var r = URLRequest(url: u)
        r.setValue(token, forHTTPHeaderField: "x-cv-secret")
        r.timeoutInterval = 10
        URLSession.shared.dataTask(with: r) { [weak self] d, _, _ in
            guard let self = self, let d = d,
                  let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return }
            for (_, v) in j {
                guard let item = v as? [String: Any], let key = item["key"] as? String else { continue }
                self.note(key: key, guess: (item["guess"] as? String) ?? key)
            }
        }.resume()
    }

    private func note(key: String, guess: String) {
        DispatchQueue.main.async {
            if self.pending.contains(where: { $0.key.lowercased() == key.lowercased() }) { return }
            self.pending.append((key: key, guess: guess))
            self.onPendingChanged?()
            var asked = Set(UserDefaults.standard.stringArray(forKey: self.askedKey) ?? [])
            if asked.contains(key.lowercased()) { return }   // 弹过就不再自动弹，条目仍留在菜单里
            asked.insert(key.lowercased())
            UserDefaults.standard.set(Array(asked), forKey: self.askedKey)
            self.deliver(key: key, guess: guess)
        }
    }

    /// 菜单栏「待定读音」入口：手动补问一个。
    func askNext() {
        guard let item = pending.first else { return }
        deliver(key: item.key, guess: item.guess)
    }

    // MARK: - 通知样式浮层

    private func showPanel(key: String, guess: String) {
        panel?.orderOut(nil)
        guard let screen = NSScreen.main else { return }

        let W: CGFloat = 372, H: CGFloat = 188
        let p = AskPanel(contentRect: NSRect(x: 0, y: 0, width: W, height: H),
                         styleMask: [.borderless, .nonactivatingPanel],
                         backing: .buffered, defer: false)
        p.isFloatingPanel = true
        p.level = .statusBar
        p.hidesOnDeactivate = false
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        // 明暗必须显式钉死。不钉的话 borderless + vibrant 会让控件各挑各的
        // 外观——背景浅色、输入框却按暗色画，看着像坏了。
        p.appearance = NSAppearance(named: NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) ?? .aqua)

        let bg = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: W, height: H))
        bg.material = .windowBackground
        bg.blendingMode = .withinWindow
        bg.appearance = p.appearance
        bg.state = .active
        bg.wantsLayer = true
        bg.layer?.cornerRadius = 16
        bg.layer?.masksToBounds = true
        bg.layer?.borderWidth = 0.5
        bg.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.5).cgColor
        p.contentView = bg

        let pad: CGFloat = 16
        let iconSize: CGFloat = 38

        let icon = NSImageView(frame: NSRect(x: pad, y: H - pad - iconSize, width: iconSize, height: iconSize))
        icon.image = NSApp.applicationIconImage
        icon.imageScaling = .scaleProportionallyUpOrDown
        bg.addSubview(icon)

        let textX = pad + iconSize + 12
        let textW = W - textX - pad

        let app = NSTextField(labelWithString: "ClaudeVoice")
        app.frame = NSRect(x: textX, y: H - pad - 15, width: textW, height: 14)
        app.font = .systemFont(ofSize: 11, weight: .semibold)
        app.textColor = .secondaryLabelColor
        bg.addSubview(app)

        let title = NSTextField(labelWithString: "新项目 \(key) 该怎么念？")
        title.frame = NSRect(x: textX, y: H - pad - 34, width: textW, height: 18)
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.lineBreakMode = .byTruncatingMiddle
        bg.addSubview(title)

        let sub = NSTextField(wrappingLabelWithString: "现在按兜底规则念作「\(guess)」。只要听着对就行，用同音汉字当注音完全没问题。")
        sub.frame = NSRect(x: textX, y: H - pad - 76, width: textW, height: 40)
        sub.font = .systemFont(ofSize: 11.5)
        sub.textColor = .secondaryLabelColor
        sub.isSelectable = false
        bg.addSubview(sub)

        let field = NSTextField(frame: NSRect(x: pad, y: 54, width: W - pad * 2, height: 24))
        field.placeholderString = "输入正确读音"
        field.font = .systemFont(ofSize: 13)
        field.bezelStyle = .roundedBezel
        field.focusRingType = .default
        field.target = self
        field.action = #selector(saveFromField(_:))   // 回车即保存
        bg.addSubview(field)

        let save = NSButton(title: "保存", target: self, action: #selector(saveFromField(_:)))
        save.frame = NSRect(x: W - pad - 72, y: 14, width: 72, height: 28)
        save.bezelStyle = .rounded
        save.keyEquivalent = "\r"
        save.controlSize = .regular
        if #available(macOS 10.14, *) { save.bezelColor = .controlAccentColor }
        bg.addSubview(save)

        let later = NSButton(title: "以后再说", target: self, action: #selector(dismissPanel))
        later.frame = NSRect(x: W - pad - 72 - 88, y: 14, width: 84, height: 28)
        later.bezelStyle = .rounded
        bg.addSubview(later)

        panelKey = key
        panelField = field

        // 贴右上角，菜单栏正下方（visibleFrame 已排除菜单栏），从右侧滑入
        // 直接摆到最终位置、alpha 拉满再显示。
        // 之前用 animator() 从屏幕外滑入，动画没跑起来时面板就卡在屏外 / alpha=0，
        // 等于没弹出来——这种地方不值得为了动效冒看不见的风险。
        let vf = screen.visibleFrame
        p.setFrameOrigin(NSPoint(x: vf.maxX - W - 12, y: vf.maxY - H - 6))
        p.alphaValue = 1
        p.orderFrontRegardless()
        p.makeKey()                      // nonactivating：拿键盘但不把 App 抢到前台
        p.makeFirstResponder(field)
        panel = p

        // 自测钩子：CV_NAMEASK_SELFTEST=<读音> 时自动填入并保存，用来验证
        // 「输入框 → 保存 → 写回服务端」整条链路，平时不生效。
        if let t = ProcessInfo.processInfo.environment["CV_NAMEASK_SELFTEST"], !t.isEmpty {
            field.stringValue = t
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.saveFromField(nil) }
        }

        // 一分钟没人管就收起来，条目留在菜单栏的「待定读音」里
        let thisKey = key
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
            if self?.panelKey == thisKey { self?.dismissPanel() }
        }
    }

    private var panelKey: String?
    private weak var panelField: NSTextField?

    @objc private func saveFromField(_ sender: Any?) {
        guard let key = panelKey else { return }
        let say = (panelField?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !say.isEmpty else { NSSound.beep(); return }
        submit(key: key, say: say)
        dismissPanel()
    }

    @objc private func dismissPanel() {
        panel?.orderOut(nil)
        panel = nil
        panelKey = nil
        panelField = nil
    }

    // MARK: - 写回服务端

    func submitFromNotification(key: String, say: String) { submit(key: key, say: say) }

    private func submit(key: String, say: String) {
        guard !base.isEmpty, let u = URL(string: base + "/names") else { return }
        var r = URLRequest(url: u)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "content-type")
        r.setValue(token, forHTTPHeaderField: "x-cv-secret")
        r.httpBody = try? JSONSerialization.data(withJSONObject: [key: ["say": say]])
        r.timeoutInterval = 15
        URLSession.shared.dataTask(with: r) { [weak self] d, _, err in
            let body = (try? JSONSerialization.jsonObject(with: d ?? Data())) as? [String: Any]
            let ok = err == nil && (body?["ok"] as? Bool) == true
            appLog("name-ask submit \(key)=\(say) ok=\(ok) err=\(err?.localizedDescription ?? "-")")
            DispatchQueue.main.async {
                guard let self = self else { return }
                if ok {
                    self.pending.removeAll { $0.key.lowercased() == key.lowercased() }
                    self.onPendingChanged?()
                }
                self.confirm(ok: ok, key: key, say: say)
            }
        }.resume()
    }

    private func confirm(ok: Bool, key: String, say: String) {
        let text = ok ? "✓ \(key) 以后念作「\(say)」" : "✗ \(key) 没保存上，可从菜单栏重试"
        UNUserNotificationCenter.current().getNotificationSettings { st in
            DispatchQueue.main.async {
                guard st.authorizationStatus == .authorized || st.authorizationStatus == .provisional else {
                    self.toast(text); return
                }
                let c = UNMutableNotificationContent()
                c.title = ok ? "读音已设定" : "读音没保存上"
                c.body = text
                UNUserNotificationCenter.current().add(
                    UNNotificationRequest(identifier: "cv-name-ok-\(key)", content: c, trigger: nil))
            }
        }
    }

    /// 没通知权限时的结果回执：贴右上角，两秒半后自己消失。
    private func toast(_ text: String) {
        guard let screen = NSScreen.main else { return }
        let W: CGFloat = 340, H: CGFloat = 52
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: W, height: H),
                        styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.isFloatingPanel = true; p.level = .statusBar; p.isOpaque = false
        p.backgroundColor = .clear; p.hasShadow = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let blur = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: W, height: H))
        blur.material = .hudWindow; blur.blendingMode = .behindWindow; blur.state = .active
        blur.wantsLayer = true; blur.layer?.cornerRadius = 14; blur.layer?.masksToBounds = true
        let lbl = NSTextField(labelWithString: text)
        lbl.frame = NSRect(x: 16, y: 16, width: W - 32, height: 20)
        lbl.font = .systemFont(ofSize: 12, weight: .medium)
        lbl.lineBreakMode = .byTruncatingTail
        blur.addSubview(lbl)
        p.contentView = blur
        let vf = screen.visibleFrame
        p.setFrameOrigin(NSPoint(x: vf.maxX - W - 14, y: vf.maxY - H - 6))
        p.orderFrontRegardless()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { p.orderOut(nil) }
    }
}

extension NameAsk: UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])   // App 在前台时也照样弹
    }

    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        defer { done() }
        guard let key = response.notification.request.content.userInfo["key"] as? String else { return }
        if let text = (response as? UNTextInputNotificationResponse)?.userText
            .trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            submitFromNotification(key: key, say: text)
        } else if response.actionIdentifier == laterId {
            appLog("name-ask deferred \(key)")
        }
    }
}
