// App mode: one Mac app on a stage shaped like the viewer's screen (docs/PROTOCOL.md, "app mode"). Starts the app,
// moves each of its windows onto the stage as it appears (through Accessibility, which Perch holds for input anyway),
// keeps them there, says when the picture must grow for a window that won't shrink, and puts every window back where
// it was when app mode ends.
//
// Threads: `want` and `leave` are called on the main thread; everything that talks to other apps runs on one serial
// queue, in order, so leaving one app always finishes before the next is entered.
import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import PerchCore

public final class AppMode: @unchecked Sendable {
    public let synthetic: Bool
    /// False in test runs on a real Mac: nothing is opened, moved or hidden there.
    public let allowChanges: Bool
    /// Protocol events: app-mode, app-gone. Any thread.
    public var onEvent: (([String: Any]) -> Void)?
    /// The picture for this app should now be this part of the display (its own points). Main thread.
    public var onPicture: ((String, CGRect) -> Void)?
    public var log: (String) -> Void = { _ in }

    /// How often the app's windows are looked at.
    static let pollMs = 400
    /// A window seen off its place this many times in a row goes back.
    static let offBeforeBack = 2

    private let queue = DispatchQueue(label: "perch.apps", qos: .userInitiated)

    // What the latest capture command asked for, and the picture for it (global points). lock.
    private let lock = NSLock()
    private var wanted: (target: AppTarget, stage: AppStage)?
    private var picture: CGRect?

    // What is actually set up. Queue only.
    private var cur: (target: AppTarget, stage: AppStage)?
    private var moved: [Moved] = []
    private var timer: DispatchSourceTimer?
    private var enteredAt = Date.distantPast
    /// When opening the app finished (nil until then).
    private var openedAt: Date?
    private var everRan = false
    private var missing = 0
    private var reopened = false
    private var pending: CGRect?
    private var syntheticOriginal: CGRect?

    /// A window Perch moved: where it was, and where it ended up (the app may not take the exact size asked for).
    final class Moved {
        let el: AXUIElement
        let original: CGRect
        var placed: CGRect
        var off = 0
        let standard: Bool
        init(el: AXUIElement, original: CGRect, placed: CGRect, standard: Bool) {
            self.el = el; self.original = original; self.placed = placed; self.standard = standard
        }
    }

    public init(synthetic: Bool, allowChanges: Bool) {
        self.synthetic = synthetic
        self.allowChanges = allowChanges
    }

    /// The app being shown, if any.
    public var appID: String? { lock.withLock { wanted?.target.id } }

    /// Main thread. The latest capture command's app mode (nil: none) on this display. Returns the part of the
    /// display to show (its own points), or nil for no app mode (none asked for, or it can't be: then an app-mode
    /// event with ok false says why).
    public func want(_ target: AppTarget?, display: DisplayInfo) -> CGRect? {
        guard let target else { leave(); return nil }
        let refuse = { [self] (error: String) -> CGRect? in
            onEvent?(["e": "app-mode", "id": target.id, "ok": false, "error": error])
            leave()
            return nil
        }
        guard synthetic || allowChanges else { return refuse("test-run") }
        guard synthetic || AXIsProcessTrusted() else { return refuse("view-only") }
        // Checked once, when this app is first asked for: later capture commands repeat the same app, and reading
        // the Applications folders again on the main thread would stall it.
        let known = lock.withLock { wanted?.target.id == target.id }
        guard known || AppCatalog.find(target.id, synthetic: synthetic) != nil else { return refuse("not-found") }
        let usable = Windows.usableArea(displayID: display.id, synthetic: synthetic)
        let stage = AppStage.plan(display: display.bounds, usable: usable, aspect: target.aspect)
        let shown = lock.withLock { () -> CGRect in
            if wanted?.target.id != target.id || wanted?.stage != stage { picture = stage.region }
            wanted = (target, stage)
            return picture ?? stage.region
        }
        queue.async { [self] in apply(target, stage) }
        return AppStage.local(shown, on: display.bounds)
    }

    /// Main thread: app mode is over (capture stopped, the session ended, a capture without it).
    public func leave() {
        let was = lock.withLock { () -> Bool in defer { wanted = nil; picture = nil }; return wanted != nil }
        if was { queue.async { [self] in apply(nil, nil) } }
    }

    /// Perch is quitting: put the windows back now, waiting at most `timeout` seconds. Main thread.
    public func leaveNow(timeout: TimeInterval) {
        leave()
        let done = DispatchSemaphore(value: 0)
        queue.async { done.signal() }
        _ = done.wait(timeout: .now() + timeout)
    }

