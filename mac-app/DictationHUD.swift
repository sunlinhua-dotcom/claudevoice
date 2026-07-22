// 悬浮听写 HUD（类「闪电说」）：屏幕底部居中的圆角半透明小浮条，
// 录音/识别时浮现，显示实时 partial 与最终 final 文字。
//
// 崩溃安全纪律（见 research：WindowServer/CoreAnimation render-server 易被非常规合成压垮）：
//  - 纯展示：.nonactivatingPanel + .borderless，不抢 key/main，ignoresMouseEvents=true 点击穿透。
//  - 全部走公开 NSPanel API，绝不碰私有 SkyLight/CGS、不建虚拟显示。
//  - 单例常驻一个 panel，复用、不反复 alloc/close。
//  - 只做 alpha 渐变这类轻量动画；所有 UI 操作主线程。

import AppKit

final class DictationHUD {

    static let shared = DictationHUD()
    private init() {}

    // MARK: - 对外

    /// 实时 partial（识别中，灰白）。会取消任何待执行的自动隐藏。
    func showPartial(_ text: String) {
        onMain { [self] in
            ensurePanel()
            cancelAutoHide()
            label.textColor = Self.partialColor
            micDot.layer?.backgroundColor = NSColor.systemGreen.cgColor
            setText(text.isEmpty ? "聆听中…" : text)
            present()
        }
    }

    /// 最终 final（亮白），~1.4s 后自动淡出。
    func showFinal(_ text: String) {
        onMain { [self] in
            guard !text.isEmpty else { hide(); return }
            ensurePanel()
            cancelAutoHide()
            label.textColor = Self.finalColor
            micDot.layer?.backgroundColor = NSColor.systemGray.cgColor
            setText(text)
            present()
            scheduleAutoHide(after: 1.4)
        }
    }

    /// 立即淡出（复用面板，不销毁）。
    func hide() {
        onMain { [self] in
            cancelAutoHide()
            guard let panel, panel.isVisible else { return }
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.22
                ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
                panel.animator().alphaValue = 0
            }, completionHandler: { panel.orderOut(nil) })   // 强持有本地 panel，动画期间不被释放
        }
    }

    /// 退出清理。
    func teardown() {
        onMain { [self] in
            cancelAutoHide()
            panel?.orderOut(nil)
            panel = nil
        }
    }

    // MARK: - 内部状态

    private var panel: NSPanel?
    private weak var blur: NSVisualEffectView?
    private let label = DictationHUD.makeLabel()
    private let micDot = NSView()
    private var autoHide: DispatchWorkItem?

    private let hPad: CGFloat = 18
    private let vPad: CGFloat = 12
    private let bottomMargin: CGFloat = 120
    private let minWidth: CGFloat = 160
    private let maxWidth: CGFloat = 600
    private static let partialColor = NSColor(white: 0.84, alpha: 1)
    private static let finalColor = NSColor.white

    private func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
    }

    // MARK: - 构建

    private func ensurePanel() {
        guard panel == nil else { return }
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 280, height: 52),
                        styleMask: [.nonactivatingPanel, .borderless],
                        backing: .buffered, defer: false)
        p.level = .statusBar
        p.isFloatingPanel = true
        p.becomesKeyOnlyIfNeeded = true
        p.hidesOnDeactivate = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        p.isMovableByWindowBackground = false
        p.isReleasedWhenClosed = false
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.ignoresMouseEvents = true
        p.alphaValue = 0

        let v = NSVisualEffectView()
        v.material = .hudWindow
        v.blendingMode = .behindWindow
        v.state = .active
        v.wantsLayer = true
        v.layer?.cornerRadius = 15
        v.layer?.cornerCurve = .continuous
        v.layer?.masksToBounds = true
        v.layer?.backgroundColor = NSColor(white: 0.05, alpha: 0.30).cgColor
        p.contentView = v
        blur = v

        micDot.wantsLayer = true
        micDot.layer?.cornerRadius = 4
        micDot.layer?.backgroundColor = NSColor.systemGreen.cgColor
        micDot.translatesAutoresizingMaskIntoConstraints = false
        v.addSubview(micDot)

        label.translatesAutoresizingMaskIntoConstraints = false
        v.addSubview(label)

        NSLayoutConstraint.activate([
            micDot.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: hPad),
            micDot.centerYAnchor.constraint(equalTo: v.centerYAnchor),
            micDot.widthAnchor.constraint(equalToConstant: 8),
            micDot.heightAnchor.constraint(equalToConstant: 8),
            label.leadingAnchor.constraint(equalTo: micDot.trailingAnchor, constant: 10),
            label.trailingAnchor.constraint(equalTo: v.trailingAnchor, constant: -hPad),
            label.topAnchor.constraint(equalTo: v.topAnchor, constant: vPad),
            label.bottomAnchor.constraint(equalTo: v.bottomAnchor, constant: -vPad),
        ])
        panel = p
    }

    private static func makeLabel() -> NSTextField {
        let l = NSTextField(labelWithString: "")
        l.font = .systemFont(ofSize: 17, weight: .medium)
        l.textColor = .white
        l.drawsBackground = false
        l.isBezeled = false
        l.isEditable = false
        l.isSelectable = false
        l.lineBreakMode = .byTruncatingHead    // 保留最新尾部文字
        l.maximumNumberOfLines = 1
        l.cell?.usesSingleLineMode = true
        return l
    }

    // MARK: - 内容/定位/动画

    private func setText(_ text: String) {
        label.stringValue = text
        reposition()
    }

    private func reposition() {
        guard let panel, let blur, let screen = currentScreen() else { return }
        let textW = (label.stringValue as NSString).size(withAttributes: [.font: label.font as Any]).width
        let width = max(minWidth, min(maxWidth, ceil(textW + 10 + 8 + hPad * 2)))
        blur.layoutSubtreeIfNeeded()
        let height = max(52, ceil(blur.fittingSize.height) + vPad * 2)
        let vf = screen.visibleFrame
        panel.setFrame(NSRect(x: vf.midX - width / 2, y: vf.minY + bottomMargin, width: width, height: height), display: true)
    }

    private func currentScreen() -> NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first(where: { $0.frame.contains(mouse) }) ?? NSScreen.main ?? NSScreen.screens.first
    }

    private func present() {
        guard let panel else { return }
        if !panel.isVisible {
            panel.alphaValue = 0
            panel.orderFrontRegardless()      // 不激活本 App 也能浮现
        }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.18
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
        }
    }

    private func scheduleAutoHide(after seconds: TimeInterval) {
        let work = DispatchWorkItem { [weak self] in self?.hide() }
        autoHide = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }
    private func cancelAutoHide() { autoHide?.cancel(); autoHide = nil }
}
