// Perch.app's brain: starts the host process (and restarts it if it dies), turns its commands into capture, input,
// menu, power and notification changes, and reports what happens on the Mac back to it as events.
// docs/PROTOCOL.md, "App ⇄ host process (IPC)". Main thread unless noted.
import AppKit
import PerchCore
import PerchMedia

final class AppController: NSObject, NSApplicationDelegate, @unchecked Sendable {
    let options: Options
    private let bundled = AppPaths.isBundled
    private let capture: CaptureController
    private let input: InputHandler
    private let power = Power()
    private let watch: SystemWatch
    private var menu: StatusMenu?
    private var notifier: Notifier?

    /// The running host and its pipe. `link` is read from capture threads, so it sits behind a lock.
    private var host: HostProcess?
    private let linkLock = NSLock()
    private var link: HostProcess?
    private var restarts = 0
    private var restartTimer: DispatchWorkItem?
    private var lastHostStatus: Int32?

    private let curtain = Curtain()
    /// Plays the viewer's microphone. Made on first use: only the real app ever makes a sound.
    private lazy var mic: MicPlayer = {
        let m = MicPlayer(dryRun: !systemChangesAllowed)
        m.onFailure = { [weak self] why in
            Log.shared.warn("microphone playback stopped: \(why)")
            self?.sendEvent(["e": "mic", "on": false, "ok": false, "error": why])
        }
        m.onLevel = { [weak self] s in
            self?.sendEvent(["e": "mic-level", "packets": s.packets, "frames": s.frames, "late": s.late, "rms": s.rms])
        }
        return m
    }()
    private var micOn = false
    private var sessionViewer: String?
    private var sessionActive = false
    private var shuttingDown = false
    private var signalSources: [DispatchSourceSignal] = []
    /// App Nap would otherwise throttle a menu bar app with no windows: timers fire minutes late (a 2 s host restart
    /// took 12 minutes in testing), sign-ins answer slowly and capture stutters. Held for the app's whole life; it
    /// still lets the Mac sleep (that is the Keep Mac Awake setting's job).
    private var awakeActivity: NSObjectProtocol?
    /// Held while a viewer is connected, so the system treats capture, encoding and input as latency critical.
    private var sessionActivity: NSObjectProtocol?

    /// Above this many bytes waiting for the host, video frames are dropped (and a keyframe follows once it
    /// catches up) instead of queueing up seconds of delay.
    static let videoBacklogLimit = 4 << 20

    /// Test runs never change the login item or move the app to the Trash, unless explicitly allowed.
    private var systemChangesAllowed: Bool {
        options.allowSystemChanges ||
            (bundled && !options.noUI && !options.synthetic && !options.echoInput &&
             ProcessInfo.processInfo.environment["PERCH_TEST"] != "1")
    }

    init(options: Options) {
        self.options = options
        capture = CaptureController(synthetic: options.synthetic)
        input = InputHandler(echo: options.echoInput, synthetic: options.synthetic)
        watch = SystemWatch(synthetic: options.synthetic, echoInput: options.echoInput)
        super.init()
    }

