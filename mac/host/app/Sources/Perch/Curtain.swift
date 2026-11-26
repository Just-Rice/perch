// The privacy curtain: while a viewer is connected (and the owner switched it on), the Mac's own displays show
// black, so nobody near the Mac can watch what is being done remotely. The viewer still sees everything: the
// curtain's windows are left out of the capture (CaptureController.setExcludedWindows).
//
// Clicks pass straight through the curtain (the viewer's clicks must reach the apps underneath), and it never takes
// the keyboard. Someone sitting at the Mac can lift it by pressing Esc three times in a row; Esc presses made by the
// viewer don't count (InputPoster marks the events it posts).
import AppKit
import PerchCore

final class Curtain {
    private var windows: [NSWindow] = []
    private var keyMonitor: Any?
    private var screenObserver: NSObjectProtocol?
    private var escTimes: [Date] = []
    /// Called (main thread) with the window numbers to leave out of the capture; call `ready` once that is done.
    var exclude: (([CGWindowID], @escaping () -> Void) -> Void)?
    /// Someone at the Mac asked to see the screen again.
    var onLifted: (() -> Void)?

    var isUp: Bool { !windows.isEmpty }

    func raise() {
        guard windows.isEmpty else { return }
        build()
        screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                                                object: nil, queue: .main) { [weak self] _ in
            guard let self, self.isUp else { return }
            self.teardownWindows()
            self.build()
        }
        // Needs Accessibility (which Perch has whenever it can control the Mac); without it, the menu bar's
        // Disconnect is the way to get the screen back.
        keyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] e in self?.key(e) }
        Log.shared.info("privacy curtain raised on \(windows.count) display(s)")
    }

    func lower() {
        guard isUp else { return }
        teardownWindows()
        exclude?([], {})
        if let m = keyMonitor { NSEvent.removeMonitor(m); keyMonitor = nil }
        if let o = screenObserver { NotificationCenter.default.removeObserver(o); screenObserver = nil }
        Log.shared.info("privacy curtain lowered")
    }

    private func teardownWindows() {
        windows.forEach { $0.orderOut(nil) }
        windows = []
    }

    private func build() {
        windows = NSScreen.screens.map { Self.makeWindow(frame: $0.frame, message: true) }
        // Invisible until the capture has been told to leave them out, so the viewer never sees a black flash.
        windows.forEach { $0.alphaValue = 0; $0.orderFrontRegardless() }
        let made = windows
        let ids = made.map { CGWindowID($0.windowNumber) }
        let reveal = { [weak self] in
            DispatchQueue.main.async {
                guard let self, self.windows.elementsEqual(made, by: { $0 === $1 }) else { return }
                made.forEach { $0.alphaValue = 1 }
            }
        }
        if let exclude { exclude(ids, reveal) } else { reveal() }
    }

    static func makeWindow(frame: NSRect, message: Bool, color: NSColor = .black) -> NSWindow {
        let w = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
        w.isReleasedWhenClosed = false
        w.level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()))
        w.backgroundColor = color
        w.isOpaque = true
        w.hasShadow = false
        w.ignoresMouseEvents = true
        w.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        w.sharingType = .none
        if message {
            let label = NSTextField(wrappingLabelWithString:
                "This Mac is being used remotely with Perch.\nPress Esc three times to show the screen.")
            label.alignment = .center
            label.textColor = NSColor(white: 1, alpha: 0.55)
            label.font = .systemFont(ofSize: 16, weight: .medium)
            label.translatesAutoresizingMaskIntoConstraints = false
            let view = NSView(frame: NSRect(origin: .zero, size: frame.size))
            view.addSubview(label)
            NSLayoutConstraint.activate([
                label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
                label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
                label.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, multiplier: 0.8),
            ])
            w.contentView = view
        }
        return w
    }

    /// Three Esc presses within two seconds, made at the Mac itself.
    private func key(_ e: NSEvent) {
        guard e.keyCode == 53 else { escTimes = []; return }
        if let cg = e.cgEvent, cg.getIntegerValueField(.eventSourceUserData) == InputPoster.sourceMark { return }
        let now = Date()
        escTimes = escTimes.filter { now.timeIntervalSince($0) < 2 } + [now]
        if escTimes.count >= 3 {
            escTimes = []
            Log.shared.info("privacy curtain lifted from the Mac's keyboard")
            lower()
            onLifted?()
        }
    }
}

/// Locks the Mac's screen. There is no public call for this; this is the one the system's own lock menu item uses.
enum ScreenLock {
    private typealias LockFn = @convention(c) () -> Int32

    private static let function: LockFn? = {
        guard let lib = dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login", RTLD_NOW),
              let sym = dlsym(lib, "SACLockScreenImmediate") else { return nil }
        return unsafeBitCast(sym, to: LockFn.self)
    }()

    static var available: Bool { function != nil }

    @discardableResult
    static func lock() -> Bool {
        guard let f = function else { return false }
        return f() == 0
    }
}
