// While the Mac's sound is tapped and kept off its speakers (SystemAudioTap), Perch plays its own copy there at the
// level the owner chose ("Mac speakers", 0–100%). At 0 nothing is played. A short queue keeps the delay low: when it
// holds more than MAX_DELAY, the oldest sound is skipped.
//
// The engine starts before the tap is made, so Core Audio already knows Perch as a process using sound and the tap
// can leave Perch out (otherwise this copy would be tapped too, and go round and round).
import Foundation
import AVFoundation

final class SpeakerMonitor {
    static let maxDelaySeconds = 0.08

    private let engine = AVAudioEngine()
    private var node: AVAudioSourceNode?
    private let lock = NSLock()
    private var queue: [Float] = []   // interleaved stereo, waiting to be played (lock)
    private var readAt = 0             // how far into `queue` playback has got (lock)
    private var gain: Float = 0        // what playback is heading for (lock)
    private var playing: Float = 0     // the gain being played now, gliding towards `gain` (render thread)
    private var maxQueued = 0

    /// 0 to 1. Any thread.
    var level: Double {
        get { lock.withLock { Double(gain) } }
        set { lock.withLock { gain = Float(min(max(newValue, 0), 1)) } }
    }

    /// Starts the engine at the tap's sample rate.
    func start(sampleRate: Double) throws {
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 2) else { return }
        maxQueued = Int(sampleRate * Self.maxDelaySeconds) * 2
        let node = AVAudioSourceNode(format: format) { [weak self] _, _, frames, buffers -> OSStatus in
            self?.render(Int(frames), UnsafeMutableAudioBufferListPointer(buffers))
            return noErr
        }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        try engine.start()
        self.node = node
    }

    func stop() {
        engine.stop()
        if let node { engine.detach(node) }
        node = nil
        lock.withLock { queue = []; readAt = 0 }
    }

    /// Interleaved stereo at the engine's rate. Any thread.
    func push(_ pcm: [Float]) {
        lock.withLock {
            guard gain > 0 || playing > 0 else { queue = []; readAt = 0; return }
            if readAt > 0 { queue.removeFirst(readAt); readAt = 0 }
            queue.append(contentsOf: pcm)
            if queue.count > maxQueued { queue.removeFirst(queue.count - maxQueued) }
        }
    }

    // MARK: the render thread

    private func render(_ frames: Int, _ out: UnsafeMutableAudioBufferListPointer) {
        guard out.count >= 2, let left = out[0].mData?.assumingMemoryBound(to: Float.self),
              let right = out[1].mData?.assumingMemoryBound(to: Float.self) else { return }
        lock.lock()
        let target = gain
        let available = (queue.count - readAt) / 2
        let n = min(frames, available)
        let step = (target - playing) / Float(max(frames, 1))
        var g = playing
        for i in 0..<frames {
            g += step
            if i < n {
                left[i] = queue[readAt + i * 2] * g
                right[i] = queue[readAt + i * 2 + 1] * g
            } else {
                left[i] = 0; right[i] = 0
            }
        }
        readAt += n * 2
        lock.unlock()
        playing = target
    }
}

/// Sound at another sample rate → 48 kHz interleaved stereo, for the Opus encoder.
final class Resampler {
    private let converter: AVAudioConverter
    private let input: AVAudioFormat
    private let output: AVAudioFormat
    let ratio: Double

    init?(from rate: Double, to target: Double = Double(OpusEncoder.sampleRate)) {
        guard let i = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 2, interleaved: true),
              let o = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: target, channels: 2, interleaved: true),
              let c = AVAudioConverter(from: i, to: o) else { return nil }
        input = i; output = o; converter = c
        ratio = target / rate
    }

    func convert(_ pcm: [Float]) -> [Float] {
        let frames = pcm.count / 2
        guard frames > 0, let inBuffer = AVAudioPCMBuffer(pcmFormat: input, frameCapacity: AVAudioFrameCount(frames)),
              let outBuffer = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: AVAudioFrameCount(Double(frames) * ratio + 32))
        else { return [] }
        inBuffer.frameLength = AVAudioFrameCount(frames)
        pcm.withUnsafeBufferPointer { src in
            inBuffer.mutableAudioBufferList.pointee.mBuffers.mData?.copyMemory(from: src.baseAddress!, byteCount: pcm.count * 4)
        }
        var fed = false
        var error: NSError?
        converter.convert(to: outBuffer, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return inBuffer
        }
        let n = Int(outBuffer.frameLength) * 2
        guard n > 0, let data = outBuffer.audioBufferList.pointee.mBuffers.mData?.assumingMemoryBound(to: Float.self) else { return [] }
        return Array(UnsafeBufferPointer(start: data, count: n))
    }
}
