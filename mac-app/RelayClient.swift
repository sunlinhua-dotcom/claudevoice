// 中继 WebSocket 客户端：收发 PROTOCOL.md 定义的信令。
// 用 URLSessionWebSocketTask（系统自带，无需第三方依赖）。

import Foundation

/// 这台 Mac 的稳定身份（房间）。首次生成随机 UUID 存 UserDefaults，之后恒定。
enum MacIdentity {
    static let defaultsKey = "rv.macId"
    private static let lock = NSLock()
    static var current: String {
        lock.lock(); defer { lock.unlock() }
        let d = UserDefaults.standard
        if let existing = d.string(forKey: defaultsKey), !existing.isEmpty { return existing }
        let fresh = UUID().uuidString
        d.set(fresh, forKey: defaultsKey)
        return fresh
    }
    /// 重置：换一个新的 macId（旧二维码/数字码作废，所有已配对设备失效）。
    @discardableResult
    static func rotate() -> String {
        lock.lock(); defer { lock.unlock() }
        let fresh = UUID().uuidString
        UserDefaults.standard.set(fresh, forKey: defaultsKey)
        return fresh
    }
}

/// 已配对的手机设备（来自中继 devices 列表）。
struct Device: Identifiable, Equatable {
    let id: String          // = 服务端 device token，吊销时回传
    let name: String
    let createdAt: TimeInterval
    let lastSeen: TimeInterval

    init?(json: [String: Any]) {
        guard let id = (json["id"] as? String) ?? (json["token"] as? String) else { return nil }
        self.id = id
        self.name = (json["name"] as? String) ?? "手机"
        self.createdAt = Device.num(json["createdAt"])
        self.lastSeen = Device.num(json["lastSeen"])
    }
    private static func num(_ any: Any?) -> TimeInterval {
        if let n = any as? NSNumber { return n.doubleValue }
        if let s = any as? String, let v = TimeInterval(s) { return v }
        return 0
    }
}

final class RelayClient: NSObject {

    /// 默认中继地址：占位符——请改成你自己部署的 Cloudflare Worker 域名（见 REPRODUCE.md 第 3 步），
    /// 或启动后在 App 菜单「服务器地址」里填一次（存 UserDefaults，优先于此默认值，rebuild 不丢）。
    static let defaultRelayURL = "wss://YOUR-WORKER-SUBDOMAIN.workers.dev/ws"
    /// 老版本的本地默认值；迁移成云端，省得已经跑过旧版的人还要去菜单手改。
    static let legacyLocalRelayURL = "ws://localhost:8787/ws"

    /// 解析要连的中继地址：用户显式设过别的就用它；没设过、或还停在老的 localhost 默认值，就用云端。
    /// （本机调试想连 localhost，临时改这里的常量或在菜单填一个非 localhost 的地址即可。）
    static func resolveRelayURL(_ stored: String?) -> String {
        if let s = stored, !s.isEmpty, s != legacyLocalRelayURL { return s }
        return defaultRelayURL
    }

    enum State { case connecting, connected, disconnected }

    enum Event {
        case assign(String)         // 配对码（旧随机码流程）
        case paired(String)         // peer = mac|phone
        case peerGone
        case config(Bool)           // llm_postprocess
        case partial(String)
        case final(String, String?)   // text, 注入 id（来自 inject_text，注入后回 ack 用；实时 ASR 无 id）
        case key(String, String?)     // 按键名（enter/tab/esc…）, 注入 id
        case error(String)
        // --- 设备信任 / 扫码配对 ---
        case macReady(String)       // mac_id，房间就绪
        case shortCode(String)      // 4 位数字短码（扫码兜底）
        case devices([Device])
        case unpaired
    }

    /// 设为非 nil 即启用「扫码 + 记住设备」新流程（菜单栏 App 用）；nil 则走旧随机码（IME 用）。
    var macId: String?

    var onState: ((State) -> Void)?
    var onEvent: ((Event) -> Void)?

    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private var url: URL?
    private var pingTimer: Timer?
    private var receivedHello = false
    private var reconnecting = false
    private var lastSeenAt = Date()   // 最近一次收到任何入站消息（含 pong）；心跳看门狗判半开死连用
    // 线程纪律：task/url/receivedHello 等可变状态只在主线程读写。
    // WS 的 receive/send 回调在后台队列触发，一律先 hop 回主线程再碰 self。

    override init() {
        super.init()
        session = URLSession(configuration: .default)
    }

    func connect(to urlString: String) {
        disconnect()
        guard let u = URL(string: urlString) else {
            onEvent?(.error("无效的地址"))
            return
        }
        url = u
        receivedHello = false
        lastSeenAt = Date()
        onState?(.connecting)
        let t = session.webSocketTask(with: u)
        task = t
        t.resume()
        listen()
        startPing()
        // 中继是纯反应式的：必须由 mac 先发 hello，中继才会回 assign。
        // 不能等首帧再发，否则双方互相等待造成死锁，配对码永远不出现。
        sendHello()
    }

