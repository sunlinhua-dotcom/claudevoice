import Foundation
import AVFoundation
import CoreAudio
import Network

// 跟小智盒子同步念（2026-09-29）。服务器是 /Volumes/ProjectsAPFS/ESP32/server（EX10 上跑），
// 几台盒子一起放的做法见那边的 app/broadcast.py：一批播报只合成一次、编码一次，按各台网络延迟对齐开口。
// 这里把 Mac 装成一台「只收播报」的盒子：像盒子一样长轮询收件箱，被叫醒就连 WS 收同一份 Opus，
// 用系统自带解码直接放。Worker 转给盒子的那几类（完成 / 等你 / 授权 / 失败）本机就不再自己合成普通话。
//
// 配置 ~/.config/claudevoice/xiaozhi.json（权限 600，口令别进日志）：
//   {"bases": ["http://中转:端口", "https://备用域名"], "device_id": "02:..", "client_id": "uuid", "token": "..."}
// 没有这个文件就整块不启用，播报照老样子。服务器那头要把 device_id 写进 XZ_ANNOUNCE_ONLY_IDS。
final class BoxSync {
    static let kinds: Set<String> = ["done", "waiting", "permission", "failed"]   // 同 worker.js 的 XIAOZHI_KINDS
    static let enabledKey = "boxSyncEnabled"
    static let fallbackAfter: TimeInterval = 120   // 交给盒子这么久还没念到，本机补念（服务器丢了 / 断网）
    static let primaryRetry: TimeInterval = 600    // 退到备用地址后，隔这么久再试首选

    struct Config { let bases: [String]; let deviceId: String; let clientId: String; let token: String }

    let config: Config?
    var isMuted: () -> Bool = { false }

    private let lock = NSLock()
    private var healthyUntil = Date.distantPast
    private var playingNow = false
    private var problem = ""
    private var baseIndex = 0
    private var switchedAt = Date.distantPast
    private var lastMsg = Date()
    private var held: [(at: Date, fallback: () -> Void)] = []
    private var worker: Task<Void, Never>?
    private var sweeper: Timer?
    private let http: URLSession

    init() {
        config = BoxSync.loadConfig()
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 75
        c.waitsForConnectivity = false
        http = URLSession(configuration: c)
    }

    static func loadConfig() -> Config? {
        let p = (NSHomeDirectory() as NSString).appendingPathComponent(".config/claudevoice/xiaozhi.json")
        guard let d = FileManager.default.contents(atPath: p),
              let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return nil }
        let bases = ((j["bases"] as? [String]) ?? [])
            .map { $0.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
            .filter { $0.hasPrefix("http") && URL(string: $0) != nil }
        guard !bases.isEmpty,
              let dev = j["device_id"] as? String, !dev.isEmpty,
              let tok = j["token"] as? String, !tok.isEmpty else {
            appLog("盒子同步：配置不全（要 bases / device_id / token），不启用")
            return nil
        }
        let cid = (j["client_id"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString.lowercased()
        return Config(bases: bases, deviceId: dev.lowercased(), clientId: cid, token: tok)
    }

    private func locked<T>(_ f: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return f() }

    // ---------- 给菜单栏 App 用的 ----------

    var enabled: Bool {
        get { UserDefaults.standard.object(forKey: BoxSync.enabledKey) as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: BoxSync.enabledKey)
            if newValue { start() } else { stop() }
        }
    }

    var healthy: Bool { config != nil && enabled && locked { Date() < healthyUntil } }
    var playing: Bool { locked { playingNow } }

    var statusText: String {
        if !enabled { return "关" }
        if playing { return "正在念" }
        if healthy { return "在线" }
        let why = locked { problem }
        return why.isEmpty ? "连接中" : "连不上，本机照念"
    }

    /// 这条交给盒子那边一起念吗（在线、而且是 Worker 会转给盒子的那几类）
    func covers(_ ev: [String: Any]) -> Bool {
        guard let kind = ev["kind"] as? String, BoxSync.kinds.contains(kind),
              let speak = ev["speak"] as? String, !speak.isEmpty else { return false }
        return healthy
    }

    /// 交出去的事件先记着：一会儿同步念到了就划掉，fallbackAfter 秒还没念到就本机补念
    func hold(_ fallback: @escaping () -> Void) {
        locked { held.append((Date(), fallback)) }
    }

    func start() {
        guard config != nil, enabled, worker == nil else { return }
        if sweeper == nil {
            sweeper = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.sweep() }
        }
        worker = Task.detached(priority: .userInitiated) { [weak self] in await self?.run() }
    }

