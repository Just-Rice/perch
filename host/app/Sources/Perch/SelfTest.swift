// `Perch --selftest`: in-process checks of the pieces that don't need a host, a screen or permissions. Prints one
// PASS/FAIL line per check and exits non-zero if any failed. (Command Line Tools have no XCTest, so this is the
// unit-test suite.) Nothing here posts input, prompts for anything or touches the network.
import Foundation
import CoreGraphics
import CoreVideo
import VideoToolbox
import PerchCore
import PerchMedia

enum SelfTest {
    private static var passed = 0
    private static var failed = 0

    private static func check(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
        if ok { passed += 1; print("PASS \(name)") } else { failed += 1; print("FAIL \(name)\(detail().isEmpty ? "" : ": " + detail())") }
    }

    static func run() -> Int32 {
        setvbuf(stdout, nil, _IOLBF, 0)
        keymap()
        ipcFraming()
        annexBConversion()
        h264Encode()
        opus()
        inputPlanning()
        cgEvents()
        sizing()
        syntheticPattern()
        menuModel()
        print("selftest: \(passed) passed, \(failed) failed")
        return failed == 0 ? 0 : 1
    }

    // MARK: key map

    private static func keymap() {
        let missing = KeyMap.required.filter { KeyMap.keyCode(for: $0) == nil }
        check("keymap covers all \(KeyMap.required.count) required codes", missing.isEmpty, "missing \(missing)")
        let spots: [String: UInt16] = [
            "KeyA": 0, "KeyS": 1, "KeyZ": 6, "KeyQ": 12, "KeyM": 46, "Digit1": 18, "Digit0": 29, "Minus": 27, "Equal": 24,
            "BracketLeft": 33, "Backslash": 42, "Semicolon": 41, "Quote": 39, "Backquote": 50, "Comma": 43, "Slash": 44,
            "Enter": 36, "NumpadEnter": 76, "Tab": 48, "Space": 49, "Backspace": 51, "Delete": 117, "Escape": 53,
            "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126, "Home": 115, "End": 119,
            "PageUp": 116, "PageDown": 121, "F1": 122, "F5": 96, "F12": 111, "F13": 105, "F19": 80, "F20": 90,
            "Numpad0": 82, "Numpad9": 92, "NumpadAdd": 69, "NumpadDecimal": 65, "ShiftLeft": 56, "ShiftRight": 60,
            "ControlLeft": 59, "ControlRight": 62, "AltLeft": 58, "AltRight": 61, "MetaLeft": 55, "MetaRight": 54,
            "CapsLock": 57,
        ]
        let wrong = spots.filter { KeyMap.keyCode(for: $0.key) != $0.value }.map { "\($0.key)=\(KeyMap.keyCode(for: $0.key).map(String.init) ?? "nil") want \($0.value)" }
        check("keymap spot values (\(spots.count))", wrong.isEmpty, wrong.joined(separator: ", "))
        // Distinct keys must not share a key code (a few names are deliberate aliases).
        let aliases: Set<String> = ["Help", "OSLeft", "OSRight", "PrintScreen", "ScrollLock", "Pause"]
        var seen: [UInt16: String] = [:]
        var clashes: [String] = []
        for (name, code) in KeyMap.codes.sorted(by: { $0.key < $1.key }) where !aliases.contains(name) {
            if let other = seen[code] { clashes.append("\(other)/\(name)=\(code)") } else { seen[code] = name }
        }
        check("keymap has no accidental duplicates", clashes.isEmpty, clashes.joined(separator: ", "))
        check("keymap modifier kinds", KeyMap.modifier(for: 56) == .shift && KeyMap.modifier(for: 54) == .command
              && KeyMap.modifier(for: 61) == .option && KeyMap.modifier(for: 62) == .control && KeyMap.modifier(for: 0) == nil)
    }

    // MARK: IPC

