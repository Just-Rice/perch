//! Turns the viewer's input messages (docs/PROTOCOL.md, "Input and pointer channels") into the events to send.
//!
//! Planning is kept apart from sending so the same plan can be sent for real (input.rs on Windows), reported back in
//! --echo-input mode, or checked by tests. The planner remembers which keys and buttons are held, so a viewer that
//! disappears mid-drag or mid-shortcut can have everything released (`rel`, a session ending, the host restarting).
use crate::jsonv::{self, Obj};
use crate::keymap::{self, Key, Modifier};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button { Left, Middle, Right }

impl Button {
    fn from(n: i64) -> Option<Self> {
        match n { 0 => Some(Self::Left), 1 => Some(Self::Middle), 2 => Some(Self::Right), _ => None }
    }
    pub fn name(self) -> &'static str { match self { Self::Left => "left", Self::Middle => "middle", Self::Right => "right" } }
}

/// A rectangle in physical pixels of the virtual desktop.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Rect { pub x: f64, pub y: f64, pub w: f64, pub h: f64 }

impl Rect {
    pub fn new(x: f64, y: f64, w: f64, h: f64) -> Self { Self { x, y, w, h } }
    pub fn mid(&self) -> (f64, f64) { (self.x + self.w / 2.0, self.y + self.h / 2.0) }
    pub fn is_empty(&self) -> bool { self.w <= 0.0 || self.h <= 0.0 }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Planned {
    /// Absolute move to a pixel of the virtual desktop.
    Move { x: f64, y: f64 },
    /// Relative move in pixels (the viewer's mouse is captured: games and 3D apps read movement, not position).
    Nudge { dx: f64, dy: f64 },
    Button { b: Button, down: bool, x: f64, y: f64 },
    /// Wheel amounts in Windows units (120 = one notch); positive dy = content moves down (wheel turned away).
    Wheel { dx: i32, dy: i32, x: f64, y: f64 },
    Key { key: Key, down: bool },
    Text(String),
    Sys(String),
}

impl Planned {
    /// How --echo-input reports it (docs/WINDOWS-APP.md).
    pub fn json(&self) -> Value {
        let r = |v: f64| (v * 100.0).round() / 100.0;
        match self {
            Planned::Move { x, y } => json!({"type": "move", "x": r(*x), "y": r(*y)}),
            Planned::Nudge { dx, dy } => json!({"type": "move", "dx": r(*dx), "dy": r(*dy)}),
            Planned::Button { b, down, x, y } =>
                json!({"type": if *down { "down" } else { "up" }, "button": b.name(), "x": r(*x), "y": r(*y)}),
            Planned::Wheel { dx, dy, x, y } => json!({"type": "wheel", "dx": dx, "dy": dy, "x": r(*x), "y": r(*y)}),
            Planned::Key { key: Key::Scan { code, ext }, down } => json!({"type": "key", "scan": code, "ext": ext, "down": down}),
            Planned::Key { key: Key::Vk(vk), down } => json!({"type": "key", "vk": vk, "down": down}),
            Planned::Text(s) => json!({"type": "text", "s": s}),
            Planned::Sys(k) => json!({"type": "sys", "key": k}),
        }
    }
}

pub const MAX_TEXT: usize = 256;
pub const SYS_KEYS: [&str; 2] = ["brightnessUp", "brightnessDown"];

pub struct Planner {
    pub bounds: Rect,
    held_buttons: Vec<Button>,
    /// Keys held, in the order they went down.
    held_keys: Vec<Key>,
    cursor: Option<(f64, f64)>,
    /// Fractions of a wheel unit left over from earlier scrolls (touchpads and phones send small deltas).
    wheel_rest: (f64, f64),
}

impl Planner {
    pub fn new(bounds: Rect) -> Self {
        Self { bounds, held_buttons: vec![], held_keys: vec![], cursor: None, wheel_rest: (0.0, 0.0) }
    }

    pub fn is_holding_anything(&self) -> bool { !self.held_buttons.is_empty() || !self.held_keys.is_empty() }

