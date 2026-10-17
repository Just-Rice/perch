// Perch.app's entry point. A menu bar ("accessory") app: no Dock icon, no main window.
import AppKit
import PerchCore

let options = Options.parse(Array(CommandLine.arguments.dropFirst()))

if options.help {
    print(Options.usage)
    exit(0)
}
if options.selftest {
    exit(SelfTest.run())
}
if let dir = options.renderMenuIcons {
    do {
        try MenuIcon.render(to: dir)
        print("menu bar icons written to \(dir)")
        exit(0)
    } catch {
        print("could not write the icons: \(error)")
        exit(1)
    }
}

if options.unregisterLoginItem {
    // Only Perch.app itself can be a login item, so this does something only when run from inside the bundle.
    let e = LoginItem.set(false, allowed: true, bundled: Bundle.main.bundlePath.hasSuffix(".app"))
    print("login item: \(e["status"] ?? "unknown")\(e["error"].map { " (\($0))" } ?? "")")
    exit(e["error"] == nil ? 0 : 1)
}

Log.shared.open(path: Log.defaultPath())
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = AppController(options: options)
app.delegate = controller
app.run()
