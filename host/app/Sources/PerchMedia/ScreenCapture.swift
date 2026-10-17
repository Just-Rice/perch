// ScreenCaptureKit: one display's picture and the Mac's sound in a single stream.
//
// Spike findings this relies on (macOS 27):
//  * SCK only sends a pixel buffer when something on screen changed; a still screen can go seconds with nothing.
//    The capture session keeps the last buffer and re-encodes it itself (see CaptureController).
//  * Audio arrives as Float32, non-interleaved, 48 kHz stereo, 960 frames (20 ms) per buffer, silence included.
//  * Screen Recording permission belongs to the "responsible" process: Perch.app when launched normally, the
//    terminal when the binary is run from one.
//  * A display that has gone to sleep (often behind the lock screen) is missing from SCShareableContent's list until
//    it wakes, and waking takes a second or two. That is exactly the Mac someone connects to, so start() wakes the
//    display and waits for it instead of failing (seen on macOS 27: "display 1 is not available" every time the
//    locked Mac's display was off when capture began).
import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import CoreGraphics
import AudioToolbox
import IOKit.pwr_mgt

public final class ScreenCapturer: NSObject, SCStreamOutput, SCStreamDelegate {
    /// A new picture (complete frames only) and its capture time, on the video queue.
    public var onVideo: ((CVPixelBuffer, CMTime) -> Void)?
    /// A buffer of system audio, on the audio queue.
    public var onAudio: ((CMSampleBuffer) -> Void)?
    /// The stream ended by itself (permission revoked, display gone...).
    public var onStop: ((Error) -> Void)?
    public var log: (String) -> Void = { _ in }

    private var stream: SCStream?
    private let videoQueue: DispatchQueue
    private let audioQueue: DispatchQueue

    /// How long start() waits for a sleeping display to wake up and become capturable.
    public static let displayWakeTimeout: TimeInterval = 6

    public init(videoQueue: DispatchQueue, audioQueue: DispatchQueue) {
        self.videoQueue = videoQueue
        self.audioQueue = audioQueue
        super.init()
    }

    public func start(displayID: UInt32, width: Int, height: Int, fps: Int, audio: Bool) async throws {
        let display = try await capturableDisplay(displayID)
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let c = SCStreamConfiguration()
        c.width = width
        c.height = height
        c.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        // Video-range NV12 with BT.709, which is what the encoder signals and what browsers expect.
        c.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        c.colorMatrix = kCVImageBufferYCbCrMatrix_ITU_R_709_2
        c.colorSpaceName = CGColorSpace.sRGB
        c.showsCursor = true
        c.queueDepth = 5
        // Capture at full Retina detail only when the output is bigger than the display's size in points.
        c.captureResolution = width > display.width ? .best : .nominal
        c.capturesAudio = audio
        c.sampleRate = OpusEncoder.sampleRate
        c.channelCount = 2
        c.excludesCurrentProcessAudio = true

        let s = SCStream(filter: filter, configuration: c, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: videoQueue)
        if audio { try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue) }
        try await s.startCapture()
        stream = s
    }

    public func stop() async {
        guard let s = stream else { return }
        stream = nil
        try? await s.stopCapture()
    }

    /// The display as ScreenCaptureKit knows it. If it isn't listed (asleep), wake it the way a key press would and
    /// look again every quarter second, for up to `displayWakeTimeout`. Capture only ever starts for a signed-in
    /// viewer, who should see the screen (or the lock screen) rather than an error. The wake request is let go once
    /// the display is back; while a viewer is connected the session keeps the display on (see Power in the app).
    private func capturableDisplay(_ id: UInt32) async throws -> SCDisplay {
        let deadline = Date().addingTimeInterval(Self.displayWakeTimeout)
        var wake: IOPMAssertionID = 0
        var asked = false
        defer { if wake != 0 { IOPMAssertionRelease(wake) } }
        let started = Date()
        while true {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            if let d = content.displays.first(where: { $0.displayID == id }) {
                if asked { log("display \(id) became capturable after \(Int(Date().timeIntervalSince(started) * 1000)) ms") }
                return d
            }
            if Date() >= deadline {
                throw NSError(domain: "Perch", code: 1, userInfo: [NSLocalizedDescriptionKey:
                    "display \(id) is not available to capture (still asleep or gone after \(Int(Self.displayWakeTimeout)) s)"])
            }
            if !asked {
                asked = true
                log("display \(id) isn't capturable yet (asleep: \(CGDisplayIsAsleep(id) != 0)); waking it")
                let r = IOPMAssertionDeclareUserActivity("Perch is showing this Mac's screen to a viewer" as CFString,
                                                         kIOPMUserActiveLocal, &wake)
                if r != kIOReturnSuccess { log("could not wake the display (IOReturn \(r))"); wake = 0 }
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
    }

    public func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sb.isValid else { return }
        switch type {
        case .screen:
            // Idle/blank/suspended buffers carry no new picture.
            guard Self.frameStatus(of: sb) ?? .complete == .complete, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
            onVideo?(pb, CMSampleBufferGetPresentationTimeStamp(sb))
        case .audio:
            onAudio?(sb)
        default:
            break
        }
    }

    public func stream(_ stream: SCStream, didStopWithError error: Error) {
        onStop?(error)
    }

    static func frameStatus(of sb: CMSampleBuffer) -> SCFrameStatus? {
        guard let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = arr.first?[.status] as? Int else { return nil }
        return SCFrameStatus(rawValue: raw)
    }

    /// Copies an SCK audio buffer into interleaved Float32 (what the Opus encoder takes), with its frame count.
    public static func interleavedFloat32(from sb: CMSampleBuffer) -> [Float]? {
        guard let fd = CMSampleBufferGetFormatDescription(sb),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee,
              asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0, asbd.mBitsPerChannel == 32 else { return nil }
        let frames = CMSampleBufferGetNumSamples(sb)
        let ch = Int(asbd.mChannelsPerFrame)
        guard frames > 0, ch > 0 else { return nil }
        var needed = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sb, bufferListSizeNeededOut: &needed, bufferListOut: nil,
                                                                bufferListSize: 0, blockBufferAllocator: nil,
                                                                blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        guard needed > 0 else { return nil }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: needed, alignment: 16)
        defer { raw.deallocate() }
        let abl = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        var block: CMBlockBuffer?
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sb, bufferListSizeNeededOut: nil, bufferListOut: abl,
                                                                      bufferListSize: needed, blockBufferAllocator: nil,
                                                                      blockBufferMemoryAllocator: nil,
                                                                      flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
                                                                      blockBufferOut: &block) == noErr else { return nil }
        let list = UnsafeMutableAudioBufferListPointer(abl)
        // Always produce stereo: mono is copied to both sides, extra channels are dropped.
        var out = [Float](repeating: 0, count: frames * 2)
        if asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0 {
            for c in 0..<2 {
                let src = min(c, list.count - 1)
                guard src >= 0, let p = list[src].mData?.assumingMemoryBound(to: Float.self) else { continue }
                let n = min(frames, Int(list[src].mDataByteSize) / 4)
                for i in 0..<n { out[i * 2 + c] = p[i] }
            }
        } else if let p = list[0].mData?.assumingMemoryBound(to: Float.self) {
            let n = min(frames, Int(list[0].mDataByteSize) / 4 / ch)
            for i in 0..<n {
                out[i * 2] = p[i * ch]
                out[i * 2 + 1] = p[i * ch + min(1, ch - 1)]
            }
        }
        return out
    }
}
