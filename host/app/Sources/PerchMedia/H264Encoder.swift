// VideoToolbox H.264 encoder tuned for a remote screen, and AVCC → Annex-B conversion.
//
// What the capture spike measured on this Mac (M2, macOS 27) and why the settings are what they are:
//  * kVTVideoEncoderSpecification_EnableLowLatencyRateControl gives ~3–7 ms encode latency and holds the target
//    bitrate by dropping frames rather than overshooting. It never makes a keyframe by itself after the first one,
//    so the caller asks for every keyframe it needs.
//  * Constrained Baseline is what the WebRTC offer promises (profile-level-id 42e01f), and every browser decodes it.
//  * Bitrate is controlled only through AverageBitRate (DataRateLimits is accepted but does nothing in this mode;
//    AverageBitRate = 0 breaks the encoder). MaxAllowedFrameQP 51 lets it go blurry instead of stalling on
//    complex content.
//  * The first frame of a new session takes ~220 ms; warmUp() pays that before a viewer is waiting.
import Foundation
import VideoToolbox
import CoreMedia
import CoreVideo

public struct EncodedFrame {
    public let annexB: Data
    public let ptsMicros: UInt64
    public let isKeyframe: Bool
    /// NAL unit types in order (7 SPS, 8 PPS, 5 IDR slice, 1 other slice, 6 SEI).
    public let nalTypes: [UInt8]
}

public enum H264EncoderError: Error, CustomStringConvertible {
    case createFailed(OSStatus)
    case noProfile
    case prepareFailed(OSStatus)
    public var description: String {
        switch self {
        case .createFailed(let s): return "VTCompressionSessionCreate failed (OSStatus \(s))"
        case .noProfile: return "the encoder accepted neither Constrained Baseline nor Baseline"
        case .prepareFailed(let s): return "VTCompressionSessionPrepareToEncodeFrames failed (OSStatus \(s))"
        }
    }
}

public final class H264Encoder {
    public let width: Int
    public let height: Int
    public private(set) var profile: String?
    /// Called on a VideoToolbox thread for each encoded frame.
    public var onFrame: ((EncodedFrame) -> Void)?
    /// Called on a VideoToolbox thread when a frame was dropped by rate control or failed.
    public var onDrop: ((_ status: OSStatus, _ wasForcedKeyframe: Bool) -> Void)?

    private var session: VTCompressionSession?
    private var warming = false

    public init(width: Int, height: Int, fps: Int, bitsPerSecond: Int) throws {
        self.width = width
        self.height = height
        let spec = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true] as CFDictionary
        var s: VTCompressionSession?
        let st = VTCompressionSessionCreate(allocator: kCFAllocatorDefault, width: Int32(width), height: Int32(height),
                                            codecType: kCMVideoCodecType_H264, encoderSpecification: spec,
                                            imageBufferAttributes: nil, compressedDataAllocator: nil,
                                            outputCallback: nil, refcon: nil, compressionSessionOut: &s)
        guard st == noErr, let session = s else { throw H264EncoderError.createFailed(st) }
        self.session = session

        for p in [kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel, kVTProfileLevel_H264_Baseline_AutoLevel] {
            if VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: p) == noErr {
                profile = p as String
                break
            }
        }
        guard profile != nil else { invalidate(); throw H264EncoderError.noProfile }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: max(bitsPerSecond, 50_000) as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxAllowedFrameQP, value: 51 as CFNumber)
        // Keyframes come only when asked for; don't let a periodic one surprise the bitrate budget.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: Int32.max as CFNumber)
        // BT.709 in the SPS (what browsers assume for HD video), matching the 420v buffers we feed in.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ColorPrimaries, value: kCVImageBufferColorPrimaries_ITU_R_709_2)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_TransferFunction, value: kCVImageBufferTransferFunction_ITU_R_709_2)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_YCbCrMatrix, value: kCVImageBufferYCbCrMatrix_ITU_R_709_2)
        let pst = VTCompressionSessionPrepareToEncodeFrames(session)
        if pst != noErr { invalidate(); throw H264EncoderError.prepareFailed(pst) }
    }

    deinit { invalidate() }

    public func invalidate() {
        guard let s = session else { return }
        session = nil
        VTCompressionSessionCompleteFrames(s, untilPresentationTimeStamp: .invalid)
        VTCompressionSessionInvalidate(s)
    }

    /// Encodes one black frame and throws the result away, so the slow first encode of a new session happens now
    /// rather than on the frame a viewer is waiting for. Blocks until it is done. The caller must ask for a keyframe
    /// on the next real frame (the warm-up's own keyframe never reaches anyone).
    public func warmUp(ptsMicros: UInt64) {
        guard let s = session, let pb = Self.blackFrame(width: width, height: height) else { return }
        warming = true
        encode(pb, ptsMicros: ptsMicros, forceKeyframe: true)
        VTCompressionSessionCompleteFrames(s, untilPresentationTimeStamp: .invalid)
        warming = false
    }

    @discardableResult
    public func setBitRate(_ bitsPerSecond: Int) -> OSStatus {
        guard let s = session else { return -1 }
        return VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate, value: max(bitsPerSecond, 50_000) as CFNumber)
    }

    @discardableResult
    public func encode(_ pixelBuffer: CVPixelBuffer, ptsMicros: UInt64, forceKeyframe: Bool) -> OSStatus {
        guard let s = session else { return -1 }
        let props = forceKeyframe ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] as CFDictionary : nil
        let pts = CMTime(value: CMTimeValue(ptsMicros), timescale: 1_000_000)
        return VTCompressionSessionEncodeFrame(s, imageBuffer: pixelBuffer, presentationTimeStamp: pts, duration: .invalid,
                                               frameProperties: props, infoFlagsOut: nil) { [weak self] status, flags, sb in
            guard let self, !self.warming else { return }
            guard status == noErr, !flags.contains(.frameDropped), let sb, let frame = AnnexB.frame(from: sb, ptsMicros: ptsMicros) else {
                self.onDrop?(status, forceKeyframe)
                return
            }
            self.onFrame?(frame)
        }
    }

    /// Blocks until every submitted frame has come out.
    public func flush() {
        guard let s = session else { return }
        VTCompressionSessionCompleteFrames(s, untilPresentationTimeStamp: .invalid)
    }

    /// A video-range black 420v buffer (Y 16, Cb/Cr 128).
    static func blackFrame(width: Int, height: Int) -> CVPixelBuffer? {
        let attrs: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
        var out: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                                  attrs as CFDictionary, &out) == kCVReturnSuccess, let pb = out else { return nil }
        CVPixelBufferLockBaseAddress(pb, [])
        defer { CVPixelBufferUnlockBaseAddress(pb, []) }
        if let y = CVPixelBufferGetBaseAddressOfPlane(pb, 0) {
            memset(y, 16, CVPixelBufferGetBytesPerRowOfPlane(pb, 0) * CVPixelBufferGetHeightOfPlane(pb, 0))
        }
        if let c = CVPixelBufferGetBaseAddressOfPlane(pb, 1) {
            memset(c, 128, CVPixelBufferGetBytesPerRowOfPlane(pb, 1) * CVPixelBufferGetHeightOfPlane(pb, 1))
        }
        return pb
    }
}