    // MARK: queue

    private func apply(_ target: AppTarget?, _ stage: AppStage?) {
        guard let target, let stage else {
            if let c = cur { putBack(c.target) }
            return
        }
        if let c = cur, c.target.id == target.id {
            cur = (target, stage) // the hide setting may have changed
            if c.stage != stage { restage() }
            return
        }
        if let c = cur { putBack(c.target) }
        enter(target, stage)
    }

    private func enter(_ target: AppTarget, _ stage: AppStage) {
        cur = (target, stage)
        moved = []
        enteredAt = Date()
        openedAt = nil
        everRan = false
        missing = 0
        reopened = false
        pending = nil
        guard let app = AppCatalog.find(target.id, synthetic: synthetic) else { return fail(target.id, "not-found") }
        log("app mode: \(app.name) (\(app.id)) on a \(Int(stage.region.width))x\(Int(stage.region.height)) stage")
        startPolling()
        if synthetic {
            onEvent?(["e": "app-mode", "id": app.id, "ok": true, "name": app.name])
            poll()
            return
        }
        open(app) { [self] error in
            guard cur?.target.id == app.id else { return }
            if let error {
                log("app mode: could not open \(app.name): \(error)")
                return fail(app.id, "launch-failed")
            }
            openedAt = Date()
            onEvent?(["e": "app-mode", "id": app.id, "ok": true, "name": app.name])
            poll()
        }
    }

    /// Opens the app, or for one already running brings it to the front and asks it for a window if it has none
    /// (as clicking its Dock icon does). `done` runs on the queue.
    private func open(_ app: AppEntry, done: @escaping (Error?) -> Void) {
        DispatchQueue.main.async { [self] in
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            NSWorkspace.shared.openApplication(at: app.url, configuration: config) { [self] _, error in
                queue.async { done(error) }
            }
        }
    }

    private func fail(_ id: String, _ error: String) {
        stopPolling()
        cur = nil
        moved = []
        lock.withLock { if wanted?.target.id == id { wanted = nil; picture = nil } }
        onEvent?(["e": "app-mode", "id": id, "ok": false, "error": error])
    }

    /// The app quit: there are no windows to put back.
    private func gone(_ id: String) {
        log("app mode: \(id) quit")
        stopPolling()
        cur = nil
        moved = []
        lock.withLock { if wanted?.target.id == id { wanted = nil; picture = nil } }
        onEvent?(["e": "app-gone", "id": id])
    }

    private func putBack(_ target: AppTarget) {
        stopPolling()
        cur = nil
        if synthetic {
            if let o = syntheticOriginal { Windows.setSynthetic(o) }
            syntheticOriginal = nil
        } else {
            var back = 0
            for m in moved where setFrame(m.el, m.original, resize: true) { back += 1 }
            if target.hide {
                let id = target.id
                DispatchQueue.main.async {
                    for app in NSRunningApplication.runningApplications(withBundleIdentifier: id) { app.hide() }
                }
            }
            log("app mode ended: \(back) of \(moved.count) windows put back\(target.hide ? ", app hidden" : "")")
        }
        moved = []
    }

    /// The stage changed shape or display: every window goes onto the new one.
    private func restage() {
        guard let c = cur else { return }
        pending = nil
        if synthetic { poll(); return }
        for m in moved {
            let f = Windows.frame(of: m.el) ?? m.placed
            m.placed = place(m.el, frame: f, standard: m.standard, on: c.stage)
            m.off = 0
        }
        poll()
    }

