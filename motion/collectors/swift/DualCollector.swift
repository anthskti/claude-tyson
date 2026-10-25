import AppKit
import CoreMotion

// A role is a filter, never a request to Core Motion to select a Bluetooth device.
func accepts(role: String, observed: String) -> Bool {
    return (role == "left" || role == "right") && role == observed
}

final class SideCollector {
    let role: String
    let manager = CMHeadphoneMotionManager()
    let queue = OperationQueue()
    let report: (String, Int, Int, Int, String, Double?) -> Void
    private var accepted: FileHandle?
    private var observed: FileHandle?
    private var session = ""
    private var running = false
    private var count = 0
    private var seen = 0
    private var rejected = 0
    private var lastSource = "none"
    private var lastAccepted: Double?
    private var acceleration = 0.0
    private var rotation = 0.0
    private var errorText: String?

    init(role: String, report: @escaping (String, Int, Int, Int, String, Double?) -> Void) {
        self.role = role; self.report = report
        queue.name = "AirPodsCollector-\(role)"
        queue.maxConcurrentOperationCount = 1
        queue.qualityOfService = .userInitiated
    }

    func start(directory: URL, group: String) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for name in ["motion.jsonl", "observed-motion.jsonl"] {
            let url = directory.appendingPathComponent(name)
            guard !FileManager.default.fileExists(atPath: url.path),
                  FileManager.default.createFile(atPath: url.path, contents: nil) else {
                throw NSError(domain: "DualCollector", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "Cannot create new log: \(url.path)"])
            }
        }
        accepted = try FileHandle(forWritingTo: directory.appendingPathComponent("motion.jsonl"))
        observed = try FileHandle(forWritingTo: directory.appendingPathComponent("observed-motion.jsonl"))
        session = "\(group)-\(role)"
        running = true; count = 0; seen = 0; rejected = 0
        lastSource = "none"; lastAccepted = nil; errorText = nil; acceleration = 0; rotation = 0
        queue.addOperation {
            self.record(["kind": "metadata", "collector": "airpods-dual-probe-v1",
                         "expectedSensorLocation": self.role,
                         "deviceSelectionSupported": false,
                         "timing": "Host callback receipt; no physical/Bluetooth latency correction",
                         "units": ["userAcceleration": "g", "gravity": "g", "rotationRate": "rad/s"]])
        }
        manager.startDeviceMotionUpdates(to: queue) { [weak self] motion, error in
            guard let self = self, self.running else { return }
            if let error = error {
                self.errorText = error.localizedDescription
                self.record(["kind": "status", "state": "error", "message": error.localizedDescription])
                self.publish(); return
            }
            guard let motion = motion else { return }
            let receipt = Date().timeIntervalSince1970 * 1000
            let source: String
            switch motion.sensorLocation {
            case .headphoneLeft: source = "left"
            case .headphoneRight: source = "right"
            default: source = "unknown"
            }
            self.seen += 1
            let a = motion.userAcceleration, g = motion.gravity
            let w = motion.rotationRate, q = motion.attitude.quaternion
            var row: [String: Any] = [
                "kind": "sample", "sequence": self.seen, "sensorLocation": source,
                "sensorTimestampSec": motion.timestamp, "receiveUnixMs": receipt,
                "userAcceleration": ["x": a.x, "y": a.y, "z": a.z],
                "gravity": ["x": g.x, "y": g.y, "z": g.z],
                "rotationRate": ["x": w.x, "y": w.y, "z": w.z],
                "attitude": ["x": q.x, "y": q.y, "z": q.z, "w": q.w]]
            row["acceptedForRole"] = accepts(role: self.role, observed: source)
            self.record(row, rawOnly: true)
            if source != self.lastSource {
                self.lastSource = source
                self.record(["kind": "status", "state": "source_changed", "sensorLocation": source])
            }
            if accepts(role: self.role, observed: source) {
                self.count += 1; self.lastAccepted = receipt
                self.acceleration = sqrt(a.x*a.x + a.y*a.y + a.z*a.z)
                self.rotation = sqrt(w.x*w.x + w.y*w.y + w.z*w.z)
                // Never substitute the requested role for the observed physical side.
                self.record(row)
            } else { self.rejected += 1 }
            if self.seen == 1 || self.seen % 5 == 0 { self.publish() }
        }
    }

    private func record(_ payload: [String: Any], rawOnly: Bool = false) {
        guard running, let handle = rawOnly ? observed : accepted else { return }
        var row = payload
        row["schemaVersion"] = 1; row["sessionId"] = session
        row["collectorRole"] = role; row["streamId"] = session
        if row["receiveUnixMs"] == nil { row["receiveUnixMs"] = Date().timeIntervalSince1970 * 1000 }
        row["receiveUptimeMs"] = ProcessInfo.processInfo.systemUptime * 1000
        do {
            var bytes = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
            bytes.append(0x0a); try handle.write(contentsOf: bytes)
        } catch {
            errorText = "Logging failed: \(error.localizedDescription)"
            running = false; manager.stopDeviceMotionUpdates(); publish()
        }
    }

    private func publish() {
        let detail = errorText ?? String(format: "%@ | a=%.2f g, gyro=%.2f rad/s", lastSource, acceleration, rotation)
        let values = (role, count, seen, rejected, detail, lastAccepted)
        DispatchQueue.main.async { self.report(values.0, values.1, values.2, values.3, values.4, values.5) }
    }

    func stop() {
        manager.stopDeviceMotionUpdates()
        queue.waitUntilAllOperationsAreFinished()
        record(["kind": "status", "state": "stopped", "acceptedSamples": count,
                "observedSamples": seen, "wrongSourceSamples": rejected])
        running = false
        try? accepted?.synchronize(); try? accepted?.close(); accepted = nil
        try? observed?.synchronize(); try? observed?.close(); observed = nil
    }
}