    private static func ipcFraming() {
        var rng = SystemRandomNumberGenerator()
        let types: [FrameType] = [.hello, .video, .audio, .event, .command, .input]
        var sent: [(UInt8, Data)] = []
        var stream = Data()
        for i in 0..<200 {
            let t = types[i % types.count]
            let n = i == 7 ? 0 : Int.random(in: 0..<3000, using: &rng)
            let payload = Data((0..<n).map { _ in UInt8.random(in: 0...255, using: &rng) })
            sent.append((t.rawValue, payload))
            stream.append(IPC.frame(t, payload))
        }
        var parser = FrameParser()
        var got: [(UInt8, Data)] = []
        var off = 0
        do {
            while off < stream.count {
                let n = min(Int.random(in: 1...700, using: &rng), stream.count - off)
                got += try parser.push(stream.subdata(in: off..<(off + n))).map { ($0.type, $0.payload) }
                off += n
            }
        } catch {
            check("ipc framing round trip", false, "\(error)")
            return
        }
        let same = got.count == sent.count && zip(got, sent).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
        check("ipc framing round trip (200 frames, random chunks)", same && parser.buffered == 0, "got \(got.count) frames")

        let f = IPC.frame(.event, Data("{}".utf8))
        check("ipc frame header is u32 BE length of type+payload", [UInt8](f.prefix(5)) == [0, 0, 0, 3, 0x04])
        var tooBig = FrameParser(maxFrame: 100)
        var threw = false
        do { _ = try tooBig.push(Data([0, 0, 0, 200, 0x10])) } catch { threw = true }
        check("ipc parser rejects oversized frames", threw)
        var zero = FrameParser()
        threw = false
        do { _ = try zero.push(Data([0, 0, 0, 0])) } catch { threw = true }
        check("ipc parser rejects a zero-length frame", threw)
        var partial = FrameParser()
        let half = (try? partial.push(f.prefix(4))) ?? []
        let rest = (try? partial.push(f.dropFirst(4))) ?? []
        check("ipc parser waits for the rest of a frame", half.isEmpty && rest.count == 1)

        let v = IPC.videoPayload(keyframe: true, ptsMicros: 0x0102_0304_0506_0708, annexB: Data([0, 0, 0, 1, 0x65]))
        check("video payload: flags, u64 BE pts, Annex-B", [UInt8](v) == [1, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 1, 0x65])
        let a = IPC.audioPayload(ptsMicros: 20_000, packet: Data([0xfc, 1]))
        check("audio payload: u64 BE pts, packet", [UInt8](a) == [0, 0, 0, 0, 0, 0, 0x4e, 0x20, 0xfc, 1])
        let obj = IPC.parseObject(IPC.json(["e": "x", "n": 3, "url": "http://a/b"]))
        check("ipc json round trip (slashes unescaped)", JSONValue.string(obj?["e"]) == "x" && JSONValue.int(obj?["n"]) == 3
              && String(decoding: IPC.json(["u": "a/b"]), as: UTF8.self) == "{\"u\":\"a/b\"}")
        check("json booleans are not numbers", JSONValue.number(true as NSNumber) == nil && JSONValue.bool(true as NSNumber) == true
              && JSONValue.bool(1 as NSNumber) == nil)
    }

    // MARK: Annex-B

