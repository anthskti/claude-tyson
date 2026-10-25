import SwiftUI
import CoreMotion
import Network

@main
struct CollectorApp: App {
    @StateObject private var collector = PhoneCollector()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            VStack(alignment: .leading, spacing: 18) {
                Text("Right controller → USB").font(.title.bold())
                Picker("Motion source", selection: $collector.selectedSource) {
                    Text("Right AirPod").tag("airpod")
                    Text("iPhone motion").tag("iphone")
                }.pickerStyle(.segmented).disabled(collector.running)
                Text(collector.selectedSource == "iphone"
                     ? "Hold this iPhone in your RIGHT hand. This reads the phone's own motion sensors. Run fresh right-hand calibration on the Mac."
                     : "Connect only the RIGHT bud's pair to this iPhone. Keep the unused left bud in its case. This reads the AirPod's motion sensors.")
                Text(collector.message).font(.headline)
                Text(collector.stats).font(.system(.body, design: .monospaced))
                HStack {
                    Button("Start collector") { collector.start() }.disabled(collector.running)
                    Button("Stop") { collector.stop() }.disabled(!collector.running)
                }.buttonStyle(.borderedProminent)
                Text("Keep this app open and the phone unlocked. The Mac connects through USB port 8765. No Wi-Fi or Personal Hotspot is needed. No old samples are replayed after reconnecting.")
                Text("A cable reconnect or motion-source change requires right-hand recalibration on the Mac.").font(.footnote)
            }.padding()
        }.onChange(of: scenePhase) { phase in
            if phase == .background { collector.stop() }
        }
    }
}

