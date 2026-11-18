// The Mac's sound, taken with a Core Audio process tap (macOS 14.2 and later) instead of ScreenCaptureKit, so it can
// be kept off the Mac's own speakers while a viewer hears it: every process but Perch is tapped, and macOS mutes what
// it taps on the output device for as long as the tap runs ("muted when tapped"). When the tap stops (the session
// ends, Perch quits or crashes), the Mac plays as before. The Mac's volume setting is never touched.
//
// Perch itself is left out of the tap, so what it plays (its own copy for the speakers, SpeakerMonitor, and a viewer's
// microphone, MicPlayer) still reaches the speakers and never comes back round into what is sent.
//
// The first time, macOS asks for "System Audio Recording" (NSAudioCaptureUsageDescription). Without it the tap runs
// but hears silence; there is no public way to ask whether it was allowed.
import Foundation
import CoreAudio
import AudioToolbox
import AVFoundation

public enum SoundTap {
    /// Whether this Mac can take its sound this way.
    public static var available: Bool {
        if #available(macOS 14.2, *) { return true }
        return false
    }
}

@available(macOS 14.2, *)
final class SystemAudioTap {
    enum Failure: Error, CustomStringConvertible {
        case coreAudio(String, OSStatus)
        case format
        var description: String {
            switch self {
            case .coreAudio(let what, let st): return "\(what) failed (\(st))"
            case .format: return "the tap's sound format isn't 32-bit float"
            }
        }
    }

    /// Interleaved stereo at `sampleRate`, the host time of its first frame in microseconds. Core Audio's IO thread.
    var onPCM: (([Float], UInt64) -> Void)?
    private(set) var sampleRate: Double = 48_000
    /// Whether Perch's own sound is left out (it couldn't be when Perch had never played anything yet).
    private(set) var excludesPerch = false

    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var format = AudioStreamBasicDescription()
    private let ioQueue = DispatchQueue(label: "perch.sound-tap", qos: .userInteractive)

    /// Starts tapping. `muted`: keep what is tapped off the output device while the tap runs.
    func start(muted: Bool) throws {
        let me = Self.processObject(pid: getpid())
        excludesPerch = me != kAudioObjectUnknown
        let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: excludesPerch ? [me] : [])
        desc.uuid = UUID()
        desc.name = "Perch"
        desc.isPrivate = true
        desc.muteBehavior = muted ? .mutedWhenTapped : .unmuted
        var tap = AudioObjectID(kAudioObjectUnknown)
        var st = AudioHardwareCreateProcessTap(desc, &tap)
        guard st == noErr else { throw Failure.coreAudio("creating the sound tap", st) }
        tapID = tap

        do {
            format = try Self.property(tap, kAudioTapPropertyFormat, AudioStreamBasicDescription())
            guard format.mFormatFlags & kAudioFormatFlagIsFloat != 0, format.mBitsPerChannel == 32 else { throw Failure.format }
            sampleRate = format.mSampleRate > 0 ? format.mSampleRate : 48_000

            // A private aggregate device around the tap, clocked by the Mac's output device.
            let output: AudioObjectID = try Self.property(AudioObjectID(kAudioObjectSystemObject),
                                                          kAudioHardwarePropertyDefaultSystemOutputDevice, AudioObjectID(0))
            let outputUID: CFString = try Self.property(output, kAudioDevicePropertyDeviceUID, "" as CFString)
            let settings: [String: Any] = [
                kAudioAggregateDeviceNameKey: "Perch sound",
                kAudioAggregateDeviceUIDKey: UUID().uuidString,
                kAudioAggregateDeviceMainSubDeviceKey: outputUID as String,
                kAudioAggregateDeviceIsPrivateKey: true,
                kAudioAggregateDeviceIsStackedKey: false,
                kAudioAggregateDeviceTapAutoStartKey: true,
                kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID as String]],
                kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: desc.uuid.uuidString]],
            ]
            var agg = AudioObjectID(kAudioObjectUnknown)
            st = AudioHardwareCreateAggregateDevice(settings as CFDictionary, &agg)
            guard st == noErr else { throw Failure.coreAudio("creating the sound device", st) }
            aggregateID = agg

            var proc: AudioDeviceIOProcID?
            st = AudioDeviceCreateIOProcIDWithBlock(&proc, agg, ioQueue) { [weak self] _, input, inputTime, _, _ in
                self?.received(input, at: inputTime)
            }
            guard st == noErr, let proc else { throw Failure.coreAudio("listening to the sound device", st) }
            procID = proc
            st = AudioDeviceStart(agg, proc)
            guard st == noErr else { throw Failure.coreAudio("starting the sound device", st) }
        } catch {
            stop()
            throw error
        }
    }

    func stop() {
        if aggregateID != kAudioObjectUnknown {
            if let procID {
                AudioDeviceStop(aggregateID, procID)
                AudioDeviceDestroyIOProcID(aggregateID, procID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
        }
        procID = nil
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
        tapID = AudioObjectID(kAudioObjectUnknown)
    }

    deinit { stop() }

    // MARK: Core Audio's IO thread

    private func received(_ input: UnsafePointer<AudioBufferList>, at time: UnsafePointer<AudioTimeStamp>) {
        let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        guard let pcm = Self.interleavedStereo(list, format: format), !pcm.isEmpty else { return }
        let t = time.pointee
        let pts = t.mFlags.contains(.hostTimeValid) ? AudioConvertHostTimeToNanos(t.mHostTime) / 1000 : hostMicros()
        onPCM?(pcm, pts)
    }

    /// Any 32-bit float layout → interleaved stereo (mono is copied to both sides, extra channels are dropped).
    static func interleavedStereo(_ list: UnsafeMutableAudioBufferListPointer, format f: AudioStreamBasicDescription) -> [Float]? {
        let channels = Int(f.mChannelsPerFrame)
        guard channels > 0, list.count > 0 else { return nil }
        if f.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0 {
            guard let left = list[0].mData?.assumingMemoryBound(to: Float.self) else { return nil }
            let frames = Int(list[0].mDataByteSize) / MemoryLayout<Float>.size
            let right = list.count > 1 ? list[1].mData?.assumingMemoryBound(to: Float.self) ?? left : left
            var out = [Float](repeating: 0, count: frames * 2)
            for i in 0..<frames { out[i * 2] = left[i]; out[i * 2 + 1] = right[i] }
            return out
        }
        guard let data = list[0].mData?.assumingMemoryBound(to: Float.self) else { return nil }
        let frames = Int(list[0].mDataByteSize) / (MemoryLayout<Float>.size * channels)
        var out = [Float](repeating: 0, count: frames * 2)
        for i in 0..<frames {
            out[i * 2] = data[i * channels]
            out[i * 2 + 1] = data[i * channels + (channels > 1 ? 1 : 0)]
        }
        return out
    }

    // MARK: Core Audio properties

    /// Core Audio's object for a process (it only has one once the process has used sound).
    static func processObject(pid: pid_t) -> AudioObjectID {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
                                                 mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var pid = pid
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let st = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address,
                                            UInt32(MemoryLayout<pid_t>.size), &pid, &size, &object)
        return st == noErr ? object : AudioObjectID(kAudioObjectUnknown)
    }

    static func property<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) throws -> T {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        var value = initial
        var size = UInt32(MemoryLayout<T>.size)
        let st = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0) }
        guard st == noErr else { throw Failure.coreAudio("reading sound property \(selector)", st) }
        return value
    }
}
