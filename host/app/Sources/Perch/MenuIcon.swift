// The menu bar icon, drawn in code from the same shapes as site/img/icon.svg: a screen with a bird perched on top.
// It is a template image, so macOS tints it to match a light or dark menu bar. While a viewer is connected the
// screen is drawn "on" (filled), so a glance at the menu bar shows someone is watching.
import AppKit

enum MenuIcon {
    enum Style { case idle, connected }

    static let size = NSSize(width: 18, height: 18)

    static func image(_ style: Style) -> NSImage {
        let img = NSImage(size: size, flipped: true) { rect in
            draw(style, in: rect)
            return true
        }
        img.isTemplate = true
        img.accessibilityDescription = style == .connected ? "Perch, viewer connected" : "Perch"
        return img
    }

    /// Draws in the SVG's 64-unit coordinates. The artwork spans x 9–55, y 10–54 there; fit that to the rect.
    private static func draw(_ style: Style, in rect: NSRect) {
        let scale = min(rect.width / 46, rect.height / 44)
        let t = NSAffineTransform()
        t.translateX(by: rect.midX - 32 * scale, yBy: rect.midY - 32.2 * scale)
        t.scale(by: scale)
        t.concat()
        NSColor.black.set()

        // The screen.
        let screen = NSBezierPath(roundedRect: NSRect(x: 11, y: 25, width: 42, height: 27), xRadius: 4.5, yRadius: 4.5)
        screen.lineWidth = 4
        screen.stroke()
        // Its chin.
        let chin = NSBezierPath()
        chin.move(to: NSPoint(x: 25, y: 52))
        chin.line(to: NSPoint(x: 39, y: 52))
        chin.lineWidth = 4
        chin.lineCapStyle = .round
        chin.stroke()
        if style == .connected {
            // The screen lit up, leaving a gap inside the frame so the outline still reads at 16 px.
            NSBezierPath(roundedRect: NSRect(x: 16, y: 30, width: 32, height: 17), xRadius: 1.5, yRadius: 1.5).fill()
        }

        // The bird: tail, body, head, beak.
        let tail = NSBezierPath()
        tail.move(to: NSPoint(x: 31.5, y: 18.5)); tail.line(to: NSPoint(x: 25, y: 15.5)); tail.line(to: NSPoint(x: 27.6, y: 21.9))
        tail.close(); tail.fill()
        NSBezierPath(ovalIn: NSRect(x: 38.5 - 7.6, y: 19.6 - 5.6, width: 15.2, height: 11.2)).fill()
        NSBezierPath(ovalIn: NSRect(x: 44.2 - 4.3, y: 14.6 - 4.3, width: 8.6, height: 8.6)).fill()
        let beak = NSBezierPath()
        beak.move(to: NSPoint(x: 47.8, y: 13.2)); beak.line(to: NSPoint(x: 52, y: 14.6)); beak.line(to: NSPoint(x: 47.8, y: 16))
        beak.close(); beak.fill()
        // The eye is a hole.
        NSGraphicsContext.current?.compositingOperation = .destinationOut
        NSBezierPath(ovalIn: NSRect(x: 45.2 - 1.3, y: 13.9 - 1.3, width: 2.6, height: 2.6)).fill()
        NSGraphicsContext.current?.compositingOperation = .sourceOver
    }

    /// Writes each style at 1x, 2x and 4x, dark on light and light on dark the way macOS tints it, for review.
    static func render(to dir: String) throws {
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        for (style, name) in [(Style.idle, "idle"), (.connected, "connected")] {
            for scale in [1, 2, 4] {
                for (bg, fg, tone) in [(NSColor.white, NSColor.black, "light"), (NSColor(white: 0.15, alpha: 1), NSColor.white, "dark")] {
                    let px = Int(size.width) * scale
                    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px + 8 * scale, pixelsHigh: px + 4 * scale,
                                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { continue }
                    rep.size = NSSize(width: size.width + 8, height: size.height + 4)
                    NSGraphicsContext.saveGraphicsState()
                    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
                    bg.setFill()
                    NSRect(origin: .zero, size: rep.size).fill()
                    // Tint the template the way the menu bar does: fill with the colour, masked by the icon.
                    let tinted = NSImage(size: size, flipped: false) { r in
                        image(style).draw(in: r)
                        fg.set()
                        r.fill(using: .sourceAtop)
                        return true
                    }
                    tinted.draw(in: NSRect(x: 4, y: 2, width: size.width, height: size.height))
                    NSGraphicsContext.restoreGraphicsState()
                    let path = (dir as NSString).appendingPathComponent("menu-\(name)-\(tone)@\(scale)x.png")
                    try rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
                }
            }
        }
    }
}
