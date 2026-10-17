// Turns the viewer's input messages (docs/PROTOCOL.md, "Input and pointer channels") into the Quartz events to post.
//
// Planning is kept apart from posting so the same plan can be posted for real (InputPoster), reported back in
// --echo-input mode, or checked by the self-test, and so that what the tests verify is exactly what would be posted.
// The planner remembers which keys and buttons are held, so a viewer that disappears mid-drag or mid-shortcut can
// have everything released ("rel", a session ending, the host restarting).
import Foundation
import CoreGraphics

public enum MouseButton: Int {
    case left = 0, middle = 1, right = 2
}

/// CGEventFlags bits, as plain numbers so plans stay simple values.
public enum EventFlags {
    public static let capsLock: UInt64 = 0x0001_0000
    public static let shift: UInt64 = 0x0002_0000
    public static let control: UInt64 = 0x0004_0000
    public static let option: UInt64 = 0x0008_0000
    public static let command: UInt64 = 0x0010_0000
    public static let numericPad: UInt64 = 0x0020_0000
    public static let help: UInt64 = 0x0040_0000
    public static let secondaryFn: UInt64 = 0x0080_0000
    /// Every bit the planner decides; anything else CoreGraphics puts in an event's flags is left alone.
    public static let managed: UInt64 = 0x00FF_0000 | 0x2000 | 0x7F

    /// The protocol's modifier bitmask (1 shift, 2 ctrl, 4 alt, 8 meta) as event flags.
    public static func from(bitmask m: Int) -> UInt64 {
        var f: UInt64 = 0
        if m & 1 != 0 { f |= shift }
        if m & 2 != 0 { f |= control }
        if m & 4 != 0 { f |= option }
        if m & 8 != 0 { f |= command }
        return f
    }
}

public struct PlannedEvent: Equatable {
    public enum Kind: Equatable {
        case move(drag: MouseButton?)
        case down(MouseButton)
        case up(MouseButton)
        /// CGEvent wheel deltas in pixels: wheel1 vertical, wheel2 horizontal (positive = content moves down/right).
        case scroll(wheel1: Int32, wheel2: Int32)
        case keyDown(UInt16, autorepeat: Bool)
        case keyUp(UInt16)
        /// A modifier key changing; `down` is whether it is now held.
        case flagsChanged(UInt16, down: Bool)
        /// Text typed as Unicode, at most 20 UTF-16 units (the most one keyboard event can carry).
        case text(String)
    }

    public var kind: Kind
    /// Global display coordinates in points (top-left origin), for mouse and scroll events.
    public var point: CGPoint
    public var clickState: Int
    public var flags: UInt64

    public init(_ kind: Kind, point: CGPoint = .zero, clickState: Int = 0, flags: UInt64 = 0) {
        self.kind = kind; self.point = point; self.clickState = clickState; self.flags = flags
    }

    /// How --echo-input reports the event, so tests can check exactly what would have been posted.
    public var json: [String: Any] {
        let x = (Double(point.x) * 100).rounded() / 100, y = (Double(point.y) * 100).rounded() / 100
        switch kind {
        case .move(let drag):
            return ["type": drag.map { "\(Self.name($0))MouseDragged" } ?? "mouseMoved", "x": x, "y": y, "flags": flags]
        case .down(let b):
            return ["type": "\(Self.name(b))MouseDown", "button": b.rawValue, "x": x, "y": y, "click": clickState, "flags": flags]
        case .up(let b):
            return ["type": "\(Self.name(b))MouseUp", "button": b.rawValue, "x": x, "y": y, "click": clickState, "flags": flags]
        case .scroll(let w1, let w2):
            return ["type": "scrollWheel", "wheel1": Int(w1), "wheel2": Int(w2), "x": x, "y": y, "flags": flags]
        case .keyDown(let k, let rep):
            return ["type": "keyDown", "keyCode": Int(k), "repeat": rep, "flags": flags]
        case .keyUp(let k):
            return ["type": "keyUp", "keyCode": Int(k), "flags": flags]
        case .flagsChanged(let k, let down):
            return ["type": "flagsChanged", "keyCode": Int(k), "down": down, "flags": flags]
        case .text(let s):
            return ["type": "text", "s": s]
        }
    }

