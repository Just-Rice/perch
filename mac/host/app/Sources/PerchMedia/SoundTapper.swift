// The Mac's sound kept off its own speakers for a whole viewer session: one Core Audio tap (SystemAudioTap) and
// Perch's own copy for the speakers (SpeakerMonitor), owned by CaptureController rather than by a capture session.
// Captures come and go inside one session (another display, a window, a restart after the display slept); when the
// tap went with them, the speakers played in every gap between one capture and the next (November 2026). Now it runs
// from the start of the session, before the first capture, until the session ends.
import Foundation

final class SoundTapper {
    /// 48 kHz interleaved stereo and the host time of its first frame (µs). Core Audio's IO thread.
    var onPCM: (([Float], UInt64) -> Void)?
    var log: (String) -> Void = { _ in }

    private var tap: AnyObject?            // SystemAudioTap (macOS 14.2+)
    private var monitor: SpeakerMonitor?
    private var resampler: Resampler?

    /// Starts tapping, with Perch's copy playing at `speakers` (0 = nothing). False if the tap couldn't be made.
    func start(speakers: Double, stream: Double) -> Bool {
        guard #available(macOS 14.2, *) else { return false }
        // Perch's own copy for the speakers starts first: Core Audio then knows Perch as a process using sound, and
        // the tap can leave it out.
        let monitor = SpeakerMonitor()
        do { try monitor.start(sampleRate: Double(OpusEncoder.sampleRate)) } catch { log("Mac speakers copy unavailable: \(error)") }
        let t = SystemAudioTap()
        do {
            try t.start(muted: true)
        } catch {
            monitor.stop()
            log("could not take the Mac's sound with a tap (\(error)); its speakers keep playing")
            return false
        }
        if t.excludesPerch {
            monitor.level = speakers
            self.monitor = monitor
        } else {
            // Perch's copy would be tapped too and go round in circles: the speakers stay silent instead.
            monitor.stop()
            log("sound tap: Perch couldn't be left out, so the Mac's speakers stay silent")
        }
        let resampler = t.sampleRate == Double(OpusEncoder.sampleRate) ? nil : Resampler(from: t.sampleRate)
        self.resampler = resampler
        let copy = self.monitor
        t.onPCM = { [weak self] pcm, pts in
            let at48 = resampler?.convert(pcm) ?? pcm
            copy?.push(at48)
            self?.onPCM?(at48, pts)
        }
        tap = t
        log("sound: taken with a tap (\(Int(t.sampleRate)) Hz) and kept off the Mac's speakers until the session ends; " +
            "Mac speakers \(Int(speakers * 100))%, sent \(Int(stream * 100))%")
        return true
    }

    func setSpeakers(_ level: Double) { monitor?.level = level }

    func stop() {
        if #available(macOS 14.2, *), let t = tap as? SystemAudioTap { t.onPCM = nil; t.stop() }
        if tap != nil { log("sound: tap stopped; the Mac's speakers play as before") }
        tap = nil
        monitor?.stop()
        monitor = nil
        resampler = nil
    }

    deinit { stop() }
}
