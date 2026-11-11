// `Perch --mic-check`: proves on this Mac that a viewer's microphone can be played. It opens the Mac's current sound
// output for real and plays one second of silence through the same path a voice would take, so nothing is heard.
import Foundation
import PerchMedia

enum MicCheck {
    static func run() -> Int32 {
        setvbuf(stdout, nil, _IOLBF, 0)
        let outs = AudioOutputs.list()
        print("sound outputs: " + (outs.isEmpty ? "none" : outs.map { "\($0.name)\($0.isDefault ? " (current)" : "")" }.joined(separator: ", ")))
        guard let enc = try? OpusEncoder() else { print("FAIL could not make an Opus encoder"); return 1 }
        let player = MicPlayer(dryRun: false)
        do { try player.start(deviceUID: nil) } catch { print("FAIL could not open the sound output: \(error)"); return 1 }
        var seq: UInt16 = 0
        for _ in 0..<50 {
            for p in enc.encode([Float](repeating: 0, count: 1920)) {
                player.push(Data([UInt8(seq >> 8), UInt8(seq & 0xff)]) + p)
                seq &+= 1
            }
            usleep(20_000) // paced like a real voice
        }
        usleep(500_000)
        let s = player.current, pending = player.pending
        player.stop()
        let played = s.packets == 50 && s.skipped == 0 && pending == 0
        print("\(played ? "PASS" : "FAIL") one second played through the sound output (\(s.packets) packets, \(s.skipped) skipped, \(pending) frames left over)")
        var refused = false
        do { try player.start(deviceUID: "no-such-output") } catch { refused = true }
        player.stop()
        print("\(refused ? "PASS" : "FAIL") an output that isn't connected is refused")
        return played && refused ? 0 : 1
    }
}
