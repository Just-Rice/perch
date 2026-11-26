// `Perch --curtain-check`: proves on this Mac that a curtain window is left out of what a viewer is sent. Shows a
// small magenta square in the corner of the main display for about a second and takes screenshots through
// ScreenCaptureKit with and without the exclusion the capture uses. Needs Screen Recording permission.
import AppKit
import CoreMedia
import ScreenCaptureKit
import VideoToolbox

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
                    let plain = try await screenshot(
                        contentFilter: SCContentFilter(display: display, excludingApplications: [], exceptingWindows: []), configuration: cfg)
                    let visible = isMagenta(plain, x: 160, y: 120)
                    var hidden = true
                    if mine.isEmpty {
                        print("     (\(name): ScreenCaptureKit doesn't list the window at all)")
                    } else {
                        let filtered = try await screenshot(
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

    /// One picture through ScreenCaptureKit. macOS 14 has SCScreenshotManager; macOS 13 takes the first complete
    /// frame of a short stream instead.
    private static func screenshot(contentFilter: SCContentFilter, configuration: SCStreamConfiguration) async throws -> CGImage {
        if #available(macOS 14.0, *) {
            return try await SCScreenshotManager.captureImage(contentFilter: contentFilter, configuration: configuration)
        }
        return try await OneFrame.capture(contentFilter, configuration)
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

/// The first complete frame of a stream, as a CGImage (the macOS 13 stand-in for SCScreenshotManager).
/// Sendable by hand: its only state, the continuation, is behind the lock.
private final class OneFrame: NSObject, SCStreamOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<CGImage, Error>?

    static func capture(_ filter: SCContentFilter, _ cfg: SCStreamConfiguration) async throws -> CGImage {
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        let grabber = OneFrame()
        let stream = SCStream(filter: filter, configuration: cfg, delegate: nil)
        try stream.addStreamOutput(grabber, type: .screen, sampleHandlerQueue: DispatchQueue(label: "perch.curtain-check"))
        do {
            let image: CGImage = try await withCheckedThrowingContinuation { c in
                grabber.lock.withLock { grabber.continuation = c }
                stream.startCapture { error in if let error { grabber.finish(.failure(error)) } }
                DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
                    grabber.finish(.failure(NSError(domain: "Perch", code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "no frame from ScreenCaptureKit within 5 seconds"])))
                }
            }
            try? await stream.stopCapture()
            return image
        } catch {
            try? await stream.stopCapture()
            throw error
        }
    }

    private func finish(_ result: Result<CGImage, Error>) {
        let c: CheckedContinuation<CGImage, Error>? = lock.withLock {
            defer { continuation = nil }
            return continuation
        }
        c?.resume(with: result)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, Self.isComplete(sb), let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        var image: CGImage?
        VTCreateCGImageFromCVPixelBuffer(pb, options: nil, imageOut: &image)
        if let image { finish(.success(image)) }
    }

    /// Idle and blank buffers carry no picture.
    private static func isComplete(_ sb: CMSampleBuffer) -> Bool {
        guard let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = arr.first?[.status] as? Int else { return false }
        return SCFrameStatus(rawValue: raw) == .complete
    }
}
