// Opus with AudioToolbox's AudioConverter, so Perch needs no audio library of its own.
//
//   OpusEncoder: 48 kHz interleaved Float32 stereo → raw Opus packets, one per 20 ms (960 frames). These are plain
//                Opus packets (TOC byte first), exactly what goes into a WebRTC RTP payload.
//   OpusDecoder: the reverse; only the self-test uses it, to prove the packets decode back to the sound put in.
//
// Measured in the spike (macOS 27): a 440 Hz tone at 64 kbit/s gives 98–128-byte packets with TOC 0xfc (CELT,
// fullband, 20 ms, stereo), ~0.2 ms of CPU each, and decodes in both AudioToolbox and ffmpeg's libopus.
// ScreenCaptureKit's 960-frame audio buffers map one-to-one onto packets.
import Foundation
import AudioToolbox

public enum OpusError: Error, CustomStringConvertible {
    case converterNew(OSStatus)
    case property(String, OSStatus)
    public var description: String {
        switch self {
        case .converterNew(let s): return "AudioConverterNew failed (OSStatus \(s))"
        case .property(let n, let s): return "\(n) failed (OSStatus \(s))"
        }
    }
}

/// What our input callbacks return when they have no more data right now (as opposed to end of stream).
let needMoreData: OSStatus = 0x6E6D6F72 // 'nmor'

func pcmFloat32Format(sampleRate: Double, channels: UInt32) -> AudioStreamBasicDescription {
    AudioStreamBasicDescription(mSampleRate: sampleRate, mFormatID: kAudioFormatLinearPCM,
                                mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
                                mBytesPerPacket: 4 * channels, mFramesPerPacket: 1, mBytesPerFrame: 4 * channels,
                                mChannelsPerFrame: channels, mBitsPerChannel: 32, mReserved: 0)
}

func opusFormat(sampleRate: Double, channels: UInt32, framesPerPacket: UInt32) -> AudioStreamBasicDescription {
    AudioStreamBasicDescription(mSampleRate: sampleRate, mFormatID: kAudioFormatOpus, mFormatFlags: 0,
                                mBytesPerPacket: 0, mFramesPerPacket: framesPerPacket, mBytesPerFrame: 0,
                                mChannelsPerFrame: channels, mBitsPerChannel: 0, mReserved: 0)
}

// MARK: - Encoder

/// PCM waiting to be encoded. The converter pulls from it through a C callback.
private final class PCMFeed {
    var samples: [Float] = [] // interleaved
    var readIndex = 0
    let channels: Int
    var chunk: UnsafeMutablePointer<Float>
    var chunkCapacity: Int
    init(channels: Int) {
        self.channels = channels
        chunkCapacity = 5760 * channels
        chunk = .allocate(capacity: chunkCapacity)
    }
    deinit { chunk.deallocate() }
    var availableFrames: Int { (samples.count - readIndex) / channels }
}

private let pcmInputProc: AudioConverterComplexInputDataProc = { _, ioNumberDataPackets, ioData, _, inUserData in
    let feed = Unmanaged<PCMFeed>.fromOpaque(inUserData!).takeUnretainedValue()
    let avail = feed.availableFrames
    if avail == 0 { ioNumberDataPackets.pointee = 0; return needMoreData }
    let n = min(Int(ioNumberDataPackets.pointee), avail)
    let count = n * feed.channels
    if count > feed.chunkCapacity {
        feed.chunk.deallocate(); feed.chunk = .allocate(capacity: count); feed.chunkCapacity = count
    }
    feed.samples.withUnsafeBufferPointer { src in
        feed.chunk.update(from: src.baseAddress! + feed.readIndex, count: count)
    }
    feed.readIndex += count
    // The converter may read this buffer until the next callback, so it lives in the feed, not on the stack.
    ioData.pointee.mNumberBuffers = 1
    ioData.pointee.mBuffers.mData = UnsafeMutableRawPointer(feed.chunk)
    ioData.pointee.mBuffers.mDataByteSize = UInt32(count * 4)
    ioData.pointee.mBuffers.mNumberChannels = UInt32(feed.channels)
    ioNumberDataPackets.pointee = UInt32(n)
    return noErr
}

