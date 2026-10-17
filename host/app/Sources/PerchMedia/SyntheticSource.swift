// A moving test pattern and a test tone, for --synthetic: tests and CI machines get real H.264 and Opus without
// Screen Recording permission (or a screen at all).
//
// The picture (video-range 420v, like real captures):
//   * a diagonal gradient that scrolls 4 px a frame, so every frame has motion (realistic P-frames);
//   * a bouncing white square, easy to follow by eye;
//   * the frame number as 32 black/white blocks across the top 16 rows (bit 0 on the left), so a receiver can read
//     back which frame it got, for loss and latency tests.
import Foundation
import CoreVideo

public final class SyntheticVideoSource {
    public let width: Int
    public let height: Int
    private var pool: CVPixelBufferPool?

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
        let attrs: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferWidthKey: width,
            kCVPixelBufferHeightKey: height,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary, // IOSurface-backed: no copy into VideoToolbox
        ]
        CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &pool)
    }

    /// Width of one frame-counter block.
    public static func counterBlock(width: Int) -> Int { max(width / 32, 1) }

    public func makeFrame(index: Int) -> CVPixelBuffer? {
        guard let pool else { return nil }
        var out: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &out) == kCVReturnSuccess, let pb = out else { return nil }
        CVBufferSetAttachment(pb, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
        CVBufferSetAttachment(pb, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
        CVBufferSetAttachment(pb, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
        CVPixelBufferLockBaseAddress(pb, [])
        defer { CVPixelBufferUnlockBaseAddress(pb, []) }

        let shift = index * 4
        let box = max(min(width, height) / 8, 16)
        let bx = bounce(index * 7, range: width - box)
        let by = bounce(index * 5, range: height - box)
        let block = Self.counterBlock(width: width)
        let counter = UInt32(truncatingIfNeeded: index)

        // Luma: video range is 16 (black) to 235 (white).
        let yBase = CVPixelBufferGetBaseAddressOfPlane(pb, 0)!.assumingMemoryBound(to: UInt8.self)
        let yStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
        for y in 0..<height {
            let row = yBase + y * yStride
            if y < 16 {
                for x in 0..<width { row[x] = (counter >> UInt32(min(x / block, 31))) & 1 == 1 ? 235 : 16 }
                continue
            }
            let inBoxRow = y >= by && y < by + box
            for x in 0..<width {
                row[x] = inBoxRow && x >= bx && x < bx + box ? 235 : UInt8(16 + (x + y + shift) % 220)
            }
        }
        // Chroma: interleaved Cb/Cr at half resolution, 16–240 with 128 as grey.
        let cBase = CVPixelBufferGetBaseAddressOfPlane(pb, 1)!.assumingMemoryBound(to: UInt8.self)
        let cStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 1)
        for y in 0..<(height / 2) {
            let row = cBase + y * cStride
            let grey = y * 2 < 16 || (y * 2 >= by && y * 2 < by + box)
            for x in 0..<(width / 2) {
                if grey && (y * 2 < 16 || (x * 2 >= bx && x * 2 < bx + box)) {
                    row[x * 2] = 128; row[x * 2 + 1] = 128
                } else {
                    row[x * 2] = UInt8(16 + (x + shift / 2) % 224)
                    row[x * 2 + 1] = UInt8(240 - (y + shift / 2) % 224)
                }
            }
        }
        return pb
    }

    private func bounce(_ t: Int, range: Int) -> Int {
        guard range > 0 else { return 0 }
        let m = t % (2 * range)
        return m < range ? m : 2 * range - m
    }
}

/// A 440 Hz sine, the same in both channels, as 48 kHz interleaved Float32 stereo.
public final class ToneGenerator {
    public let frequency: Double
    public let amplitude: Float
    private var phase = 0.0

    public init(frequency: Double = 440, amplitude: Float = 0.2) {
        self.frequency = frequency
        self.amplitude = amplitude
    }

    public func next(frames: Int) -> [Float] {
        var out = [Float](repeating: 0, count: frames * 2)
        let step = 2 * Double.pi * frequency / Double(OpusEncoder.sampleRate)
        for i in 0..<frames {
            let v = amplitude * Float(sin(phase))
            out[2 * i] = v
            out[2 * i + 1] = v
            phase += step
            if phase > 2 * Double.pi { phase -= 2 * Double.pi }
        }
        return out
    }
}
