//! Performs planned input with SendInput. Every event Roost sends is marked (dwExtraInfo = ROOST_MARK) so the
//! privacy curtain can tell the viewer's keys from ones pressed at the PC itself (only the latter lift it).
use crate::keymap::Key;
use crate::planner::{Button, Planned};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN};

/// "ROOST" in the low bytes.
pub const ROOST_MARK: usize = 0x524F_4F53;

fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
    INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: ROOST_MARK } } }
}

fn key(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: ROOST_MARK } } }
}

/// A pixel of the virtual desktop in SendInput's 0–65535 absolute coordinates.
fn absolute(x: f64, y: f64) -> (i32, i32) {
    unsafe {
        let (vx, vy) = (GetSystemMetrics(SM_XVIRTUALSCREEN) as f64, GetSystemMetrics(SM_YVIRTUALSCREEN) as f64);
        let (vw, vh) = (GetSystemMetrics(SM_CXVIRTUALSCREEN).max(2) as f64, GetSystemMetrics(SM_CYVIRTUALSCREEN).max(2) as f64);
        ((((x - vx) * 65535.0 / (vw - 1.0)).round()) as i32, (((y - vy) * 65535.0 / (vh - 1.0)).round()) as i32)
    }
}

pub fn post(plan: &[Planned]) {
    let mut inputs: Vec<INPUT> = Vec::with_capacity(plan.len() * 2);
    for p in plan {
        match p {
            Planned::Move { x, y } => {
                let (ax, ay) = absolute(*x, *y);
                inputs.push(mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay, 0));
            }
            Planned::Nudge { dx, dy } => inputs.push(mouse(MOUSEEVENTF_MOVE, dx.round() as i32, dy.round() as i32, 0)),
            Planned::Button { b, down, x, y } => {
                let (ax, ay) = absolute(*x, *y);
                let f = match (b, down) {
                    (Button::Left, true) => MOUSEEVENTF_LEFTDOWN, (Button::Left, false) => MOUSEEVENTF_LEFTUP,
                    (Button::Right, true) => MOUSEEVENTF_RIGHTDOWN, (Button::Right, false) => MOUSEEVENTF_RIGHTUP,
                    (Button::Middle, true) => MOUSEEVENTF_MIDDLEDOWN, (Button::Middle, false) => MOUSEEVENTF_MIDDLEUP,
                };
                inputs.push(mouse(f | MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay, 0));
            }
            Planned::Wheel { dx, dy, .. } => {
                if *dy != 0 { inputs.push(mouse(MOUSEEVENTF_WHEEL, 0, 0, *dy)); }
                if *dx != 0 { inputs.push(mouse(MOUSEEVENTF_HWHEEL, 0, 0, *dx)); }
            }
            Planned::Key { key: Key::Scan { code, ext }, down } => {
                let mut f = KEYEVENTF_SCANCODE;
                if *ext { f |= KEYEVENTF_EXTENDEDKEY; }
                if !down { f |= KEYEVENTF_KEYUP; }
                inputs.push(key(0, *code, f));
            }
            Planned::Key { key: Key::Vk(vk), down } => inputs.push(key(*vk, 0, if *down { KEYBD_EVENT_FLAGS(0) } else { KEYEVENTF_KEYUP })),
            Planned::Text(s) => {
                // Typed text carries no modifiers of its own: each UTF-16 unit goes as a Unicode "key".
                for u in s.encode_utf16() {
                    inputs.push(key(0, u, KEYEVENTF_UNICODE));
                    inputs.push(key(0, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
                }
            }
            Planned::Sys(k) => {
                flush(&mut inputs);
                super::brightness::step(k == "brightnessUp");
            }
        }
    }
    flush(&mut inputs);
}

fn flush(inputs: &mut Vec<INPUT>) {
    if inputs.is_empty() { return; }
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if (sent as usize) < inputs.len() {
        // Usually UIPI: the window under the pointer belongs to an app running as administrator.
        crate::log::write("WARN", "input", &format!("Windows took {sent} of {} input events (an administrator app is in front?)", inputs.len()));
    }
    inputs.clear();
}
