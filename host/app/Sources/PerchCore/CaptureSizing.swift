// What size to capture and encode at, and the sane ranges for the host's capture settings.
import Foundation

public struct CaptureRequest: Equatable {
    public var displayID: UInt32?
    public var maxEdge: Int
    public var fps: Int
    public var kbps: Int
    public var audio: Bool

    public init(displayID: UInt32? = nil, maxEdge: Int = 1920, fps: Int = 30, kbps: Int = 5000, audio: Bool = true) {
        self.displayID = displayID; self.maxEdge = maxEdge; self.fps = fps; self.kbps = kbps; self.audio = audio
    }

    /// Reads a `capture` command, clamping each value into a range the encoder handles well.
    public init(command c: [String: Any]) {
        displayID = JSONValue.number(c["display"]).flatMap { $0 >= 0 && $0 <= Double(UInt32.max) ? UInt32($0) : nil }
        maxEdge = CaptureSizing.clampEdge(JSONValue.int(c["maxEdge"]) ?? 1920)
        fps = CaptureSizing.clampFps(JSONValue.int(c["fps"]) ?? 30)
        kbps = CaptureSizing.clampKbps(JSONValue.int(c["kbps"]) ?? 5000)
        audio = JSONValue.bool(c["audio"]) ?? true
    }
}

public enum CaptureSizing {
    /// H.264 level 5.2 tops out around 4096 pixels wide; nothing Perch sends needs more.
    public static func clampEdge(_ v: Int) -> Int { min(max(v, 160), 4096) }
    public static func clampFps(_ v: Int) -> Int { min(max(v, 1), 60) }
    /// VideoToolbox misbehaves with an AverageBitRate of 0, and below ~100 kbit/s nothing is readable anyway.
    public static func clampKbps(_ v: Int) -> Int { min(max(v, 100), 50_000) }

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