    private static func annexBConversion() {
        let sps = Data([0x67, 0x42, 0xc0, 0x1f, 0xaa]), pps = Data([0x68, 0xce, 0x3c, 0x80])
        // AVCC with 4-byte lengths: an AUD (dropped), an in-band SPS (dropped on keyframes), an IDR slice.
        var avcc = Data()
        for nal in [Data([0x09, 0xf0]), sps, Data([0x65, 1, 2, 3])] { avcc.appendBigEndian(UInt32(nal.count)); avcc.append(nal) }
        let key = AnnexB.fromAVCC(avcc, parameterSets: [sps, pps], nalLengthSize: 4, isKeyframe: true, ptsMicros: 1)
        check("annexb keyframe = SPS, PPS, IDR with start codes", key.nalTypes == [7, 8, 5]
              && key.annexB == Data([0, 0, 0, 1]) + sps + Data([0, 0, 0, 1]) + pps + Data([0, 0, 0, 1, 0x65, 1, 2, 3]))
        var avcc2 = Data()
        for nal in [Data([0x41, 9, 9]), Data([0x06, 5])] { avcc2.appendBigEndian(UInt16(nal.count)); avcc2.append(nal) }
        let p = AnnexB.fromAVCC(avcc2, parameterSets: [], nalLengthSize: 2, isKeyframe: false, ptsMicros: 2)
        check("annexb delta frame, 2-byte lengths", p.nalTypes == [1, 6] && AnnexB.split(p.annexB) == [Data([0x41, 9, 9]), Data([0x06, 5])])
        let truncated = AnnexB.fromAVCC(Data([0, 0, 0, 9, 0x65]), parameterSets: [], nalLengthSize: 4, isKeyframe: false, ptsMicros: 3)
        check("annexb stops at a truncated NAL unit", truncated.annexB.isEmpty)
    }

    private static func h264Encode() {
        let w = 640, h = 360
        let enc: H264Encoder
        do { enc = try H264Encoder(width: w, height: h, fps: 30, bitsPerSecond: 2_000_000) } catch {
            check("h264 encoder created", false, "\(error)")
            return
        }
        check("h264 encoder uses Constrained Baseline", enc.profile == (kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel as String), enc.profile ?? "none")
        let lock = NSLock()
        var frames: [EncodedFrame] = []
        enc.onFrame = { f in lock.withLock { frames.append(f) } }
        let t0 = Date()
        enc.warmUp(ptsMicros: 1)
        let warmMs = Date().timeIntervalSince(t0) * 1000
        check("h264 warm-up output is discarded", lock.withLock { frames.isEmpty })
        let src = SyntheticVideoSource(width: w, height: h)
        for i in 0..<12 {
            guard let pb = src.makeFrame(index: i) else { check("synthetic frame", false); return }
            enc.encode(pb, ptsMicros: UInt64(100_000 + i * 33_333), forceKeyframe: i == 0 || i == 6)
            usleep(5000)
        }
        enc.flush()
        let out = lock.withLock { frames }
        enc.invalidate()
        guard let first = out.first else { check("h264 produced frames", false); return }
        print("     (warm-up \(Int(warmMs)) ms, \(out.count) frames, first \(first.annexB.count) bytes)")
        check("h264 first frame is a keyframe: SPS, PPS, then IDR", first.isKeyframe && Array(first.nalTypes.prefix(3)) == [7, 8, 5], "\(first.nalTypes)")
        let units = AnnexB.split(first.annexB)
        let spsOK = units.first.map { $0.count >= 4 && $0[$0.startIndex + 1] == 66 && ($0[$0.startIndex + 2] & 0x40) != 0 } ?? false
        check("h264 SPS says Constrained Baseline (profile_idc 66, constraint_set1)", spsOK,
              units.first.map { [UInt8]($0.prefix(4)).map { String(format: "%02x", $0) }.joined() } ?? "no SPS")
        check("h264 Annex-B splits back into the reported NAL units", units.map { $0.first! & 0x1f } == first.nalTypes)
        let keyIdx = out.enumerated().filter { $0.element.isKeyframe }.map(\.offset)
        let forced = out.first { $0.ptsMicros == UInt64(100_000 + 6 * 33_333) }
        check("h264 forced keyframe honoured", forced?.isKeyframe == true && forced.map { Array($0.nalTypes.prefix(2)) == [7, 8] } == true, "keyframes at \(keyIdx)")
        let deltas = out.filter { !$0.isKeyframe }
        check("h264 delta frames carry no SPS/PPS", !deltas.isEmpty && deltas.allSatisfy { !$0.nalTypes.contains(7) && !$0.nalTypes.contains(8) && $0.nalTypes.contains(1) })
        check("h264 pts preserved and increasing", zip(out, out.dropFirst()).allSatisfy { $0.ptsMicros < $1.ptsMicros })
    }

