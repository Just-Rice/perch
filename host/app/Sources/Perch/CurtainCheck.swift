// `Perch --curtain-check`: proves on this Mac that a curtain window is left out of what a viewer is sent. Shows a
// small magenta square in the corner of the main display for about a second and takes screenshots through
// ScreenCaptureKit with and without the exclusion the capture uses. Needs Screen Recording permission.
import AppKit
import ScreenCaptureKit

enum CurtainCheck {
    static func run() -> Int32 {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        guard let screen = NSScreen.main else { print("FAIL no screen"); return 1 }
        let frame = NSRect(x: screen.frame.minX + 40, y: screen.frame.maxY - 40 - 160, width: 240, height: 160)
        let magenta = NSColor(srgbRed: 1, green: 0, blue: 1, alpha: 1)
        var failures = 0
        var finished = false
        Task {
            defer { finished = true }
            for (name, sharing) in [("as the curtain is made (not shared)", NSWindow.SharingType.none), ("shared normally", .readOnly)] {
                let w = await MainActor.run { () -> NSWindow in
                    let w = Curtain.makeWindow(frame: frame, message: false, color: magenta)
                    w.sharingType = sharing
                    w.orderFrontRegardless()
                    return w
                }
                defer { DispatchQueue.main.async { w.orderOut(nil) } }
                do {
                    try await Task.sleep(nanoseconds: 500_000_000)
                    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                    guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
                        print("FAIL the main display isn't listed"); failures += 1; continue
                    }
                    let number = await MainActor.run { CGWindowID(w.windowNumber) }
                    let mine = content.windows.filter { $0.windowID == number }
                    let cfg = SCStreamConfiguration()
                    cfg.width = display.width
                    cfg.height = display.height
                    cfg.showsCursor = false
                    let plain = try await SCScreenshotManager.captureImage(
                        contentFilter: SCContentFilter(display: display, excludingApplications: [], exceptingWindows: []), configuration: cfg)
                    let visible = isMagenta(plain, x: 160, y: 120)
                    var hidden = true
                    if mine.isEmpty {
                        print("     (\(name): ScreenCaptureKit doesn't list the window at all)")
                    } else {
                        let filtered = try await SCScreenshotManager.captureImage(
                            contentFilter: SCContentFilter(display: display, excludingWindows: mine), configuration: cfg)
                        hidden = !isMagenta(filtered, x: 160, y: 120)
                    }
                    print("\(hidden ? "PASS" : "FAIL") window \(name): in a plain capture \(visible ? "visible" : "hidden"), with the exclusion \(hidden ? "hidden" : "VISIBLE")")
                    if !hidden { failures += 1 }
                } catch {
                    print("FAIL \(name): \(error.localizedDescription)")
                    failures += 1
                }
            }
        }
        while !finished { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        print("lock call available: \(ScreenLock.available)")
        return failures == 0 ? 0 : 1
    }

    /// Is the pixel at (x, y) from the top-left, in points of a display-sized image, close to pure magenta?
    private static func isMagenta(_ image: CGImage, x: Int, y: Int) -> Bool {
        var px = [UInt8](repeating: 0, count: 4)
        guard let ctx = CGContext(data: &px, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        // Draw so that the wanted pixel lands on the 1x1 context (CoreGraphics' origin is bottom-left).
        ctx.draw(image, in: CGRect(x: -CGFloat(x), y: -CGFloat(image.height - 1 - y), width: CGFloat(image.width), height: CGFloat(image.height)))
        return px[0] > 200 && px[1] < 80 && px[2] > 200
    }
}