    pub fn plan(&mut self, msg: &Obj) -> Vec<Planned> {
        match jsonv::s(msg, "t") {
            Some("m") => self.plan_move(msg),
            Some("b") => self.plan_button(msg),
            Some("w") => self.plan_wheel(msg),
            Some("k") => self.plan_key(msg),
            Some("txt") => self.plan_text(msg),
            Some("rel") => self.release_all(),
            Some("sys") => match jsonv::s(msg, "k") {
                Some(k) if SYS_KEYS.contains(&k) => vec![Planned::Sys(k.into())],
                _ => vec![],
            },
            _ => vec![],
        }
    }

    /// Lets go of every held button and key: buttons first (ending any drag where it is), then ordinary keys, then
    /// modifiers, newest first.
    pub fn release_all(&mut self) -> Vec<Planned> {
        let mut out = vec![];
        let (x, y) = self.cursor.unwrap_or_else(|| self.bounds.mid());
        for b in self.held_buttons.drain(..).rev() { out.push(Planned::Button { b, down: false, x, y }); }
        let keys: Vec<Key> = self.held_keys.drain(..).rev().collect();
        for k in keys.iter().filter(|k| keymap::modifier(**k).is_none()) { out.push(Planned::Key { key: *k, down: false }); }
        for k in keys.iter().filter(|k| keymap::modifier(**k).is_some()) { out.push(Planned::Key { key: *k, down: false }); }
        out
    }

    fn point(&self, msg: &Obj) -> Option<(f64, f64)> {
        let (x, y) = (jsonv::n(msg, "x")?, jsonv::n(msg, "y")?);
        let b = self.bounds;
        if b.is_empty() { return None; }
        // Stay one pixel inside the right/bottom edge: that coordinate already belongs to the next display.
        let px = (b.x + x.clamp(0.0, 1.0) * b.w).min(b.x + b.w - 1.0).floor();
        let py = (b.y + y.clamp(0.0, 1.0) * b.h).min(b.y + b.h - 1.0).floor();
        Some((px, py))
    }

    fn plan_move(&mut self, msg: &Obj) -> Vec<Planned> {
        if let (Some(dx), Some(dy)) = (jsonv::n(msg, "dx"), jsonv::n(msg, "dy")) {
            if let Some(p) = self.point(msg) { self.cursor = Some(p); }
            let (dx, dy) = (dx.clamp(-1.0, 1.0) * self.bounds.w, dy.clamp(-1.0, 1.0) * self.bounds.h);
            if dx == 0.0 && dy == 0.0 { return vec![]; }
            return vec![Planned::Nudge { dx, dy }];
        }
        let Some((x, y)) = self.point(msg) else { return vec![] };
        self.cursor = Some((x, y));
        vec![Planned::Move { x, y }]
    }

    /// Buttons and scrolls carry their own position; if the pointer isn't there yet (a lost or late move), move it
    /// first so hover state and the click target are right.
    fn move_if_needed(&mut self, p: (f64, f64), out: &mut Vec<Planned>) {
        if self.cursor != Some(p) {
            self.cursor = Some(p);
            out.push(Planned::Move { x: p.0, y: p.1 });
        }
    }

    fn plan_button(&mut self, msg: &Obj) -> Vec<Planned> {
        let (Some(p), Some(b), Some(down)) = (self.point(msg), jsonv::i(msg, "b").and_then(Button::from), jsonv::b(msg, "d"))
        else { return vec![] };
        let mut out = vec![];
        self.move_if_needed(p, &mut out);
        if down {
            if !self.held_buttons.contains(&b) { self.held_buttons.push(b); }
        } else {
            self.held_buttons.retain(|h| *h != b);
        }
        out.push(Planned::Button { b, down, x: p.0, y: p.1 });
        out
    }