    // MARK: Opus

    private static func opus() {
        let enc: OpusEncoder, dec: OpusDecoder
        do { enc = try OpusEncoder(); dec = try OpusDecoder() } catch { check("opus codec created", false, "\(error)"); return }
        let tone = ToneGenerator(frequency: 440, amplitude: 0.2)
        var packets: [Data] = []
        for _ in 0..<100 { packets += enc.encode(tone.next(frames: 480)) } // 10 ms pieces, like an uneven source
        check("opus: 1 s of audio gives 50 packets", packets.count == 50 && enc.lastStatus == 0, "\(packets.count) packets, status \(enc.lastStatus)")
        let tocs = packets.compactMap(OpusTOC.init)
        check("opus TOC: 20 ms, stereo, one frame per packet", tocs.count == packets.count && tocs.allSatisfy { $0.packetDurationTenthsMs == 200 && $0.stereo && $0.frameCountCode == 0 },
              tocs.prefix(3).map { "config \($0.config) \($0.mode) stereo \($0.stereo) code \($0.frameCountCode)" }.joined(separator: "; "))
        let sizes = packets.map(\.count)
        let bps = Double(sizes.dropFirst().reduce(0, +)) * 8 / (Double(sizes.count - 1) * 0.02)
        check("opus packet sizes and bitrate sane", sizes.allSatisfy { $0 > 10 && $0 < 1500 } && bps > 32_000 && bps < 96_000,
              "sizes \(sizes.min() ?? 0)-\(sizes.max() ?? 0), \(Int(bps)) bit/s")
        var pcm: [Float] = []
        for p in packets { pcm += dec.decode(p) }
        let left = stride(from: 9600, to: pcm.count, by: 2).map { pcm[$0] } // skip the first 100 ms (encoder delay)
        var crossings = 0
        for i in 1..<max(left.count, 1) where (left[i - 1] < 0) != (left[i] < 0) { crossings += 1 }
        let hz = Double(crossings) / 2 / (Double(left.count) / 48_000)
        let rms = (left.reduce(0) { $0 + Double($1 * $1) } / Double(max(left.count, 1))).squareRoot()
        // AudioToolbox's decoder trims a little of its own start-up delay, so allow up to one packet less.
        let frames = pcm.count / 2
        check("opus decodes back to the 440 Hz tone", frames <= 50 * 960 && frames >= 49 * 960 && abs(hz - 440) < 5 && abs(rms - 0.1414) < 0.035,
              "\(pcm.count / 2) frames, \(String(format: "%.1f", hz)) Hz, rms \(String(format: "%.3f", rms))")
    }

    // MARK: input