public final class OpusEncoder {
    public static let sampleRate = 48_000
    public static let framesPerPacket = 960

    private let converter: AudioConverterRef
    private let channels: UInt32
    private let maxPacketSize: Int
    private let feed: PCMFeed
    private let outBuffer: UnsafeMutableRawPointer
    public private(set) var lastStatus: OSStatus = 0

    public init(channels: UInt32 = 2, bitRate: UInt32 = 64_000) throws {
        self.channels = channels
        var inF = pcmFloat32Format(sampleRate: Double(Self.sampleRate), channels: channels)
        var outF = opusFormat(sampleRate: Double(Self.sampleRate), channels: channels, framesPerPacket: UInt32(Self.framesPerPacket))
        var conv: AudioConverterRef?
        let st = AudioConverterNew(&inF, &outF, &conv)
        guard st == noErr, let conv else { throw OpusError.converterNew(st) }
        converter = conv
        var br = bitRate
        let s = AudioConverterSetProperty(conv, kAudioConverterEncodeBitRate, UInt32(MemoryLayout<UInt32>.size), &br)
        if s != noErr { AudioConverterDispose(conv); throw OpusError.property("setting the Opus bitrate", s) }
        var maxSize: UInt32 = 0
        var sz = UInt32(MemoryLayout<UInt32>.size)
        AudioConverterGetProperty(conv, kAudioConverterPropertyMaximumOutputPacketSize, &sz, &maxSize)
        maxPacketSize = Int(max(maxSize, 1500))
        outBuffer = .allocate(byteCount: maxPacketSize, alignment: 16)
        feed = PCMFeed(channels: Int(channels))
    }

    deinit { AudioConverterDispose(converter); outBuffer.deallocate() }

    /// Frames held back waiting to fill the next 20 ms packet.
    public var bufferedFrames: Int { feed.availableFrames }

    /// Appends interleaved Float32 PCM and returns every complete Opus packet now available.
    public func encode(_ pcm: [Float]) -> [Data] {
        if feed.readIndex > 0 && feed.readIndex > feed.samples.count / 2 {
            feed.samples.removeFirst(feed.readIndex); feed.readIndex = 0
        }
        feed.samples.append(contentsOf: pcm)
        var packets: [Data] = []
        while feed.availableFrames >= Self.framesPerPacket {
            var ioPackets: UInt32 = 1
            var desc = AudioStreamPacketDescription()
            var abl = AudioBufferList(mNumberBuffers: 1,
                                      mBuffers: AudioBuffer(mNumberChannels: channels,
                                                            mDataByteSize: UInt32(maxPacketSize), mData: outBuffer))
            let st = AudioConverterFillComplexBuffer(converter, pcmInputProc, Unmanaged.passUnretained(feed).toOpaque(),
                                                     &ioPackets, &abl, &desc)
            if st != noErr && st != needMoreData { lastStatus = st; break }
            if ioPackets == 0 { break }
            let size = desc.mDataByteSize > 0 ? Int(desc.mDataByteSize) : Int(abl.mBuffers.mDataByteSize)
            packets.append(Data(bytes: outBuffer, count: size))
        }
        return packets
    }
}

// MARK: - Decoder

private final class PacketFeed {
    var data: UnsafeMutableRawPointer
    var capacity: Int
    var size = 0
    var pending = false
    let desc: UnsafeMutablePointer<AudioStreamPacketDescription> = .allocate(capacity: 1)
    init() { capacity = 4000; data = .allocate(byteCount: capacity, alignment: 16) }
    deinit { data.deallocate(); desc.deallocate() }
}

