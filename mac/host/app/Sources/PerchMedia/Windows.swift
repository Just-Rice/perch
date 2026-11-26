// The windows on screen, for "show one window": the list a viewer picks from, where a window is right now (the
// picture follows it as it moves), bringing it to the front, and reshaping it to fit the viewer's screen.
//
// The list and positions come from CoreGraphics (titles need Screen Recording permission, which a session has).
// Raising and reshaping go through Accessibility, which Perch holds anyway for clicks and keys. Accessibility has no
// public way to ask for a window by its number, so the window is matched by where it is and what it is called.
import Foundation
import CoreGraphics
import ApplicationServices
import AppKit

public struct WindowInfo: Equatable {
    public let id: UInt32
    public let pid: pid_t
    public let app: String
    public let title: String
    /// Global position and size in points (top-left origin), the space Quartz events use.
    public let bounds: CGRect

    /// As the protocol lists it: `{id, app, title, width, height}`, sizes in points.
    public var json: [String: Any] {
        ["id": Int(id), "app": app, "title": title, "width": Int(bounds.width), "height": Int(bounds.height)]
    }
}

public enum Windows {
    /// Smaller than this (either side, in points) isn't a window anyone wants to look at: tooltips, status items.
    static let minSide: CGFloat = 120
    public static let maxListed = 40
    /// A reshaped window is never made narrower or shorter than this.
    static let minFit: CGFloat = 320

    // --synthetic has one pretend window on its pretend display. Tests reshape it with `window-fit`.
    private static let lock = NSLock()
    private static var syntheticBounds = CGRect(x: 200, y: 100, width: 800, height: 600)
    static var synthetic: WindowInfo {
        WindowInfo(id: 7, pid: 0, app: "Test App", title: "Test Window", bounds: lock.withLock { syntheticBounds })
    }