    private static func inputPlanning() {
        let p = InputPlanner(bounds: CGRect(x: 100, y: 50, width: 1920, height: 1080))
        var e = p.plan(["t": "m", "x": 0.5, "y": 0.5])
        check("input: move maps normalized to global points", e == [PlannedEvent(.move(drag: nil), point: CGPoint(x: 1060, y: 590))], "\(e)")
        e = p.plan(["t": "m", "x": 1.0, "y": -0.2])
        check("input: coordinates clamp inside the display", e.first?.point == CGPoint(x: 2019, y: 50), "\(e)")
        e = p.plan(["t": "b", "b": 0, "d": true, "x": 0.25, "y": 0.25, "n": 1])
        check("input: button down at its own position moves there first", e.map(\.kind) == [.move(drag: nil), .down(.left)] && e.last?.point == CGPoint(x: 580, y: 320), "\(e)")
        e = p.plan(["t": "m", "x": 0.3, "y": 0.3])
        check("input: move with the left button held is a drag", e.first?.kind == .move(drag: .left))
        e = p.plan(["t": "b", "b": 0, "d": false, "x": 0.3, "y": 0.3, "n": 1])
        check("input: button up, no extra move", e.map(\.kind) == [.up(.left)])
        e = p.plan(["t": "b", "b": 2, "d": true, "x": 0.3, "y": 0.3, "n": 2])
        check("input: right button and click count", e.map(\.kind) == [.down(.right)] && e.first?.clickState == 2)
        _ = p.plan(["t": "b", "b": 2, "d": false, "x": 0.3, "y": 0.3, "n": 2])
        e = p.plan(["t": "b", "b": 1, "d": true, "x": 0.3, "y": 0.3, "n": 9999])
        check("input: middle button, click count capped", e.map(\.kind) == [.down(.middle)] && e.first?.clickState == InputPlanner.maxClicks)
        _ = p.plan(["t": "b", "b": 1, "d": false, "x": 0.3, "y": 0.3])

        e = p.plan(["t": "w", "dx": 0, "dy": 120, "x": 0.3, "y": 0.3])
        check("input: DOM dy +120 scrolls content like a browser (wheel1 -120)", e.map(\.kind) == [.scroll(wheel1: -120, wheel2: 0)], "\(e)")
        e = p.plan(["t": "w", "dx": -30, "dy": -10, "x": 0.3, "y": 0.3])
        check("input: negative deltas, horizontal on wheel2", e.map(\.kind) == [.scroll(wheel1: 10, wheel2: 30)], "\(e)")
        var fractional: [PlannedEvent] = []
        for _ in 0..<3 { fractional += p.plan(["t": "w", "dx": 0, "dy": 0.4, "x": 0.3, "y": 0.3]) }
        check("input: fractional scrolls add up", fractional.map(\.kind) == [.scroll(wheel1: -1, wheel2: 0)], "\(fractional)")

        e = p.plan(["t": "k", "c": "KeyA", "k": "A", "d": true, "m": 9])
        check("input: key with Shift+Command bitmask", e == [PlannedEvent(.keyDown(0, autorepeat: false), flags: EventFlags.shift | EventFlags.command)], "\(e)")
        e = p.plan(["t": "k", "c": "KeyA", "k": "A", "d": true, "m": 9])
        check("input: repeated keydown is an autorepeat", e.first?.kind == .keyDown(0, autorepeat: true))
        _ = p.plan(["t": "k", "c": "KeyA", "k": "A", "d": false, "m": 0])
        e = p.plan(["t": "k", "c": "ShiftLeft", "k": "Shift", "d": true, "m": 1])
        check("input: modifier key is flagsChanged with its device bit", e == [PlannedEvent(.flagsChanged(56, down: true), flags: EventFlags.shift | 0x2)], "\(e)")
        e = p.plan(["t": "k", "c": "ArrowLeft", "k": "ArrowLeft", "d": true, "m": 1])
        check("input: arrow keys carry numeric-pad and fn flags like real keys",
              e.first?.flags == EventFlags.shift | 0x2 | EventFlags.numericPad | EventFlags.secondaryFn, "\(e)")
        e = p.plan(["t": "b", "b": 0, "d": true, "x": 0.5, "y": 0.5, "n": 1])
        check("input: shift-click carries the held modifier", e.last?.flags == EventFlags.shift | 0x2)
        let rel = p.plan(["t": "rel"])
        check("input: rel releases button, keys, then modifiers", rel.map(\.kind) == [.up(.left), .keyUp(123), .flagsChanged(56, down: false)]
              && rel.last?.flags == 0 && !p.isHoldingAnything, "\(rel)")
        check("input: nothing held after rel", p.plan(["t": "rel"]).isEmpty)
        e = p.plan(["t": "k", "c": "", "k": "é", "d": true, "m": 0])
        check("input: unknown code types its character", e.map(\.kind) == [.text("é")])
        check("input: unknown code with a named key does nothing", p.plan(["t": "k", "c": "Weird", "k": "Unidentified", "d": true, "m": 0]).isEmpty)
        e = p.plan(["t": "k", "c": "CapsLock", "k": "CapsLock", "d": true, "m": 0])
        check("input: Caps Lock is not tracked as held", e.map(\.kind) == [.flagsChanged(57, down: true)] && !p.isHoldingAnything)

        let chunks = InputPlanner.textChunks(String(repeating: "a", count: 25))
        check("input: text in chunks of at most 20 UTF-16 units", chunks.map(\.count) == [20, 5])
        let emoji = InputPlanner.textChunks(String(repeating: "😀", count: 15))
        check("input: emoji are never split across events", emoji.map { $0.utf16.count } == [20, 10] && emoji.joined() == String(repeating: "😀", count: 15))
        let family = "👨‍👩‍👧‍👦"
        let mixed = InputPlanner.textChunks("abcdefghijklmnopqr" + family + "xyz")
        check("input: a long emoji sequence moves whole to the next chunk", mixed == ["abcdefghijklmnopqr", family + "xyz"], "\(mixed.map { $0.utf16.count })")
        e = p.plan(["t": "txt", "s": String(repeating: "b", count: 300)])
        check("input: txt is capped at 256 characters", e.reduce(0) { n, ev in if case .text(let s) = ev.kind { return n + s.count }; return n } == 256)
        check("input: malformed messages plan nothing", p.plan(["t": "m", "x": "a", "y": 0.1]).isEmpty && p.plan(["t": "b", "b": 7, "d": true, "x": 0, "y": 0]).isEmpty
              && p.plan(["t": "zzz"]).isEmpty && p.plan([:]).isEmpty)
    }

