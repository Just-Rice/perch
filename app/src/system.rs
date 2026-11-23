//! What the PC offers the rest of the app (displays, windows, picture and sound sources), from the real Windows
//! implementation (sys/windows) or the synthetic one used by --synthetic, tests and development on other systems.
use crate::media::synthetic;
use crate::media::yuv::I420;
use crate::planner::Rect;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq)]
pub struct DisplayInfo {
    pub id: u32,
    pub name: String,
    /// Physical pixels in the virtual desktop.
    pub rect: Rect,
    pub main: bool,
}

impl DisplayInfo {
    /// As the protocol lists it: `{id, name, x, y, width, height, main}`.
    pub fn json(&self) -> Value {
        json!({"id": self.id, "name": self.name, "x": self.rect.x as i64, "y": self.rect.y as i64,
               "width": self.rect.w as i64, "height": self.rect.h as i64, "main": self.main})
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct WindowInfo {
    pub id: u32,
    pub app: String,
    pub title: String,
    pub rect: Rect,
}

impl WindowInfo {
    pub fn json(&self) -> Value {
        json!({"id": self.id, "app": self.app, "title": self.title, "width": self.rect.w as i64, "height": self.rect.h as i64})
    }
}

/// The part of a window on a display, in that display's own pixels, on whole pixels; None when too little of it
/// is there to show.
pub fn region_of(window: Rect, display: Rect) -> Option<Rect> {
    let x0 = window.x.max(display.x).floor();
    let y0 = window.y.max(display.y).floor();
    let x1 = (window.x + window.w).min(display.x + display.w).ceil();
    let y1 = (window.y + window.h).min(display.y + display.h).ceil();
    if x1 - x0 < 32.0 || y1 - y0 < 32.0 { return None; }
    // Even sizes, so the picture never needs padding.
    let (w, h) = (((x1 - x0) as i64 & !1) as f64, ((y1 - y0) as i64 & !1) as f64);
    Some(Rect::new(x0 - display.x, y0 - display.y, w, h))
}

pub fn contains(r: Rect, (x, y): (f64, f64)) -> bool { x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h }

#[derive(Debug)]
pub enum SourceError {
    /// The capture broke but may work again (display mode change, the secure desktop, a lost device): rebuild it.
    Lost(String),
    /// It won't work (no such display, nothing to capture with).
    Fatal(String),
}

/// Pictures of one display (or of a region of it), delivered already scaled and converted.
pub trait VideoSource: Send {
    /// `region` in the display's own pixels (None: all of it), delivered at `w × h`.
    fn configure(&mut self, region: Option<Rect>, w: usize, h: usize);
    /// Waits up to `timeout` for a new picture. Ok(true): `out` holds it; Ok(false): nothing new on screen.
    fn next(&mut self, out: &mut I420, timeout: Duration) -> Result<bool, SourceError>;
    fn name(&self) -> String;
}

/// Sound from the PC (or the test tone): interleaved 48 kHz stereo floats with the time of their first frame.
pub type AudioSink = Box<dyn FnMut(&[f32], u64) + Send>;

pub trait AudioCapture: Send {
    /// The PC's own speakers while capturing (0..1), where the source can do that.
    fn set_speakers(&mut self, _level: f64) {}
    fn stop(&mut self);
}

// ---- the synthetic PC ------------------------------------------------------------------------------------------

pub const SYNTHETIC_WINDOW: u32 = 7;
static SYNTHETIC_WINDOW_RECT: Mutex<Rect> = Mutex::new(Rect { x: 200.0, y: 100.0, w: 800.0, h: 600.0 });

pub fn synthetic_display() -> DisplayInfo {
    DisplayInfo { id: synthetic::DISPLAY_ID, name: synthetic::DISPLAY_NAME.into(),
        rect: Rect::new(0.0, 0.0, synthetic::DISPLAY_W as f64, synthetic::DISPLAY_H as f64), main: true }
}

pub fn synthetic_window() -> WindowInfo {
    WindowInfo { id: SYNTHETIC_WINDOW, app: "Test App".into(), title: "Test Window".into(), rect: *SYNTHETIC_WINDOW_RECT.lock().unwrap() }
}

pub fn synthetic_fit(aspect: f64, area: Rect) -> bool {
    let mut r = SYNTHETIC_WINDOW_RECT.lock().unwrap();
    *r = fit_rect(*r, aspect, area);
    true
}

/// The biggest rectangle of shape `aspect` (w/h) that fits in `area`, at least 320 on each side where possible,
/// centred on where the window was.
pub fn fit_rect(was: Rect, aspect: f64, area: Rect) -> Rect {
    let aspect = aspect.clamp(0.2, 5.0);
    let (mut w, mut h) = (area.w, area.w / aspect);
    if h > area.h { h = area.h; w = h * aspect; }
    let (w, h) = (w.max(320.0_f64.min(area.w)).floor(), h.max(320.0_f64.min(area.h)).floor());
    let (cx, cy) = was.mid();
    let x = (cx - w / 2.0).clamp(area.x, area.x + area.w - w);
    let y = (cy - h / 2.0).clamp(area.y, area.y + area.h - h);
    Rect::new(x.floor(), y.floor(), w, h)
}

pub struct SyntheticVideo {
    fps: u32,
    start: Instant,
    last_index: Option<u64>,
    region: Option<Rect>,
    w: usize,
    h: usize,
}

impl SyntheticVideo {
    pub fn new(fps: u32) -> Self { Self { fps: fps.max(1), start: Instant::now(), last_index: None, region: None, w: 0, h: 0 } }
}

impl VideoSource for SyntheticVideo {
    fn configure(&mut self, region: Option<Rect>, w: usize, h: usize) {
        self.region = region;
        self.w = w;
        self.h = h;
        self.last_index = None;
    }

    fn next(&mut self, out: &mut I420, timeout: Duration) -> Result<bool, SourceError> {
        let frame = Duration::from_micros(1_000_000 / self.fps as u64);
        let deadline = Instant::now() + timeout;
        loop {
            let index = (self.start.elapsed().as_micros() / frame.as_micros()) as u64;
            if self.last_index != Some(index) {
                self.last_index = Some(index);
                if out.width != self.w || out.height != self.h { *out = I420::new(self.w, self.h); }
                synthetic::draw(out, index, self.region.map(|r| (r.x, r.y, r.w, r.h)));
                return Ok(true);
            }
            let next_at = self.start + frame * (index as u32 + 1);
            let now = Instant::now();
            if now >= deadline { return Ok(false); }
            std::thread::sleep((next_at.min(deadline)).saturating_duration_since(now).max(Duration::from_millis(1)));
        }
    }

    fn name(&self) -> String { "test pattern".into() }
}

/// The test tone, 20 ms at a time on its own thread.
pub struct SyntheticAudio { stop: std::sync::Arc<std::sync::atomic::AtomicBool>, thread: Option<std::thread::JoinHandle<()>> }

impl SyntheticAudio {
    pub fn start(mut sink: AudioSink) -> Self {
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let s = stop.clone();
        let thread = std::thread::Builder::new().name("roost-tone".into()).spawn(move || {
            let mut tone = synthetic::Tone::default();
            let start = crate::clock::now_us();
            let mut produced: u64 = 0;
            while !s.load(std::sync::atomic::Ordering::Relaxed) {
                let due = (crate::clock::now_us() - start) * 48 / 1000;
                // After a long stall (the PC slept), skip ahead instead of bursting seconds of tone at once.
                if due > produced + 48_000 { produced = due - 960; }
                while produced + 960 <= due {
                    sink(&tone.next(960), start + produced * 1000 / 48);
                    produced += 960;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }).expect("tone thread");
        Self { stop, thread: Some(thread) }
    }
}

impl AudioCapture for SyntheticAudio {
    fn stop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(t) = self.thread.take() { let _ = t.join(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regions_and_fitting() {
        let d = Rect::new(1920.0, 0.0, 1920.0, 1080.0);
        assert_eq!(region_of(Rect::new(1900.0, 100.0, 801.0, 600.0), d), Some(Rect::new(0.0, 100.0, 780.0, 600.0)));
        assert_eq!(region_of(Rect::new(0.0, 0.0, 100.0, 100.0), d), None);
        let f = fit_rect(Rect::new(200.0, 100.0, 800.0, 600.0), 9.0 / 16.0, Rect::new(0.0, 0.0, 1920.0, 1040.0));
        assert_eq!((f.w, f.h), (585.0, 1040.0));
        assert!(f.x >= 0.0 && f.y == 0.0);
    }

    #[test]
    fn the_synthetic_source_paces_itself() {
        let mut s = SyntheticVideo::new(30);
        s.configure(None, 320, 180);
        let mut pic = I420::new(2, 2);
        assert!(s.next(&mut pic, Duration::from_millis(100)).unwrap());
        assert_eq!((pic.width, pic.height), (320, 180));
        let t = Instant::now();
        assert!(s.next(&mut pic, Duration::from_millis(100)).unwrap());
        assert!(t.elapsed() <= Duration::from_millis(60));
    }
}