private let packetInputProc: AudioConverterComplexInputDataProc = { _, ioNumberDataPackets, ioData, outDesc, inUserData in
    let feed = Unmanaged<PacketFeed>.fromOpaque(inUserData!).takeUnretainedValue()
    guard feed.pending else { ioNumberDataPackets.pointee = 0; return needMoreData }
    feed.pending = false
    ioData.pointee.mNumberBuffers = 1
    ioData.pointee.mBuffers.mData = feed.data
    ioData.pointee.mBuffers.mDataByteSize = UInt32(feed.size)
    ioData.pointee.mBuffers.mNumberChannels = 0
    feed.desc.pointee = AudioStreamPacketDescription(mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(feed.size))
    outDesc?.pointee = feed.desc
    ioNumberDataPackets.pointee = 1
    return noErr
}

public final class OpusDecoder {
    private let converter: AudioConverterRef
    private let channels: Int
    private let feed = PacketFeed()
    private let maxFrames = 5760 // 120 ms, the longest Opus packet
    private let out: UnsafeMutablePointer<Float>
    public private(set) var lastStatus: OSStatus = 0

    public init(channels: UInt32 = 2) throws {
        var inF = opusFormat(sampleRate: Double(OpusEncoder.sampleRate), channels: channels, framesPerPacket: UInt32(OpusEncoder.framesPerPacket))
        var outF = pcmFloat32Format(sampleRate: Double(OpusEncoder.sampleRate), channels: channels)
        var conv: AudioConverterRef?
        let st = AudioConverterNew(&inF, &outF, &conv)
        guard st == noErr, let conv else { throw OpusError.converterNew(st) }
        converter = conv
        self.channels = Int(channels)
        out = .allocate(capacity: maxFrames * Int(channels))
    }

    deinit { AudioConverterDispose(converter); out.deallocate() }

    /// Decodes one raw Opus packet into interleaved Float32 PCM.
    public func decode(_ packet: Data) -> [Float] {
        guard !packet.isEmpty else { return [] }
        if packet.count > feed.capacity {
            feed.data.deallocate(); feed.capacity = packet.count; feed.data = .allocate(byteCount: packet.count, alignment: 16)
        }
        packet.withUnsafeBytes { feed.data.copyMemory(from: $0.baseAddress!, byteCount: packet.count) }
        feed.size = packet.count
        feed.pending = true
        var result: [Float] = []
        while true {
            var ioFrames = UInt32(maxFrames)
            var abl = AudioBufferList(mNumberBuffers: 1,
                                      mBuffers: AudioBuffer(mNumberChannels: UInt32(channels),
                                                            mDataByteSize: UInt32(maxFrames * channels * 4), mData: out))
            let st = AudioConverterFillComplexBuffer(converter, packetInputProc, Unmanaged.passUnretained(feed).toOpaque(),
                                                     &ioFrames, &abl, nil)
            if st != noErr && st != needMoreData { lastStatus = st }
            if ioFrames > 0 { result.append(contentsOf: UnsafeBufferPointer(start: out, count: Int(ioFrames) * channels)) }
            if st != noErr || ioFrames == 0 || !feed.pending { break }
        }
        return result
    }
}

/// Reads an Opus packet's TOC byte (RFC 6716 §3.1).
public struct OpusTOC {
    public let config: Int
    public let stereo: Bool
    public let frameCountCode: Int

    public init?(_ packet: Data) {
        guard let b = packet.first else { return nil }
        config = Int(b >> 3)
        stereo = (b >> 2) & 1 == 1
        frameCountCode = Int(b & 3)
    }

    public var mode: String { config < 12 ? "SILK" : (config < 16 ? "Hybrid" : "CELT") }

    /// Duration of one frame in the packet, in tenths of a millisecond.
    public var frameDurationTenthsMs: Int {
        switch config {
        case 0...11: return [100, 200, 400, 600][config % 4]
        case 12...15: return [100, 200][config % 2]
        default: return [25, 50, 100, 200][config % 4]
        }
    }

    /// Total packet duration in tenths of a millisecond, for packets with one or two frames (code 0–2).
    public var packetDurationTenthsMs: Int? {
        switch frameCountCode {
        case 0: return frameDurationTenthsMs
        case 1, 2: return 2 * frameDurationTenthsMs
        default: return nil
        }
    }
}
