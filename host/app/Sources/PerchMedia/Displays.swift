// The Mac's displays, from CoreGraphics. ScreenCaptureKit isn't used for the list because asking it for shareable
// content without Screen Recording permission can make macOS show the permission prompt.
import Foundation
import CoreGraphics
import AppKit

public struct DisplayInfo: Equatable {
    public let id: UInt32
    public var name: String
    /// Global position and size in points (top-left origin), the space Quartz events use.
    public let bounds: CGRect
    public let pixelWidth: Int
    public let pixelHeight: Int
    public let isMain: Bool

    /// As the protocol lists it: `{id, name, width, height, main}`, sizes in points.
    public var json: [String: Any] {
        ["id": Int(id), "name": name, "width": Int(bounds.width), "height": Int(bounds.height), "main": isMain]
    }
}

public enum Displays {
    /// --synthetic has one pretend 1920×1080-point Retina display, the same on every machine.
    public static let synthetic = DisplayInfo(id: 1, name: "Perch Test Pattern",
                                              bounds: CGRect(x: 0, y: 0, width: 1920, height: 1080),
                                              pixelWidth: 3840, pixelHeight: 2160, isMain: true)

    /// The displays a viewer can be shown, one per mirror set. Names need AppKit, so pass `names: true` only on the
    /// main thread.
    ///
    /// This is the *online* list, not the active one: CoreGraphics leaves a sleeping display out of its active list
    /// (seen on macOS 27 with the built-in display asleep: no active displays at all), and a Mac whose screen has
    /// gone to sleep is exactly the one someone wants to reach. A session wakes the display before capture begins.
    public static func active(names: Bool = false) -> [DisplayInfo] {
        var count: UInt32 = 0
        var ids = [CGDirectDisplayID](repeating: 0, count: 32)
        guard CGGetOnlineDisplayList(UInt32(ids.count), &ids, &count) == .success else { return [] }
        let screenNames = names ? Self.screenNames() : [:]
        let main = CGMainDisplayID()
        return ids.prefix(Int(count)).compactMap { id in
            // Switched off (but still plugged in): nothing to show.
            if CGDisplayIsActive(id) == 0 && CGDisplayIsAsleep(id) == 0 { return nil }
            // A display mirroring another shows the same picture; list only the one it mirrors.
            if CGDisplayMirrorsDisplay(id) != kCGNullDirectDisplay { return nil }
            let b = CGDisplayBounds(id)
            var pw = Int(b.width), ph = Int(b.height)
            if let mode = CGDisplayCopyDisplayMode(id) { pw = mode.pixelWidth; ph = mode.pixelHeight }
            return DisplayInfo(id: id, name: screenNames[id] ?? (id == main ? "Main display" : "Display \(id)"),
                               bounds: b, pixelWidth: pw, pixelHeight: ph, isMain: id == main)
        }
    }

    public static func list(synthetic: Bool, names: Bool = false) -> [DisplayInfo] {
        synthetic ? [Self.synthetic] : active(names: names)
    }

    /// The display with this id, or the main display when there is no such display (or no id was given).
    public static func find(_ id: UInt32?, synthetic: Bool) -> DisplayInfo? {
        let all = list(synthetic: synthetic)
        if let id, let d = all.first(where: { $0.id == id }) { return d }
        return all.first(where: { $0.isMain }) ?? all.first
    }

    private static func screenNames() -> [UInt32: String] {
        var out: [UInt32: String] = [:]
        for s in NSScreen.screens {
            if let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
                out[n.uint32Value] = s.localizedName
            }
        }
        return out
    }
}