    func stop() {
        worker?.cancel()
        worker = nil
        locked { healthyUntil = .distantPast }
        let due = locked { () -> [() -> Void] in let f = held.map { $0.fallback }; held.removeAll(); return f }
        due.forEach { $0() }    // 关掉了：交出去还没念的本机补上
    }

    private func sweep() {
        let now = Date()
        let due = locked { () -> [() -> Void] in
            let old = held.filter { now.timeIntervalSince($0.at) > BoxSync.fallbackAfter }
            held.removeAll { now.timeIntervalSince($0.at) > BoxSync.fallbackAfter }
            return old.map { $0.fallback }
        }
        if !due.isEmpty { appLog("盒子同步：\(due.count) 条交出去 \(Int(BoxSync.fallbackAfter)) 秒还没念到，本机补念") }
        due.forEach { $0() }
    }

    private func markCovered(before t: Date) {
        let n = locked { () -> Int in let c = held.count; held.removeAll { $0.at < t }; return c - held.count }
        if n > 0 { appLog("盒子同步：念到了，划掉 \(n) 条") }
    }

    private func setHealthy(for secs: TimeInterval) {
        locked { healthyUntil = Date().addingTimeInterval(secs); problem = "" }
    }

    private func setProblem(_ why: String) {
        let changed = locked { () -> Bool in let c = problem != why; problem = why; healthyUntil = .distantPast; return c }
        if changed { appLog("盒子同步：\(why)") }
    }

    // ---------- 长轮询 ----------

    private func currentBase(_ cfg: Config) -> String {
        locked {
            if baseIndex != 0 && Date().timeIntervalSince(switchedAt) > BoxSync.primaryRetry { baseIndex = 0 }
            return cfg.bases[baseIndex % cfg.bases.count]
        }
    }

    private func rotateBase(_ cfg: Config) {
        guard cfg.bases.count > 1 else { return }
        let next = locked { () -> String in
            baseIndex = (baseIndex + 1) % cfg.bases.count
            switchedAt = Date()
            return cfg.bases[baseIndex]
        }
        appLog("盒子同步：换地址 → \(next)")
    }

    private func sleep(_ secs: Double) async {
        try? await Task.sleep(nanoseconds: UInt64(max(secs, 0) * 1_000_000_000))
    }

    private func run() async {
        guard let cfg = config else { return }
        appLog("盒子同步：开始，设备 \(cfg.deviceId)，地址 \(cfg.bases.joined(separator: " / "))")
        var backoff = 2.0
        var fails = 0     // 同一个地址连着失败两次才换（服务器重启会断一下，别一断就换到慢路上待十分钟）
        func failed() async {
            fails += 1
            if fails >= 2 { rotateBase(cfg); fails = 0 }
            await sleep(backoff)
            backoff = min(backoff * 2, 30)
        }
        while !Task.isCancelled {
            let base = currentBase(cfg)
            do {
                let (code, after) = try await poll(base, cfg)
                switch code {
                case 200:
                    backoff = 2; fails = 0
                    setHealthy(for: 90)
                    if await session(base, cfg) == false { await failed() }
                case 204 where after <= 60:
                    backoff = 2; fails = 0
                    setHealthy(for: Double(after) + 90)
                    if after > 1 { await sleep(Double(after)) }
                case 204:
                    // 服务器这阵子不播报（静默时段 / 没开）：本机照老样子念
                    fails = 0
                    setProblem("服务器暂停播报，\(after) 秒后再问")
                    await sleep(Double(min(after, 300)))
                case 401, 403:
                    setProblem("服务器拒绝（\(code)），查口令和 XZ_ANNOUNCE_ONLY_IDS")
                    await sleep(Double(max(60, min(after, 600))))
                default:
                    setProblem("收件箱回 \(code)")
                    await failed()
                }
            } catch {
                if Task.isCancelled { break }
                setProblem("连不上 \(base)：\(error.localizedDescription)")
                await failed()
            }
        }
        appLog("盒子同步：停了")
    }

