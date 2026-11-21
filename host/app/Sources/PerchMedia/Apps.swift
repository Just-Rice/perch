// App mode's parts that don't move anything: which apps a viewer may open (the Applications folders), their icons,
// and the stage, the part of a display shaped like the viewer's screen that the app is shown on.
// docs/PROTOCOL.md, "app mode".
import Foundation
import AppKit
import CoreGraphics
import PerchCore

public struct AppEntry: Equatable {
    /// The bundle identifier.
    public let id: String
    public let name: String
    public let url: URL

    public func json(running: Bool) -> [String: Any] { ["id": id, "name": name, "running": running] }
}

public enum AppCatalog {
    /// --synthetic has two pretend apps: Test Notes owns the pretend window (Windows.synthetic), Test Draw has none.
    public static let testNotes = "io.github.just-rice.perch.test-notes"
    public static let testDraw = "io.github.just-rice.perch.test-draw"
    static let synthetic = [
        AppEntry(id: testDraw, name: "Test Draw", url: URL(fileURLWithPath: "/Applications/Test Draw.app")),
        AppEntry(id: testNotes, name: "Test Notes", url: URL(fileURLWithPath: "/Applications/Test Notes.app")),
    ]
    public static let maxListed = 400

    private static let lock = NSLock()
    private static var cached: (at: Date, list: [AppEntry])?

    /// The folders apps are listed from, and one folder down in each (apps that come in a folder of their own).
    static var folders: [URL] {
        var out = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities"]
            .map { URL(fileURLWithPath: $0, isDirectory: true) }
        out.append(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications", isDirectory: true))
        // Test runs may add a folder of test apps of their own (never anything a real Perch lists).
        let env = ProcessInfo.processInfo.environment
        if env["PERCH_TEST"] == "1", let extra = env["PERCH_TEST_APPS"], !extra.isEmpty {
            out.append(URL(fileURLWithPath: extra, isDirectory: true))
        }
        return out
    }

    /// The apps a viewer may open, sorted by name. Kept for half a minute (reading a few hundred bundles takes a
    /// moment). Any thread.
    public static func list(synthetic: Bool) -> [AppEntry] {
        if synthetic { return Self.synthetic }
        if let c = lock.withLock({ cached }), Date().timeIntervalSince(c.at) < 30 { return c.list }
        var seen = Set<String>(), out: [AppEntry] = []
        let me = Bundle.main.bundleIdentifier
        func add(_ url: URL) {
            guard out.count < maxListed, let entry = entry(at: url), entry.id != me, seen.insert(entry.id).inserted else { return }
            out.append(entry)
        }
        let fm = FileManager.default
        for folder in folders {
            guard let items = try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.isDirectoryKey],
                                                          options: [.skipsHiddenFiles]) else { continue }
            for item in items {
                if item.pathExtension == "app" { add(item); continue }
                // One folder down ("/Applications/Some Suite/Some App.app"), but not into the Utilities folders,
                // which are listed themselves.
                guard (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true,
                      item.lastPathComponent != "Utilities",
                      let inner = try? fm.contentsOfDirectory(at: item, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
                else { continue }
                for app in inner where app.pathExtension == "app" { add(app) }
            }
        }
        add(URL(fileURLWithPath: "/System/Library/CoreServices/Finder.app"))
        out.sort { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        lock.withLock { cached = (Date(), out) }
        return out
    }

    /// An app with windows of its own, or nil (no bundle id, a menu bar extra, a background helper).
    static func entry(at url: URL) -> AppEntry? {
        guard let b = Bundle(url: url), let id = b.bundleIdentifier, AppTarget.validID(id) else { return nil }
        let info = b.infoDictionary ?? [:]
        if flag(info["LSUIElement"]) || flag(info["LSBackgroundOnly"]) { return nil }
        var name = FileManager.default.displayName(atPath: url.path)
        if name.hasSuffix(".app") { name = String(name.dropLast(4)) }
        if name.isEmpty { name = (info["CFBundleName"] as? String) ?? id }
        return AppEntry(id: id, name: String(name.prefix(80)), url: url)
    }

    private static func flag(_ v: Any?) -> Bool {
        if let b = v as? Bool { return b }
        if let s = v as? String { return s == "1" || s.lowercased() == "yes" || s.lowercased() == "true" }
        if let n = v as? NSNumber { return n.boolValue }
        return false
    }

    public static func find(_ id: String, synthetic: Bool) -> AppEntry? {
        list(synthetic: synthetic).first { $0.id == id }
    }

    /// Which of these apps are running now (with windows of their own: a regular app).
    public static func running(synthetic: Bool) -> Set<String> {
        if synthetic { return [testNotes] }
        return Set(NSWorkspace.shared.runningApplications.compactMap {
            $0.activationPolicy == .regular ? $0.bundleIdentifier : nil
        })
    }

    // MARK: icons

    /// The protocol's limit on one icon, in base64 characters.
    public static let maxIconChars = 48_000

    /// The app's icon: `size` 96 as it is (PNG, transparent around it), 180 filling a white square with its margin
    /// cut off (JPEG), as a phone's home screen wants it. Returns (mime, base64). Any thread.
    public static func icon(_ app: AppEntry, size: Int, synthetic: Bool) -> (mime: String, data: String)? {
        let tile = size >= 160
        let image: NSImage = synthetic ? testIcon(app) : NSWorkspace.shared.icon(forFile: app.url.path)
        for px in tile ? [180] : [96, 72, 48] {
            guard let data = render(image, px: px, tile: tile) else { return nil }
            let b64 = data.base64EncodedString()
            if b64.count <= maxIconChars { return (tile ? "image/jpeg" : "image/png", b64) }
        }
        return nil
    }

    static func render(_ image: NSImage, px: Int, tile: Bool) -> Data? {
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0),
              let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        ctx.imageInterpolation = .high
        let s = CGFloat(px)
        if tile {
            NSColor.white.setFill()
            CGRect(x: 0, y: 0, width: s, height: s).fill()
            // A Mac icon is drawn on a 1024-point grid with the shape itself 824 across: enlarge it so the shape
            // fills the square, and the phone rounds the corners itself.
            let k = s * 1024 / 824
            image.draw(in: CGRect(x: (s - k) / 2, y: (s - k) / 2, width: k, height: k), from: .zero, operation: .sourceOver, fraction: 1)
        } else {
            image.draw(in: CGRect(x: 0, y: 0, width: s, height: s), from: .zero, operation: .sourceOver, fraction: 1)
        }
        NSGraphicsContext.restoreGraphicsState()
        return tile ? rep.representation(using: .jpeg, properties: [.compressionFactor: 0.86])
            : rep.representation(using: .png, properties: [:])
    }

    /// A plain coloured square with the app's first letter: the pretend apps' icons.
    static func testIcon(_ app: AppEntry) -> NSImage {
        NSImage(size: NSSize(width: 256, height: 256), flipped: false) { _ in
            (app.id == testNotes ? NSColor.systemYellow : NSColor.systemTeal).setFill()
            NSBezierPath(roundedRect: NSRect(x: 25, y: 25, width: 206, height: 206), xRadius: 46, yRadius: 46).fill()
            let letter = NSAttributedString(string: String(app.name.dropFirst(5).prefix(1)),
                                            attributes: [.font: NSFont.boldSystemFont(ofSize: 120), .foregroundColor: NSColor.black])
            let sz = letter.size()
            letter.draw(at: NSPoint(x: (256 - sz.width) / 2, y: (256 - sz.height) / 2))
            return true
        }
    }
}

/// The stage: where on a display app mode shows the app. Plain geometry, in global points (top-left origin).
public struct AppStage: Equatable {
    /// The display it is on.
    public let display: CGRect
    /// What the picture shows: from the top of the display (its menu bar) down, at the left of the space windows can
    /// use, of the viewer's shape.
    public let region: CGRect
    /// Where an ordinary window of the app goes: the picture below the menu bar.
    public let window: CGRect

