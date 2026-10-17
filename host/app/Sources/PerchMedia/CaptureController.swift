// Runs capture for the host's `capture` commands: picks the display and size, makes an encoder, starts the screen
// (or the synthetic pattern), and hands encoded video and audio back. docs/PROTOCOL.md, "WebRTC" and "IPC".
//
// Threads: commands arrive on the main thread and are run one after another (starting ScreenCaptureKit is async,
// and a quick capture-on/capture-off pair must not overlap). Everything about pictures runs on one video queue;
// encoded frames come back on VideoToolbox's thread; audio has its own queue.
import Foundation
import CoreMedia
import CoreVideo
import CoreGraphics
import ScreenCaptureKit
import PerchCore

/// The host clock in microseconds: what ScreenCaptureKit stamps its buffers with, so video and audio line up.
public func hostMicros() -> UInt64 { micros(CMClockGetTime(CMClockGetHostTimeClock())) ?? 0 }

func micros(_ t: CMTime) -> UInt64? {
    guard t.isValid, t.isNumeric else { return nil }
    return UInt64(max(0, t.seconds) * 1_000_000)
}

/// Timestamps that only ever go forward (the protocol promises monotonic pts). Use from one queue.
final class MonotonicClock {
    private var last: UInt64 = 0
    func next(_ candidate: UInt64) -> UInt64 {
        last = max(last + 1, candidate)
        return last
    }
}

/// Decides which encoded frames may go to the host. Until a keyframe has gone out, and again after any frame that
/// couldn't be sent, only a keyframe may: every other frame builds on pictures the viewer would never have had.
final class KeyframeGate {
    private let lock = NSLock()
    private var awaiting = true
    private var closed = false

    var isAwaiting: Bool { lock.withLock { awaiting } }
    func request() { lock.withLock { awaiting = true } }
    func close() { lock.withLock { closed = true } }

    func admit(_ frame: EncodedFrame, canSend: Bool) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if closed { return false }
        if !canSend { awaiting = true; return false }
        if frame.isKeyframe { awaiting = false; return true }
        return !awaiting
    }
}

/// System audio (or the test tone) → 20 ms Opus packets with their timestamps. Audio queue only.
final class AudioPipeline {
    private let encoder: OpusEncoder
    private let clock = MonotonicClock()
    var onPacket: ((UInt64, Data) -> Void)?

    init() throws { encoder = try OpusEncoder(channels: 2, bitRate: 64_000) }

    /// `pts` is the time of the first frame in `pcm` (interleaved stereo).
    func feed(_ pcm: [Float], pts: UInt64) {
        // Frames still waiting from the previous buffer come first in the next packet.
        var t = Double(pts) - Double(encoder.bufferedFrames) * 1_000_000 / Double(OpusEncoder.sampleRate)
        for packet in encoder.encode(pcm) {
            onPacket?(clock.next(UInt64(max(0, t))), packet)
            t += 1_000_000 * Double(OpusEncoder.framesPerPacket) / Double(OpusEncoder.sampleRate)
        }
    }
}

/// One running capture: a source, an encoder and the timers that keep pictures coming while the screen is still.
/// Sendable by construction: its picture state is only touched on the video queue, audio state on the audio queue.
final class CaptureSession: @unchecked Sendable {
    let request: CaptureRequest
    let display: DisplayInfo
    let width: Int
    let height: Int
    let synthetic: Bool
    let gate = KeyframeGate()
    var onVideo: ((EncodedFrame) -> Void)?
    var onAudio: ((UInt64, Data) -> Void)?
    var onFailure: ((Error) -> Void)?
    var canSend: () -> Bool = { true }
    var log: (String) -> Void = { _ in }

    private let videoQueue: DispatchQueue
    private let audioQueue: DispatchQueue
    private let encoder: H264Encoder
    private var capturer: ScreenCapturer?
    private var audio: AudioPipeline?
    private var videoTimers: [DispatchSourceTimer] = []
    private var toneTimer: DispatchSourceTimer?
    private var lastPixelBuffer: CVPixelBuffer?
    private var lastEncode: UInt64 = 0
    private let videoClock = MonotonicClock()