    // Quartz names: the middle button is one of the "other" buttons.
    private static func name(_ b: MouseButton) -> String {
        switch b { case .left: return "left"; case .right: return "right"; case .middle: return "other" }
    }
}

public final class InputPlanner {
    /// Global bounds (points) of the display the viewer sees; normalized coordinates map onto it.
    public var bounds: CGRect
    public private(set) var heldButtons: [MouseButton] = []
    public private(set) var heldKeys: Set<UInt16> = []
    /// Shift/Control/Option/Command as the viewer last reported them.
    private var modifierFlags: UInt64 = 0
    private var cursor: CGPoint?
    /// Fractions of a pixel left over from earlier scrolls (phones and trackpads send fractional deltas).
    private var scrollRemainder = (x: 0.0, y: 0.0)

    public static let maxText = 256
    public static let maxClicks = 10

    public init(bounds: CGRect) { self.bounds = bounds }

    public var isHoldingAnything: Bool { !heldButtons.isEmpty || !heldKeys.isEmpty }

    public func plan(_ msg: [String: Any]) -> [PlannedEvent] {
        guard let t = JSONValue.string(msg["t"]) else { return [] }
        switch t {
        case "m": return planMove(msg)
        case "b": return planButton(msg)
        case "w": return planScroll(msg)
        case "k": return planKey(msg)
        case "txt": return planText(msg)
        case "rel": return releaseAll()
        default: return []
        }
    }

    /// Lets go of every held button and key: buttons first (ending any drag where it is), then ordinary keys,
    /// then modifiers.
    public func releaseAll() -> [PlannedEvent] {
        var out: [PlannedEvent] = []
        let p = cursor ?? CGPoint(x: bounds.midX, y: bounds.midY)
        for b in heldButtons.reversed() {
            out.append(PlannedEvent(.up(b), point: p, clickState: 1, flags: currentFlags))
        }
        heldButtons = []
        for k in heldKeys.sorted() where KeyMap.modifier(for: k) == nil {
            heldKeys.remove(k)
            out.append(PlannedEvent(.keyUp(k), flags: currentFlags | Self.extraFlags(k)))
        }
        for k in heldKeys.sorted() {
            heldKeys.remove(k)
            modifierFlags = flagsFromHeldModifiers()
            out.append(PlannedEvent(.flagsChanged(k, down: false), flags: currentFlags))
        }
        modifierFlags = 0
        return out
    }

    // MARK: pointer

    private func point(_ msg: [String: Any]) -> CGPoint? {
        guard let x = JSONValue.number(msg["x"]), let y = JSONValue.number(msg["y"]),
              bounds.width > 0, bounds.height > 0 else { return nil }
        let nx = min(max(x, 0), 1), ny = min(max(y, 0), 1)
        // Stay one point inside the right/bottom edge: that coordinate already belongs to the next display.
        let px = min(bounds.minX + nx * bounds.width, bounds.maxX - 1)
        let py = min(bounds.minY + ny * bounds.height, bounds.maxY - 1)
        return CGPoint(x: px, y: py)
    }

    /// The button a move counts as dragging with, following Quartz's priority when several are held.
    private var dragButton: MouseButton? {
        if heldButtons.contains(.left) { return .left }
        if heldButtons.contains(.right) { return .right }
        return heldButtons.first
    }

    private func planMove(_ msg: [String: Any]) -> [PlannedEvent] {
        guard let p = point(msg) else { return [] }
        cursor = p
        return [PlannedEvent(.move(drag: dragButton), point: p, flags: currentFlags)]
    }

    /// Buttons and scrolls carry their own position; if the pointer isn't there yet (a lost or late move), move it
    /// first so hover state and the click target are right.
    private func moveIfNeeded(to p: CGPoint, into out: inout [PlannedEvent]) {
        if cursor != p {
            cursor = p
            out.append(PlannedEvent(.move(drag: dragButton), point: p, flags: currentFlags))
        }
    }

    private func planButton(_ msg: [String: Any]) -> [PlannedEvent] {
        guard let p = point(msg), let raw = JSONValue.int(msg["b"]), let b = MouseButton(rawValue: raw),
              let down = JSONValue.bool(msg["d"]) else { return [] }
        var out: [PlannedEvent] = []
        moveIfNeeded(to: p, into: &out)
        let clicks = min(max(JSONValue.int(msg["n"]) ?? 1, 1), Self.maxClicks)
        if down {
            if !heldButtons.contains(b) { heldButtons.append(b) }
            out.append(PlannedEvent(.down(b), point: p, clickState: clicks, flags: currentFlags))
        } else {
            heldButtons.removeAll { $0 == b }
            out.append(PlannedEvent(.up(b), point: p, clickState: clicks, flags: currentFlags))
        }
        return out
    }

