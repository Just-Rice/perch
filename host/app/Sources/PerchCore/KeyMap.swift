// DOM KeyboardEvent.code → macOS virtual key code.
//
// DOM `code` names a physical key position (the key labelled A on a US keyboard is "KeyA" whatever the layout), and
// macOS virtual key codes do the same, so posting the matching code makes the Mac apply its own keyboard layout, just
// as if the key were pressed on a keyboard plugged into it. Values are the kVK_* constants from Carbon's
// HIToolbox/Events.h (US ANSI positions).
import Foundation

public enum KeyMap {
    public static let codes: [String: UInt16] = [
        // Letters
        "KeyA": 0x00, "KeyS": 0x01, "KeyD": 0x02, "KeyF": 0x03, "KeyH": 0x04, "KeyG": 0x05, "KeyZ": 0x06,
        "KeyX": 0x07, "KeyC": 0x08, "KeyV": 0x09, "KeyB": 0x0B, "KeyQ": 0x0C, "KeyW": 0x0D, "KeyE": 0x0E,
        "KeyR": 0x0F, "KeyY": 0x10, "KeyT": 0x11, "KeyO": 0x1F, "KeyU": 0x20, "KeyI": 0x22, "KeyP": 0x23,
        "KeyL": 0x25, "KeyJ": 0x26, "KeyK": 0x28, "KeyN": 0x2D, "KeyM": 0x2E,
        // Digits row
        "Digit1": 0x12, "Digit2": 0x13, "Digit3": 0x14, "Digit4": 0x15, "Digit6": 0x16, "Digit5": 0x17,
        "Digit9": 0x19, "Digit7": 0x1A, "Digit8": 0x1C, "Digit0": 0x1D,
        // Punctuation
        "Equal": 0x18, "Minus": 0x1B, "BracketRight": 0x1E, "BracketLeft": 0x21, "Quote": 0x27,
        "Semicolon": 0x29, "Backslash": 0x2A, "Comma": 0x2B, "Slash": 0x2C, "Period": 0x2F, "Backquote": 0x32,
        "IntlBackslash": 0x0A, // the extra key left of Z on ISO keyboards (kVK_ISO_Section)
        "IntlYen": 0x5D, "IntlRo": 0x5E, // JIS keyboards
        // Editing and whitespace
        "Enter": 0x24,          // Return
        "Tab": 0x30,
        "Space": 0x31,
        "Backspace": 0x33,      // kVK_Delete: deletes backwards
        "Delete": 0x75,         // kVK_ForwardDelete
        "Escape": 0x35,
        "Insert": 0x72,         // kVK_Help sits where Insert is on PC keyboards
        "Help": 0x72,
        // Navigation
        "Home": 0x73, "End": 0x77, "PageUp": 0x74, "PageDown": 0x79,
        "ArrowLeft": 0x7B, "ArrowRight": 0x7C, "ArrowDown": 0x7D, "ArrowUp": 0x7E,
        // Function keys
        "F1": 0x7A, "F2": 0x78, "F3": 0x63, "F4": 0x76, "F5": 0x60, "F6": 0x61, "F7": 0x62, "F8": 0x64,
        "F9": 0x65, "F10": 0x6D, "F11": 0x67, "F12": 0x6F, "F13": 0x69, "F14": 0x6B, "F15": 0x71,
        "F16": 0x6A, "F17": 0x40, "F18": 0x4F, "F19": 0x50, "F20": 0x5A,
        // PC keyboards plugged into a Mac report these three as F13–F15, so do the same.
        "PrintScreen": 0x69, "ScrollLock": 0x6B, "Pause": 0x71,
        // Numeric keypad
        "Numpad0": 0x52, "Numpad1": 0x53, "Numpad2": 0x54, "Numpad3": 0x55, "Numpad4": 0x56,
        "Numpad5": 0x57, "Numpad6": 0x58, "Numpad7": 0x59, "Numpad8": 0x5B, "Numpad9": 0x5C,
        "NumpadDecimal": 0x41, "NumpadMultiply": 0x43, "NumpadAdd": 0x45, "NumpadDivide": 0x4B,
        "NumpadEnter": 0x4C, "NumpadSubtract": 0x4E, "NumpadEqual": 0x51, "NumpadComma": 0x5F,
        "NumLock": 0x47,        // the Mac keypad's Clear key reports itself as NumLock in browsers
        // Modifiers
        "ShiftLeft": 0x38, "ShiftRight": 0x3C, "ControlLeft": 0x3B, "ControlRight": 0x3E,
        "AltLeft": 0x3A, "AltRight": 0x3D, "MetaLeft": 0x37, "MetaRight": 0x36,
        "OSLeft": 0x37, "OSRight": 0x36, // older Firefox names for Meta
        "CapsLock": 0x39, "Fn": 0x3F,
        // Japanese input keys
        "Lang1": 0x68, "Lang2": 0x66, // kVK_JIS_Kana, kVK_JIS_Eisu
        "ContextMenu": 0x6E,
    ]

