// "Start at Login", through SMAppService (macOS 13+): the app registers itself, macOS lists it under
// System Settings > General > Login Items, and the user can switch it off there too.
import Foundation
import ServiceManagement
import PerchCore

enum LoginItem {
    static func name(_ s: SMAppService.Status) -> String {
        switch s {
        case .notRegistered: return "not-registered"
        case .enabled: return "enabled"
        case .requiresApproval: return "requires-approval"
        case .notFound: return "not-found"
        @unknown default: return "unknown"
        }
    }

    /// `{on, status}` as HELLO and the login-item event report it. Outside Perch.app there is nothing to register.
    static func current(bundled: Bool) -> [String: Any] {
        guard bundled else { return ["on": false, "status": "not-found"] }
        let s = SMAppService.mainApp.status
        return ["on": s == .enabled, "status": name(s)]
    }

    /// Turns the login item on or off and returns the `login-item` event. `allowed` is false in test runs, so a
    /// test can never leave a login item behind on the Mac it runs on.
    static func set(_ on: Bool, allowed: Bool, bundled: Bool) -> [String: Any] {
        var event = current(bundled: bundled)
        guard allowed else {
            event["error"] = "Login item changes are turned off in test runs (pass --allow-system-changes to allow them)."
            return withName(event)
        }
        guard bundled else {
            event["error"] = "Only Perch.app can be a login item."
            return withName(event)
        }
        // The host asks for the user's choice every time it starts. When the login item is already that way, leave it
        // alone: registering again can only fail or show macOS's "will open automatically" notice a second time, and
        // unregistering something that isn't registered is an error.
        let before = SMAppService.mainApp.status
        if (on && before == .enabled) || (!on && (before == .notRegistered || before == .notFound)) {
            return withName(event)
        }
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            Log.shared.info("login item \(on ? "registered" : "unregistered")")
        } catch {
            event["error"] = error.localizedDescription
            Log.shared.warn("login item \(on ? "register" : "unregister") failed: \(error.localizedDescription)")
        }
        let s = SMAppService.mainApp.status
        event["on"] = s == .enabled
        event["status"] = name(s)
        return withName(event)
    }

    private static func withName(_ e: [String: Any]) -> [String: Any] {
        var out = e
        out["e"] = "login-item"
        return out
    }
}
