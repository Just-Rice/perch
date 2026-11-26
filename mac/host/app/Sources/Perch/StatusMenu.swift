// The menu bar item. Its contents come from the host's `status` command (state, Mac name, Setup link, settings,
// available update) and `session` command (who is connected); MenuModel decides what to show and this class only
// draws it. Choosing an item sends a `menu` event to the host, which owns the settings and answers with a fresh
// `status`. Main thread.
import AppKit
import PerchCore

final class StatusMenu: NSObject, NSMenuDelegate {
    /// A `menu` event action (pause, resume, disconnect, backup-on, ...).
    var onAction: ((String) -> Void)?
    var onOpenURL: ((URL) -> Void)?
    var onQuit: (() -> Void)?

    private let item: NSStatusItem
    private let menu = NSMenu()
    private var status: [String: Any] = [:]
    private var viewer: String?
    private var problem: String?
    private var shownConnected: Bool?

    override init() {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()
        menu.autoenablesItems = false
        menu.delegate = self
        item.menu = menu
        refresh()
    }

    func update(status s: [String: Any]) {
        status = s
        problem = nil
        refresh()
    }

    /// `viewer` nil means nobody is connected.
    func setSession(viewer v: String?) {
        viewer = v
        refresh()
    }

    /// Shown instead of the host's status while the host isn't running.
    func setProblem(_ text: String?) {
        problem = text
        refresh()
    }

    func remove() { NSStatusBar.system.removeStatusItem(item) }

    func menuNeedsUpdate(_ menu: NSMenu) { refresh() }

    private func refresh() {
        let model = MenuModel(status: status, viewer: viewer, problem: problem)
        if let button = item.button {
            if shownConnected != model.connected {
                shownConnected = model.connected
                button.image = MenuIcon.image(model.connected ? .connected : .idle)
                Log.shared.info("menu bar icon: \(model.connected ? "connected" : "idle")")
            }
            // Dimmed the way macOS shows an inactive menu extra.
            button.appearsDisabled = model.dimmed
            button.toolTip = model.tooltip
        }
        menu.removeAllItems()
        for entry in model.entries { menu.addItem(menuItem(entry)) }
    }

    private func menuItem(_ entry: MenuModel.Entry) -> NSMenuItem {
        switch entry {
        case .separator:
            return .separator()
        case .header(let text):
            let i = NSMenuItem(title: text, action: nil, keyEquivalent: "")
            i.isEnabled = false
            return i
        case .detail(let text):
            let i = NSMenuItem(title: text, action: nil, keyEquivalent: "")
            i.attributedTitle = NSAttributedString(string: text, attributes: [
                .font: NSFont.menuFont(ofSize: NSFont.smallSystemFontSize),
                .foregroundColor: NSColor.secondaryLabelColor,
            ])
            i.isEnabled = false
            return i
        case let .item(title, command, enabled, checked, key, tip):
            let i = NSMenuItem(title: title, action: #selector(choose(_:)), keyEquivalent: key)
            i.target = self
            i.representedObject = Box(command)
            i.isEnabled = enabled
            if let checked { i.state = checked ? .on : .off }
            i.toolTip = tip
            return i
        }
    }

    @objc private func choose(_ sender: NSMenuItem) {
        guard let command = (sender.representedObject as? Box)?.command else { return }
        switch command {
        case .event(let action): onAction?(action)
        case .openSetup(let url): onOpenURL?(url)
        case .quit: onQuit?()
        case .none: break
        }
    }

    /// NSMenuItem.representedObject wants an object.
    private final class Box {
        let command: MenuModel.Command
        init(_ c: MenuModel.Command) { command = c }
    }
}