    private func planScroll(_ msg: [String: Any]) -> [PlannedEvent] {
        guard let p = point(msg) else { return [] }
        let dx = JSONValue.number(msg["dx"]) ?? 0, dy = JSONValue.number(msg["dy"]) ?? 0
        var out: [PlannedEvent] = []
        moveIfNeeded(to: p, into: &out)
        // DOM: positive dy means the page moves up (the user scrolls down). Quartz: positive wheel1 means content
        // moves down. Browsers on a Mac compute deltaY = -wheel delta, so negating gives the same scroll a browser
        // window would have done with these deltas.
        let limit = 10_000.0
        let ty = scrollRemainder.y - min(max(dy, -limit), limit)
        let tx = scrollRemainder.x - min(max(dx, -limit), limit)
        let w1 = ty.rounded(.towardZero), w2 = tx.rounded(.towardZero)
        scrollRemainder = (x: tx - w2, y: ty - w1)
        if w1 != 0 || w2 != 0 {
            out.append(PlannedEvent(.scroll(wheel1: Int32(w1), wheel2: Int32(w2)), point: p, flags: currentFlags))
        }
        return out
    }

    // MARK: keyboard

    private func planKey(_ msg: [String: Any]) -> [PlannedEvent] {
        guard let code = JSONValue.string(msg["c"]), let down = JSONValue.bool(msg["d"]) else { return [] }
        modifierFlags = EventFlags.from(bitmask: JSONValue.int(msg["m"]) ?? 0)
        guard let k = KeyMap.keyCode(for: code) else {
            // A key with no US position (some layouts' extra keys, or a code the browser left empty): type the
            // character it produced instead.
            if down, let key = JSONValue.string(msg["k"]), key.count == 1,
               !key.unicodeScalars.contains(where: { $0.properties.generalCategory == .control }) {
                return [PlannedEvent(.text(key))]
            }
            return []
        }
        if let mod = KeyMap.modifier(for: k) {
            // Caps Lock toggles rather than being held, so it is never "released" by rel.
            if mod != .capsLock { if down { heldKeys.insert(k) } else { heldKeys.remove(k) } }
            var f = currentFlags
            if mod == .function && down { f |= EventFlags.secondaryFn }
            return [PlannedEvent(.flagsChanged(k, down: down), flags: f)]
        }
        let flags = currentFlags | Self.extraFlags(k)
        if down {
            let repeated = heldKeys.contains(k)
            heldKeys.insert(k)
            return [PlannedEvent(.keyDown(k, autorepeat: repeated), flags: flags)]
        }
        heldKeys.remove(k)
        return [PlannedEvent(.keyUp(k), flags: flags)]
    }

    private func planText(_ msg: [String: Any]) -> [PlannedEvent] {
        guard let s = JSONValue.string(msg["s"]), !s.isEmpty else { return [] }
        return Self.textChunks(String(s.prefix(Self.maxText))).map { PlannedEvent(.text($0)) }
    }

    /// Splits text into pieces of at most `maxUnits` UTF-16 units without breaking a character (an emoji with skin
    /// tone, a flag) across two events.
    public static func textChunks(_ s: String, maxUnits: Int = 20) -> [String] {
        var chunks: [String] = []
        var current = "", units = 0
        func flush() { if !current.isEmpty { chunks.append(current); current = ""; units = 0 } }
        for ch in s {
            let n = ch.utf16.count
            if n > maxUnits {
                // One enormous character (long emoji sequences): split it between scalars, the best we can do.
                flush()
                for scalar in ch.unicodeScalars {
                    let su = String(scalar).utf16.count
                    if units + su > maxUnits { flush() }
                    current.unicodeScalars.append(scalar); units += su
                }
                flush()
                continue
            }
            if units + n > maxUnits { flush() }
            current.append(ch); units += n
        }
        flush()
        return chunks
    }

    private var currentFlags: UInt64 {
        var f = modifierFlags
        for k in heldKeys { f |= KeyMap.deviceFlag(for: k) }
        return f
    }