final class DualCollector: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let startButton = NSButton(title: "Start both collectors", target: nil, action: nil)
    let stopButton = NSButton(title: "Stop both", target: nil, action: nil)
    let status = NSTextField(wrappingLabelWithString: "Idle")
    let path = NSTextField(wrappingLabelWithString: "")
    let left = NSTextField(wrappingLabelWithString: "LEFT: waiting")
    let right = NSTextField(wrappingLabelWithString: "RIGHT: waiting")
    var workers: [SideCollector] = []
    var latest: [String: Double] = [:]
    var timer: Timer?
    var active = false
    var currentGroup = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 850, height: 430),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Dual AirPods Collector — source verification"
        window.center()
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        let heading = NSTextField(labelWithString: "Two workers • actual left/right source filtering")
        heading.font = NSFont.boldSystemFont(ofSize: 20)
        let note = NSTextField(wrappingLabelWithString:
            "Core Motion cannot select a Bluetooth device. Two managers may receive the SAME source even with two pairs connected. Wrong-side samples are logged for inspection but never sent to that hand's classifier. Both counters must advance while each hand moves independently.")
        startButton.target = self; startButton.action = #selector(start)
        stopButton.target = self; stopButton.action = #selector(stop); stopButton.isEnabled = false
        for view in [heading, note, NSStackView(views: [startButton, stopButton]), left, right, status, path] {
            stack.addArrangedSubview(view)
        }
        path.isSelectable = true
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24)])
        let menu = NSMenu(); let item = NSMenuItem(); let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Dual Collector", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu; menu.addItem(item); NSApp.mainMenu = menu
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.refresh() }
    }

    @objc func start() {
        guard !active else { return }
        let group = UUID().uuidString
        currentGroup = group
        let root = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("dual-runs")
        let name = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-") + "-" + group.prefix(8)
        let directory = root.appendingPathComponent(name)
        latest = [:]; workers = []
        left.stringValue = "LEFT: waiting"; right.stringValue = "RIGHT: waiting"
        do {
            for side in ["left", "right"] {
                let worker = SideCollector(role: side) { [weak self] side, count, seen, rejected, source, stamp in
                    guard let self = self, self.active, self.currentGroup == group else { return }
                    if let stamp = stamp { self.latest[side] = stamp }
                    let field = side == "left" ? self.left : self.right
                    field.stringValue = "\(side.uppercased()): accepted \(count) / observed \(seen), rejected \(rejected), observed source: \(source)"
                }
                workers.append(worker)
                try worker.start(directory: directory.appendingPathComponent(side), group: group)
            }
            let manifest: [String: Any] = ["schemaVersion": 1, "sessionId": group,
                "deviceSelectionSupported": false,
                "left": directory.appendingPathComponent("left/motion.jsonl").path,
                "right": directory.appendingPathComponent("right/motion.jsonl").path]
            let url = directory.appendingPathComponent("streams.json")
            try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys]).write(to: url)
            path.stringValue = url.path
            active = true; startButton.isEnabled = false; stopButton.isEnabled = true
            refresh()
        } catch {
            workers.forEach { $0.stop() }; workers = []
            status.stringValue = "Start failed: \(error.localizedDescription)"
        }
    }

    func refresh() {
        guard active else { return }
        let now = Date().timeIntervalSince1970 * 1000
        let fresh = ["left", "right"].filter { now - (latest[$0] ?? 0) < 250 }
        status.stringValue = fresh.count == 2
            ? "Both physical sides fresh. Now verify: left-only motion, right-only motion, then simultaneous motion."
            : "Waiting for independent streams. Fresh sides: \(fresh.joined(separator: ", ")). Pairing alone does not guarantee two motion sources."
    }

    @objc func stop() {
        active = false
        workers.forEach { $0.stop() }; workers = []
        startButton.isEnabled = true; stopButton.isEnabled = false
        status.stringValue = "Stopped. Logs saved; starting again creates a new streams.json."
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { timer?.invalidate(); stop() }
}

if CommandLine.arguments.contains("--self-test") {
    precondition(accepts(role: "left", observed: "left"))
    precondition(accepts(role: "right", observed: "right"))
    precondition(!accepts(role: "right", observed: "left"))
    precondition(!accepts(role: "left", observed: "right"))
    precondition(!accepts(role: "left", observed: "unknown"))
    print("PASS: source routing never relabels or duplicates a physical side")
} else {
    let app = NSApplication.shared; let delegate = DualCollector()
    app.setActivationPolicy(.regular); app.delegate = delegate; app.run()
}
