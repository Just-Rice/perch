// The pipe between Perch.app and its Node host process. docs/PROTOCOL.md, "App ⇄ host process (IPC)".
//
// The app writes to the host's stdin and reads the host's stdout. Every frame is
// [u32 big-endian length of the rest][u8 type][payload], so either side can split a byte stream back into frames
// without caring how the operating system chopped it up.
import Foundation

public enum FrameType: UInt8 {
    case hello = 0x01    // app → host, JSON
    case video = 0x02    // app → host, u8 flags · u64 BE pts µs · Annex-B access unit
    case audio = 0x03    // app → host, u64 BE pts µs · one Opus packet
    case event = 0x04    // app → host, JSON
    case command = 0x10  // host → app, JSON
    case input = 0x11    // host → app, JSON input message
}

public enum IPC {
    public static let version = 1
    /// The host only ever sends us small JSON. Anything bigger means the stream is out of step (or the host is not
    /// speaking this protocol at all), and the app restarts it rather than buffering without limit.
    public static let maxIncomingFrame = 1 << 20

    public static func frame(_ type: FrameType, _ payload: Data) -> Data {
        frame(rawType: type.rawValue, payload)
    }

    public static func frame(rawType: UInt8, _ payload: Data) -> Data {
        var out = Data(capacity: 5 + payload.count)
        out.appendBigEndian(UInt32(payload.count + 1))
        out.append(rawType)
        out.append(payload)
        return out
    }

    public static func videoPayload(keyframe: Bool, ptsMicros: UInt64, annexB: Data) -> Data {
        var out = Data(capacity: 9 + annexB.count)
        out.append(keyframe ? 1 : 0)
        out.appendBigEndian(ptsMicros)
        out.append(annexB)
        return out
    }

    public static func audioPayload(ptsMicros: UInt64, packet: Data) -> Data {
        var out = Data(capacity: 8 + packet.count)
        out.appendBigEndian(ptsMicros)
        out.append(packet)
        return out
    }

    /// Serialises a JSON object. Our own dictionaries are always valid JSON, so a failure here is a programming
    /// error; it still yields `{}` rather than crashing the app.
    public static func json(_ object: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])) ?? Data("{}".utf8)
    }

    /// Parses a JSON object payload; nil for anything that isn't one.
    public static func parseObject(_ data: Data) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}

/// Splits a byte stream into frames. Keeps any partial frame until the rest arrives.
public struct FrameParser {
    public enum Failure: Error, CustomStringConvertible {
        case tooLarge(Int)
        case empty
        public var description: String {
            switch self {
            case .tooLarge(let n): return "frame of \(n) bytes is larger than the \(IPC.maxIncomingFrame)-byte limit"
            case .empty: return "frame with no type byte"
            }
        }
    }

    public let maxFrame: Int
    private var buffer: [UInt8] = []
    private var start = 0

    public init(maxFrame: Int = IPC.maxIncomingFrame) { self.maxFrame = maxFrame }

    /// Bytes held back waiting for the rest of a frame.
    public var buffered: Int { buffer.count - start }

    public mutating func push(_ chunk: Data) throws -> [(type: UInt8, payload: Data)] {
        buffer.append(contentsOf: chunk)
        var frames: [(type: UInt8, payload: Data)] = []
        while buffer.count - start >= 4 {
            let len = Int(buffer[start]) << 24 | Int(buffer[start + 1]) << 16 | Int(buffer[start + 2]) << 8 | Int(buffer[start + 3])
            if len == 0 { throw Failure.empty }
            if len > maxFrame { throw Failure.tooLarge(len) }
            guard buffer.count - start >= 4 + len else { break }
            let type = buffer[start + 4]
            let payload = Data(buffer[(start + 5)..<(start + 4 + len)])
            frames.append((type, payload))
            start += 4 + len
        }
        // Drop consumed bytes once they make up most of the buffer, so a long session doesn't grow it forever.
        if start > 0 && start * 2 >= buffer.count {
            buffer.removeFirst(start)
            start = 0
        }
        return frames
    }
}

extension Data {
    public mutating func appendBigEndian<T: FixedWidthInteger>(_ value: T) {
        Swift.withUnsafeBytes(of: value.bigEndian) { append(contentsOf: $0) }
    }
}
