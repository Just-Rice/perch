// What the host needs to know about the Mac, watched and reported as events: permissions, the lock screen, displays.
// Also power assertions. Nothing here ever shows a permission prompt except `requestPermission`, which only runs
// when the host asks (the user pressed a button in Setup).
import AppKit
import CoreGraphics
import ApplicationServices
import IOKit.pwr_mgt
import PerchCore
import PerchMedia

struct Permissions: Equatable {
    var screen: Bool
    var accessibility: Bool

    var json: [String: Any] { ["screen": screen, "accessibility": accessibility] }

    /// The permissions as they matter to Perch. The synthetic source needs no Screen Recording permission, and
    /// echoed input needs no Accessibility permission, so in those test modes they count as granted.
    static func current(synthetic: Bool, echoInput: Bool) -> Permissions {
        Permissions(screen: synthetic || CGPreflightScreenCaptureAccess(),
                    accessibility: echoInput || AXIsProcessTrusted())
    }

    static func request(_ which: String) {
        switch which {
        case "screen":
            _ = CGRequestScreenCaptureAccess()
            openSettings("Privacy_ScreenCapture")
        case "accessibility":
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
            openSettings("Privacy_Accessibility")
        default:
            Log.shared.warn("request-permission for unknown permission \(which)")
        }
    }

    private static func openSettings(_ anchor: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") {
            NSWorkspace.shared.open(url)
        }
    }
}

enum LockState {
    /// CGSSessionScreenIsLocked is only present while the screen is locked; a missing key means unlocked.
    static var isLocked: Bool {
        guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        if let v = d["CGSSessionScreenIsLocked"] as? Bool { return v }
        if let v = d["CGSSessionScreenIsLocked"] as? Int { return v != 0 }
        return false
    }
}

/// Polls permissions (every 3 s) and the lock screen (every 2 s), and listens for display changes. Each change
/// becomes an event for the host. Main thread.
final class SystemWatch {
    var onPermissions: ((Permissions) -> Void)?
    var onLock: ((Bool) -> Void)?
    var onDisplays: (([DisplayInfo]) -> Void)?

    private let synthetic: Bool
    private let echoInput: Bool
    private var timers: [Timer] = []
    private(set) var permissions: Permissions
    private(set) var locked: Bool
    private var displays: [DisplayInfo]
    private var displayCheck: DispatchWorkItem?

    init(synthetic: Bool, echoInput: Bool) {
        self.synthetic = synthetic
        self.echoInput = echoInput
        permissions = Permissions.current(synthetic: synthetic, echoInput: echoInput)
        locked = LockState.isLocked
        displays = Displays.list(synthetic: synthetic, names: true)
    }

    var currentDisplays: [DisplayInfo] { displays }

    func start() {
        // Timers in the common run loop modes keep firing while the menu is open.
        let p = Timer(timeInterval: 3, repeats: true) { [weak self] _ in self?.checkPermissions() }
        let l = Timer(timeInterval: 2, repeats: true) { [weak self] _ in self?.checkLock() }
        for t in [p, l] { RunLoop.main.add(t, forMode: .common); timers.append(t) }
        if !synthetic {
            CGDisplayRegisterReconfigurationCallback(displayCallback, Unmanaged.passUnretained(self).toOpaque())
        }
    }

    func stop() {
        timers.forEach { $0.invalidate() }
        timers = []
        if !synthetic {
            CGDisplayRemoveReconfigurationCallback(displayCallback, Unmanaged.passUnretained(self).toOpaque())
        }
    }

    func checkPermissions(force: Bool = false) {
        let now = Permissions.current(synthetic: synthetic, echoInput: echoInput)
        if force || now != permissions {
            permissions = now
            onPermissions?(now)
        }
    }

    private func checkLock() {
        let now = LockState.isLocked
        if now != locked {
            locked = now
            onLock?(now)
        }
    }

    /// Displays change in bursts (one callback per display, before and after); look once things have settled.
    fileprivate func displaysChanged() {
        displayCheck?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let now = Displays.list(synthetic: self.synthetic, names: true)
            if now != self.displays {
                self.displays = now
                self.onDisplays?(now)
            }
        }
        displayCheck = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
    }
}

private let displayCallback: CGDisplayReconfigurationCallBack = { _, flags, userInfo in
    guard !flags.contains(.beginConfigurationFlag), let userInfo else { return }
    let watch = Unmanaged<SystemWatch>.fromOpaque(userInfo).takeUnretainedValue()
    DispatchQueue.main.async { watch.displaysChanged() }
}

/// Power assertions: "Keep Mac Awake" stops idle system sleep; a viewing session also keeps the display on and
/// wakes it at the start. Main thread.
final class Power {
    private var awake: IOPMAssertionID = 0
    private var display: IOPMAssertionID = 0
    private var activity: IOPMAssertionID = 0

    var keepingAwake: Bool { awake != 0 }
    var holdingDisplay: Bool { display != 0 }

    func setKeepAwake(_ on: Bool) {
        if on && awake == 0 {
            let r = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                                                IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                                "Perch is keeping this Mac awake so you can reach it" as CFString, &awake)
            if r != kIOReturnSuccess { Log.shared.warn("could not keep the Mac awake (IOReturn \(r))"); awake = 0 }
        } else if !on && awake != 0 {
            IOPMAssertionRelease(awake)
            awake = 0
        }
    }

    func setSessionActive(_ on: Bool) {
        if on {
            if display == 0 {
                let r = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
                                                    IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                                    "Someone is viewing this Mac with Perch" as CFString, &display)
                if r != kIOReturnSuccess { Log.shared.warn("could not keep the display on (IOReturn \(r))"); display = 0 }
            }
            // Wakes a sleeping display, as if someone touched the keyboard.
            let r = IOPMAssertionDeclareUserActivity("Perch viewer connected" as CFString, kIOPMUserActiveLocal, &activity)
            if r != kIOReturnSuccess { Log.shared.warn("could not wake the display (IOReturn \(r))") }
        } else {
            if display != 0 { IOPMAssertionRelease(display); display = 0 }
            if activity != 0 { IOPMAssertionRelease(activity); activity = 0 }
        }
    }

    func releaseAll() {
        setKeepAwake(false)
        setSessionActive(false)
    }
}