    /// With nothing new on screen, send the last picture again this often so the viewer's stream stays alive.
    static let repeatAfterMicros: UInt64 = 1_000_000
    /// A keyframe that rate control dropped is retried this soon, even on a still screen.
    static let keyframeRetryMicros: UInt64 = 100_000

    init(request: CaptureRequest, display: DisplayInfo, synthetic: Bool, videoQueue: DispatchQueue, audioQueue: DispatchQueue) throws {
        self.request = request
        self.display = display
        self.synthetic = synthetic
        self.videoQueue = videoQueue
        self.audioQueue = audioQueue
        let size = CaptureSizing.outputSize(pixelWidth: display.pixelWidth, pixelHeight: display.pixelHeight, maxEdge: request.maxEdge)
        width = size.width
        height = size.height
        encoder = try H264Encoder(width: width, height: height, fps: request.fps, bitsPerSecond: request.kbps * 1000)
        encoder.warmUp(ptsMicros: hostMicros())
        encoder.onFrame = { [weak self] frame in
            guard let self, self.gate.admit(frame, canSend: self.canSend()) else { return }
            self.onVideo?(frame)
        }
    }

    func start() async throws {
        if request.audio {
            let pipeline = try AudioPipeline()
            pipeline.onPacket = { [weak self] pts, packet in self?.onAudio?(pts, packet) }
            audio = pipeline
        }
        if synthetic {
            videoQueue.sync { startPattern() }
            if request.audio { audioQueue.sync { startTone() } }
        } else {
            let cap = ScreenCapturer(videoQueue: videoQueue, audioQueue: audioQueue)
            cap.onVideo = { [weak self] pb, t in self?.frameArrived(pb, pts: micros(t) ?? hostMicros()) }
            cap.onAudio = { [weak self] sb in self?.audioArrived(sb) }
            cap.onStop = { [weak self] error in self?.onFailure?(error) }
            cap.log = log
            try await cap.start(displayID: display.id, width: width, height: height, fps: request.fps, audio: request.audio)
            capturer = cap
        }
        videoQueue.sync { startRepeats() }
    }

    func stop() async {
        gate.close()
        videoQueue.sync {
            videoTimers.forEach { $0.cancel() }
            videoTimers = []
            lastPixelBuffer = nil
        }
        audioQueue.sync { toneTimer?.cancel(); toneTimer = nil }
        await capturer?.stop()
        capturer = nil
        videoQueue.sync { encoder.invalidate() }
    }

    /// Ask for a keyframe now. A still screen sends no new pictures, so re-encode the last one rather than wait.
    func keyframe() {
        videoQueue.async { [self] in
            gate.request()
            if let pb = lastPixelBuffer { encode(pb, pts: hostMicros()) }
        }
    }

    func setBitrate(kbps: Int) {
        videoQueue.async { [self] in encoder.setBitRate(CaptureSizing.clampKbps(kbps) * 1000) }
    }

    // MARK: video queue

    private func frameArrived(_ pb: CVPixelBuffer, pts: UInt64) {
        lastPixelBuffer = pb
        encode(pb, pts: pts)
    }

    private func encode(_ pb: CVPixelBuffer, pts: UInt64) {
        lastEncode = hostMicros()
        encoder.encode(pb, ptsMicros: videoClock.next(pts), forceKeyframe: gate.isAwaiting)
    }

