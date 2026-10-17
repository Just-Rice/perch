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
    /// The display being captured; input maps onto it (the main display when nothing is captured).
    var displayID: () -> UInt32? = { nil }

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
        if synthetic { return Displays.synthetic.bounds }
        let id = displayID() ?? CGMainDisplayID()
        let b = CGDisplayBounds(id)
        return b.isEmpty ? CGDisplayBounds(CGMainDisplayID()) : b
    }
}
