//! What size to capture and encode at, the sane ranges for the host's capture settings, and the two sound levels.
use crate::jsonv::{self, Obj};

#[derive(Clone, Debug, PartialEq)]
pub struct CaptureRequest {
    pub display: Option<u32>,
    pub max_edge: u32,
    pub fps: u32,
    pub kbps: u32,
    pub audio: bool,
    /// Show only this window (the picture follows it) instead of the whole display.
    pub window: Option<u32>,
    /// The viewer agreed to H.264 High. OpenH264 always makes Constrained Baseline, which every decoder plays.
    pub high: bool,
    /// The coarsest quantiser the encoder may use (detail first: it drops frames instead), or None for no limit.
    pub max_qp: Option<u8>,
}

impl Default for CaptureRequest {
    fn default() -> Self {
        Self { display: None, max_edge: 1920, fps: 30, kbps: 5000, audio: true, window: None, high: false, max_qp: None }
    }
}

pub fn clamp_edge(v: i64) -> u32 { v.clamp(160, 3840) as u32 }
pub fn clamp_fps(v: i64) -> u32 { v.clamp(1, 60) as u32 }
pub fn clamp_kbps(v: i64) -> u32 { v.clamp(100, 50_000) as u32 }
pub fn clamp_qp(v: i64) -> u8 { v.clamp(18, 51) as u8 }

impl CaptureRequest {
    /// Reads a `capture` command, clamping each value into a range the encoder handles well.
    pub fn from_command(c: &Obj) -> Self {
        let id = |k: &str| jsonv::n(c, k).filter(|v| *v >= 0.0 && *v <= u32::MAX as f64 && v.fract() == 0.0).map(|v| v as u32);
        Self {
            display: id("display"),
            max_edge: clamp_edge(jsonv::i(c, "maxEdge").unwrap_or(1920)),
            fps: clamp_fps(jsonv::i(c, "fps").unwrap_or(30)),
            kbps: clamp_kbps(jsonv::i(c, "kbps").unwrap_or(5000)),
            audio: jsonv::b(c, "audio").unwrap_or(true),
            window: id("window").filter(|w| *w >= 1),
            high: jsonv::s(c, "profile") == Some("high"),
            max_qp: jsonv::i(c, "maxQp").map(clamp_qp),
        }
    }
}

/// The encoded size for a picture of pw × ph pixels: the longest edge at most max_edge, the shape kept, both sides
/// even (4:2:0 video needs that), never bigger than the source, and within OpenH264's 3840×2160 limit.
pub fn output_size(pw: u32, ph: u32, max_edge: u32) -> (u32, u32) {
    let (pw, ph) = (pw.max(2) as u64, ph.max(2) as u64);
    let longest = pw.max(ph);
    let mut edge = (max_edge.max(2) as u64).min(longest);
    // Level 5.2: the long side at most 3840 and the short side at most 2160.
    let short = pw.min(ph);
    if short * edge / longest > 2160 { edge = 2160 * longest / short; }
    let w = (pw * edge / longest) & !1;
    let h = (ph * edge / longest) & !1;
    (w.max(2) as u32, h.max(2) as u32)
}

/// How loud the PC's sound is in two places while someone is connected: on its own speakers, and in what is sent.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AudioLevels {
    /// The PC's speakers, 0 (silent) to 1 (as loud as usual).
    pub speakers: f64,
    /// What is sent to the viewer, 0 to 1.5 (soft-limited).
    pub stream: f64,
}

impl AudioLevels {
    pub const MAX_STREAM: f64 = 1.5;
    pub const NORMAL: AudioLevels = AudioLevels { speakers: 1.0, stream: 1.0 };

    pub fn new(speakers: f64, stream: f64) -> Self {
        let c = |v: f64, top: f64| if v.is_finite() { v.clamp(0.0, top) } else { 1.0 };
        Self { speakers: c(speakers, 1.0), stream: c(stream, Self::MAX_STREAM) }
    }

    /// From a command: `speakers` and `stream`, each optional, kept from `base` when missing.
    pub fn from_command(c: &Obj, base: AudioLevels) -> Self {
        Self::new(jsonv::n(c, "speakers").unwrap_or(base.speakers), jsonv::n(c, "stream").unwrap_or(base.stream))
    }

    pub fn quiet_speakers(&self) -> bool { self.speakers < 0.999 }
}

/// Applies a gain to interleaved samples, gliding from the last gain to the new one across the buffer (so a moving
/// slider doesn't click), and bends anything above the knee smoothly towards full scale instead of clipping.
#[derive(Clone, Debug)]
pub struct GainStage {
    pub current: f32,
    pub target: f32,
}

impl Default for GainStage {
    fn default() -> Self { Self { current: 1.0, target: 1.0 } }
}

impl GainStage {
    pub const KNEE: f32 = 0.8;

    pub fn apply(&mut self, samples: &mut [f32]) {
        let n = samples.len();
        if n == 0 { return; }
        let (from, to) = (self.current, self.target);
        if from == 1.0 && to == 1.0 { return; }
        let step = (to - from) / n as f32;
        let mut g = from;
        for s in samples.iter_mut() {
            g += step;
            *s = Self::limit(*s * g);
        }
        self.current = to;
    }

    pub fn limit(x: f32) -> f32 {
        let a = x.abs();
        if a <= Self::KNEE { return x; }
        let room = 1.0 - Self::KNEE;
        let y = Self::KNEE + room * ((a - Self::KNEE) / room).tanh();
        if x < 0.0 { -y } else { y }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sizes_keep_the_shape_and_stay_even() {
        assert_eq!(output_size(2880, 1800, 1920), (1920, 1200));
        assert_eq!(output_size(1920, 1080, 4096), (1920, 1080));
        assert_eq!(output_size(1366, 768, 1366), (1366, 768));
        assert_eq!(output_size(1365, 767, 4000), (1364, 766));
        assert_eq!(output_size(3840, 2400, 3840), (3456, 2160), "short side capped at 2160");
        assert_eq!(output_size(1080, 1920, 1280), (720, 1280));
    }

    #[test]
    fn capture_commands_are_clamped() {
        let c = json!({"c":"capture","on":true,"display":3,"maxEdge":99999,"fps":0,"kbps":7,"audio":false,"window":0,"profile":"high","maxQp":2});
        let r = CaptureRequest::from_command(c.as_object().unwrap());
        assert_eq!(r, CaptureRequest { display: Some(3), max_edge: 3840, fps: 1, kbps: 100, audio: false, window: None, high: true, max_qp: Some(18) });
        let r = CaptureRequest::from_command(json!({"display":-1,"window":2.5}).as_object().unwrap());
        assert_eq!((r.display, r.window), (None, None));
    }

    #[test]
    fn levels_and_gain() {
        let l = AudioLevels::from_command(json!({"stream": 9}).as_object().unwrap(), AudioLevels::new(0.5, 1.0));
        assert_eq!(l, AudioLevels { speakers: 0.5, stream: 1.5 });
        assert!(l.quiet_speakers());
        let mut g = GainStage { current: 1.0, target: 1.5 };
        let mut s = vec![0.9f32; 100];
        g.apply(&mut s);
        assert!(s.iter().all(|v| *v < 1.0 && *v > 0.8));
        assert_eq!(GainStage::limit(0.5), 0.5);
        assert!(GainStage::limit(-3.0) >= -1.0 && GainStage::limit(-3.0) < -0.99);
    }
}