final class PhoneCollector: ObservableObject {
    @Published var selectedSource = "airpod"
    @Published var running = false
    @Published var message = "Ready. Allow Motion access when asked."
    @Published var stats = "Source: -- | samples: 0 | Mac: disconnected"
    private let manager = CMHeadphoneMotionManager()
    private let phoneManager = CMMotionManager()
    private var activeSource = "airpod"
    private let motionQueue: OperationQueue = {
        let q = OperationQueue(); q.name = "airpod-imu"; q.maxConcurrentOperationCount = 1
        q.qualityOfService = .userInteractive; return q
    }()
    // Transport state belongs only to this queue. UI is throttled on the main queue.
    private let queue = DispatchQueue(label: "airpod-usb", qos: .userInteractive)
    private var listener: NWListener?
    private var connection: NWConnection?
    private var timer: DispatchSourceTimer?
    private var session = ""
    private var count = 0
    private var source = "unknown"
    private var pending: [UUID: Double] = [:]
    private var input = Data()
    private var lastSample = 0.0
    private var lastUI = 0.0
    private var lastStatus = ""
    private var active = false
    private var connected = false
    private func uptime() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }

    func start() {
        guard !running else { return }
        running = true; UIApplication.shared.isIdleTimerDisabled = true
        let requestedSource = selectedSource
        message = "Starting \(requestedSource) motion and USB listener…"
        queue.async { [self] in
            guard !active else { return }
            active = true; activeSource = requestedSource
            session = UUID().uuidString; count = 0; source = "unknown"
            lastSample = uptime(); lastStatus = ""
            let currentSession = session
            do {
                let tcp = NWProtocolTCP.Options(); tcp.noDelay = true
                let parameters = NWParameters(tls: nil, tcp: tcp)
                // usbmux forwards to the phone's loopback. Never expose IMU on LAN.
                parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: 8765)
                let server = try NWListener(using: parameters)
                listener = server
                server.stateUpdateHandler = { [weak self, weak server] state in
                    guard let self = self, let server = server, self.listener === server else { return }
                    switch state {
                    case .ready: self.updateUI("Listening on USB port 8765. Waiting for Mac bridge.", force: true)
                    case .failed(let error): self.fail("Listener: \(error.localizedDescription)")
                    default: break
                    }
                }
                server.newConnectionHandler = { [weak self] client in self?.accept(client) }
                server.start(queue: queue)
                guard requestedSource == "iphone" ? phoneManager.isDeviceMotionAvailable : manager.isDeviceMotionAvailable else {
                    fail(requestedSource == "iphone" ? "iPhone device motion unavailable." : "Headphone motion unavailable. Connect your right AirPod pair, then start again."); return
                }
                let handler: CMDeviceMotionHandler = { [weak self] motion, error in
                    guard let self = self else { return }
                    let received = ProcessInfo.processInfo.systemUptime * 1000
                    let unix = Date().timeIntervalSince1970 * 1000
                    if let error = error {
                        self.queue.async {
                            if self.session == currentSession && self.active { self.fail("Motion: \(error.localizedDescription)") }
                        }; return
                    }
                    guard let motion = motion else { return }
                    let side: String
                    if requestedSource == "iphone" { side = "device" }
                    else {
                        switch motion.sensorLocation {
                        case .headphoneLeft: side = "left"
                        case .headphoneRight: side = "right"
                        default: side = "unknown"
                        }
                    }
                    let a = motion.userAcceleration, g = motion.gravity, w = motion.rotationRate
                    let q = motion.attitude.quaternion
                    let payload: [String: Any] = ["kind": "sample", "sessionId": currentSession,
                        "sourceType": requestedSource, "punchingHand": "right",
                        "earbud": requestedSource == "iphone" ? NSNull() : side as Any,
                        "sensorLocation": side, "sensorTimestampSec": motion.timestamp,
                        "receiveUnixMs": unix, "receiveUptimeMs": received,
                        "userAcceleration": ["x": a.x, "y": a.y, "z": a.z],
                        "gravity": ["x": g.x, "y": g.y, "z": g.z],
                        "rotationRate": ["x": w.x, "y": w.y, "z": w.z],
                        "attitude": ["x": q.x, "y": q.y, "z": q.z, "w": q.w]]
                    self.queue.async {
                        guard self.active, self.session == currentSession else { return }
                        self.count += 1; self.lastSample = received
                        if side != self.source {
                            self.source = side
                            self.send(["kind": "status", "state": "source_changed", "sensorLocation": side])
                        }
                        var row = payload; row["sequence"] = self.count
                        // Includes wrong-side callbacks for audit; Mac rejects them for inference.
                        self.send(row)
                        self.updateUI(requestedSource == "iphone" || side == "right" ? "\(requestedSource == "iphone" ? "iPhone motion" : "Right bud") active. \(self.connected ? "Streaming to Mac." : "Start the Mac bridge.")" : "WRONG SOURCE: \(side). Put the left bud away; reconnect the right.")
                    }
                }
                if requestedSource == "iphone" {
                    // Match training cadence. The bridge also bounds faster callbacks,
                    // while archiving every original reading before rate selection.
                    phoneManager.deviceMotionUpdateInterval = 1.0 / 25.0
                    phoneManager.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: motionQueue, withHandler: handler)
                } else {
                    manager.startDeviceMotionUpdates(to: motionQueue, withHandler: handler)
                }
                let heartbeat = DispatchSource.makeTimerSource(queue: queue)
                heartbeat.schedule(deadline: .now() + 0.25, repeating: 0.25)
                heartbeat.setEventHandler { [weak self] in
                    guard let self = self, self.active else { return }
                    if let oldest = self.pending.values.min(), self.uptime() - oldest > 250 {
                        self.disconnect("Slow USB client: disconnected rather than buffering stale motion.")
                    }
                    if self.uptime() - self.lastSample > 750 {
                        if self.lastStatus != "stale" {
                            self.send(["kind": "status", "state": "stale"]); self.lastStatus = "stale"
                        }
                        self.updateUI(self.activeSource == "iphone" ? "No fresh iPhone samples. Check Motion permission; keep this app open." : "No fresh AirPod samples. Check Bluetooth, Motion permission and ear detection.")
                    } else { self.lastStatus = "" }
                }
                timer = heartbeat; heartbeat.resume()
            } catch { fail(error.localizedDescription) }
        }
    }

    private func accept(_ client: NWConnection) {
        guard active, connection == nil else { client.cancel(); return }
        connection = client; input.removeAll(); pending.removeAll(); connected = false
        client.stateUpdateHandler = { [weak self, weak client] state in
            guard let self = self, let client = client, self.connection === client else { return }
            switch state {
            case .ready:
                self.connected = true
                self.send(["kind": "hello", "protocol": "airpod-usb-v1", "role": "right",
                           "sourceType": self.activeSource, "punchingHand": "right",
                           "requestedSampleRateHz": self.activeSource == "iphone" ? 25 : NSNull(),
                           "deviceModel": UIDevice.current.model,
                           "os": ProcessInfo.processInfo.operatingSystemVersionString])
                self.receive(client)
            case .failed(let error): self.disconnect("USB: \(error.localizedDescription)")
            case .cancelled: self.disconnect("USB disconnected")
            default: break
            }
        }
        client.start(queue: queue)
    }

    private func receive(_ client: NWConnection) {
        client.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self, weak client] data, _, done, error in
            guard let self = self, let client = client, self.connection === client else { return }
            if let data = data { self.input.append(data) }
            guard self.input.count <= 16384 else { self.disconnect("Oversize command"); return }
            while let newline = self.input.firstIndex(of: 10) {
                let line = self.input.prefix(upTo: newline); self.input.removeSubrange(...newline)
                let t1 = self.uptime()
                guard let command = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                      command["kind"] as? String == "ping", let id = command["id"] as? String else {
                    self.disconnect("Invalid bridge command"); return
                }
                self.send(["kind": "pong", "id": id, "phoneReceiveUptimeMs": t1,
                           "phoneSendUptimeMs": self.uptime()])
            }
            if done || error != nil { self.disconnect("USB closed. Reconnect the Mac bridge.") }
            else { self.receive(client) }
        }
    }

    private func send(_ payload: [String: Any]) {
        guard let client = connection, connected else { return }
        guard pending.count < 8 else { disconnect("USB backlog: dropped connection; no replay."); return }
        var row = payload
        row["schemaVersion"] = 1; row["sessionId"] = session
        row["sourceType"] = activeSource
        row["phoneSendUptimeMs"] = uptime()
        guard var bytes = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else {
            disconnect("Invalid sensor payload"); return
        }
        bytes.append(10)
        let id = UUID(); pending[id] = uptime()
        client.send(content: bytes, completion: .contentProcessed { [weak self, weak client] error in
            guard let self = self, let client = client, self.connection === client else { return }
            self.pending.removeValue(forKey: id)
            if let error = error { self.disconnect(error.localizedDescription) }
        })
    }
    private func disconnect(_ message: String) {
        let old = connection; connection = nil; connected = false
        pending.removeAll(); input.removeAll(); old?.cancel(); updateUI(message, force: true)
    }
    private func updateUI(_ text: String, force: Bool = false) {
        guard force || uptime() - lastUI >= 200 else { return }
        lastUI = uptime()
        let detail = "Source: \(activeSource)/\(source) | samples: \(count)\nMac: \(connected ? "connected" : "disconnected")"
        DispatchQueue.main.async { self.message = text; self.stats = detail }
    }
    private func fail(_ text: String) {
        shutdown(); updateUI(text, force: true)
        DispatchQueue.main.async { self.running = false; UIApplication.shared.isIdleTimerDisabled = false }
    }
    private func shutdown() {
        active = false; manager.stopDeviceMotionUpdates(); phoneManager.stopDeviceMotionUpdates(); timer?.cancel(); timer = nil
        listener?.cancel(); listener = nil; disconnect("Stopped")
    }
    func stop() {
        running = false; UIApplication.shared.isIdleTimerDisabled = false
        queue.async { self.shutdown() }
    }
}