    fn plan_wheel(&mut self, msg: &Obj) -> Vec<Planned> {
        let Some(p) = self.point(msg) else { return vec![] };
        let lim = 10_000.0;
        let dx = jsonv::n(msg, "dx").unwrap_or(0.0).clamp(-lim, lim);
        let dy = jsonv::n(msg, "dy").unwrap_or(0.0).clamp(-lim, lim);
        let mut out = vec![];
        self.move_if_needed(p, &mut out);
        // DOM: positive dy = the page moves up (scrolling down); Windows: a positive wheel turn scrolls up. Browsers on
        // Windows report 100 CSS pixels per 120-unit notch, so the same scroll comes back out here.
        let ty = self.wheel_rest.1 - dy * 1.2;
        let tx = self.wheel_rest.0 + dx * 1.2;
        let (wy, wx) = (ty.trunc(), tx.trunc());
        self.wheel_rest = (tx - wx, ty - wy);
        if wx != 0.0 || wy != 0.0 { out.push(Planned::Wheel { dx: wx as i32, dy: wy as i32, x: p.0, y: p.1 }); }
        out
    }

    fn holds_modifier(&self, m: Modifier) -> bool {
        self.held_keys.iter().any(|k| keymap::modifier(*k) == Some(m))
    }

    /// The viewer's modifier bitmask says what it holds. Before an ordinary key, make ours agree: press a modifier
    /// it holds that we never got (a key-down lost to focus changes), and let go of one it no longer holds.
    fn sync_modifiers(&mut self, mask: i64, out: &mut Vec<Planned>) {
        for m in [Modifier::Shift, Modifier::Control, Modifier::Alt, Modifier::Meta] {
            let wanted = mask & keymap::mask_bit(m) != 0;
            let held = self.holds_modifier(m);
            if wanted && !held {
                let k = keymap::left_key(m);
                self.held_keys.push(k);
                out.push(Planned::Key { key: k, down: true });
            } else if !wanted && held {
                let mine: Vec<Key> = self.held_keys.iter().copied().filter(|k| keymap::modifier(*k) == Some(m)).collect();
                self.held_keys.retain(|k| keymap::modifier(*k) != Some(m));
                for k in mine { out.push(Planned::Key { key: k, down: false }); }
            }
        }
    }

    fn plan_key(&mut self, msg: &Obj) -> Vec<Planned> {
        let (Some(code), Some(down)) = (jsonv::s(msg, "c"), jsonv::b(msg, "d")) else { return vec![] };
        let Some(key) = keymap::lookup(code) else {
            // A key with no PC position (some layouts' extra keys, or a code the browser left empty): type the
            // character it produced instead.
            if down {
                if let Some(k) = jsonv::s(msg, "k") {
                    if k.chars().count() == 1 && !k.chars().any(char::is_control) { return vec![Planned::Text(k.into())]; }
                }
            }
            return vec![];
        };
        let mut out = vec![];
        if let Some(m) = keymap::modifier(key) {
            if m == Modifier::CapsLock {
                // Caps Lock toggles rather than being held, so it is never "released" by rel.
                out.push(Planned::Key { key, down });
                return out;
            }
            if down {
                if !self.held_keys.contains(&key) { self.held_keys.push(key); }
            } else {
                self.held_keys.retain(|k| *k != key);
            }
            out.push(Planned::Key { key, down });
            return out;
        }
        if down {
            if let Some(mask) = jsonv::i(msg, "m") { self.sync_modifiers(mask, &mut out); }
            if !self.held_keys.contains(&key) { self.held_keys.push(key); }
        } else {
            self.held_keys.retain(|k| *k != key);
        }
        out.push(Planned::Key { key, down });
        out
    }

