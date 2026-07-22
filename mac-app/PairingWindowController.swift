// 「配对 / 设备」窗口：
//  - 永久二维码（内容 = https://host/?m=<macId>，macId 即长期密钥，不过期）。
//  - 4 位数字短码兜底（扫不了码时手机手输），可换一个。
//  - 已配对设备列表，可单独移除。
// 事件由 AppDelegate 收到 .shortCode / .devices 时转发进来。

import AppKit

final class PairingWindowController: NSWindowController, NSTableViewDataSource, NSTableViewDelegate {

    private weak var relay: RelayClient?
    private let relayUrl: String
    private var devices: [Device] = []

    private let qrView = NSImageView()
    private let codeLabel = NSTextField(labelWithString: "————")
    private let table = NSTableView()
    private let scroll = NSScrollView()

    init(relay: RelayClient, relayUrl: String) {
        self.relay = relay
        self.relayUrl = relayUrl
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 660),
                         styleMask: [.titled, .closable, .miniaturizable],
                         backing: .buffered, defer: false)
        w.title = "配对 / 设备"
        w.isReleasedWhenClosed = false
        w.center()
        super.init(window: w)
        buildUI()
    }
    required init?(coder: NSCoder) { fatalError() }

    /// 打开：二维码立即出（永久），并拉设备列表 + 申请一个数字短码。
    func showAndRequest() {
        renderQR()
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        relay?.requestDeviceList()
        relay?.requestShortCode()
    }

    /// 连接就绪/重置后，若窗口开着就静默刷新二维码与数字码（不弹窗、不抢焦点）。
    func refreshIfOpen() {
        guard window?.isVisible == true else { return }
        renderQR()
        relay?.requestDeviceList()
        relay?.requestShortCode()
    }

    // AppDelegate 转发进来：
    func applyShortCode(_ code: String) {
        // 1234 → "1 2 3 4"，更易读
        codeLabel.stringValue = code.map { String($0) }.joined(separator: " ")
    }
    func applyDevices(_ list: [Device]) { devices = list; table.reloadData() }

    // MARK: - UI

    private func buildUI() {
        guard let content = window?.contentView else { return }

        let title = NSTextField(labelWithString: "扫码配对")
        title.font = .systemFont(ofSize: 20, weight: .semibold)
        title.translatesAutoresizingMaskIntoConstraints = false

        qrView.translatesAutoresizingMaskIntoConstraints = false
        qrView.imageScaling = .scaleProportionallyUpOrDown
        qrView.wantsLayer = true
        qrView.layer?.backgroundColor = NSColor.white.cgColor
        qrView.layer?.cornerRadius = 12

        let hint = NSTextField(labelWithString: "用手机相机扫上方二维码即可配对（永久有效）。配过一次后手机自动连接，无需再扫。")
        hint.font = .systemFont(ofSize: 13)
        hint.textColor = .secondaryLabelColor
        hint.alignment = .center
        hint.maximumNumberOfLines = 0
        hint.lineBreakMode = .byWordWrapping
        hint.translatesAutoresizingMaskIntoConstraints = false

        // 4 位数字短码兜底
        let codeTitle = NSTextField(labelWithString: "扫不了？在手机上输入数字码")
        codeTitle.font = .systemFont(ofSize: 12)
        codeTitle.textColor = .secondaryLabelColor
        codeTitle.translatesAutoresizingMaskIntoConstraints = false

        codeLabel.font = .monospacedDigitSystemFont(ofSize: 30, weight: .semibold)
        codeLabel.alignment = .center
        codeLabel.translatesAutoresizingMaskIntoConstraints = false

        let refreshCode = NSButton(title: "换一个", target: self, action: #selector(onRefreshCode))
        refreshCode.bezelStyle = .rounded
        refreshCode.controlSize = .small
        refreshCode.translatesAutoresizingMaskIntoConstraints = false

        let sep = NSBox(); sep.boxType = .separator; sep.translatesAutoresizingMaskIntoConstraints = false

        let devTitle = NSTextField(labelWithString: "已配对设备")
        devTitle.font = .systemFont(ofSize: 14, weight: .semibold)
        devTitle.translatesAutoresizingMaskIntoConstraints = false

        configureTable()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.hasVerticalScroller = true
        scroll.documentView = table
        scroll.borderType = .bezelBorder

        [title, qrView, hint, codeTitle, codeLabel, refreshCode, sep, devTitle, scroll].forEach { content.addSubview($0) }

        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            title.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            qrView.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 14),
            qrView.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            qrView.widthAnchor.constraint(equalToConstant: 210),
            qrView.heightAnchor.constraint(equalToConstant: 210),
            hint.topAnchor.constraint(equalTo: qrView.bottomAnchor, constant: 12),
            hint.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 30),
            hint.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -30),

            codeTitle.topAnchor.constraint(equalTo: hint.bottomAnchor, constant: 14),
            codeTitle.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            codeLabel.topAnchor.constraint(equalTo: codeTitle.bottomAnchor, constant: 2),
            codeLabel.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            refreshCode.centerYAnchor.constraint(equalTo: codeLabel.centerYAnchor),
            refreshCode.leadingAnchor.constraint(equalTo: codeLabel.trailingAnchor, constant: 12),

            sep.topAnchor.constraint(equalTo: codeLabel.bottomAnchor, constant: 14),
            sep.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            sep.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            devTitle.topAnchor.constraint(equalTo: sep.bottomAnchor, constant: 12),
            devTitle.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            scroll.topAnchor.constraint(equalTo: devTitle.bottomAnchor, constant: 8),
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            scroll.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -20),
        ])
    }

    private func configureTable() {
        table.translatesAutoresizingMaskIntoConstraints = false
        table.usesAlternatingRowBackgroundColors = true
        table.rowHeight = 40
        table.dataSource = self
        table.delegate = self
        let name = NSTableColumn(identifier: .init("name")); name.title = "设备"; name.width = 130
        let created = NSTableColumn(identifier: .init("created")); created.title = "配对时间"; created.width = 120
        let seen = NSTableColumn(identifier: .init("seen")); seen.title = "最近使用"; seen.width = 120
        let action = NSTableColumn(identifier: .init("action")); action.title = ""; action.width = 64
        [name, created, seen, action].forEach { table.addTableColumn($0) }
    }

    /// 永久二维码：内容只含 macId（长期密钥），不带任何会过期的令牌。
    private func renderQR() {
        let host = RelayClient.httpsHost(fromRelayURL: relayUrl)
        var comps = URLComponents(string: host)
        comps?.path = "/"
        comps?.queryItems = [URLQueryItem(name: "m", value: MacIdentity.current)]
        let urlString = comps?.url?.absoluteString ?? "\(host)/?m=\(MacIdentity.current)"
        qrView.image = QRCode.image(from: urlString, sizePoints: 210)
    }

    @objc private func onRefreshCode() { relay?.requestShortCode() }

    @objc private func onRemove(_ sender: NSButton) {
        let row = sender.tag
        guard row >= 0, row < devices.count else { return }
        let device = devices[row]
        let alert = NSAlert()
        alert.messageText = "移除「\(device.name)」？"
        alert.informativeText = "移除后，该设备需重新扫码才能继续使用。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "移除")
        alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn {
            relay?.revokeDevice(token: device.id)
        }
    }

    private static let fmt: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "zh_CN"); f.dateFormat = "MM-dd HH:mm"; return f
    }()
    private func dateStr(_ ms: TimeInterval) -> String {
        guard ms > 0 else { return "—" }
        return Self.fmt.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    // MARK: - Table

    func numberOfRows(in tableView: NSTableView) -> Int { devices.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard let col = tableColumn, row >= 0, row < devices.count else { return nil }
        let d = devices[row]
        if col.identifier.rawValue == "action" {
            let id = NSUserInterfaceItemIdentifier("actionCell")
            let button = (tableView.makeView(withIdentifier: id, owner: self) as? NSButton) ?? {
                let b = NSButton(title: "移除", target: self, action: #selector(onRemove(_:)))
                b.identifier = id; b.bezelStyle = .rounded; b.controlSize = .small
                return b
            }()
            button.tag = row
            return button
        }
        let text: String
        switch col.identifier.rawValue {
        case "name": text = d.name
        case "created": text = dateStr(d.createdAt)
        case "seen": text = dateStr(d.lastSeen)
        default: text = ""
        }
        let id = NSUserInterfaceItemIdentifier("text_\(col.identifier.rawValue)")
        let field = (tableView.makeView(withIdentifier: id, owner: self) as? NSTextField) ?? {
            let f = NSTextField(labelWithString: "")
            f.identifier = id; f.lineBreakMode = .byTruncatingTail
            if col.identifier.rawValue != "name" {
                f.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
                f.textColor = .secondaryLabelColor
            }
            return f
        }()
        field.stringValue = text
        return field
    }
}