    /// A window is never made narrower or shorter than this, even for a very narrow screen.
    static let minSide: CGFloat = 240

    /// `usable` is the part of the display windows can use (no menu bar, no Dock), `aspect` width ÷ height.
    public static func plan(display: CGRect, usable: CGRect, aspect: Double) -> AppStage {
        let a = CGFloat(AppTarget.clampAspect(aspect))
        let u = usable.intersection(display).isNull ? display : usable.intersection(display)
        let top = display.minY, strip = u.minY - top
        let availW = u.width, availH = u.maxY - top
        var w = availW, h = w / a
        if h > availH { h = availH; w = h * a }
        w = max(min(w, availW), min(minSide, availW)).rounded(.down)
        h = max(min(h, availH), min(minSide + strip, availH)).rounded(.down)
        let region = CGRect(x: u.minX, y: top, width: w, height: h)
        let window = CGRect(x: u.minX, y: u.minY, width: w, height: max(h - strip, 1))
        return AppStage(display: display, region: region, window: window)
    }

    /// Where a window that isn't an ordinary one (a dialog, a panel) of this size goes: the middle of the stage, made
    /// smaller if it doesn't fit.
    public func place(dialog size: CGSize) -> CGRect {
        let w = min(size.width, window.width), h = min(size.height, window.height)
        return CGRect(x: (window.midX - w / 2).rounded(.down), y: (window.midY - h / 2).rounded(.down), width: w, height: h)
    }

    /// The picture for this stage when the front window turned out bigger than the stage (an app with a smallest
    /// size): the stage grown to take in the whole window and the menu bar above it, kept on the display.
    public func picture(front: CGRect?) -> CGRect {
        guard let f = front, f.width > window.width + 1 || f.height > window.height + 1 else { return region }
        let grown = region.union(CGRect(x: f.minX, y: display.minY, width: f.width, height: f.maxY - display.minY))
        let r = grown.intersection(display).integral.intersection(display)
        return r.isNull || r.width < 32 || r.height < 32 ? region : r
    }

    /// In the display's own points, as capture wants it.
    public static func local(_ r: CGRect, on display: CGRect) -> CGRect { r.offsetBy(dx: -display.minX, dy: -display.minY) }
}