    private func startPolling() {
        guard timer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + .milliseconds(Self.pollMs), repeating: .milliseconds(Self.pollMs), leeway: .milliseconds(50))
        t.setEventHandler { [weak self] in self?.poll() }
        t.resume()
        timer = t
    }

    private func stopPolling() {
        timer?.cancel()
        timer = nil
    }

    private func poll() {
        guard let (target, stage) = cur else { return }
        if synthetic {
            if target.id == AppCatalog.testNotes {
                if syntheticOriginal == nil { syntheticOriginal = Windows.synthetic.bounds }
                if Windows.synthetic.bounds != stage.window { Windows.setSynthetic(stage.window) }
            }
            show(target.id, stage.picture(front: nil))
            return
        }
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: target.id).filter { !$0.isTerminated }
        if apps.isEmpty {
            // Starting can take a while; once it has run, three looks in a row without it means it quit.
            if everRan || Date().timeIntervalSince(enteredAt) > 30 { missing += 1 }
            if missing >= 3 { gone(target.id) }
            return
        }
        everRan = true
        missing = 0
        var seen: [AXUIElement] = []
        var front: CGRect?
        var hasWindow = false
        for app in apps {
            let ax = AXUIElementCreateApplication(app.processIdentifier)
            // An app that isn't answering must not hold up the others (or putting windows back).
            AXUIElementSetMessagingTimeout(ax, 0.5)
            guard let windows = Self.copy(ax, kAXWindowsAttribute) as? [AXUIElement] else { continue }
            var focused: AXUIElement?
            if let f = Self.copy(ax, kAXFocusedWindowAttribute), CFGetTypeID(f) == AXUIElementGetTypeID() { focused = (f as! AXUIElement) }
            for el in windows {
                if Self.copy(el, kAXMinimizedAttribute) as? Bool == true { continue }
                if Self.copy(el, "AXFullScreen") as? Bool == true { continue } // its own Space: leave it be
                guard let f = Windows.frame(of: el), f.width >= 40, f.height >= 40 else { continue }
                seen.append(el)
                let standard = (Self.copy(el, kAXSubroleAttribute) as? String) == (kAXStandardWindowSubrole as String)
                if standard { hasWindow = true }
                var now = f
                if let m = moved.first(where: { CFEqual($0.el, el) }) {
                    if Self.near(f, m.placed) {
                        m.off = 0
                    } else {
                        m.off += 1
                        if m.off >= Self.offBeforeBack {
                            m.placed = place(el, frame: f, standard: m.standard, on: stage)
                            m.off = 0
                            now = m.placed
                        }
                    }
                } else {
                    // Moved without raising it: the app keeps its own order of windows (a new one is in front anyway).
                    let placed = place(el, frame: f, standard: standard, on: stage)
                    moved.append(Moved(el: el, original: f, placed: placed, standard: standard))
                    now = placed
                }
                if standard, let focused, CFEqual(focused, el) { front = now }
            }
        }
        moved.removeAll { m in !seen.contains { CFEqual($0, m.el) } } // closed
        // Opening a running app asks it for a window, as clicking its Dock icon does. One that still has none a few
        // seconds later (some answer only once they have finished starting) is asked once more.
        if !hasWindow && !reopened, let opened = openedAt, Date().timeIntervalSince(opened) > 5,
           let app = AppCatalog.find(target.id, synthetic: false) {
            reopened = true
            log("app mode: \(app.name) has no window; asking it for one")
            open(app) { _ in }
        }
        show(target.id, stage.picture(front: front))
    }

    /// The picture for this app becomes `r` (global points) once it has been wanted twice in a row, so a window
    /// that is being resized doesn't rebuild the encoder several times a second.
    private func show(_ id: String, _ r: CGRect) {
        let (current, display) = lock.withLock { (picture, wanted?.target.id == id ? wanted?.stage.display : nil) }
        guard let display else { return }
        if current == r { pending = nil; return }
        if pending != r { pending = r; return }
        pending = nil
        let changed = lock.withLock { () -> Bool in
            guard wanted?.target.id == id, picture != r else { return false }
            picture = r
            return true
        }
        guard changed else { return }
        let local = AppStage.local(r, on: display)
        DispatchQueue.main.async { [self] in onPicture?(id, local) }
    }

    /// Moves a window onto the stage: an ordinary one fills it, anything else goes in its middle. Returns where it
    /// actually is now.
    private func place(_ el: AXUIElement, frame f: CGRect, standard: Bool, on stage: AppStage) -> CGRect {
        let target = standard ? stage.window : stage.place(dialog: f.size)
        setFrame(el, target, resize: standard || target.size != f.size)
        return Windows.frame(of: el) ?? target
    }

    @discardableResult
    private func setFrame(_ el: AXUIElement, _ r: CGRect, resize: Bool) -> Bool {
        var p = r.origin, s = r.size
        guard let pv = AXValueCreate(.cgPoint, &p), let sv = AXValueCreate(.cgSize, &s) else { return false }
        // Position, size, position again: a window can't grow past the screen's edge from where it was, and some
        // apps nudge the position when their size changes.
        var ok = AXUIElementSetAttributeValue(el, kAXPositionAttribute as CFString, pv) == .success
        if resize { ok = AXUIElementSetAttributeValue(el, kAXSizeAttribute as CFString, sv) == .success && ok }
        AXUIElementSetAttributeValue(el, kAXPositionAttribute as CFString, pv)
        return ok
    }

    private static func copy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success ? v : nil
    }

    static func near(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) <= 2 && abs(a.minY - b.minY) <= 2 && abs(a.width - b.width) <= 2 && abs(a.height - b.height) <= 2
    }
}