/// VideoToolbox hands out AVCC (length-prefixed NAL units, parameter sets kept in the format description). The host
/// and WebRTC want Annex-B (start codes), with SPS and PPS in front of every keyframe so a viewer can start at any one.
public enum AnnexB {
    public static let startCode: [UInt8] = [0, 0, 0, 1]

    public static func isKeyframe(_ sb: CMSampleBuffer) -> Bool {
        guard let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]],
              let first = arr.first else { return true } // no attachments means a sync sample
        return !((first[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
    }

    public static func parameterSets(_ fd: CMFormatDescription) -> (sets: [Data], nalLengthSize: Int) {
        var count = 0
        var nalLen: Int32 = 4
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fd, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                           parameterSetSizeOut: nil, parameterSetCountOut: &count,
                                                           nalUnitHeaderLengthOut: &nalLen)
        var sets: [Data] = []
        for i in 0..<count {
            var p: UnsafePointer<UInt8>?
            var size = 0
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fd, parameterSetIndex: i, parameterSetPointerOut: &p,
                                                                  parameterSetSizeOut: &size, parameterSetCountOut: nil,
                                                                  nalUnitHeaderLengthOut: nil) == noErr, let p {
                sets.append(Data(bytes: p, count: size))
            }
        }
        return (sets, Int(nalLen))
    }

    public static func frame(from sb: CMSampleBuffer, ptsMicros: UInt64) -> EncodedFrame? {
        guard let bb = CMSampleBufferGetDataBuffer(sb), let fd = CMSampleBufferGetFormatDescription(sb) else { return nil }
        let key = isKeyframe(sb)
        let (sets, nalLengthSize) = parameterSets(fd)
        let total = CMBlockBufferGetDataLength(bb)
        var avcc = Data(count: total)
        let copied = avcc.withUnsafeMutableBytes {
            CMBlockBufferCopyDataBytes(bb, atOffset: 0, dataLength: total, destination: $0.baseAddress!)
        }
        guard copied == kCMBlockBufferNoErr else { return nil }
        return fromAVCC(avcc, parameterSets: key ? sets : [], nalLengthSize: nalLengthSize, isKeyframe: key, ptsMicros: ptsMicros)
    }

    /// The conversion itself, separate from CoreMedia so the self-test can feed it hand-made input.
    public static func fromAVCC(_ avcc: Data, parameterSets: [Data], nalLengthSize: Int, isKeyframe key: Bool,
                                ptsMicros: UInt64) -> EncodedFrame {
        var out = Data(capacity: avcc.count + 64)
        var types: [UInt8] = []
        for ps in parameterSets {
            out.append(contentsOf: startCode); out.append(ps)
            if let b = ps.first { types.append(b & 0x1f) }
        }
        avcc.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let p = raw.bindMemory(to: UInt8.self)
            var off = 0
            while off + nalLengthSize <= p.count {
                var len = 0
                for i in 0..<nalLengthSize { len = (len << 8) | Int(p[off + i]) }
                off += nalLengthSize
                guard len > 0, off + len <= p.count else { break }
                let nalType = p[off] & 0x1f
                // Access unit delimiters are useless here, and in-band SPS/PPS would duplicate the ones put in front.
                if nalType == 9 || (key && (nalType == 7 || nalType == 8)) { off += len; continue }
                types.append(nalType)
                out.append(contentsOf: startCode)
                out.append(UnsafeBufferPointer(rebasing: p[off..<(off + len)]))
                off += len
            }
        }
        return EncodedFrame(annexB: out, ptsMicros: ptsMicros, isKeyframe: key, nalTypes: types)
    }

    /// Splits an Annex-B stream at its start codes (3- or 4-byte), returning each NAL unit without the start code.
    public static func split(_ data: Data) -> [Data] {
        let b = [UInt8](data)
        var units: [Data] = []
        var i = 0, start = -1
        while i + 2 < b.count {
            if b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1 {
                if start >= 0 {
                    var end = i
                    if end > start && b[end - 1] == 0 { end -= 1 }
                    units.append(Data(b[start..<end]))
                }
                i += 3
                start = i
            } else {
                i += 1
            }
        }
        if start >= 0 && start < b.count { units.append(Data(b[start...])) }
        return units
    }
}