    /// Builds (never posts) the CGEvents for a few plans and reads their fields back.
    private static func cgEvents() {
        let poster = InputPoster()
        let scroll = poster.events(for: PlannedEvent(.scroll(wheel1: -120, wheel2: 7), point: CGPoint(x: 10, y: 20)))
        check("cgevent scroll: pixel deltas and location", scroll.count == 1 && scroll[0].type == .scrollWheel
              && scroll[0].getIntegerValueField(.scrollWheelEventPointDeltaAxis1) == -120
              && scroll[0].getIntegerValueField(.scrollWheelEventPointDeltaAxis2) == 7
              && scroll[0].getIntegerValueField(.scrollWheelEventIsContinuous) == 1 && scroll[0].location == CGPoint(x: 10, y: 20))
        let click = poster.events(for: PlannedEvent(.down(.right), point: CGPoint(x: 5, y: 6), clickState: 2, flags: EventFlags.option))
        check("cgevent click: type, click state, flags", click.first?.type == .rightMouseDown
              && click.first?.getIntegerValueField(.mouseEventClickState) == 2 && click.first?.flags.contains(.maskAlternate) == true)
        let drag = poster.events(for: PlannedEvent(.move(drag: .middle), point: CGPoint(x: 1, y: 2)))
        check("cgevent middle drag", drag.first?.type == .otherMouseDragged && drag.first?.getIntegerValueField(.mouseEventButtonNumber) == 2)
        let key = poster.events(for: PlannedEvent(.keyDown(0, autorepeat: true), flags: EventFlags.command))
        check("cgevent key: code, autorepeat, only our modifiers", key.first?.type == .keyDown
              && key.first?.getIntegerValueField(.keyboardEventKeycode) == 0 && key.first?.getIntegerValueField(.keyboardEventAutorepeat) == 1
              && key.first.map { $0.flags.rawValue & EventFlags.managed } == EventFlags.command)
        let mod = poster.events(for: PlannedEvent(.flagsChanged(55, down: true), flags: EventFlags.command | 0x8))
        check("cgevent modifier is flagsChanged", mod.first?.type == .flagsChanged && mod.first?.getIntegerValueField(.keyboardEventKeycode) == 55)
        let text = poster.events(for: PlannedEvent(.text("hé😀")))
        var buf = [UniChar](repeating: 0, count: 20)
        var len = 0
        text.first?.keyboardGetUnicodeString(maxStringLength: 20, actualStringLength: &len, unicodeString: &buf)
        check("cgevent text: down and up carrying the string, no modifiers", text.count == 2 && String(utf16CodeUnits: buf, count: len) == "hé😀"
              && text[0].flags.rawValue & EventFlags.managed == 0)
    }

