import AppKit
import CoreMotion

// A normal app bundle gives macOS a stable identity for the motion permission.
// All state and writes live on the main queue; sensor timestamps remain untouched.
final class Collector: NSObject, NSApplicationDelegate, CMHeadphoneMotionManagerDelegate {
    let manager = CMHeadphoneMotionManager()
    var window: NSWindow!
    let status = NSTextField(wrappingLabelWithString: "Connect AirPods Pro 2, then start. No sensors run until you click Start.")
    let path = NSTextField(wrappingLabelWithString: "")
    let startButton = NSButton(title: "Start new recording", target: nil, action: nil)
    let stopButton = NSButton(title: "Stop", target: nil, action: nil)
    var root = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("runs")
    var file: FileHandle?
    var timer: Timer?
    var session = ""
    var count = 0
    var firstReceive: Double?
    var lastReceive: Double?
    var lastSource: String?
    var stale = false
    var running = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        manager.delegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 740, height: 320),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "AirPods Motion Collector"
        window.center()
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField(labelWithString: "AirPods → local motion.jsonl")
        title.font = NSFont.boldSystemFont(ofSize: 20)
        let note = NSTextField(wrappingLabelWithString: "Only one earbud supplies data at a time. The Python detector pins that source to your chosen hand. Verify the displayed source before testing.")
        let choose = NSButton(title: "Choose recordings folder…", target: self, action: #selector(chooseFolder))
        startButton.target = self; startButton.action = #selector(start)
        stopButton.target = self; stopButton.action = #selector(stop)
        stopButton.isEnabled = false
        let buttons = NSStackView(views: [choose, startButton, stopButton])
        for view in [title, note, buttons, status, path] { stack.addArrangedSubview(view) }
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24)
        ])
        path.stringValue = "Recordings folder: \(root.path)"
        path.isSelectable = true
        let menu = NSMenu()
        let item = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit AirPods Collector", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu; menu.addItem(item); NSApp.mainMenu = menu
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func chooseFolder() {
        guard !running else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false
        panel.canCreateDirectories = true; panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            root = url; path.stringValue = "Recordings folder: \(root.path)"
        }
    }

    func authorization() -> String {
        switch CMHeadphoneMotionManager.authorizationStatus() {
        case .notDetermined: return "not_determined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorized: return "authorized"
        @unknown default: return "unknown"
        }
    }

    func write(_ payload: [String: Any]) {
        guard let output = file else { return }
        var row = payload
        row["schemaVersion"] = 1
        row["sessionId"] = session
        row["receiveUnixMs"] = Date().timeIntervalSince1970 * 1000
        row["receiveUptimeMs"] = ProcessInfo.processInfo.systemUptime * 1000
        do {
            var data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
            data.append(0x0a)
            try output.write(contentsOf: data)
        } catch {
            shutdown()
            status.stringValue = "Logging failed; collection stopped: \(error.localizedDescription)"
        }
    }

    @objc func start() {
        guard !running else { return }
        session = UUID().uuidString
        let name = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-") + "-" + session.prefix(8)
        let directory = root.appendingPathComponent(name)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent("motion.jsonl")
            guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
                throw NSError(domain: "Collector", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cannot create motion.jsonl"])
            }
            file = try FileHandle(forWritingTo: url)
            path.stringValue = url.path
        } catch { status.stringValue = error.localizedDescription; return }
        running = true; count = 0; firstReceive = nil; lastReceive = nil; lastSource = nil; stale = false
        startButton.isEnabled = false; stopButton.isEnabled = true
        write(["kind": "metadata", "collector": "airpods-swift-v1",
               "os": ProcessInfo.processInfo.operatingSystemVersionString,
               "authorization": authorization(), "available": manager.isDeviceMotionAvailable,
               "units": ["userAcceleration": "g", "gravity": "g", "rotationRate": "rad/s", "attitude": "quaternion x,y,z,w", "sensorTimestampSec": "Core Motion seconds"],
               "timing": "receive clocks describe Mac callback receipt, not physical onset; sensor clock has its own origin"])
        guard running else { return }
        guard manager.isDeviceMotionAvailable else {
            write(["kind": "status", "state": "unavailable", "authorization": authorization()])
            shutdown()
            status.stringValue = "Motion unavailable. Connect supported AirPods; try in-ear first, then Start again."
            return
        }
        status.stringValue = "Waiting for motion permission / first sample…"
        let started = ProcessInfo.processInfo.systemUptime
        manager.startDeviceMotionUpdates(to: .main) { [weak self] motion, error in
            guard let self = self, self.running else { return }
            if let error = error {
                self.write(["kind": "status", "state": "error", "message": error.localizedDescription,
                            "authorization": self.authorization()])
                self.shutdown()
                self.status.stringValue = "Motion error: \(error.localizedDescription). Check permission and reconnect, then Start."
                return
            }
            guard let motion = motion else { return }
            let source: String
            switch motion.sensorLocation {
            case .headphoneLeft: source = "left"
            case .headphoneRight: source = "right"
            default: source = "unknown"
            }
            if source != self.lastSource {
                self.write(["kind": "status", "state": "source_changed", "sensorLocation": source])
                self.lastSource = source
            }
            let now = ProcessInfo.processInfo.systemUptime
            if self.stale { self.write(["kind": "status", "state": "resumed"]); self.stale = false }
            self.lastReceive = now
            if self.firstReceive == nil { self.firstReceive = now }
            self.count += 1
            let a = motion.userAcceleration, g = motion.gravity, r = motion.rotationRate, q = motion.attitude.quaternion
            self.write(["kind": "sample", "sequence": self.count, "sensorLocation": source,
                        "sensorTimestampSec": motion.timestamp,
                        "userAcceleration": ["x": a.x, "y": a.y, "z": a.z],
                        "gravity": ["x": g.x, "y": g.y, "z": g.z],
                        "rotationRate": ["x": r.x, "y": r.y, "z": r.z],
                        "attitude": ["x": q.x, "y": q.y, "z": q.z, "w": q.w]])
            guard self.running else { return }
            if self.count % 10 == 0 || self.count == 1 {
                let rate = Double(max(0, self.count - 1)) / max(0.001, now - self.firstReceive!)
                self.status.stringValue = String(format: "Source: %@ earbud • %d samples • %.1f callbacks/s • %@", source, self.count, rate, self.authorization())
            }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self = self, self.running else { return }
            let gap = ProcessInfo.processInfo.systemUptime - (self.lastReceive ?? started)
            if gap > 0.75 && !self.stale {
                self.stale = true
                self.write(["kind": "status", "state": "stale", "gapMs": gap * 1000,
                            "authorization": self.authorization(), "available": self.manager.isDeviceMotionAvailable])
                if self.running { self.status.stringValue = "No fresh samples. Check connection, source and ear detection; stop/restart if needed." }
            }
        }
    }

    @objc func stop() {
        if running { write(["kind": "status", "state": "stopped", "samples": count]) }
        shutdown()
        status.stringValue = "Stopped. \(count) samples saved. Start creates a new recording."
    }

    func shutdown() {
        running = false; manager.stopDeviceMotionUpdates()
        timer?.invalidate(); timer = nil
        try? file?.synchronize(); try? file?.close(); file = nil
        startButton.isEnabled = true; stopButton.isEnabled = false
    }

    func headphoneMotionManagerDidConnect(_ manager: CMHeadphoneMotionManager) {
        DispatchQueue.main.async { self.write(["kind": "status", "state": "connected"]) }
    }
    func headphoneMotionManagerDidDisconnect(_ manager: CMHeadphoneMotionManager) {
        DispatchQueue.main.async {
            self.write(["kind": "status", "state": "disconnected"])
            if self.running { self.status.stringValue = "Headphone motion disconnected. Waiting for reconnection…" }
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { stop() }
}

let app = NSApplication.shared
let delegate = Collector()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
