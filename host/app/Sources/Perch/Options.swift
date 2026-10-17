// Command-line flags. Normal launches (Finder, login item) pass none; the rest are for development and tests
// (docs/PROTOCOL.md, "Test mode").
import Foundation

struct Options {
    /// A moving test pattern and a test tone instead of the real screen and sound.
    var synthetic = false
    /// Report input back to the host instead of performing it.
    var echoInput = false
    /// No menu bar item (and no notifications).
    var noUI = false
    var nodePath: String?
    var hostPath: String?
    /// Run the built-in checks and exit.
    var selftest = false
    /// When the app quits, exit with the host process's exit status (so a test host's verdict reaches the shell).
    var exitWithHost = false
    /// Let a test or development run really change the login item (and let `uninstall` move the app to the Trash).
    var allowSystemChanges = false
    /// Draw the menu bar icons into this folder as PNGs and exit (to look at them).
    var renderMenuIcons: String?
    var help = false
    var ignored: [String] = []

    static let usage = """
    usage: Perch [--synthetic] [--echo-input] [--no-ui] [--node <path>] [--host <path>]
                 [--exit-with-host] [--allow-system-changes] [--selftest] [--render-menu-icons <dir>]

      --synthetic             test pattern and tone instead of the real screen and sound
      --echo-input            report input to the host instead of performing it
      --no-ui                 no menu bar item, no notifications (tests, CI)
      --node <path>           Node.js to run the host with (else $PERCH_NODE, the bundled one, Homebrew's)
      --host <path>           host script (else Contents/Resources/host/perch-host.mjs)
      --exit-with-host        on quit, exit with the host process's exit status
      --allow-system-changes  let a test run change the login item and move the app to the Trash on uninstall
      --selftest              run the built-in checks and exit
      --render-menu-icons <d> write the menu bar icons to <d> as PNGs and exit
    """

    static func parse(_ args: [String]) -> Options {
        var o = Options()
        var i = 0
        func value() -> String? {
            guard i + 1 < args.count else { return nil }
            i += 1
            return args[i]
        }
        while i < args.count {
            switch args[i] {
            case "--synthetic": o.synthetic = true
            case "--echo-input": o.echoInput = true
            case "--no-ui": o.noUI = true
            case "--node": o.nodePath = value()
            case "--host": o.hostPath = value()
            case "--selftest": o.selftest = true
            case "--exit-with-host": o.exitWithHost = true
            case "--allow-system-changes": o.allowSystemChanges = true
            case "--render-menu-icons": o.renderMenuIcons = value()
            case "-h", "--help": o.help = true
            // Launch Services and debuggers sometimes add their own arguments; never fail because of them.
            default: o.ignored.append(args[i])
            }
            i += 1
        }
        return o
    }
}

/// Where things are, depending on whether we run from Perch.app or as a bare binary during development.
enum AppPaths {
    static let version = "0.1.0"

    /// True inside Perch.app (Launch Services, the login item, or Contents/MacOS/Perch run directly).
    static var isBundled: Bool {
        Bundle.main.bundleURL.pathExtension == "app" && Bundle.main.bundleIdentifier != nil
    }

    static var appVersion: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? version
    }

    static func nodePath(options: Options, environment: [String: String]) -> String? {
        var candidates: [String] = []
        if let p = options.nodePath { candidates.append(p) }
        if let p = environment["PERCH_NODE"], !p.isEmpty { candidates.append(p) }
        if isBundled { candidates.append(Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/node").path) }
        candidates += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        // An explicit choice that doesn't exist is a mistake worth reporting, not something to quietly replace.
        if let explicit = options.nodePath ?? environment["PERCH_NODE"].flatMap({ $0.isEmpty ? nil : $0 }) {
            return FileManager.default.isExecutableFile(atPath: explicit) ? explicit : nil
        }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    static func hostScript(options: Options) -> String? {
        let path = options.hostPath ?? Bundle.main.resourceURL?.appendingPathComponent("host/perch-host.mjs").path
        guard let path else { return nil }
        let absolute = URL(fileURLWithPath: path).standardizedFileURL.path
        return FileManager.default.fileExists(atPath: absolute) ? absolute : nil
    }
}
