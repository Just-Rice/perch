// "Talk through your Mac": the viewer's microphone arrives as Opus packets and is played on one of this Mac's sound
// outputs. On the speakers it works like an intercom. On a loopback device (such as the free BlackHole) other apps
// can pick it as their microphone, which is how a call on the Mac hears the person who is away from it.
//
// What Perch plays never comes back to the viewer: the screen capture leaves out this process's own sound.
import Foundation
import AVFoundation
import AudioToolbox
import CoreAudio

public struct AudioOutput: Equatable {
    public let id: AudioDeviceID
    public let uid: String
    public let name: String
    public let isDefault: Bool

    /// As the protocol lists it: `{uid, name, main}`.
    public var json: [String: Any] { ["uid": uid, "name": name, "main": isDefault] }
}

public enum AudioOutputs {
    private static func address(_ selector: AudioObjectPropertySelector,
                                scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    private static func string(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var addr = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr, let value else { return nil }
        return value.takeRetainedValue() as String
    }

    /// The devices sound can be played on, in the system's order.
    public static func list() -> [AudioOutput] {
        let system = AudioObjectID(kAudioObjectSystemObject)
        var addr = address(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
        var main = AudioDeviceID(0)
        var mainAddr = address(kAudioHardwarePropertyDefaultOutputDevice)
        var mainSize = UInt32(MemoryLayout<AudioDeviceID>.size)
        AudioObjectGetPropertyData(system, &mainAddr, 0, nil, &mainSize, &main)
        return ids.compactMap { id in
            // Only devices with something to play on.
            var streams = address(kAudioDevicePropertyStreams, scope: kAudioObjectPropertyScopeOutput)
            var streamBytes: UInt32 = 0
            guard AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &streamBytes) == noErr, streamBytes > 0,
                  let uid = string(id, kAudioDevicePropertyDeviceUID), !uid.isEmpty else { return nil }
            return AudioOutput(id: id, uid: uid, name: string(id, kAudioObjectPropertyName) ?? uid, isDefault: id == main)
        }
    }

    /// Calls `changed` on the main queue when an output is plugged in or removed, or the Mac's own choice changes.
    public static func watch(_ changed: @escaping () -> Void) {
        let system = AudioObjectID(kAudioObjectSystemObject)
        for selector in [kAudioHardwarePropertyDevices, kAudioHardwarePropertyDefaultOutputDevice] {
            var addr = address(selector)
            AudioObjectAddPropertyListenerBlock(system, &addr, DispatchQueue.main) { _, _ in changed() }
        }
    }
}

public final class MicPlayer: @unchecked Sendable {
    public enum Failure: Error, CustomStringConvertible {
        case noDevice, engine(String)
        public var description: String {
            switch self {
            case .noDevice: return "That sound output is not connected."
            case .engine(let why): return "Couldn't start playing sound: \(why)"
            }
        }
    }

    /// What has been played (or, in a dry run, decoded) since start: for logs and tests.
    public struct Stats: Equatable {
        public var packets = 0, frames = 0, skipped = 0, late = 0
        public var sumSquares = 0.0
        public var rms: Double { frames > 0 ? (sumSquares / Double(frames * 2)).squareRoot() : 0 }
    }

    /// Playback stopped by itself and could not be picked up again (the output went away). Any thread.
    public var onFailure: ((String) -> Void)?
    /// Dry runs only: a count of what has arrived, about once a second while packets flow. Any thread.
    public var onLevel: ((Stats) -> Void)?

    private let queue = DispatchQueue(label: "perch.mic", qos: .userInteractive)
    private let dryRun: Bool
    private var on = false
    private var deviceUID: String?
    private var decoder: OpusDecoder?
    private var engine: AVAudioEngine?
    private var node: AVAudioPlayerNode?
    private var observer: NSObjectProtocol?
    private var lastSeq: UInt16?
    private var queuedFrames = 0
    private var stats = Stats()
    private let format = AVAudioFormat(standardFormatWithSampleRate: Double(OpusEncoder.sampleRate), channels: 2)!

