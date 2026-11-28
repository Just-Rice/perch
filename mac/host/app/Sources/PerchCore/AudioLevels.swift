// How loud the Mac's sound is in two places while someone is connected, set apart from each other: on the Mac's own
// speakers, and in what is sent to the viewer. The owner sets both (Setup, or live in the viewer); the host passes
// them on in the `capture` command and in `audio-levels` (docs/PROTOCOL.md).
import Foundation

public struct AudioLevels: Equatable {
    /// The Mac's own speakers: 0 (silent) to 1 (as loud as the Mac would play it anyway). Below 1, Perch takes the
    /// Mac's sound with a Core Audio tap that keeps it off the speakers, and plays its own copy at this level.
    public var speakers: Double
    /// What is sent to the viewer: 0 (nothing) to 1.5 (half as loud again, limited so it doesn't distort).
    public var stream: Double

    public static let maxStream = 1.5
    public static let normal = AudioLevels(speakers: 1, stream: 1)

    public init(speakers: Double = 1, stream: Double = 1) {
        self.speakers = Self.clamp(speakers, to: 1)
        self.stream = Self.clamp(stream, to: Self.maxStream)
    }

    /// From a command: `speakers` and `stream`, each optional, kept from `base` when missing or not a number.
    public init(command c: [String: Any], base: AudioLevels = .normal) {
        self.init(speakers: JSONValue.number(c["speakers"]) ?? base.speakers,
                  stream: JSONValue.number(c["stream"]) ?? base.stream)
    }

    /// Whether the speakers need the tap: anything below full level.
    public var quietSpeakers: Bool { speakers < 0.999 }

    private static func clamp(_ v: Double, to top: Double) -> Double { v.isFinite ? min(max(v, 0), top) : 1 }
}

/// Applies a gain to interleaved samples, gliding from the last gain to the new one across the buffer (so a slider
/// moving doesn't click), and bends anything above LIMIT_KNEE smoothly towards full scale instead of clipping it.
public struct GainStage {
    public private(set) var current: Float = 1
    public var target: Float = 1
    /// Samples below this pass untouched; above it they are squeezed into the space up to 1.0.
    public static let knee: Float = 0.8

    public init(gain: Float = 1) { current = gain; target = gain }

    public mutating func apply(_ samples: inout [Float]) {
        let n = samples.count
        guard n > 0 else { return }
        let from = current, to = target
        if from == 1, to == 1 { return }
        let step = (to - from) / Float(n)
        var g = from
        for i in 0..<n {
            g += step
            samples[i] = Self.limit(samples[i] * g)
        }
        current = to
    }

    /// Soft limiter: unchanged up to the knee, then a tanh curve that approaches (never reaches) 1.0.
    public static func limit(_ x: Float) -> Float {
        let a = abs(x)
        if a <= knee { return x }
        let room = 1 - knee
        let y = knee + room * tanh((a - knee) / room)
        return x < 0 ? -y : y
    }
}