    private func headerPairs(_ cfg: Config) -> [(String, String)] {
        // 服务器两种都认：口令本身带空格就原样发，否则加 Bearer（app/main.py 的 _check_auth）
        [("Authorization", cfg.token.contains(" ") ? cfg.token : "Bearer " + cfg.token),
         ("Device-Id", cfg.deviceId), ("Client-Id", cfg.clientId), ("Protocol-Version", "1")]
    }

    private func poll(_ base: String, _ cfg: Config) async throws -> (Int, Int) {
        guard let url = URL(string: base + "/xiaozhi/inbox?wait=50") else { throw URLError(.badURL) }
        if url.scheme == "http" {
            let (code, h) = try await rawGet(url, headers: headerPairs(cfg), timeout: 75)
            return (code, Int(h["x-poll-after"] ?? "") ?? 1)
        }
        var r = URLRequest(url: url)
        r.timeoutInterval = 75
        headerPairs(cfg).forEach { r.setValue($0.1, forHTTPHeaderField: $0.0) }
        let (_, resp) = try await http.data(for: r)
        guard let h = resp as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (h.statusCode, Int(h.value(forHTTPHeaderField: "X-Poll-After") ?? "") ?? 1)
    }

    // ---------- 一次同步播报：连上来、说是被叫醒的、收声音放，服务器念完就挂 ----------

    /// 返回 false = 没连上（换地址再来）
    private func session(_ base: String, _ cfg: Config) async -> Bool {
        let wsBase = base.hasPrefix("https") ? "wss" + base.dropFirst(5) : "ws" + base.dropFirst(4)
        guard let url = URL(string: wsBase + "/xiaozhi/v1/") else { return false }
        let ch: SyncChannel
        if url.scheme == "ws" {
            ch = NWChannel(url: url, headers: headerPairs(cfg))
        } else {
            var r = URLRequest(url: url)
            r.timeoutInterval = 15
            headerPairs(cfg).forEach { r.setValue($0.1, forHTTPHeaderField: $0.0) }
            ch = URLSessionChannel(http, r)
        }

        let started = Date()
        let out = SyncAudioOut()
        let outOK = out.start(rate: 24000, frameMs: 60)      // 先把喇叭开好；服务器 hello 说别的再改
        let latency = outOK ? SyncAudioOut.deviceLatencyMs() : 0
        locked { lastMsg = Date() }
        let watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self = self else { return }
                let idle = self.locked { Date().timeIntervalSince(self.lastMsg) }
                if idle > 30 || Date().timeIntervalSince(started) > 900 {
                    appLog("盒子同步：\(Int(idle)) 秒没动静，断开")
                    ch.close()
                    return
                }
            }
        }

        var sid = ""
        var frames = 0
        do {
            try await ch.open()
            try await ch.send(json([
                "type": "hello", "version": 1, "transport": "websocket", "features": [String: Any](),
                "audio_params": ["format": "opus", "sample_rate": 16000, "channels": 1, "frame_duration": 60,
                                 "output_latency_ms": latency],
            ]))
            while true {
                let msg = try await ch.receive()
                locked { lastMsg = Date() }
                switch msg {
                case .data(let d):
                    if frames == 0 {
                        markCovered(before: started.addingTimeInterval(2))
                        locked { playingNow = true }
                    }
                    frames += 1
                    if outOK && !isMuted() { out.play(opus: d) }
                case .text(let s):
                    guard let j = (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] else { continue }
                    switch j["type"] as? String {
                    case "hello":
                        sid = j["session_id"] as? String ?? ""
                        let ap = j["audio_params"] as? [String: Any] ?? [:]
                        if outOK { out.reconfigure(rate: ap["sample_rate"] as? Int ?? 24000, frameMs: ap["frame_duration"] as? Int ?? 60) }
                        try await ch.send(json(["session_id": sid, "type": "listen", "state": "detect", "text": "__announce__"]))
                    case "mcp":
                        if let reply = mcpReply(j["payload"] as? [String: Any], sid) { try await ch.send(reply) }
                    case "tts":
                        if (j["state"] as? String) == "sentence_start", let t = j["text"] as? String { appLog("盒子同步 ♪ \(t)") }
                    default:
                        break
                    }
                case .other:
                    break
                }
            }
        } catch {
            // 服务器念完就挂断，正常收尾也走这里
            if sid.isEmpty { setProblem("WS 没连上 \(base)：\(error.localizedDescription)") }
        }
        watchdog.cancel()
        ch.close()
        if outOK {
            await out.drain(timeout: 10)
            out.stop()
        }
        locked { playingNow = false }
        if frames > 0 {
            appLog("盒子同步：念完，\(frames) 帧，\(String(format: "%.1f", Date().timeIntervalSince(started))) 秒，报的出声延迟 \(latency) ms，走 \(url.scheme ?? "?")")
        }
        return !sid.isEmpty
    }

    private func mcpReply(_ p: [String: Any]?, _ sid: String) -> String? {
        // 服务器拿 MCP ping 测往返时间对齐开口；别的请求这边都没有，老实回「没有」
        guard let p = p, let id = p["id"], let method = p["method"] as? String else { return nil }
        var resp: [String: Any] = ["jsonrpc": "2.0", "id": id]
        switch method {
        case "ping":
            resp["result"] = [String: Any]()
        case "initialize":
            resp["result"] = ["protocolVersion": "2024-11-05", "capabilities": ["tools": [String: Any]()],
                              "serverInfo": ["name": "claudevoice-mac", "version": "1.0"]]
        case "tools/list":
            resp["result"] = ["tools": [Any]()]
        default:
            resp["error"] = ["code": -32601, "message": "Method not found"]
        }
        return json(["session_id": sid, "type": "mcp", "payload": resp])
    }

    private func json(_ o: [String: Any]) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: o), let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }
}