    /// Codes the protocol requires (letters, digits, punctuation, F1–F20, navigation, editing, keypad, modifiers).
    public static let required: [String] = {
        var r: [String] = []
        r += (UnicodeScalar("A").value...UnicodeScalar("Z").value).map { "Key\(Character(UnicodeScalar($0)!))" }
        r += (0...9).map { "Digit\($0)" }
        r += ["Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Backquote",
              "Comma", "Period", "Slash"]
        r += (1...20).map { "F\($0)" }
        r += ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown",
              "Backspace", "Delete", "Escape", "Tab", "Space", "Enter", "NumpadEnter"]
        r += (0...9).map { "Numpad\($0)" }
        r += ["NumpadDecimal", "NumpadMultiply", "NumpadAdd", "NumpadSubtract", "NumpadDivide", "NumpadEqual"]
        r += ["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft",
              "MetaRight", "CapsLock"]
        return r
    }()

    public static func keyCode(for code: String) -> UInt16? { codes[code] }

    /// Which modifier a virtual key code is, if any.
    public enum Modifier { case shift, control, option, command, capsLock, function }

    public static func modifier(for keyCode: UInt16) -> Modifier? {
        switch keyCode {
        case 0x38, 0x3C: return .shift
        case 0x3B, 0x3E: return .control
        case 0x3A, 0x3D: return .option
        case 0x37, 0x36: return .command
        case 0x39: return .capsLock
        case 0x3F: return .function
        default: return nil
        }
    }

    /// Device-dependent flag bit for a left/right modifier key (NX_DEVICE*KEYMASK in IOKit's IOLLEvent.h). Real
    /// keyboards set these next to the shared Shift/Control/Option/Command bits, and some apps use them to tell
    /// the left and right keys apart.
    public static func deviceFlag(for keyCode: UInt16) -> UInt64 {
        switch keyCode {
        case 0x3B: return 0x0001 // left control
        case 0x38: return 0x0002 // left shift
        case 0x3C: return 0x0004 // right shift
        case 0x37: return 0x0008 // left command
        case 0x36: return 0x0010 // right command
        case 0x3A: return 0x0020 // left option
        case 0x3D: return 0x0040 // right option
        case 0x3E: return 0x2000 // right control
        default: return 0
        }
    }

    /// Keys on the keypad: real keyboards mark their events with the numeric-pad flag. Arrow keys carry it too.
    public static func isKeypad(_ keyCode: UInt16) -> Bool {
        switch keyCode {
        case 0x41, 0x43, 0x45, 0x47, 0x4B, 0x4C, 0x4E, 0x51, 0x52...0x59, 0x5B, 0x5C, 0x5F: return true
        case 0x7B...0x7E: return true
        default: return false
        }
    }

    /// Keys a Mac keyboard produces with the Fn layer: arrows, navigation, forward delete, help and F-keys carry
    /// the secondary-function flag on real hardware.
    public static func isFunctionLayer(_ keyCode: UInt16) -> Bool {
        switch keyCode {
        case 0x7B...0x7E, 0x73, 0x74, 0x75, 0x77, 0x79, 0x72: return true
        case 0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F, 0x69, 0x6B, 0x71, 0x6A,
             0x40, 0x4F, 0x50, 0x5A: return true
        default: return false
        }
    }
}