    fn plan_text(&mut self, msg: &Obj) -> Vec<Planned> {
        match jsonv::s(msg, "s") {
            Some(s) if !s.is_empty() => vec![Planned::Text(s.chars().take(MAX_TEXT).collect())],
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p() -> Planner { Planner::new(Rect::new(1920.0, 0.0, 2560.0, 1440.0)) }
    fn m(v: Value) -> Obj { v.as_object().unwrap().clone() }

    #[test]
    fn pointer_maps_onto_the_display_and_stays_inside() {
        let mut pl = p();
        assert_eq!(pl.plan(&m(json!({"t":"m","x":0.5,"y":0.5}))), vec![Planned::Move { x: 3200.0, y: 720.0 }]);
        assert_eq!(pl.plan(&m(json!({"t":"m","x":1,"y":2}))), vec![Planned::Move { x: 4479.0, y: 1439.0 }]);
        assert!(pl.plan(&m(json!({"t":"m","x":"a","y":0}))).is_empty());
    }

    #[test]
    fn a_click_moves_first_when_the_move_was_lost_and_rel_lets_go() {
        let mut pl = p();
        let out = pl.plan(&m(json!({"t":"b","b":0,"d":true,"x":0,"y":0,"n":1})));
        assert_eq!(out, vec![Planned::Move { x: 1920.0, y: 0.0 }, Planned::Button { b: Button::Left, down: true, x: 1920.0, y: 0.0 }]);
        pl.plan(&m(json!({"t":"k","c":"ShiftLeft","k":"Shift","d":true,"m":1})));
        pl.plan(&m(json!({"t":"k","c":"KeyA","k":"A","d":true,"m":1})));
        assert!(pl.is_holding_anything());
        let rel = pl.plan(&m(json!({"t":"rel"})));
        assert_eq!(rel, vec![
            Planned::Button { b: Button::Left, down: false, x: 1920.0, y: 0.0 },
            Planned::Key { key: keymap::lookup("KeyA").unwrap(), down: false },
            Planned::Key { key: keymap::lookup("ShiftLeft").unwrap(), down: false },
        ]);
        assert!(!pl.is_holding_anything());
    }

    #[test]
    fn missing_modifiers_are_pressed_and_stale_ones_let_go() {
        let mut pl = p();
        let ctrl = keymap::lookup("ControlLeft").unwrap();
        let c = keymap::lookup("KeyC").unwrap();
        let out = pl.plan(&m(json!({"t":"k","c":"KeyC","k":"c","d":true,"m":2})));
        assert_eq!(out, vec![Planned::Key { key: ctrl, down: true }, Planned::Key { key: c, down: true }]);
        pl.plan(&m(json!({"t":"k","c":"KeyC","k":"c","d":false,"m":2})));
        let out = pl.plan(&m(json!({"t":"k","c":"KeyV","k":"v","d":true,"m":0})));
        assert_eq!(out[0], Planned::Key { key: ctrl, down: false });
    }

    #[test]
    fn wheel_carries_fractions_and_turns_the_right_way() {
        let mut pl = p();
        let a = pl.plan(&m(json!({"t":"w","dx":0,"dy":100,"x":0.5,"y":0.5})));
        assert_eq!(a.last(), Some(&Planned::Wheel { dx: 0, dy: -120, x: 3200.0, y: 720.0 }));
        assert!(pl.plan(&m(json!({"t":"w","dx":0,"dy":0.5,"x":0.5,"y":0.5}))).is_empty());
        let b = pl.plan(&m(json!({"t":"w","dx":0,"dy":0.5,"x":0.5,"y":0.5})));
        assert_eq!(b, vec![Planned::Wheel { dx: 0, dy: -1, x: 3200.0, y: 720.0 }]);
    }

    #[test]
    fn text_keys_without_a_position_and_special_keys() {
        let mut pl = p();
        assert_eq!(pl.plan(&m(json!({"t":"k","c":"","k":"é","d":true}))), vec![Planned::Text("é".into())]);
        assert!(pl.plan(&m(json!({"t":"k","c":"","k":"Unidentified","d":true}))).is_empty());
        let long: String = "x".repeat(400);
        assert_eq!(pl.plan(&m(json!({"t":"txt","s":long}))), vec![Planned::Text("x".repeat(256))]);
        assert_eq!(pl.plan(&m(json!({"t":"sys","k":"brightnessUp"}))), vec![Planned::Sys("brightnessUp".into())]);
        assert!(pl.plan(&m(json!({"t":"sys","k":"volumeUp"}))).is_empty(), "a viewer never changes the PC's volume");
        let nudge = pl.plan(&m(json!({"t":"m","x":0.5,"y":0.5,"dx":0.01,"dy":-0.01})));
        assert_eq!(nudge, vec![Planned::Nudge { dx: 25.6, dy: -14.4 }]);
    }
}