/// 收到一帧 Opus 就解一帧、排进播放器：跟盒子一样来一帧放一帧，开头不另外攒
final class SyncAudioOut {
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private var pcm: AVAudioFormat?
    private var opus: AVAudioFormat?
    private var conv: AVAudioConverter?
    private var frameSamples: AVAudioFrameCount = 1440
    private var rate = 0
    private var frameMs = 0
    private let lock = NSLock()
    private var pending = 0

    /// 默认输出设备从排进去到出声的延迟（毫秒），服务器按它早发这么久。
    /// AVAudioEngine 的 presentationLatency 在内置喇叭上只报 1.5 ms（实际约 30 ms），所以直接问 CoreAudio：
    /// 设备延迟 + 安全偏移 + 缓冲 + 输出流延迟（蓝牙耳机这几项会大很多）。
    static func deviceLatencyMs() -> Int {
        func get<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope, _ v: T) -> T? {
            var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
            var val = v
            var size = UInt32(MemoryLayout<T>.size)
            let st = withUnsafeMutableBytes(of: &val) { AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, $0.baseAddress!) }
            return st == noErr ? val : nil
        }
        let outScope = kAudioObjectPropertyScopeOutput
        guard let dev = get(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice,
                            kAudioObjectPropertyScopeGlobal, AudioObjectID(0)), dev != 0,
              let rate = get(dev, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, Float64(0)), rate > 0
        else { return 0 }
        var frames = [kAudioDevicePropertyLatency, kAudioDevicePropertySafetyOffset, kAudioDevicePropertyBufferFrameSize]
            .map { get(dev, $0, outScope, UInt32(0)) ?? 0 }.reduce(0, +)
        var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: outScope, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        if AudioObjectGetPropertyDataSize(dev, &addr, 0, nil, &size) == noErr, size >= UInt32(MemoryLayout<AudioStreamID>.size) {
            var streams = [AudioStreamID](repeating: 0, count: Int(size) / MemoryLayout<AudioStreamID>.size)
            if AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, &streams) == noErr, let s = streams.first {
                frames += get(s, kAudioStreamPropertyLatency, kAudioObjectPropertyScopeGlobal, UInt32(0)) ?? 0
            }
        }
        return min(Int((Double(frames) / rate * 1000).rounded()), 500)
    }

    private func formats(rate: Int, frameMs: Int) -> Bool {
        var asbd = AudioStreamBasicDescription(
            mSampleRate: Double(rate), mFormatID: kAudioFormatOpus, mFormatFlags: 0, mBytesPerPacket: 0,
            mFramesPerPacket: UInt32(rate * frameMs / 1000), mBytesPerFrame: 0, mChannelsPerFrame: 1,
            mBitsPerChannel: 0, mReserved: 0)
        guard let o = AVAudioFormat(streamDescription: &asbd),
              let p = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(rate), channels: 1, interleaved: false),
              let c = AVAudioConverter(from: o, to: p) else {
            appLog("盒子同步：建不了 Opus 解码（\(rate) Hz / \(frameMs) ms）")
            return false
        }
        opus = o; pcm = p; conv = c
        frameSamples = AVAudioFrameCount(rate * frameMs / 1000)
        self.rate = rate; self.frameMs = frameMs
        return true
    }

    func start(rate: Int, frameMs: Int) -> Bool {
        guard formats(rate: rate, frameMs: frameMs), let p = pcm else { return false }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: p)
        engine.prepare()
        do { try engine.start() } catch {
            appLog("盒子同步：开不了喇叭：\(error.localizedDescription)")
            return false
        }
        node.play()
        return true
    }

    func reconfigure(rate: Int, frameMs: Int) {
        guard rate != self.rate || frameMs != self.frameMs, rate > 0, frameMs > 0 else { return }
        guard formats(rate: rate, frameMs: frameMs), let p = pcm else { return }
        node.stop()
        engine.disconnectNodeOutput(node)
        engine.connect(node, to: engine.mainMixerNode, format: p)
        node.play()
        appLog("盒子同步：下行改成 \(rate) Hz / \(frameMs) ms")
    }

    func play(opus packet: Data) {
        guard !packet.isEmpty, let o = opus, let p = pcm, let c = conv else { return }
        let cb = AVAudioCompressedBuffer(format: o, packetCapacity: 1, maximumPacketSize: packet.count)
        packet.withUnsafeBytes { raw in
            if let src = raw.baseAddress { cb.data.copyMemory(from: src, byteCount: packet.count) }
        }
        cb.byteLength = UInt32(packet.count)
        cb.packetCount = 1
        cb.packetDescriptions?[0] = AudioStreamPacketDescription(
            mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(packet.count))
        guard let buf = AVAudioPCMBuffer(pcmFormat: p, frameCapacity: frameSamples) else { return }
        var fed = false
        var err: NSError?
        let st = c.convert(to: buf, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return cb
        }
        guard st != .error, buf.frameLength > 0 else { return }
        lock.lock(); pending += 1; lock.unlock()
        node.scheduleBuffer(buf) { [weak self] in
            guard let self = self else { return }
            self.lock.lock(); self.pending -= 1; self.lock.unlock()
        }
    }

    private func pendingCount() -> Int { lock.lock(); defer { lock.unlock() }; return pending }

    /// 等排进去的都放完（服务器念完就挂断，尾巴还在喇叭里）
    func drain(timeout: TimeInterval) async {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if pendingCount() <= 0 { break }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        try? await Task.sleep(nanoseconds: UInt64(max(0.05, engine.outputNode.presentationLatency) * 1_000_000_000))
    }

    func stop() {
        node.stop()
        engine.stop()
    }
}