    private func startRepeats() {
        let t = DispatchSource.makeTimerSource(queue: videoQueue)
        t.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100), leeway: .milliseconds(10))
        t.setEventHandler { [weak self] in
            guard let self, let pb = self.lastPixelBuffer else { return }
            let idle = hostMicros() &- self.lastEncode
            if idle >= Self.repeatAfterMicros || (self.gate.isAwaiting && idle >= Self.keyframeRetryMicros) {
                self.encode(pb, pts: hostMicros())
            }
        }
        t.resume()
        videoTimers.append(t)
    }

    private func startPattern() {
        let pattern = SyntheticVideoSource(width: width, height: height)
        let fps = request.fps
        let start = hostMicros()
        var lastIndex = -1
        let t = DispatchSource.makeTimerSource(queue: videoQueue)
        let interval = 1_000_000 / fps
        t.schedule(deadline: .now(), repeating: .microseconds(interval), leeway: .milliseconds(2))
        t.setEventHandler { [weak self] in
            guard let self else { return }
            let now = hostMicros()
            let index = Int((now &- start) * UInt64(fps) / 1_000_000)
            guard index != lastIndex, let pb = pattern.makeFrame(index: index) else { return }
            lastIndex = index
            self.frameArrived(pb, pts: now)
        }
        t.resume()
        videoTimers.append(t)
    }

    // MARK: audio queue

    private func audioArrived(_ sb: CMSampleBuffer) {
        guard let pcm = ScreenCapturer.interleavedFloat32(from: sb) else { return }
        audio?.feed(pcm, pts: micros(CMSampleBufferGetPresentationTimeStamp(sb)) ?? hostMicros())
    }

    private func startTone() {
        let tone = ToneGenerator()
        let start = hostMicros()
        let rate = Double(OpusEncoder.sampleRate), per = OpusEncoder.framesPerPacket
        var produced = 0
        let t = DispatchSource.makeTimerSource(queue: audioQueue)
        t.schedule(deadline: .now(), repeating: .milliseconds(20), leeway: .milliseconds(2))
        t.setEventHandler { [weak self] in
            guard let self else { return }
            let due = Int(Double(hostMicros() &- start) * rate / 1_000_000)
            // After a long stall (the Mac slept), skip ahead instead of bursting seconds of tone at once.
            if due - produced > Int(rate) { produced = due - per }
            while produced + per <= due {
                self.audio?.feed(tone.next(frames: per), pts: start + UInt64(Double(produced) * 1_000_000 / rate))
                produced += per
            }
        }
        t.resume()
        toneTimer = t
    }
}

/// Sendable by construction: shared state sits behind `lock`, and `chain` is only used on the main thread.
public final class CaptureController: @unchecked Sendable {
    public let synthetic: Bool
    /// Encoded video ready to send (already gated: the first frame is always a keyframe). VideoToolbox's thread.
    public var onVideo: ((EncodedFrame) -> Void)?
    /// One 20 ms Opus packet and its timestamp. The audio queue.
    public var onAudio: ((UInt64, Data) -> Void)?
    /// A protocol event for the host (capture-started, capture-stopped, capture-error). Any thread.
    public var onEvent: (([String: Any]) -> Void)?
    /// Asked before each video frame goes out: false (the pipe to the host is backed up) drops it.
    public var canSendVideo: () -> Bool = { true }
    public var log: (String) -> Void = { _ in }

    private let videoQueue = DispatchQueue(label: "perch.video", qos: .userInteractive)
    private let audioQueue = DispatchQueue(label: "perch.audio", qos: .userInteractive)
    private let lock = NSLock()
    private var generation = 0
    private var current: CaptureSession?
    private var pendingKbps: Int?
    /// Commands run one at a time, in order. Main thread only.
    private var chain: Task<Void, Never>?

    public init(synthetic: Bool) { self.synthetic = synthetic }

    /// The display being captured, if any (input coordinates map onto it).
    public var displayID: UInt32? { lock.withLock { current?.display.id } }
    public var isCapturing: Bool { lock.withLock { current != nil } }

    /// Starts capture, or changes what is being captured. Main thread.
    public func capture(_ request: CaptureRequest) {
        let gen = nextGeneration()
        lock.withLock { pendingKbps = nil }
        enqueue { [self] in await start(request, generation: gen) }
    }

    /// Stops capture. `notify` false is for when there is no host left to tell. Main thread.
    public func stop(reason: String, notify: Bool = true) {
        let gen = nextGeneration()
        enqueue { [self] in
            guard isLatest(gen) else { return }
            await teardown()
            if notify { onEvent?(["e": "capture-stopped", "reason": reason]) }
        }
    }

    public func keyframe() { lock.withLock { current }?.keyframe() }

    public func setBitrate(kbps: Int) {
        let s = lock.withLock { () -> CaptureSession? in pendingKbps = kbps; return current }
        s?.setBitrate(kbps: kbps)
    }

    /// Calls `done` (on any thread) once every command queued so far has finished. Main thread.
    public func whenSettled(_ done: @escaping () -> Void) {
        let pending = chain
        Task { await pending?.value; done() }
    }

    // MARK: internals