    /// More than this waiting to be played means the Mac has fallen behind (clocks drift, the network delivers in
    /// bursts): packets are skipped until it has caught up, so the delay never builds.
    static let maxQueuedFrames = OpusEncoder.sampleRate * 3 / 10

    /// A dry run decodes and counts but never makes a sound (tests, and every run that isn't the real app).
    public init(dryRun: Bool) { self.dryRun = dryRun }

    public var isOn: Bool { queue.sync { on } }
    public var current: Stats { queue.sync { stats } }
    /// Frames handed to the sound output and not played yet.
    public var pending: Int { queue.sync { queuedFrames } }

    /// Starts playing on the output with this UID, or on the Mac's current output when nil or empty.
    public func start(deviceUID uid: String?) throws {
        try queue.sync {
            teardown()
            deviceUID = (uid?.isEmpty ?? true) ? nil : uid
            decoder = try OpusDecoder(channels: 2)
            lastSeq = nil
            queuedFrames = 0
            stats = Stats()
            if !dryRun { try setUp() }
            on = true
        }
    }

    public func stop() {
        queue.sync {
            on = false
            teardown()
        }
    }

    /// One MIC frame from the host: a 16-bit sequence number, then one Opus packet.
    public func push(_ payload: Data) {
        queue.async { [self] in
            guard on, payload.count > 2, let decoder else { return }
            let seq = UInt16(payload[payload.startIndex]) << 8 | UInt16(payload[payload.startIndex + 1])
            if let last = lastSeq {
                // Late or repeated packets are dropped: by now their moment has passed. (A big jump back is a new
                // stream starting over.)
                let d = Int16(bitPattern: seq &- last)
                if d <= 0 && d > -1000 { stats.late += 1; return }
            }
            lastSeq = seq
            let pcm = decoder.decode(payload.subdata(in: (payload.startIndex + 2)..<payload.endIndex))
            let frames = pcm.count / 2
            guard frames > 0 else { return }
            stats.packets += 1
            stats.frames += frames
            for s in pcm { stats.sumSquares += Double(s) * Double(s) }
            if dryRun {
                if stats.packets % 50 == 0 { onLevel?(stats) }
                return
            }
            guard let node, queuedFrames <= Self.maxQueuedFrames,
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
                  let channels = buffer.floatChannelData else { stats.skipped += 1; return }
            buffer.frameLength = AVAudioFrameCount(frames)
            for i in 0..<frames {
                channels[0][i] = pcm[i * 2]
                channels[1][i] = pcm[i * 2 + 1]
            }
            queuedFrames += frames
            node.scheduleBuffer(buffer) { [weak self] in
                self?.queue.async { self?.queuedFrames -= frames }
            }
        }
    }

    // MARK: on the queue

    private func setUp() throws {
        let engine = AVAudioEngine()
        let node = AVAudioPlayerNode()
        if let uid = deviceUID {
            guard let device = AudioOutputs.list().first(where: { $0.uid == uid }) else { throw Failure.noDevice }
            guard let unit = engine.outputNode.audioUnit else { throw Failure.engine("no output unit") }
            var id = device.id
            let st = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                          &id, UInt32(MemoryLayout<AudioDeviceID>.size))
            guard st == noErr else { throw Failure.engine("the output refused (\(st))") }
        }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        do { try engine.start() } catch { throw Failure.engine(error.localizedDescription) }
        node.play()
        self.engine = engine
        self.node = node
        // Headphones plugged in, an output unplugged: the engine stops itself. Pick up again where possible.
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.queue.async { self?.outputChanged() }
        }
    }

    private func outputChanged() {
        guard on, !dryRun else { return }
        teardown()
        queuedFrames = 0
        do {
            try setUp()
        } catch {
            on = false
            onFailure?("\(error)")
        }
    }

    private func teardown() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        node?.stop()
        engine?.stop()
        node = nil
        engine = nil
    }
}