// ---------- 传输：wss 用 URLSession；ws / http（明文中转，跟盒子走同一条）用 Network.framework ----------
// App 的 ATS 不许 URLSession 走明文，放宽要改整个 App 的 Info.plist；Network.framework 不归 ATS 管，只这一条路明文。

enum SyncMsg { case text(String), data(Data), other }

protocol SyncChannel: AnyObject {
    func open() async throws
    func send(_ text: String) async throws
    func receive() async throws -> SyncMsg
    func close()
}

final class URLSessionChannel: SyncChannel {
    private let task: URLSessionWebSocketTask
    init(_ s: URLSession, _ r: URLRequest) {
        task = s.webSocketTask(with: r)
        task.maximumMessageSize = 4 << 20
    }
    func open() async throws { task.resume() }
    func send(_ text: String) async throws { try await task.send(.string(text)) }
    func receive() async throws -> SyncMsg {
        switch try await task.receive() {
        case .string(let s): return .text(s)
        case .data(let d): return .data(d)
        @unknown default: return .other
        }
    }
    func close() { task.cancel(with: .normalClosure, reason: nil) }
}

/// NWConnection 的回调可能来好几次，continuation 只认第一次
final class Once<T>: @unchecked Sendable {   // 锁护着，跨线程回调安全
    private let lock = NSLock()
    private var done = false
    private let cont: CheckedContinuation<T, Error>
    init(_ c: CheckedContinuation<T, Error>) { cont = c }
    func finish(_ r: Result<T, Error>) {
        lock.lock(); let first = !done; done = true; lock.unlock()
        if first { cont.resume(with: r) }
    }
}

