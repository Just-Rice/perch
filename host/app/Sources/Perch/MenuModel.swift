// What the menu bar item shows, worked out from the host's latest `status` and `session` commands as plain values.
// StatusMenu turns this into real NSMenuItems; the self-test checks it directly, so menu rules (Disconnect only
// while someone is connected, Backup Sign-in only once a backup password exists, ...) are tested without putting
// anything in the menu bar.
import Foundation
import PerchCore

struct MenuModel: Equatable {
    /// What choosing an item does.
    enum Command: Equatable {
        /// Send `{e:"menu", action}` to the host, which owns every setting and answers with a fresh `status`.
        case event(String)
        case openSetup(URL)
        case quit
        /// Shown but not usable (Open Setup… before the host has said where Setup is).
        case none
    }

    enum Entry: Equatable {
        /// The first line: what Perch is doing right now.
        case header(String)
        /// A smaller grey line under it.
        case detail(String)
        case separator
        case item(title: String, command: Command, enabled: Bool, checked: Bool?, key: String, tip: String?)
    }

    var entries: [Entry] = []
    /// The screen in the icon is drawn lit while someone is connected.
    var connected = false
    /// The icon is dimmed while Perch is paused or its helper isn't running.
    var dimmed = false
    var tooltip = "Perch"

    /// `status` is the host's latest status command, `viewer` who the latest `session` command says is connected,
    /// and `problem` a message shown instead of the host's status while the host isn't running.
    init(status: [String: Any], viewer: String?, problem: String?) {
        let state = JSONValue.string(status["state"]) ?? "starting"
        let settings = JSONValue.object(status["settings"]) ?? [:]
        connected = viewer != nil || state == "connected"
        let paused = state == "paused" || JSONValue.bool(settings["paused"]) == true
        let text = Self.stateText(status: status, state: state, viewer: viewer, problem: problem)
        dimmed = problem != nil || (paused && !connected)
        tooltip = "Perch — \(text)"
        // Nothing but Quit can work while the host isn't running.
        let live = problem == nil

        entries.append(.header(text))
        if let name = JSONValue.string(status["macName"]), !name.isEmpty { entries.append(.detail("This Mac is \(name)")) }
        entries.append(.separator)

        if let url = Self.setupURL(status) {
            entries.append(.item(title: "Open Setup…", command: .openSetup(url), enabled: live, checked: nil, key: "", tip: nil))
        } else {
            entries.append(.item(title: "Open Setup…", command: .none, enabled: false, checked: nil, key: "",
                                 tip: "Setup isn't ready yet."))
        }
        if paused {
            entries.append(.item(title: "Resume Perch", command: .event("resume"), enabled: live, checked: nil, key: "", tip: nil))
        } else {
            entries.append(.item(title: "Pause Perch", command: .event("pause"), enabled: live, checked: nil, key: "",
                                 tip: "Nobody can connect while Perch is paused."))
        }
        if connected {
            entries.append(.item(title: "Disconnect \(viewer ?? "Viewer")", command: .event("disconnect"), enabled: live,
                                 checked: nil, key: "", tip: nil))
        }
        entries.append(.separator)

        let login = JSONValue.bool(settings["loginItem"]) ?? false
        entries.append(.item(title: "Start at Login", command: .event(login ? "login-item-off" : "login-item-on"),
                             enabled: live, checked: login, key: "", tip: nil))
        let awake = JSONValue.bool(settings["keepAwake"]) ?? false
        entries.append(.item(title: "Keep Mac Awake", command: .event(awake ? "keep-awake-off" : "keep-awake-on"),
                             enabled: live, checked: awake, key: "", tip: "Stops this Mac going to sleep by itself, so you can always reach it."))
        // Backup sign-in can only be switched on once a backup password exists (chosen in Setup). It can always be
        // switched off.
        let backup = JSONValue.bool(settings["backupOn"]) ?? false
        let passwordSet = JSONValue.bool(status["backupSet"]) ?? JSONValue.bool(settings["backupSet"]) ?? false
        entries.append(.item(title: "Backup Sign-in", command: .event(backup ? "backup-off" : "backup-on"),
                             enabled: live && (passwordSet || backup), checked: backup, key: "",
                             tip: passwordSet || backup ? nil : "Choose a backup password in Setup first."))

        entries.append(.item(title: "Check for Updates…", command: .event("check-updates"), enabled: live, checked: nil, key: "", tip: nil))
        if let v = Self.updateVersion(status) {
            entries.append(.item(title: "Update to \(v)…", command: .event("update"), enabled: live, checked: nil, key: "", tip: nil))
        }
        entries.append(.separator)
        entries.append(.item(title: "Quit Perch", command: .quit, enabled: true, checked: nil, key: "q", tip: nil))
    }

    private static func stateText(status: [String: Any], state: String, viewer: String?, problem: String?) -> String {
        if let problem { return problem }
        if let t = JSONValue.string(status["text"]), !t.isEmpty { return t }
        switch state {
        case "ready": return "Ready"
        case "needs-setup": return "Needs setting up"
        case "offline": return "Offline"
        case "paused": return "Paused"
        case "connected": return viewer.map { "\($0) is connected" } ?? "Viewer connected"
        case "error": return "Something went wrong"
        default: return "Starting…"
        }
    }

    /// Setup is a page the host serves on this Mac; nothing else may be opened from the menu.
    private static func setupURL(_ status: [String: Any]) -> URL? {
        guard let s = JSONValue.string(status["setupUrl"]), let url = URL(string: s),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        return url
    }

    /// `update` is `{version, ...}` from the host's updater (a bare version string is accepted too).
    private static func updateVersion(_ status: [String: Any]) -> String? {
        let v = JSONValue.string(status["update"]) ?? JSONValue.object(status["update"]).flatMap { JSONValue.string($0["version"]) }
        guard let v, !v.isEmpty else { return nil }
        return String(v.prefix(32))
    }
}
