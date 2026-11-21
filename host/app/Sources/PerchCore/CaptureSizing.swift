// What size to capture and encode at, and the sane ranges for the host's capture settings.
import Foundation
import CoreGraphics

public struct CaptureRequest: Equatable {
    public var displayID: UInt32?
    public var maxEdge: Int
    public var fps: Int
    public var kbps: Int
    public var audio: Bool
    /// Show only this window (the picture follows it) instead of the whole display.
    public var window: UInt32?
    /// H.264 Constrained High (every viewer's browser agreed to it) rather than Constrained Baseline.
    public var high: Bool = false
    /// The coarsest quantiser the encoder may use (detail first: it drops frames instead), or nil for no limit.
    public var maxQP: Int?
    /// App mode: this app, on a stage shaped like the viewer's screen (docs/PROTOCOL.md, "app mode").
    public var app: AppTarget?
    /// Show only this part of the display (its own points, top-left origin): app mode's stage. Not part of the
    /// command; the app fills it in.
    public var region: CGRect?

    public init(displayID: UInt32? = nil, maxEdge: Int = 1920, fps: Int = 30, kbps: Int = 5000, audio: Bool = true,
                window: UInt32? = nil) {
        self.displayID = displayID; self.maxEdge = maxEdge; self.fps = fps; self.kbps = kbps; self.audio = audio
        self.window = window
    }

    /// Reads a `capture` command, clamping each value into a range the encoder handles well.
    public init(command c: [String: Any]) {
        displayID = JSONValue.number(c["display"]).flatMap { $0 >= 0 && $0 <= Double(UInt32.max) ? UInt32($0) : nil }
        maxEdge = CaptureSizing.clampEdge(JSONValue.int(c["maxEdge"]) ?? 1920)
        fps = CaptureSizing.clampFps(JSONValue.int(c["fps"]) ?? 30)
        kbps = CaptureSizing.clampKbps(JSONValue.int(c["kbps"]) ?? 5000)
        audio = JSONValue.bool(c["audio"]) ?? true
        window = JSONValue.number(c["window"]).flatMap { $0 >= 1 && $0 <= Double(UInt32.max) ? UInt32($0) : nil }
        high = JSONValue.string(c["profile"]) == "high"
        maxQP = JSONValue.int(c["maxQp"]).map(CaptureSizing.clampQP)
        app = AppTarget(json: c["app"])
        // One window or one app, never both: a window wins (the host never sends both).
        if window != nil { app = nil }
    }
}

/// What app mode asks for: which app (its bundle id), the viewer's shape (width ÷ height) and whether to hide the app
/// when app mode ends.
public struct AppTarget: Equatable {
    public var id: String
    public var aspect: Double
    public var hide: Bool

    public init(id: String, aspect: Double, hide: Bool = false) {
        self.id = id; self.aspect = AppTarget.clampAspect(aspect); self.hide = hide
    }

    public init?(json: Any?) {
        guard let o = JSONValue.object(json), let id = JSONValue.string(o["id"]), AppTarget.validID(id),
              let a = JSONValue.number(o["aspect"]), a > 0 else { return nil }
        self.init(id: id, aspect: a, hide: JSONValue.bool(o["hide"]) == true)
    }

    /// Bundle identifiers: letters, digits, dots, hyphens (and underscores, which some old apps have).
    public static func validID(_ s: String) -> Bool {
        !s.isEmpty && s.utf8.count <= 200 && s.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "." || $0 == "-" || $0 == "_"
        }
    }

    /// From a tall phone (1:4) to a wide one on its side (4:1).
    public static func clampAspect(_ a: Double) -> Double { a.isFinite ? min(max(a, 0.25), 4) : 1 }
}

public enum CaptureSizing {
    /// H.264 level 5.2 tops out around 4096 pixels wide; nothing Perch sends needs more.
    public static func clampEdge(_ v: Int) -> Int { min(max(v, 160), 4096) }
    public static func clampFps(_ v: Int) -> Int { min(max(v, 1), 60) }
    /// VideoToolbox misbehaves with an AverageBitRate of 0, and below ~100 kbit/s nothing is readable anyway.
    public static func clampKbps(_ v: Int) -> Int { min(max(v, 100), 50_000) }
    /// H.264 quantisers run 0–51; below 18 the encoder would spend bits on detail nobody can see.
    public static func clampQP(_ v: Int) -> Int { min(max(v, 18), 51) }

    /// The encoded size for a display of pixelWidth × pixelHeight: the longest edge at most maxEdge, the display's
    /// shape kept, both sides even (4:2:0 video needs that), and never bigger than the display itself.
    public static func outputSize(pixelWidth: Int, pixelHeight: Int, maxEdge: Int) -> (width: Int, height: Int) {
        let pw = max(pixelWidth, 2), ph = max(pixelHeight, 2)
        // Whole-number arithmetic, so 2940 px scaled to 1920 really is 1920 (floating point gives 1919.99...).
        let longest = max(pw, ph), edge = min(max(maxEdge, 2), longest)
        let w = (pw * edge / longest) & ~1
        let h = (ph * edge / longest) & ~1
        return (max(w, 2), max(h, 2))
    }
}
