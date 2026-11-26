//! DOM `KeyboardEvent.code` → PC keyboard scan codes (set 1, the codes Windows' SendInput takes).
//!
//! DOM `code` names a physical key position (the key labelled A on a US keyboard is "KeyA" whatever the layout), and
//! so do scan codes, so sending the matching scan code makes Windows apply the PC's own keyboard layout, just as if
//! the key were pressed on a keyboard plugged into it.

/// How a key is sent: a scan code (with the E0 "extended" prefix or not), or, for the few keys whose scan code
/// sequence SendInput can't express (Pause), a virtual-key code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Key {
    Scan { code: u16, ext: bool },
    Vk(u16),
}

const fn sc(code: u16) -> Key { Key::Scan { code, ext: false } }
const fn ex(code: u16) -> Key { Key::Scan { code, ext: true } }

pub fn lookup(code: &str) -> Option<Key> {
    Some(match code {
        "Escape" => sc(0x01),
        "Digit1" => sc(0x02), "Digit2" => sc(0x03), "Digit3" => sc(0x04), "Digit4" => sc(0x05), "Digit5" => sc(0x06),
        "Digit6" => sc(0x07), "Digit7" => sc(0x08), "Digit8" => sc(0x09), "Digit9" => sc(0x0A), "Digit0" => sc(0x0B),
        "Minus" => sc(0x0C), "Equal" => sc(0x0D), "Backspace" => sc(0x0E), "Tab" => sc(0x0F),
        "KeyQ" => sc(0x10), "KeyW" => sc(0x11), "KeyE" => sc(0x12), "KeyR" => sc(0x13), "KeyT" => sc(0x14),
        "KeyY" => sc(0x15), "KeyU" => sc(0x16), "KeyI" => sc(0x17), "KeyO" => sc(0x18), "KeyP" => sc(0x19),
        "BracketLeft" => sc(0x1A), "BracketRight" => sc(0x1B), "Enter" => sc(0x1C), "ControlLeft" => sc(0x1D),
        "KeyA" => sc(0x1E), "KeyS" => sc(0x1F), "KeyD" => sc(0x20), "KeyF" => sc(0x21), "KeyG" => sc(0x22),
        "KeyH" => sc(0x23), "KeyJ" => sc(0x24), "KeyK" => sc(0x25), "KeyL" => sc(0x26),
        "Semicolon" => sc(0x27), "Quote" => sc(0x28), "Backquote" => sc(0x29), "ShiftLeft" => sc(0x2A),
        "Backslash" => sc(0x2B),
        "KeyZ" => sc(0x2C), "KeyX" => sc(0x2D), "KeyC" => sc(0x2E), "KeyV" => sc(0x2F), "KeyB" => sc(0x30),
        "KeyN" => sc(0x31), "KeyM" => sc(0x32),
        "Comma" => sc(0x33), "Period" => sc(0x34), "Slash" => sc(0x35), "ShiftRight" => sc(0x36),
        "NumpadMultiply" => sc(0x37), "AltLeft" => sc(0x38), "Space" => sc(0x39), "CapsLock" => sc(0x3A),
        "F1" => sc(0x3B), "F2" => sc(0x3C), "F3" => sc(0x3D), "F4" => sc(0x3E), "F5" => sc(0x3F),
        "F6" => sc(0x40), "F7" => sc(0x41), "F8" => sc(0x42), "F9" => sc(0x43), "F10" => sc(0x44),
        "NumLock" => sc(0x45), "ScrollLock" => sc(0x46),
        "Numpad7" => sc(0x47), "Numpad8" => sc(0x48), "Numpad9" => sc(0x49), "NumpadSubtract" => sc(0x4A),
        "Numpad4" => sc(0x4B), "Numpad5" => sc(0x4C), "Numpad6" => sc(0x4D), "NumpadAdd" => sc(0x4E),
        "Numpad1" => sc(0x4F), "Numpad2" => sc(0x50), "Numpad3" => sc(0x51), "Numpad0" => sc(0x52),
        "NumpadDecimal" => sc(0x53),
        "IntlBackslash" => sc(0x56), // the extra key left of Z on ISO keyboards
        "F11" => sc(0x57), "F12" => sc(0x58), "NumpadEqual" => sc(0x59),
        "F13" => sc(0x64), "F14" => sc(0x65), "F15" => sc(0x66), "F16" => sc(0x67), "F17" => sc(0x68),
        "F18" => sc(0x69), "F19" => sc(0x6A), "F20" => sc(0x6B), "F21" => sc(0x6C), "F22" => sc(0x6D),
        "F23" => sc(0x6E), "F24" => sc(0x76),
        "KanaMode" => sc(0x70), "Lang2" => sc(0x71), "Lang1" => sc(0x72), "IntlRo" => sc(0x73),
        "Convert" => sc(0x79), "NonConvert" => sc(0x7B), "IntlYen" => sc(0x7D), "NumpadComma" => sc(0x7E),
        // Extended keys: the same codes as keypad keys, told apart by the E0 prefix.
        "NumpadEnter" => ex(0x1C), "ControlRight" => ex(0x1D), "NumpadDivide" => ex(0x35),
        "PrintScreen" => ex(0x37), "AltRight" => ex(0x38),
        "Home" => ex(0x47), "ArrowUp" => ex(0x48), "PageUp" => ex(0x49), "ArrowLeft" => ex(0x4B),
        "ArrowRight" => ex(0x4D), "End" => ex(0x4F), "ArrowDown" => ex(0x50), "PageDown" => ex(0x51),
        "Insert" => ex(0x52), "Delete" => ex(0x53),
        "MetaLeft" | "OSLeft" => ex(0x5B), "MetaRight" | "OSRight" => ex(0x5C), "ContextMenu" => ex(0x5D),
        // Pause sends E1 1D 45 E1 9D C5, which SendInput can't express as one scan code.
        "Pause" => Key::Vk(0x13),
        _ => return None,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Modifier { Shift, Control, Alt, Meta, CapsLock }

pub fn modifier(k: Key) -> Option<Modifier> {
    match k {
        Key::Scan { code: 0x2A | 0x36, ext: false } => Some(Modifier::Shift),
        Key::Scan { code: 0x1D, .. } => Some(Modifier::Control),
        Key::Scan { code: 0x38, .. } => Some(Modifier::Alt),
        Key::Scan { code: 0x5B | 0x5C, ext: true } => Some(Modifier::Meta),
        Key::Scan { code: 0x3A, ext: false } => Some(Modifier::CapsLock),
        _ => None,
    }
}

/// The protocol's modifier bitmask bit for a modifier (1 shift, 2 ctrl, 4 alt, 8 meta).
pub fn mask_bit(m: Modifier) -> i64 {
    match m { Modifier::Shift => 1, Modifier::Control => 2, Modifier::Alt => 4, Modifier::Meta => 8, Modifier::CapsLock => 0 }
}

/// The key pressed to make a modifier the viewer says is held when none of ours is.
pub fn left_key(m: Modifier) -> Key {
    match m {
        Modifier::Shift => sc(0x2A), Modifier::Control => sc(0x1D), Modifier::Alt => sc(0x38),
        Modifier::Meta => ex(0x5B), Modifier::CapsLock => sc(0x3A),
    }
}

/// Codes the protocol requires (letters, digits, punctuation, F1–F20, navigation, editing, keypad, modifiers).
pub fn required() -> Vec<String> {
    let mut r: Vec<String> = ('A'..='Z').map(|c| format!("Key{c}")).collect();
    r.extend((0..=9).map(|d| format!("Digit{d}")));
    for s in ["Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Backquote", "Comma",
        "Period", "Slash", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown",
        "Backspace", "Delete", "Escape", "Tab", "Space", "Enter", "NumpadEnter", "NumpadDecimal", "NumpadMultiply",
        "NumpadAdd", "NumpadSubtract", "NumpadDivide", "NumpadEqual", "ShiftLeft", "ShiftRight", "ControlLeft",
        "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "CapsLock"] {
        r.push(s.into());
    }
    r.extend((1..=20).map(|n| format!("F{n}")));
    r.extend((0..=9).map(|d| format!("Numpad{d}")));
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn every_required_code_has_a_key_and_no_two_codes_share_one() {
        let mut seen: HashMap<Key, String> = HashMap::new();
        for code in required() {
            let k = lookup(&code).unwrap_or_else(|| panic!("{code} missing"));
            if let Some(other) = seen.insert(k, code.clone()) { panic!("{code} and {other} are both {k:?}"); }
        }
    }

    #[test]
    fn modifiers_are_recognised() {
        assert_eq!(modifier(lookup("ControlRight").unwrap()), Some(Modifier::Control));
        assert_eq!(modifier(lookup("MetaLeft").unwrap()), Some(Modifier::Meta));
        assert_eq!(modifier(lookup("NumpadMultiply").unwrap()), None);
        assert_eq!(modifier(lookup("PrintScreen").unwrap()), None, "E0 37 is not the keypad's *");
    }
}