    func disconnect() {
        pingTimer?.invalidate(); pingTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        onState?(.disconnected)
    }

    func send(_ json: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: json),
              let s = String(data: data, encoding: .utf8) else { return }
        sendText(s)
    }

    private func sendText(_ text: String) {
        task?.send(.string(text)) { [weak self] err in
            if let err = err {
                DispatchQueue.main.async { self?.handleFailure(err) }
            }
        }
    }

    // ---------- 接收循环 ----------
    private func listen() {
        let armed = task   // 记下这次 receive 绑定的 task；回调时若已不是当前 task（重连过）就丢弃
        armed?.receive { [weak self] result in
            // 回调在后台队列：先回主线程，再碰任何 self 的可变状态，避免与 connect/disconnect 竞争。
            DispatchQueue.main.async {
                guard let self, self.task === armed else { return }  // 忽略旧 task 的回调
                switch result {
                case .success(let msg):
                    self.lastSeenAt = Date()   // 收到任何入站消息都刷新存活时间戳
                    switch msg {
                    case .string(let s): self.handleText(s)
                    case .data(let d):
                        if let s = String(data: d, encoding: .utf8) { self.handleText(s) }
                    @unknown default: break
                    }
                    if !self.receivedHello {
                        self.receivedHello = true
                        self.onState?(.connected)
                    }
                    self.listen()
                case .failure(let err):
                    self.handleFailure(err)
                }
            }
        }
    }

    private func handleText(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            switch type {
            case "assign":
                if let code = obj["code"] as? String { self.onEvent?(.assign(code)) }
            case "paired":
                if let peer = obj["peer"] as? String { self.onEvent?(.paired(peer)) }
            case "peer_gone":
                self.onEvent?(.peerGone)
            case "config":
                if let v = obj["llm_postprocess"] as? Bool { self.onEvent?(.config(v)) }
            case "partial":
                if let t = obj["text"] as? String { self.onEvent?(.partial(t)) }
            case "final":
                if let t = obj["text"] as? String { self.onEvent?(.final(t, obj["id"] as? String)) }
            case "key":
                if let k = obj["key"] as? String { self.onEvent?(.key(k, obj["id"] as? String)) }
            case "error":
                let m = (obj["message"] as? String) ?? "错误"
                self.onEvent?(.error(m))
            case "asr_error":
                let m = (obj["message"] as? String) ?? "识别异常"
                self.onEvent?(.error(m))
            case "mac_ready":
                let id = (obj["mac_id"] as? String) ?? (obj["macId"] as? String) ?? ""
                self.onEvent?(.macReady(id))
            case "short_code":
                if let code = obj["code"] as? String { self.onEvent?(.shortCode(code)) }
            case "devices":
                let list = (obj["list"] as? [[String: Any]]) ?? []
                self.onEvent?(.devices(list.compactMap(Device.init(json:))))
            case "unpaired":
                self.onEvent?(.unpaired)
            case "pong", "status": break
            default: break
            }
        }
    }

    private func sendHello() {
        // 菜单栏 App 设了 macId → 走设备信任新流程；否则旧随机码（IME）。
        if let macId, !macId.isEmpty {
            send(["type": "hello", "role": "mac", "macId": macId])
        } else {
            send(["type": "hello", "role": "mac"])
        }
    }

    // ---------- 设备信任 / 扫码配对 便捷发送 ----------
    func requestShortCode() { send(["type": "new_short_code"]) }
    func requestDeviceList() { send(["type": "list_devices"]) }
    func revokeDevice(token: String) { send(["type": "revoke_device", "token": token]) }

    /// 从 relayUrl（wss://host/ws）推导 https://host，给二维码拼网址用。
    static func httpsHost(fromRelayURL relayUrl: String) -> String {
        guard let u = URL(string: relayUrl), let host = u.host else { return relayUrl }
        var s = "https://" + host
        if let port = u.port { s += ":\(port)" }
        return s
    }

    // ---------- 心跳与重连 ----------
    private func startPing() {
        pingTimer?.invalidate()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 25, repeats: true) { [weak self] _ in
            guard let self else { return }
            // 心跳看门狗：60s 没收到任何入站消息（含 pong）→ 判半开死连（睡眠/网络切换后常见），强制重连。
            if Date().timeIntervalSince(self.lastSeenAt) > 60 {
                self.handleFailure(NSError(domain: "RelayClient", code: -1001,
                    userInfo: [NSLocalizedDescriptionKey: "心跳超时"]))
                return
            }
            self.send(["type": "ping"])
        }
    }

    // 始终在主线程调用（listen/sendText 的失败都已 hop 回主线程）。
    private func handleFailure(_ err: Error) {
        onState?(.disconnected)
        guard !reconnecting else { return }   // 去抖：避免重连风暴叠加 connect()
        reconnecting = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            self.reconnecting = false
            if let url = self.url { self.connect(to: url.absoluteString) }
        }
    }
}
