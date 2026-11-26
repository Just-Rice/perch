// Runs INPUT frames on their own queue, so pointer and keys keep flowing while the main thread is busy (an open menu,
// a capture restart). With --echo-input nothing is ever posted: each message and the events it would have posted go
// back to the host as `input-echo`, which is how every automated test checks input.
import Foundation
import CoreGraphics
import ApplicationServices
import PerchCore
import PerchMedia

final class InputHandler: @unchecked Sendable {
    /// Where an echo goes (only used with --echo-input).
    var onEcho: (([String: Any]) -> Void)?
    /// After each click: whether the Mac now waits for typing (a `text-focus` event), so a phone can open its keyboard.
    var onTextFocus: (([String: Any]) -> Void)?
    private let focusQueue = DispatchQueue(label: "perch.text-focus", qos: .userInitiated)
    private var focusCheck = 0
    /// The display being captured; input maps onto it (the main display when nothing is captured).
    var displayID: () -> UInt32? = { nil }
    /// When one window is being shown: the part of the screen in the picture (global points). Input maps onto that.
    var region: () -> CGRect? = { nil }

    private let queue = DispatchQueue(label: "perch.input", qos: .userInteractive)
    private let echo: Bool
    private let synthetic: Bool
    private let planner = InputPlanner(bounds: .zero)
    /// Only exists when input is really performed.
    private let poster: InputPoster?
    private var warnedNoPermission = false

    init(echo: Bool, synthetic: Bool) {
        self.echo = echo
        self.synthetic = synthetic
        poster = echo ? nil : InputPoster()
    }

    func handle(_ payload: Data) {
        queue.async { [self] in
            guard let msg = IPC.parseObject(payload) else {
                Log.shared.warn("ignored an input frame that isn't a JSON object")
                return
            }
            planner.bounds = bounds()
            perform(planner.plan(msg), for: msg)
            if JSONValue.string(msg["t"]) == "b", JSONValue.bool(msg["d"]) == false, JSONValue.int(msg["b"]) == 0 {
                checkTextFocus(x: JSONValue.number(msg["x"]) ?? 0, y: JSONValue.number(msg["y"]) ?? 0)
            }
        }
    }

    /// A moment after a left click is let go, ask what has focus now; and again a little later for apps that are
    /// slow to move it (a web page, an app just brought to the front). The second answer is sent only if it differs.
    private func checkTextFocus(x: Double, y: Double) {
        focusCheck += 1
        let mine = focusCheck
        // Test runs click nothing for real, so they get a pretend text box: the top half of the screen.
        let pretend = echo || synthetic
        let ask: () -> TextFocus.Answer? = { pretend ? TextFocus.Answer(editable: y < 0.5, secure: false) : TextFocus.current() }
        var first: TextFocus.Answer?
        focusQueue.asyncAfter(deadline: .now() + .milliseconds(150)) { [weak self] in
            guard let self, self.queue.sync(execute: { mine == self.focusCheck }) else { return }
            first = ask()
            if let a = first { self.onTextFocus?(a.json) }
        }
        focusQueue.asyncAfter(deadline: .now() + .milliseconds(500)) { [weak self] in
            guard let self, self.queue.sync(execute: { mine == self.focusCheck }) else { return }
            if let a = ask(), a != first { self.onTextFocus?(a.json) }
        }
    }

    /// Presses ⌘V, as if typed: after the viewer's text has been put on the clipboard. On the input queue, so it
    /// comes in order with the viewer's other keys.
    func pressPaste() {
        queue.async { [self] in
            planner.bounds = bounds()
            for msg: [String: Any] in [["t": "k", "c": "MetaLeft", "k": "Meta", "d": true, "m": 8],
                                       ["t": "k", "c": "KeyV", "k": "v", "d": true, "m": 8],
                                       ["t": "k", "c": "KeyV", "k": "v", "d": false, "m": 8],
                                       ["t": "k", "c": "MetaLeft", "k": "Meta", "d": false, "m": 0]] {
                perform(planner.plan(msg), for: msg)
            }
        }
    }

    /// Lets go of everything the viewer was holding (session over, host gone, quitting).
    func releaseAll(wait: Bool = false) {
        let work = { [self] in
            let plan = planner.releaseAll()
            if !plan.isEmpty { perform(plan, for: ["t": "rel", "source": "app"]) }
        }
        if wait { queue.sync(execute: work) } else { queue.async(execute: work) }
    }

    private func perform(_ plan: [PlannedEvent], for msg: [String: Any]) {
        if echo {
            onEcho?(["e": "input-echo", "ev": msg, "out": plan.map(\.json)])
            return
        }
        guard !plan.isEmpty, let poster else { return }
        // Without Accessibility permission macOS would silently drop the events; the host already knows (it got
        // a permissions event) and shows the viewer that this Mac is view-only.
        guard AXIsProcessTrusted() else {
            if !warnedNoPermission { Log.shared.warn("input ignored: Perch doesn't have Accessibility permission"); warnedNoPermission = true }
            return
        }
        warnedNoPermission = false
        poster.post(plan)
    }

    private func bounds() -> CGRect {
        if let r = region(), !r.isEmpty { return r }
        if synthetic { return Displays.synthetic.bounds }
        let id = displayID() ?? CGMainDisplayID()
        let b = CGDisplayBounds(id)
        return b.isEmpty ? CGDisplayBounds(CGMainDisplayID()) : b
    }
}