func nwOpen(_ conn: NWConnection, timeout: TimeInterval) async throws {
    try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
        let once = Once(c)
        conn.stateUpdateHandler = { st in
            switch st {
            case .ready: once.finish(.success(()))
            case .failed(let e), .waiting(let e): once.finish(.failure(e))    // waiting = 连不上还在重试，不等它
            case .cancelled: once.finish(.failure(URLError(.cancelled)))
            default: break
            }
        }
        conn.start(queue: .global(qos: .userInitiated))
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { once.finish(.failure(URLError(.timedOut))) }
    }
}

final class NWChannel: SyncChannel {
    private let conn: NWConnection
    init(url: URL, headers: [(String, String)]) {
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        ws.maximumMessageSize = 4 << 20
        ws.setAdditionalHeaders(headers)
        let p = NWParameters.tcp
        p.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        conn = NWConnection(to: .url(url), using: p)
    }
    func open() async throws { try await nwOpen(conn, timeout: 10) }
    func send(_ text: String) async throws {
        let ctx = NWConnection.ContentContext(identifier: "text", metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            conn.send(content: Data(text.utf8), contentContext: ctx, isComplete: true, completion: .contentProcessed { e in
                if let e = e { c.resume(throwing: e) } else { c.resume() }
            })
        }
    }
    func receive() async throws -> SyncMsg {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<SyncMsg, Error>) in
            conn.receiveMessage { content, ctx, _, err in
                if let err = err { c.resume(throwing: err); return }
                guard let meta = ctx?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata else {
                    c.resume(throwing: URLError(.networkConnectionLost)); return
                }
                switch meta.opcode {
                case .text: c.resume(returning: .text(String(decoding: content ?? Data(), as: UTF8.self)))
                case .binary: c.resume(returning: .data(content ?? Data()))
                case .close: c.resume(throwing: URLError(.networkConnectionLost))
                default: c.resume(returning: .other)
                }
            }
        }
    }
    func close() { conn.cancel() }
}

/// 明文 HTTP/1.1 GET（长轮询用）：读到响应头就回，正文不要
func rawGet(_ url: URL, headers: [(String, String)], timeout: TimeInterval) async throws -> (Int, [String: String]) {
    guard let host = url.host, let port = NWEndpoint.Port(rawValue: UInt16(url.port ?? 80)) else { throw URLError(.badURL) }
    let conn = NWConnection(host: NWEndpoint.Host(host), port: port, using: .tcp)
    let killer = DispatchWorkItem { conn.cancel() }
    defer { killer.cancel(); conn.cancel() }
    try await nwOpen(conn, timeout: 10)
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
    var target = url.path.isEmpty ? "/" : url.path
    if let q = url.query { target += "?" + q }
    var req = "GET \(target) HTTP/1.1\r\nHost: \(host):\(port.rawValue)\r\n"
    for (k, v) in headers { req += "\(k): \(v)\r\n" }
    req += "Connection: close\r\n\r\n"
    try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
        conn.send(content: Data(req.utf8), completion: .contentProcessed { e in
            if let e = e { c.resume(throwing: e) } else { c.resume() }
        })
    }
    var buf = Data()
    while buf.count < 65536 {
        let (chunk, eof) = try await withCheckedThrowingContinuation { (c: CheckedContinuation<(Data, Bool), Error>) in
            conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { d, _, done, e in
                if let e = e { c.resume(throwing: e) } else { c.resume(returning: (d ?? Data(), done)) }
            }
        }
        buf.append(chunk)
        if let head = parseHead(buf) { return head }
        if eof { break }
    }
    throw URLError(.badServerResponse)
}

func parseHead(_ buf: Data) -> (Int, [String: String])? {
    guard let r = buf.range(of: Data("\r\n\r\n".utf8)) else { return nil }
    var lines = String(decoding: buf[..<r.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
    let status = lines.removeFirst().split(separator: " ")
    guard status.count >= 2, let code = Int(status[1]) else { return nil }
    var h: [String: String] = [:]
    for l in lines {
        if let i = l.firstIndex(of: ":") {
            h[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
        }
    }
    return (code, h)
}
