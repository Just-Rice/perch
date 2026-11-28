// After a viewer clicks or taps, is the Mac now waiting for typing? Asked through Accessibility (which Perch holds
// for input anyway), so a phone can bring up its keyboard by itself when a text box was tapped. Only yes/no leaves
// the Mac (and whether it is a password box); never the text, the app or where the box is.
import Foundation
import ApplicationServices

enum TextFocus {
    struct Answer: Equatable {
        let editable: Bool
        let secure: Bool
        var json: [String: Any] { ["e": "text-focus", "editable": editable, "secure": secure] }
    }

    /// Roles that always take typing.
    static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]

    /// Whether the focused element, anywhere on the Mac, takes typing. Nil when Accessibility can't say.
    static func current() -> Answer? {
        guard AXIsProcessTrusted() else { return nil }
        let system = AXUIElementCreateSystemWide()
        // An app that isn't answering must not hold up the next check.
        AXUIElementSetMessagingTimeout(system, 0.3)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &value) == .success,
              let v = value, CFGetTypeID(v) == AXUIElementGetTypeID() else {
            return Answer(editable: false, secure: false)
        }
        let el = v as! AXUIElement
        AXUIElementSetMessagingTimeout(el, 0.3)
        let role = string(el, kAXRoleAttribute) ?? ""
        let subrole = string(el, kAXSubroleAttribute) ?? ""
        let secure = subrole == "AXSecureTextField"
        if textRoles.contains(role) || secure { return Answer(editable: isEnabled(el), secure: secure) }
        // Web pages and editors: anything with a text cursor whose value can be changed (a contenteditable area
        // in a browser, a code editor) takes typing too. Sliders and the like have no text cursor.
        var range: CFTypeRef?
        let hasCursor = AXUIElementCopyAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, &range) == .success
        var settable = DarwinBoolean(false)
        AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &settable)
        return Answer(editable: hasCursor && settable.boolValue && isEnabled(el), secure: false)
    }

    private static func string(_ el: AXUIElement, _ attr: String) -> String? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
        return v as? String
    }

    private static func isEnabled(_ el: AXUIElement) -> Bool {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXEnabledAttribute as CFString, &v) == .success else { return true }
        return (v as? Bool) ?? true
    }
}