    private func enqueue(_ op: @escaping () async -> Void) {
        let previous = chain
        chain = Task { await previous?.value; await op() }
    }

    private func nextGeneration() -> Int { lock.withLock { generation += 1; return generation } }
    /// A command already followed by a newer one is skipped: only the newest capture setting matters.
    private func isLatest(_ gen: Int) -> Bool { lock.withLock { gen == generation } }

    private func start(_ request: CaptureRequest, generation gen: Int) async {
        guard isLatest(gen) else { return }
        guard let display = Displays.find(request.displayID, synthetic: synthetic) else {
            onEvent?(["e": "capture-error", "code": "capture-failed", "message": "This Mac has no display to capture."])
            return
        }
        if let wanted = request.displayID, wanted != display.id {
            log("display \(wanted) is not connected; capturing display \(display.id) instead")
        }
        let size = CaptureSizing.outputSize(pixelWidth: display.pixelWidth, pixelHeight: display.pixelHeight, maxEdge: request.maxEdge)
        if let cur = lock.withLock({ current }), cur.display.id == display.id, cur.width == size.width, cur.height == size.height,
           cur.request.fps == request.fps, cur.request.audio == request.audio {
            // Same picture: keep the stream running, take the new bitrate, and send a keyframe so whoever asked
            // can start at once.
            cur.setBitrate(kbps: request.kbps)
            cur.keyframe()
            emitStarted(cur)
            return
        }
        if !synthetic && !CGPreflightScreenCaptureAccess() {
            await teardown()
            onEvent?(["e": "capture-error", "code": "no-screen-permission",
                      "message": "Perch needs Screen Recording permission to show this Mac's screen."])
            return
        }
        await teardown()
        var session: CaptureSession?
        do {
            let s = try CaptureSession(request: request, display: display, synthetic: synthetic,
                                       videoQueue: videoQueue, audioQueue: audioQueue)
            session = s
            s.canSend = { [weak self] in self?.canSendVideo() ?? false }
            s.log = { [weak self] in self?.log($0) }
            s.onVideo = { [weak self] frame in self?.onVideo?(frame) }
            s.onAudio = { [weak self] pts, packet in self?.onAudio?(pts, packet) }
            s.onFailure = { [weak self, weak s] error in
                DispatchQueue.main.async { if let self, let s { self.failed(s, error) } }
            }
            try await s.start()
            let kbps = lock.withLock { () -> Int? in current = s; return pendingKbps }
            if let kbps { s.setBitrate(kbps: kbps) }
            log("capture started: display \(display.id) at \(s.width)x\(s.height), \(request.fps) fps, \(request.kbps) kbit/s, audio \(request.audio)")
            emitStarted(s)
        } catch {
            await session?.stop()
            log("capture failed to start: \(error)")
            onEvent?(["e": "capture-error", "code": Self.errorCode(error), "message": Self.message(error)])
        }
    }

    private func teardown() async {
        guard let s = lock.withLock({ () -> CaptureSession? in defer { current = nil }; return current }) else { return }
        await s.stop()
    }

    /// ScreenCaptureKit ended the stream on its own (permission taken away, display unplugged...).
    private func failed(_ session: CaptureSession, _ error: Error) {
        enqueue { [self] in
            guard lock.withLock({ current === session }) else { return }
            log("capture stopped by the system: \(error)")
            await teardown()
            onEvent?(["e": "capture-error", "code": Self.errorCode(error), "message": Self.message(error)])
            onEvent?(["e": "capture-stopped", "reason": "error"])
        }
    }

    private func emitStarted(_ s: CaptureSession) {
        onEvent?(["e": "capture-started", "display": Int(s.display.id), "width": s.width, "height": s.height, "fps": s.request.fps])
    }

    static func errorCode(_ error: Error) -> String {
        let ns = error as NSError
        if ns.domain == SCStreamErrorDomain && ns.code == SCStreamError.Code.userDeclined.rawValue { return "no-screen-permission" }
        return "capture-failed"
    }

    static func message(_ error: Error) -> String {
        errorCode(error) == "no-screen-permission"
            ? "Perch needs Screen Recording permission to show this Mac's screen."
            : "Couldn't capture the screen: \((error as NSError).localizedDescription)"
    }
}