    /// Ordinary windows on screen, front to back, without Perch's own.
    public static func list(synthetic: Bool) -> [WindowInfo] {
        if synthetic { return [Self.synthetic] }
        guard CGPreflightScreenCaptureAccess(),
              let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return [] }
        let me = getpid()
        var out: [WindowInfo] = []
        for w in raw {
            guard (w[kCGWindowLayer as String] as? Int) == 0, ((w[kCGWindowAlpha as String] as? Double) ?? 1) > 0,
                  let info = parse(w), info.pid != me,
                  info.bounds.width >= minSide, info.bounds.height >= minSide else { continue }
            out.append(info)
            if out.count == maxListed { break }
        }
        return out
    }

    /// Where this window is now, or nil once it is closed, minimised or on another desktop.
    public static func find(_ id: UInt32, synthetic: Bool) -> WindowInfo? {
        if synthetic { return id == Self.synthetic.id ? Self.synthetic : nil }
        guard let raw = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]], let w = raw.first,
              (w[kCGWindowIsOnscreen as String] as? Bool) == true else { return nil }
        return parse(w)
    }

    private static func parse(_ w: [String: Any]) -> WindowInfo? {
        guard let id = w[kCGWindowNumber as String] as? Int, id > 0,
              let pid = w[kCGWindowOwnerPID as String] as? Int,
              let b = w[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: b as CFDictionary) else { return nil }
        let app = (w[kCGWindowOwnerName as String] as? String) ?? ""
        let title = (w[kCGWindowName as String] as? String) ?? ""
        return WindowInfo(id: UInt32(id), pid: pid_t(pid), app: String(app.prefix(80)), title: String(title.prefix(160)), bounds: bounds)
    }

    /// The part of a window that is on a display, in that display's own points (top-left origin), on whole points.
    /// Nil when too little of it is there to show.
    public static func region(of bounds: CGRect, on display: CGRect) -> CGRect? {
        let r = bounds.intersection(display).integral.intersection(display)
        guard !r.isNull, r.width >= 32, r.height >= 32 else { return nil }
        return r.offsetBy(dx: -display.minX, dy: -display.minY)
    }

    /// The size for a window that should have the shape `aspect` (width ÷ height) and be as large as `area` allows.
    public static func fitSize(aspect: Double, in area: CGSize) -> CGSize {
        guard aspect.isFinite, aspect > 0, area.width > 0, area.height > 0 else { return area }
        let a = min(max(aspect, 0.25), 4)
        var w = area.width, h = area.width / a
        if h > area.height { h = area.height; w = h * a }
        return CGSize(width: max(min(w, area.width), min(minFit, area.width)).rounded(.down),
                      height: max(min(h, area.height), min(minFit, area.height)).rounded(.down))
    }

    // MARK: Accessibility

    private static func element(for w: WindowInfo) -> AXUIElement? {
        let app = AXUIElementCreateApplication(w.pid)
        // An app that isn't answering must not hang Perch.
        AXUIElementSetMessagingTimeout(app, 1.0)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
              let windows = value as? [AXUIElement] else { return nil }
        var byTitle: AXUIElement?
        for el in windows {
            if let f = frame(of: el), abs(f.minX - w.bounds.minX) <= 2, abs(f.minY - w.bounds.minY) <= 2,
               abs(f.width - w.bounds.width) <= 2, abs(f.height - w.bounds.height) <= 2 { return el }
            var t: CFTypeRef?
            if byTitle == nil, !w.title.isEmpty,
               AXUIElementCopyAttributeValue(el, kAXTitleAttribute as CFString, &t) == .success, (t as? String) == w.title {
                byTitle = el
            }
        }
        return byTitle
    }

    private static func frame(of el: AXUIElement) -> CGRect? {
        var p: CFTypeRef?, s: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &p) == .success,
              AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &s) == .success,
              let pv = p, let sv = s, CFGetTypeID(pv) == AXValueGetTypeID(), CFGetTypeID(sv) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(pv as! AXValue, .cgPoint, &point), AXValueGetValue(sv as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
    }

    /// Brings the window in front of everything else and makes its app the active one, so clicks and keys reach it.
    /// False when Accessibility couldn't find it (the app is then still made active).
    @discardableResult
    public static func raise(_ w: WindowInfo, synthetic: Bool) -> Bool {
        if synthetic { return true }
        guard AXIsProcessTrusted() else { return false }
        var raised = false
        if let el = element(for: w) { raised = AXUIElementPerformAction(el, kAXRaiseAction as CFString) == .success }
        NSRunningApplication(processIdentifier: w.pid)?.activate(options: [])
        return raised
    }

    /// Reshapes the window to `aspect` (width ÷ height), as large as fits in `area` (global points, top-left origin;
    /// the part of the display not taken by the menu bar and the Dock), and puts it at the top of that area. Apps
    /// decide their own smallest and largest sizes, so the result can differ; the picture follows whatever it becomes.
    @discardableResult
    public static func fit(_ w: WindowInfo, aspect: Double, in area: CGRect, synthetic: Bool) -> Bool {
        let size = fitSize(aspect: aspect, in: area.size)
        let origin = CGPoint(x: (area.minX + (area.width - size.width) / 2).rounded(.down), y: area.minY)
        if synthetic {
            lock.withLock { syntheticBounds = CGRect(origin: origin, size: size) }
            return true
        }
        guard AXIsProcessTrusted(), let el = element(for: w) else { return false }
        var p = origin, s = size
        guard let pv = AXValueCreate(.cgPoint, &p), let sv = AXValueCreate(.cgSize, &s) else { return false }
        // Position, size, position again: a window can't grow past the screen edge from where it was, and some apps
        // nudge the position when their size changes.
        AXUIElementSetAttributeValue(el, kAXPositionAttribute as CFString, pv)
        let ok = AXUIElementSetAttributeValue(el, kAXSizeAttribute as CFString, sv) == .success
        AXUIElementSetAttributeValue(el, kAXPositionAttribute as CFString, pv)
        return ok
    }

    /// The part of a display that windows can use (no menu bar, no Dock), in global points with a top-left origin.
    /// Main thread (AppKit).
    public static func usableArea(displayID: UInt32, synthetic: Bool) -> CGRect {
        if synthetic { return Displays.synthetic.bounds }
        let full = CGDisplayBounds(displayID)
        guard let primary = NSScreen.screens.first,
              let screen = NSScreen.screens.first(where: {
                  ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == displayID
              }) else { return full }
        // AppKit measures from the bottom-left of the primary screen; Quartz from its top-left.
        let v = screen.visibleFrame
        let r = CGRect(x: v.minX, y: primary.frame.height - v.maxY, width: v.width, height: v.height)
        return r.isEmpty ? full : r
    }
}