    // MARK: lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        Log.shared.info("Perch \(AppPaths.appVersion) starting (pid \(getpid()), \(bundled ? Bundle.main.bundlePath : "not in an app bundle")"
            + "\(options.synthetic ? ", synthetic" : "")\(options.echoInput ? ", echo input" : "")\(options.noUI ? ", no UI" : ""))")
        if !options.ignored.isEmpty { Log.shared.info("ignoring arguments: \(options.ignored.joined(separator: " "))") }
        awakeActivity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiatedAllowingIdleSystemSleep], reason: "Perch answers sign-ins and streams on demand")
        handleSignals()

        capture.onVideo = { [weak self] f in
            _ = self?.send(.video, IPC.videoPayload(keyframe: f.isKeyframe, ptsMicros: f.ptsMicros, annexB: f.annexB))
        }
        capture.onAudio = { [weak self] pts, packet in _ = self?.send(.audio, IPC.audioPayload(ptsMicros: pts, packet: packet)) }
        capture.onEvent = { [weak self] e in self?.sendEvent(e) }
        capture.canSendVideo = { [weak self] in
            guard let self, let w = self.currentLink()?.writer else { return false }
            return w.pendingBytes < Self.videoBacklogLimit
        }
        capture.log = { Log.shared.info($0) }
        input.displayID = { [weak self] in self?.capture.displayID }
        input.region = { [weak self] in self?.capture.inputBounds }
        input.onEcho = { [weak self] e in self?.sendEvent(e) }
        input.onTextFocus = { [weak self] e in self?.sendEvent(e) }

        watch.onPermissions = { [weak self] p in self?.sendEvent(["e": "permissions", "screen": p.screen, "accessibility": p.accessibility]) }
        watch.onLock = { [weak self] locked in self?.sendEvent(["e": "lock", "locked": locked]) }
        watch.onDisplays = { [weak self] d in self?.sendEvent(["e": "displays", "displays": d.map(\.json)]) }
        watch.start()
        if !options.synthetic { AudioOutputs.watch { [weak self] in self?.sendAudioOutputs() } }

        if !options.noUI {
            let m = StatusMenu()
            m.onAction = { [weak self] a in self?.sendEvent(["e": "menu", "action": a]) }
            m.onOpenURL = { [weak self] url in self?.open(url) }
            m.onQuit = { [weak self] in self?.shutDown() }
            menu = m
            if bundled { notifier = Notifier() }
        }
        startHost()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Logging out or shutting down: stop the host properly first; shutDown() exits the process itself.
        shutDown()
        return .terminateLater
    }

    // MARK: the host process

    private func currentLink() -> HostProcess? { linkLock.withLock { link } }

    private func send(_ type: FrameType, _ payload: Data) -> Bool {
        currentLink()?.send(type, payload) ?? false
    }

    private func sendEvent(_ event: [String: Any]) {
        _ = send(.event, IPC.json(event))
    }

    private func startHost() {
        restartTimer = nil
        guard !shuttingDown else { return }
        let env = ProcessInfo.processInfo.environment
        guard let node = AppPaths.nodePath(options: options, environment: env) else {
            hostCouldNotStart("Perch can't find Node.js to run its helper.")
            return
        }
        guard let script = AppPaths.hostScript(options: options) else {
            hostCouldNotStart("Perch's helper is missing\(options.hostPath.map { " (\($0))" } ?? "").")
            return
        }
        var environment = env
        environment["PERCH_APP_VERSION"] = AppPaths.appVersion
        let h = HostProcess(node: node, script: script)
        h.onFrame = { [weak self] type, payload in self?.received(type, payload) }
        h.onProtocolError = { [weak self, weak h] message in
            DispatchQueue.main.async {
                Log.shared.error("host sent a bad frame (\(message)); restarting it")
                if let h, self?.host === h { h.terminate() }
            }
        }
        h.onExit = { [weak self, weak h] status, ran in
            guard let self, let h, self.host === h else { return }
            self.hostExited(status: status, ran: ran)
        }
        do {
            try h.launch(environment: environment)
        } catch {
            hostCouldNotStart("Perch couldn't start its helper: \(error.localizedDescription)")
            return
        }
        host = h
        linkLock.withLock { link = h }
        Log.shared.info("host started: \(node) \(script) (pid \(h.pid))")
        menu?.setProblem(nil)
        sendHello()
    }

    private func sendHello() {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        let hello: [String: Any] = [
            "app": "Perch",
            "version": AppPaths.appVersion,
            "ipc": IPC.version,
            "macos": "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)",
            "synthetic": options.synthetic,
            "permissions": watch.permissions.json,
            "displays": watch.currentDisplays.map(\.json),
            "loginItem": LoginItem.current(bundled: bundled),
        ]
        _ = send(.hello, IPC.json(hello))
        // The protocol's HELLO has no lock state, so say it straight away.
        sendEvent(["e": "lock", "locked": LockState.isLocked])
        sendAudioOutputs()
    }

    private func hostCouldNotStart(_ message: String) {
        Log.shared.error(message)
        menu?.setProblem(message)
        scheduleRestart()
    }

    private func hostExited(status: Int32, ran: TimeInterval) {
        host = nil
        linkLock.withLock { link = nil }
        lastHostStatus = status
        // Everything the host had switched on goes with it; a new host starts from a clean slate and resends.
        capture.stop(reason: "host-exited", notify: false)
        endSession()
        power.setKeepAwake(false)
        if shuttingDown { return }
        if ran > 60 { restarts = 0 }
        menu?.setProblem("Perch's helper stopped. Restarting…")
        scheduleRestart()
    }

    /// 1, 2, 4 ... 30 seconds between attempts; back to 1 s once a host has run for a minute.
    private func scheduleRestart() {
        guard !shuttingDown, restartTimer == nil else { return }
        let delay = min(30, pow(2, Double(restarts)))
        restarts += 1
        Log.shared.info("restarting the host in \(Int(delay)) s")
        let work = DispatchWorkItem { [weak self] in self?.startHost() }
        restartTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// Called on the reader thread.
    private func received(_ type: UInt8, _ payload: Data) {
        switch FrameType(rawValue: type) {
        case .input?:
            input.handle(payload)
        case .mic?:
            mic.push(payload)
        case .command?:
            DispatchQueue.main.async { [weak self] in self?.handleCommand(payload) }
        default:
            Log.shared.warn("ignored a frame of type 0x\(String(type, radix: 16)) from the host")
        }
    }

    // MARK: commands

    private func handleCommand(_ payload: Data) {
        guard let cmd = IPC.parseObject(payload), let c = JSONValue.string(cmd["c"]) else {
            warn("ignored a command that isn't a JSON object with a \"c\" field")
            return
        }
        switch c {
        case "capture":
            // Only an explicit `on: true` starts showing the screen; a malformed command must never switch it on.
            switch JSONValue.bool(cmd["on"]) {
            case true?:
                let request = CaptureRequest(command: cmd)
                // A window just chosen comes to the front, so what the viewer sees is what their clicks reach.
                if let wid = request.window, wid != capture.windowID { raiseWindow(wid) }
                capture.capture(request)
            case false?: capture.stop(reason: "requested")
            case nil: warn("capture without on")
            }
        case "clipboard-get":
            sendEvent(["e": "clipboard", "ok": true, "text": clipboardText()])
        case "clipboard-set":
            if let text = JSONValue.string(cmd["text"]), text.utf16.count <= Self.clipboardMax {
                setClipboard(text)
                if JSONValue.bool(cmd["paste"]) == true { input.pressPaste() }
                sendEvent(["e": "clipboard-set", "ok": true])
            } else {
                sendEvent(["e": "clipboard-set", "ok": false])
            }
        case "mic":
            setMic(JSONValue.bool(cmd["on"]) == true, device: JSONValue.string(cmd["device"]))
        case "windows":
            sendEvent(["e": "windows", "list": Windows.list(synthetic: options.synthetic).map(\.json)])
        case "window-fit":
            if let wid = JSONValue.int(cmd["window"]), let w = JSONValue.number(cmd["w"]), let h = JSONValue.number(cmd["h"]),
               wid > 0, w > 0, h > 0 {
                fitWindow(UInt32(wid), aspect: w / h)
            } else {
                warn("window-fit without window, w and h")
            }
        case "keyframe":
            capture.keyframe()
        case "bitrate":
            if let kbps = JSONValue.int(cmd["kbps"]) { capture.setBitrate(kbps: kbps) } else { warn("bitrate without kbps") }
        case "session":
            if JSONValue.bool(cmd["active"]) == true {
                startSession(viewer: JSONValue.string(cmd["viewer"]), route: JSONValue.string(cmd["route"]))
                setCurtain(JSONValue.bool(cmd["curtain"]) == true)
            } else {
                endSession()
            }
        case "lock":
            lockScreen()
        case "status":
            menu?.update(status: cmd)
        case "notify":
            let title = JSONValue.string(cmd["title"]) ?? "Perch"
            notify(title: title, body: JSONValue.string(cmd["body"]) ?? "")
        case "permissions":
            watch.checkPermissions(force: true)
        case "request-permission":
            Permissions.request(JSONValue.string(cmd["which"]) ?? "")
            // The answer can take a while; look again soon rather than at the next 3 s poll.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.watch.checkPermissions() }
        case "open-url":
            if let s = JSONValue.string(cmd["url"]), let url = URL(string: s) { open(url) } else { warn("open-url without a valid url") }
        case "login-item":
            if let on = JSONValue.bool(cmd["on"]) {
                sendEvent(LoginItem.set(on, allowed: systemChangesAllowed, bundled: bundled))
            } else {
                warn("login-item without on")
            }
        case "keep-awake":
            power.setKeepAwake(JSONValue.bool(cmd["on"]) == true)
        case "uninstall":
            uninstall()
        case "quit":
            shutDown()
        default:
            warn("ignored unknown command \"\(c)\"")
        }
    }

    /// A warning in the log, also sent to the host so it shows up in its log next to whatever caused it.
    // MARK: clipboard (text only)

    /// The most text that goes either way at once (it has to fit in one message on the connection).
    static let clipboardMax = 30_000
    /// Test runs never touch the real clipboard of whoever is at this Mac.
    private var testClipboard = ""

    private func clipboardText() -> String {
        guard systemChangesAllowed else { return testClipboard }
        let text = NSPasteboard.general.string(forType: .string) ?? ""
        // Cut on a whole character, so nothing half-encoded goes out.
        var out = "", units = 0
        for ch in text {
            units += ch.utf16.count
            if units > Self.clipboardMax { break }
            out.append(ch)
        }
        return out
    }

    private func setClipboard(_ text: String) {
        guard systemChangesAllowed else { testClipboard = text; return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    /// Starts or stops playing the viewer's microphone on this Mac. Only while a session is on.
    private func setMic(_ on: Bool, device: String?) {
        guard on else {
            if micOn {
                micOn = false
                mic.stop()
                Log.shared.info("microphone off")
            }
            sendEvent(["e": "mic", "on": false, "ok": true])
            return
        }
        guard sessionActive else {
            sendEvent(["e": "mic", "on": false, "ok": false, "error": "Nobody is connected."])
            return
        }
        do {
            try mic.start(deviceUID: device)
            micOn = true
            Log.shared.info("microphone on\(device.map { ", playing on \($0)" } ?? "")\(systemChangesAllowed ? "" : " (not played in a test run)")")
            sendEvent(["e": "mic", "on": true, "ok": true])
        } catch {
            micOn = false
            Log.shared.warn("could not play the microphone: \(error)")
            sendEvent(["e": "mic", "on": false, "ok": false, "error": "\(error)"])
        }
    }

    /// The Mac's sound outputs, for the picker in Setup. Synthetic runs list one pretend output, the same everywhere.
    private func sendAudioOutputs() {
        let list: [[String: Any]] = options.synthetic
            ? [["uid": "test-speakers", "name": "Test Speakers", "main": true]]
            : AudioOutputs.list().map(\.json)
        sendEvent(["e": "audio-outputs", "list": list])
    }

    // Accessibility calls wait on the other app, so they stay off the main thread.
    private let windowQueue = DispatchQueue(label: "perch.windows", qos: .userInitiated)

    private func raiseWindow(_ id: UInt32) {
        let synthetic = options.synthetic
        // Test runs never rearrange the windows of whoever is sitting at this Mac.
        guard synthetic || systemChangesAllowed else { return }
        windowQueue.async {
            guard let w = Windows.find(id, synthetic: synthetic) else { return }
            if !Windows.raise(w, synthetic: synthetic) { Log.shared.info("could not bring window \(id) to the front") }
        }
    }

    /// Reshapes the window to the viewer's screen shape. The capture follows the window, so the picture changes by
    /// itself a moment later. Never done for real in a test run, like every other change to the Mac.
    private func fitWindow(_ id: UInt32, aspect: Double) {
        let synthetic = options.synthetic
        guard synthetic || systemChangesAllowed else {
            sendEvent(["e": "window-fit", "window": Int(id), "ok": false, "error": "Windows are not reshaped in test runs."])
            return
        }
        guard let w = Windows.find(id, synthetic: synthetic) else {
            sendEvent(["e": "window-fit", "window": Int(id), "ok": false, "error": "That window is no longer on screen."])
            return
        }
        let displays = Displays.list(synthetic: synthetic)
        let middle = CGPoint(x: w.bounds.midX, y: w.bounds.midY)
        let display = displays.first(where: { $0.bounds.contains(middle) }) ?? displays.first(where: { $0.isMain }) ?? displays.first
        guard let display else { return }
        let area = Windows.usableArea(displayID: display.id, synthetic: synthetic)
        windowQueue.async { [weak self] in
            let ok = Windows.fit(w, aspect: aspect, in: area, synthetic: synthetic)
            var e: [String: Any] = ["e": "window-fit", "window": Int(id), "ok": ok]
            if !ok { e["error"] = "This window can't be reshaped." }
            self?.sendEvent(e)
        }
    }

    private func warn(_ message: String) {
        Log.shared.warn(message)
        sendEvent(["e": "log", "level": "warn", "message": message])
    }

    private func startSession(viewer: String?, route: String?) {
        let isNew = !sessionActive || viewer != sessionViewer
        sessionActive = true
        sessionViewer = viewer
        power.setSessionActive(true)
        if sessionActivity == nil {
            sessionActivity = ProcessInfo.processInfo.beginActivity(
                options: [.userInitiatedAllowingIdleSystemSleep, .latencyCritical], reason: "A viewer is connected")
        }
        menu?.setSession(viewer: viewer ?? "Viewer")
        if isNew {
            Log.shared.info("session started: \(viewer ?? "unnamed viewer") via \(route ?? "unknown route")")
            notify(title: "\(viewer ?? "Someone") is viewing this Mac",
                   body: "You can disconnect them from Perch in the menu bar.")
        }
    }

    /// The privacy curtain only ever shows from a real, bundled Perch (never in test runs: a test must not black out
    /// the screen of the Mac it runs on).
    private func setCurtain(_ on: Bool) {
        guard systemChangesAllowed, !options.noUI else {
            if on { Log.shared.info("privacy curtain requested (not shown in a test run)") }
            sendEvent(["e": "curtain", "up": false, "requested": on])
            return
        }
        if on {
            curtain.exclude = { [weak self] ids, done in
                guard let self else { done(); return }
                self.capture.setExcludedWindows(ids, done: done)
            }
            curtain.onLifted = { [weak self] in self?.sendEvent(["e": "curtain", "up": false, "lifted": true]) }
            curtain.raise()
        } else {
            curtain.lower()
        }
        sendEvent(["e": "curtain", "up": curtain.isUp, "requested": on])
    }

    private func lockScreen() {
        guard systemChangesAllowed else {
            Log.shared.info("lock requested (not done in a test run; lock call available: \(ScreenLock.available))")
            sendEvent(["e": "lock-request", "performed": false, "available": ScreenLock.available])
            return
        }
        let ok = ScreenLock.lock()
        Log.shared.info(ok ? "locked the screen (session ended)" : "could not lock the screen")
        sendEvent(["e": "lock-request", "performed": ok, "available": ScreenLock.available])
    }

    private func endSession() {
        curtain.lower()
        input.releaseAll()
        if micOn { micOn = false; mic.stop(); Log.shared.info("microphone off (session ended)") }
        guard sessionActive else { return }
        sessionActive = false
        sessionViewer = nil
        power.setSessionActive(false)
        if let a = sessionActivity { ProcessInfo.processInfo.endActivity(a); sessionActivity = nil }
        menu?.setSession(viewer: nil)
        Log.shared.info("session ended")
    }

    private func notify(title: String, body: String) {
        if let notifier { notifier.show(title: title, body: body) } else { Log.shared.info("notification (not shown here): \(title) — \(body)") }
    }

    /// Only web pages: the host never needs to open anything else, so nothing else is allowed.
    private func open(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            warn("refused to open \(url.scheme ?? "a") URL (only http and https are allowed)")
            return
        }
        NSWorkspace.shared.open(url)
    }

    private func uninstall() {
        Log.shared.info("uninstalling")
        guard systemChangesAllowed && bundled else {
            warn("uninstall: not removing anything (\(bundled ? "test run" : "not running from Perch.app"))")
            shutDown()
            return
        }
        _ = LoginItem.set(false, allowed: true, bundled: true)
        NSWorkspace.shared.recycle([Bundle.main.bundleURL]) { [weak self] _, error in
            if let error { Log.shared.error("could not move Perch to the Trash: \(error.localizedDescription)") }
            DispatchQueue.main.async { self?.shutDown() }
        }
    }

    // MARK: quitting

    /// Stops everything and exits: release input and power, stop capture, close the host's stdin, wait up to 2 s
    /// for it to exit, then terminate it. "Quit Perch" in the menu, the `quit` command, logging out and SIGTERM all
    /// end here. Nothing special is sent first: the host treats the end of its input as "quit", and says goodbye to
    /// a connected viewer by itself.
    private func shutDown() {
        guard !shuttingDown else { return }
        shuttingDown = true
        Log.shared.info("quitting")
        restartTimer?.cancel()
        watch.stop()
        menu?.remove()
        input.releaseAll(wait: true)
        power.releaseAll()
        capture.stop(reason: "quit", notify: false)
        let finish: (Int32?) -> Void = { [weak self] status in
            guard let self else { exit(0) }
            if let status { self.lastHostStatus = status }
            // Give capture a moment to stop cleanly, but never hang on it.
            let done = DispatchSemaphore(value: 0)
            self.capture.whenSettled { done.signal() }
            _ = done.wait(timeout: .now() + 1)
            let code = self.options.exitWithHost ? (self.lastHostStatus ?? 1) : 0
            Log.shared.info("bye (exit \(code))")
            exit(code)
        }
        if let h = host {
            linkLock.withLock { link = nil }
            h.shutdown(timeout: 2, completion: finish)
        } else {
            finish(nil)
        }
    }

    private func handleSignals() {
        signal(SIGPIPE, SIG_IGN) // a dead host's pipe must not kill the app
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            s.setEventHandler { [weak self] in
                Log.shared.info("got signal \(sig)")
                self?.shutDown()
            }
            s.resume()
            signalSources.append(s)
        }
    }
}