    // MARK: sizing and the synthetic source

    private static func sizing() {
        let cases: [((Int, Int, Int), (Int, Int))] = [
            ((2940, 1912, 1920), (1920, 1248)), ((2940, 1912, 4096), (2940, 1912)), ((1366, 768, 1280), (1280, 718)),
            ((3840, 2160, 2880), (2880, 1620)), ((1080, 1920, 1280), (720, 1280)), ((1, 1, 1280), (2, 2)),
        ]
        let wrong = cases.filter { CaptureSizing.outputSize(pixelWidth: $0.0.0, pixelHeight: $0.0.1, maxEdge: $0.0.2) != $0.1 }
        check("capture size: longest edge, aspect, even, never upscaled", wrong.isEmpty, "\(wrong)")
        let r = CaptureRequest(command: ["c": "capture", "on": true, "maxEdge": 99999, "fps": 0, "kbps": 0, "audio": false, "display": 7])
        check("capture request is clamped", r.maxEdge == 4096 && r.fps == 1 && r.kbps == 100 && !r.audio && r.displayID == 7)
    }

    private static func syntheticPattern() {
        let src = SyntheticVideoSource(width: 640, height: 360)
        guard let pb = src.makeFrame(index: 0x00A5_0F3C) else { check("synthetic frame", false); return }
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        let y = CVPixelBufferGetBaseAddressOfPlane(pb, 0)!.assumingMemoryBound(to: UInt8.self)
        let block = SyntheticVideoSource.counterBlock(width: 640)
        var value: UInt32 = 0
        for bit in 0..<32 where y[8 * CVPixelBufferGetBytesPerRowOfPlane(pb, 0) + bit * block + block / 2] > 128 { value |= 1 << UInt32(bit) }
        check("synthetic pattern: 420v with a readable frame counter",
              CVPixelBufferGetPixelFormatType(pb) == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange && value == 0x00A5_0F3C,
              String(format: "read 0x%08x", value))
    }

    // MARK: the menu