    private func flagsFromHeldModifiers() -> UInt64 {
        var f: UInt64 = 0
        for k in heldKeys {
            switch KeyMap.modifier(for: k) {
            case .shift: f |= EventFlags.shift
            case .control: f |= EventFlags.control
            case .option: f |= EventFlags.option
            case .command: f |= EventFlags.command
            default: break
            }
        }
        return f
    }

    private static func extraFlags(_ k: UInt16) -> UInt64 {
        (KeyMap.isKeypad(k) ? EventFlags.numericPad : 0) | (KeyMap.isFunctionLayer(k) ? EventFlags.secondaryFn : 0)
    }
}

/// Builds and posts the Quartz events for a plan. Only created when the app really performs input; --echo-input
/// never makes one, so tests can't post anything to the Mac they run on.
public final class InputPoster {
    private let source: CGEventSource?

    public init() {
        source = CGEventSource(stateID: .hidSystemState)
        // By default, posting suppresses the Mac's own mouse and keyboard for a quarter second; someone sitting at
        // the Mac should never feel the remote viewer fighting them for the pointer.
        source?.localEventsSuppressionInterval = 0
    }

    public func post(_ plan: [PlannedEvent]) {
        for e in plan { for ev in events(for: e) { ev.post(tap: .cghidEventTap) } }
    }

    /// The CGEvents for one planned event (two for text: key down and up). Creating them posts nothing.
    public func events(for e: PlannedEvent) -> [CGEvent] {
        func apply(_ ev: CGEvent, _ flags: UInt64) -> CGEvent {
            ev.flags = CGEventFlags(rawValue: (ev.flags.rawValue & ~EventFlags.managed) | flags)
            return ev
        }
        switch e.kind {
        case .move(let drag):
            let type: CGEventType
            switch drag {
            case nil: type = .mouseMoved
            case .left?: type = .leftMouseDragged
            case .right?: type = .rightMouseDragged
            case .middle?: type = .otherMouseDragged
            }
            guard let ev = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: e.point,
                                   mouseButton: Self.cgButton(drag ?? .left)) else { return [] }
            return [apply(ev, e.flags)]
        case .down(let b), .up(let b):
            let isDown: Bool
            if case .down = e.kind { isDown = true } else { isDown = false }
            let type: CGEventType
            switch b {
            case .left: type = isDown ? .leftMouseDown : .leftMouseUp
            case .right: type = isDown ? .rightMouseDown : .rightMouseUp
            case .middle: type = isDown ? .otherMouseDown : .otherMouseUp
            }
            guard let ev = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: e.point,
                                   mouseButton: Self.cgButton(b)) else { return [] }
            ev.setIntegerValueField(.mouseEventClickState, value: Int64(e.clickState))
            return [apply(ev, e.flags)]
        case .scroll(let w1, let w2):
            guard let ev = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                                   wheel1: w1, wheel2: w2, wheel3: 0) else { return [] }
            ev.location = e.point
            return [apply(ev, e.flags)]
        case .keyDown(let k, let rep):
            guard let ev = CGEvent(keyboardEventSource: source, virtualKey: k, keyDown: true) else { return [] }
            if rep { ev.setIntegerValueField(.keyboardEventAutorepeat, value: 1) }
            return [apply(ev, e.flags)]
        case .keyUp(let k):
            guard let ev = CGEvent(keyboardEventSource: source, virtualKey: k, keyDown: false) else { return [] }
            return [apply(ev, e.flags)]
        case .flagsChanged(let k, let down):
            // CoreGraphics makes a flagsChanged event for a modifier's virtual key code.
            guard let ev = CGEvent(keyboardEventSource: source, virtualKey: k, keyDown: down) else { return [] }
            ev.type = .flagsChanged
            return [apply(ev, e.flags)]
        case .text(let s):
            // Typed text carries no modifiers: a held Command must not turn pasted words into shortcuts.
            let units = Array(s.utf16)
            var out: [CGEvent] = []
            for down in [true, false] {
                guard let ev = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
                ev.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                out.append(apply(ev, 0))
            }
            return out
        }
    }

    private static func cgButton(_ b: MouseButton) -> CGMouseButton {
        switch b { case .left: return .left; case .right: return .right; case .middle: return .center }
    }
}