    private static func menuModel() {
        typealias M = MenuModel
        func items(_ m: M) -> [String: (command: M.Command, enabled: Bool, checked: Bool?)] {
            var out: [String: (M.Command, Bool, Bool?)] = [:]
            for case let .item(title, command, enabled, checked, _, _) in m.entries { out[title] = (command, enabled, checked) }
            return out
        }
        let setup = "http://127.0.0.1:52100/?k=abc"
        let ready: [String: Any] = ["state": "ready", "text": "Ready: open just-rice.github.io/perch to connect",
                                    "macName": "amber-otter-4821", "setupUrl": setup,
                                    "settings": ["paused": false, "backupOn": false, "keepAwake": false, "loginItem": false]]
        var m = M(status: ready, viewer: nil, problem: nil)
        var i = items(m)
        check("menu: status line, Mac name, then the items in order",
              m.entries.prefix(3) == [.header("Ready: open just-rice.github.io/perch to connect"), .detail("This Mac is amber-otter-4821"), .separator]
              && m.entries.compactMap { if case let .item(t, _, _, _, _, _) = $0 { return t }; return nil }
                == ["Open Setup…", "Pause Perch", "Start at Login", "Keep Mac Awake", "Backup Sign-in", "Check for Updates…", "Quit Perch"],
              "\(m.entries)")
        check("menu: Open Setup opens the host's Setup link", i["Open Setup…"]?.command == .openSetup(URL(string: setup)!) && i["Open Setup…"]?.enabled == true)
        check("menu: no Disconnect and a plain icon while nobody is connected", !m.connected && !m.dimmed && i.keys.allSatisfy { !$0.hasPrefix("Disconnect") })
        check("menu: checkboxes off send the -on actions", i["Start at Login"]?.command == .event("login-item-on") && i["Start at Login"]?.checked == false
              && i["Keep Mac Awake"]?.command == .event("keep-awake-on") && i["Keep Mac Awake"]?.checked == false)
        check("menu: Backup Sign-in disabled until a backup password is set", i["Backup Sign-in"]?.enabled == false && i["Backup Sign-in"]?.command == .event("backup-on"))
        check("menu: Pause and Check for Updates send their actions", i["Pause Perch"]?.command == .event("pause") && i["Check for Updates…"]?.command == .event("check-updates")
              && i["Quit Perch"]?.command == .quit && i["Quit Perch"]?.enabled == true)

        var s = ready
        s["backupSet"] = true
        s["settings"] = ["paused": false, "backupOn": false, "keepAwake": true, "loginItem": true]
        i = items(M(status: s, viewer: nil, problem: nil))
        check("menu: backupSet enables Backup Sign-in", i["Backup Sign-in"]?.enabled == true && i["Backup Sign-in"]?.checked == false)
        check("menu: checkboxes on show ticks and send the -off actions", i["Start at Login"]?.checked == true && i["Start at Login"]?.command == .event("login-item-off")
              && i["Keep Mac Awake"]?.checked == true && i["Keep Mac Awake"]?.command == .event("keep-awake-off"))
        s = ready
        s["settings"] = ["backupOn": true]
        i = items(M(status: s, viewer: nil, problem: nil))
        check("menu: backup on can always be switched off", i["Backup Sign-in"]?.enabled == true && i["Backup Sign-in"]?.checked == true
              && i["Backup Sign-in"]?.command == .event("backup-off"))

        s = ready
        s["state"] = "connected"; s["text"] = "Safari on iPhone is connected"
        m = M(status: s, viewer: "Safari on iPhone", problem: nil)
        i = items(m)
        check("menu: Disconnect <viewer> and a lit icon while connected", m.connected && i["Disconnect Safari on iPhone"]?.command == .event("disconnect")
              && m.entries.first == .header("Safari on iPhone is connected"))
        m = M(status: ready, viewer: "Chrome on Pixel", problem: nil)
        check("menu: a session command alone also counts as connected", m.connected && items(m)["Disconnect Chrome on Pixel"] != nil)

        s = ready
        s["state"] = "paused"; s["text"] = "Paused: nobody can connect"; s["settings"] = ["paused": true]
        m = M(status: s, viewer: nil, problem: nil)
        check("menu: paused shows Resume and a dimmed icon", m.dimmed && items(m)["Resume Perch"]?.command == .event("resume") && items(m)["Pause Perch"] == nil)

        s = ready
        s["update"] = ["version": "0.2.0", "url": "https://example.invalid"]
        check("menu: an available update adds Update to x.y.z…", items(M(status: s, viewer: nil, problem: nil))["Update to 0.2.0…"]?.command == .event("update"))
        check("menu: no update item without an update", items(M(status: ready, viewer: nil, problem: nil)).keys.allSatisfy { !$0.hasPrefix("Update to") })

        s = ready
        s["setupUrl"] = "file:///etc/hosts"
        check("menu: a Setup link that isn't http(s) is not offered", items(M(status: s, viewer: nil, problem: nil))["Open Setup…"]?.enabled == false)
        m = M(status: [:], viewer: nil, problem: nil)
        check("menu: before any status it says Starting… and Setup is disabled", m.entries.first == .header("Starting…") && items(m)["Open Setup…"]?.enabled == false)

        m = M(status: ready, viewer: nil, problem: "Perch's helper stopped. Restarting…")
        let enabled = items(m).filter { $0.value.enabled }.map(\.key)
        check("menu: while the helper is down only Quit works", m.dimmed && m.entries.first == .header("Perch's helper stopped. Restarting…") && enabled == ["Quit Perch"], "\(enabled)")
    }
}
