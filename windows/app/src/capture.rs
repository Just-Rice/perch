//! Runs capture for the host's `capture` commands: picks the display and size, makes an encoder, starts the screen
//! (or the synthetic pattern) and the sound, and hands encoded video and audio to the host. docs/PROTOCOL.md,
//! "WebRTC" and "IPC". Commands come from the controller thread; pictures are taken and encoded on one session
//! thread; sound comes on its source's own thread.
use crate::media::h264::{self, H264};
use crate::media::opus::AudioPipeline;
use crate::media::yuv::I420;
use crate::planner::Rect;
use crate::sizing::{self, AudioLevels, CaptureRequest};
use crate::system::{self, AudioCapture, DisplayInfo, SourceError, VideoSource};
use crate::clock;
use serde_json::{json, Value};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Where encoded media and events go (the host link).
pub trait Sink: Send + Sync {
    fn video(&self, keyframe: bool, pts_us: u64, annex_b: &[u8]) -> bool;
    /// False while the pipe to the host is backed up: video is dropped (and a keyframe follows) instead of queued.
    fn can_send_video(&self) -> bool;
    fn audio(&self, pts_us: u64, packet: &[u8]);
    fn event(&self, e: Value);
}

/// Makes the picture source for a display: the real screen or the test pattern.
pub type SourceFactory = Arc<dyn Fn(&DisplayInfo, u32) -> Result<Box<dyn VideoSource>, String> + Send + Sync>;
/// Starts the sound: the PC's own, or the test tone.
pub type AudioFactory = Arc<dyn Fn(system::AudioSink, AudioLevels) -> Result<Box<dyn AudioCapture>, String> + Send + Sync>;
/// The displays and windows right now.
pub type Displays = Arc<dyn Fn() -> Vec<DisplayInfo> + Send + Sync>;
pub type FindWindow = Arc<dyn Fn(u32) -> Option<system::WindowInfo> + Send + Sync>;

/// With nothing new on screen, send the last picture again this often so the viewer's stream stays alive.
const REPEAT_AFTER: Duration = Duration::from_millis(1000);
/// A keyframe that rate control dropped is retried this soon, even on a still screen.
const KEYFRAME_RETRY: Duration = Duration::from_millis(100);
/// The newest picture was dropped by rate control: the viewer has an older one, so try again this soon.
const DROP_RETRY: Duration = Duration::from_millis(40);
/// Just after movement stops the last picture is rough (encoded in a hurry): for this long send it again several
/// times a second, which costs little and lets the encoder sharpen what the viewer is reading.
const SHARPEN_FOR: Duration = Duration::from_millis(1500);
const SHARPEN_EVERY: Duration = Duration::from_millis(120);
/// With a detail cap, rate control can throw away the keyframe a viewer waits for again and again on a slow link;
/// after this many in a row the cap is lifted until one gets through.
const KEYFRAME_DROPS_BEFORE_RELAX: u32 = 2;

enum Msg {
    Keyframe,
    Bitrate(u32),
    Reconfigure { w: usize, h: usize, fps: u32, kbps: u32, max_qp: Option<u8>, region: Option<Rect> },
    Move(Rect),
    Stop,
}

/// What a running session shows (shared with the input thread, which maps pointer positions onto it).
#[derive(Clone, Debug)]
pub struct Shown {
    pub display: DisplayInfo,
    /// The part of the display shown (its own pixels), when following one window.
    pub region: Option<Rect>,
    pub window: Option<u32>,
    pub width: usize,
    pub height: usize,
    pub fps: u32,
    pub audio: bool,
}

impl Shown {
    /// The part of the virtual desktop in the picture: input maps onto it.
    pub fn input_bounds(&self) -> Rect {
        match self.region {
            Some(r) => Rect::new(self.display.rect.x + r.x, self.display.rect.y + r.y, r.w, r.h),
            None => self.display.rect,
        }
    }
}

struct Session {
    tx: Sender<Msg>,
    thread: Option<std::thread::JoinHandle<()>>,
    request: CaptureRequest,
}

pub struct CaptureController {
    sink: Arc<dyn Sink>,
    sources: SourceFactory,
    audio_factory: AudioFactory,
    displays: Displays,
    find_window: FindWindow,
    session: Option<Session>,
    pub shown: Arc<Mutex<Option<Shown>>>,
    audio: Option<Box<dyn AudioCapture>>,
    pipeline: Arc<Mutex<Option<AudioPipeline>>>,
    levels: AudioLevels,
    last_request: Option<CaptureRequest>,
    /// A new window size is only taken once it has been seen twice in a row, so dragging an edge doesn't rebuild
    /// the encoder several times a second.
    pending_size: Option<(f64, f64)>,
    failures: Arc<Mutex<Vec<String>>>,
}

impl CaptureController {
    pub fn new(sink: Arc<dyn Sink>, sources: SourceFactory, audio_factory: AudioFactory, displays: Displays, find_window: FindWindow) -> Self {
        Self { sink, sources, audio_factory, displays, find_window, session: None, shown: Arc::new(Mutex::new(None)),
            audio: None, pipeline: Arc::new(Mutex::new(None)), levels: AudioLevels::NORMAL, last_request: None,
            pending_size: None, failures: Arc::new(Mutex::new(vec![])) }
    }

    pub fn levels(&self) -> AudioLevels { self.levels }
    pub fn is_capturing(&self) -> bool { self.session.is_some() }
    pub fn window_id(&self) -> Option<u32> { self.shown.lock().unwrap().as_ref().and_then(|s| s.window) }

    pub fn set_levels(&mut self, levels: AudioLevels) {
        self.levels = levels;
        if let Some(p) = self.pipeline.lock().unwrap().as_mut() { p.gain.target = levels.stream as f32; }
        if let Some(a) = self.audio.as_mut() { a.set_speakers(levels.speakers); }
    }

    pub fn keyframe(&self) {
        if let Some(s) = &self.session { let _ = s.tx.send(Msg::Keyframe); }
    }

    pub fn set_bitrate(&mut self, kbps: u32) {
        let kbps = sizing::clamp_kbps(kbps as i64);
        if let Some(s) = &mut self.session { s.request.kbps = kbps; let _ = s.tx.send(Msg::Bitrate(kbps)); }
    }

    /// Starts capture, or changes what is being captured.
    pub fn capture(&mut self, request: CaptureRequest) {
        self.last_request = Some(request.clone());
        self.pending_size = None;
        self.start(request);
    }

    fn start(&mut self, request: CaptureRequest) {
        let all = (self.displays)();
        let Some(mut display) = request.display.and_then(|id| all.iter().find(|d| d.id == id).cloned())
            .or_else(|| all.iter().find(|d| d.main).cloned()).or_else(|| all.first().cloned())
        else {
            self.sink.event(json!({"e": "capture-error", "code": "capture-failed", "message": "This PC has no display to capture."}));
            return;
        };
        if let Some(want) = request.display { if want != display.id { info!("display {want} is not connected; capturing display {} instead", display.id); } }
        // One window: the part of its display it covers right now. A window that is gone (closed, minimised, on
        // another desktop) means the whole display again, and the host is told.
        let mut region = None;
        if let Some(wid) = request.window {
            if let Some(w) = (self.find_window)(wid) {
                let mid = w.rect.mid();
                if !system::contains(display.rect, mid) {
                    if let Some(other) = all.iter().find(|d| system::contains(d.rect, mid)) { display = other.clone(); }
                }
                region = system::region_of(w.rect, display.rect);
            }
            if region.is_none() {
                if let Some(r) = self.last_request.as_mut() { if r.window == Some(wid) { r.window = None; } }
                info!("window {wid} is no longer on screen; showing the whole display");
                self.sink.event(json!({"e": "window-gone", "window": wid}));
            }
        }
        let (pw, ph) = region.map(|r| (r.w, r.h)).unwrap_or((display.rect.w, display.rect.h));
        let (w, h) = sizing::output_size(pw as u32, ph as u32, request.max_edge);
        let (w, h) = (w as usize, h as usize);
        let window = if region.is_some() { request.window } else { None };

        let current = self.shown.lock().unwrap().clone();
        if let (Some(cur), Some(s)) = (current, self.session.as_mut()) {
            if cur.display.id == display.id && cur.audio == request.audio {
                if cur.width == w && cur.height == h && cur.region == region && cur.fps == request.fps && s.request.max_qp == request.max_qp {
                    // Same picture: keep the stream, take the new bitrate, and send a keyframe for whoever asked.
                    let _ = s.tx.send(Msg::Bitrate(request.kbps));
                    let _ = s.tx.send(Msg::Keyframe);
                    s.request = request;
                    self.emit_started();
                    return;
                }
                // Same display, new size, region or frame rate: a new encoder on the running stream, so the sound
                // carries on.
                let _ = s.tx.send(Msg::Reconfigure { w, h, fps: request.fps, kbps: request.kbps, max_qp: request.max_qp, region });
                s.request = request.clone();
                *self.shown.lock().unwrap() = Some(Shown { display, region, window, width: w, height: h, fps: request.fps, audio: request.audio });
                info!("capture changed to {w}x{h} at {} fps, {} kbit/s{}", request.fps, request.kbps, if region.is_some() { ", one window" } else { "" });
                self.emit_started();
                return;
            }
        }
        self.teardown();
        let mut source = match (self.sources)(&display, request.fps) {
            Ok(s) => s,
            Err(e) => {
                warn!("capture failed to start: {e}");
                self.sink.event(json!({"e": "capture-error", "code": "capture-failed", "message": format!("Couldn't capture the screen: {e}")}));
                return;
            }
        };
        source.configure(region, w, h);
        let encoder = match H264::new(w, h, request.fps, request.kbps, request.max_qp) {
            Ok(e) => e,
            Err(e) => {
                self.sink.event(json!({"e": "capture-error", "code": "capture-failed", "message": format!("Couldn't start the video encoder: {e}")}));
                return;
            }
        };
        if request.audio { self.start_audio(); }
        let shown = Shown { display: display.clone(), region, window, width: w, height: h, fps: request.fps, audio: request.audio };
        *self.shown.lock().unwrap() = Some(shown);
        let (tx, rx) = mpsc::channel();
        let sink = self.sink.clone();
        let sources = self.sources.clone();
        let failures = self.failures.clone();
        let req = request.clone();
        let source_name = source.name();
        let thread = std::thread::Builder::new().name("roost-video".into()).spawn(move || {
            run_session(rx, source, encoder, req, display, sink, sources, failures);
        }).expect("video thread");
        info!("capture started: {source_name} at {w}x{h}, {} fps, {} kbit/s{}, audio {}", request.fps, request.kbps,
            request.max_qp.map(|q| format!(", detail cap QP {q}")).unwrap_or_default(), request.audio);
        self.session = Some(Session { tx, thread: Some(thread), request });
        self.emit_started();
    }

    fn start_audio(&mut self) {
        if self.audio.is_some() { return; }
        match AudioPipeline::new() {
            Ok(mut p) => { p.gain.target = self.levels.stream as f32; *self.pipeline.lock().unwrap() = Some(p); }
            Err(e) => { warn!("no sound: {e}"); return; }
        }
        let pipeline = self.pipeline.clone();
        let sink = self.sink.clone();
        let feed: system::AudioSink = Box::new(move |pcm: &[f32], pts: u64| {
            if let Some(p) = pipeline.lock().unwrap().as_mut() { p.feed(pcm, pts, |t, pk| sink.audio(t, &pk)); }
        });
        match (self.audio_factory)(feed, self.levels) {
            Ok(a) => self.audio = Some(a),
            Err(e) => warn!("no sound from this PC: {e}"),
        }
    }

    fn emit_started(&self) {
        let Some(s) = self.shown.lock().unwrap().clone() else { return };
        let mut e = json!({"e": "capture-started", "display": s.display.id, "width": s.width, "height": s.height,
                           "fps": s.fps, "profile": "baseline", "encoder": h264::NAME});
        if let Some(w) = s.window { e["window"] = json!(w); }
        self.sink.event(e);
    }

    /// Stops capture. `notify` false is for when there is no host left to tell.
    pub fn stop(&mut self, reason: &str, notify: bool) {
        self.last_request = None;
        self.teardown();
        if let Some(mut a) = self.audio.take() { a.stop(); }
        *self.pipeline.lock().unwrap() = None;
        if notify { self.sink.event(json!({"e": "capture-stopped", "reason": reason})); }
    }

    fn teardown(&mut self) {
        if let Some(mut s) = self.session.take() {
            let _ = s.tx.send(Msg::Stop);
            if let Some(t) = s.thread.take() { let _ = t.join(); }
        }
        *self.shown.lock().unwrap() = None;
    }

    /// Called a few times a second by the controller: follows the one window being shown, and notices a session
    /// that ended by itself (the display went away for good).
    pub fn tick(&mut self) {
        let failed: Vec<String> = std::mem::take(&mut *self.failures.lock().unwrap());
        if !failed.is_empty() && self.session.as_ref().is_some_and(|s| s.thread.as_ref().is_some_and(|t| t.is_finished())) {
            self.teardown();
            if let Some(mut a) = self.audio.take() { a.stop(); }
            *self.pipeline.lock().unwrap() = None;
            self.sink.event(json!({"e": "capture-error", "code": "capture-failed", "message": failed.join("; ")}));
            self.sink.event(json!({"e": "capture-stopped", "reason": "error"}));
            self.last_request = None;
            return;
        }
        let Some(request) = self.last_request.clone() else { return };
        let Some(wid) = request.window else { return };
        let Some(cur) = self.shown.lock().unwrap().clone() else { return };
        if cur.window != Some(wid) { return; }
        let Some(shown) = cur.region else { return };
        let target = (self.find_window)(wid)
            .filter(|w| system::contains(cur.display.rect, w.rect.mid()))
            .and_then(|w| system::region_of(w.rect, cur.display.rect));
        let Some(target) = target else { return self.start(request) };
        if target == shown { self.pending_size = None; return; }
        if (target.w, target.h) == (shown.w, shown.h) {
            self.pending_size = None;
            if let Some(s) = &self.session { let _ = s.tx.send(Msg::Move(target)); }
            if let Some(sh) = self.shown.lock().unwrap().as_mut() { sh.region = Some(target); }
        } else if self.pending_size == Some((target.w, target.h)) {
            self.pending_size = None;
            self.start(request);
        } else {
            self.pending_size = Some((target.w, target.h));
        }
    }
}

/// Until a keyframe has gone out, and again after any frame that couldn't be sent, only a keyframe may: every other
/// frame builds on pictures the viewer would never have had.
struct Gate { awaiting: bool }

impl Gate {
    fn admit(&mut self, keyframe: bool, can_send: bool) -> bool {
        if !can_send { self.awaiting = true; return false; }
        if keyframe { self.awaiting = false; return true; }
        !self.awaiting
    }
}

#[allow(clippy::too_many_arguments)]
fn run_session(rx: Receiver<Msg>, mut source: Box<dyn VideoSource>, mut enc: H264, request: CaptureRequest, display: DisplayInfo,
               sink: Arc<dyn Sink>, sources: SourceFactory, failures: Arc<Mutex<Vec<String>>>) {
    let mut gate = Gate { awaiting: true };
    let mut pic = I420::new(enc.width, enc.height);
    let mut have = false;
    let mut fps = request.fps;
    let mut max_qp = request.max_qp;
    let mut region: Option<Rect> = None;
    let mut last_encode = Instant::now() - Duration::from_secs(10);
    let mut last_new = Instant::now() - Duration::from_secs(10);
    let mut dropped = false;
    let mut keyframe_drops = 0u32;
    let mut relaxed = false;
    let mut clock = clock::Monotonic::default();
    let mut lost_since: Option<Instant> = None;
    let mut rebuilds = 0u32;

    loop {
        // Commands first.
        loop {
            match rx.try_recv() {
                Ok(Msg::Stop) | Err(mpsc::TryRecvError::Disconnected) => return,
                Ok(Msg::Keyframe) => gate.awaiting = true,
                Ok(Msg::Bitrate(k)) => enc.set_bitrate(k),
                Ok(Msg::Move(r)) => { region = Some(r); source.configure(region, enc.width, enc.height); }
                Ok(Msg::Reconfigure { w, h, fps: f, kbps, max_qp: q, region: r }) => {
                    match H264::new(w, h, f, kbps, q) {
                        Ok(e) => {
                            enc = e;
                            fps = f;
                            max_qp = q;
                            relaxed = false;
                            region = r;
                            source.configure(region, w, h);
                            pic = I420::new(w, h);
                            have = false; // the old size; a picture of the new size arrives in a moment
                            gate.awaiting = true;
                        }
                        Err(e) => warn!("could not resize capture: {e}"),
                    }
                }
                Err(mpsc::TryRecvError::Empty) => break,
            }
        }

        // At most `fps` pictures a second.
        let interval = Duration::from_micros(1_000_000 / fps.max(1) as u64);
        let since = last_encode.elapsed();
        if since < interval { std::thread::sleep(interval - since); }

        let got = match source.next(&mut pic, Duration::from_millis(40)) {
            Ok(g) => { lost_since = None; g }
            Err(SourceError::Lost(why)) => {
                // Display mode change, the lock screen or a UAC prompt (the secure desktop can't be captured), a
                // lost graphics device: keep the viewer's stream alive with the last picture and try again.
                if lost_since.is_none() { info!("capture interrupted ({why}); retrying"); }
                lost_since.get_or_insert_with(Instant::now);
                std::thread::sleep(Duration::from_millis(250));
                match sources(&display, fps) {
                    Ok(mut s) => { s.configure(region, enc.width, enc.height); source = s; rebuilds += 1; }
                    Err(e) => if rebuilds == 0 { warn!("capture can't restart yet: {e}") },
                }
                false
            }
            Err(SourceError::Fatal(why)) => {
                warn!("capture stopped: {why}");
                failures.lock().unwrap().push(why);
                return;
            }
        };
        let now = Instant::now();
        let idle = now - last_encode;
        let repeat = have && (idle >= REPEAT_AFTER
            || (gate.awaiting && idle >= KEYFRAME_RETRY)
            || (dropped && idle >= DROP_RETRY)
            || (now - last_new < SHARPEN_FOR && idle >= SHARPEN_EVERY));
        if got { have = true; last_new = now; }
        if !(got || repeat) { continue; }

        last_encode = now;
        let force = gate.awaiting;
        let pts = clock.next(clock::now_us());
        match enc.encode(&pic, force, pts / 1000) {
            Ok(Some(f)) => {
                dropped = false;
                if f.keyframe {
                    keyframe_drops = 0;
                    // A keyframe got through: put the detail cap back.
                    if relaxed { relaxed = false; rebuild_cap(&mut enc, max_qp); }
                }
                if gate.admit(f.keyframe, sink.can_send_video()) { sink.video(f.keyframe, pts, &f.annex_b); }
            }
            Ok(None) => {
                dropped = true;
                if force {
                    keyframe_drops += 1;
                    if max_qp.is_some() && !relaxed && keyframe_drops >= KEYFRAME_DROPS_BEFORE_RELAX {
                        relaxed = true;
                        rebuild_cap(&mut enc, None);
                        info!("detail cap lifted until a keyframe gets through");
                    }
                }
            }
            Err(e) => {
                warn!("{e}");
                failures.lock().unwrap().push(e);
                return;
            }
        }
    }
}

/// OpenH264 takes a new QP range only through a fresh encoder; the next frame is then a keyframe.
fn rebuild_cap(enc: &mut H264, qp: Option<u8>) {
    if let Ok(e) = H264::new(enc.width, enc.height, enc.fps, enc.kbps, qp) { *enc = e; }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Collect { frames: Mutex<Vec<(bool, u64, usize)>>, audio: Mutex<usize>, events: Mutex<Vec<Value>> }
    impl Sink for Collect {
        fn video(&self, k: bool, pts: u64, d: &[u8]) -> bool { self.frames.lock().unwrap().push((k, pts, d.len())); true }
        fn can_send_video(&self) -> bool { true }
        fn audio(&self, _: u64, _: &[u8]) { *self.audio.lock().unwrap() += 1; }
        fn event(&self, e: Value) { self.events.lock().unwrap().push(e); }
    }

    fn controller(sink: Arc<Collect>) -> CaptureController {
        let s: Arc<dyn Sink> = sink;
        CaptureController::new(s,
            Arc::new(|_, fps| Ok(Box::new(system::SyntheticVideo::new(fps)) as Box<dyn VideoSource>)),
            Arc::new(|feed, _| Ok(Box::new(system::SyntheticAudio::start(feed)) as Box<dyn AudioCapture>)),
            Arc::new(|| vec![system::synthetic_display()]),
            Arc::new(|id| (id == system::SYNTHETIC_WINDOW).then(system::synthetic_window)))
    }

    #[test]
    fn capture_starts_with_a_keyframe_resizes_follows_a_window_and_stops() {
        let sink = Arc::new(Collect::default());
        let mut c = controller(sink.clone());
        c.capture(CaptureRequest { max_edge: 640, fps: 30, kbps: 1500, ..Default::default() });
        // Waits for frames and sound rather than a fixed time: CI's ARM machines run the debug build slowly.
        let until = std::time::Instant::now() + Duration::from_secs(5);
        while (sink.frames.lock().unwrap().len() < 5 || *sink.audio.lock().unwrap() < 10) && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        {
            let f = sink.frames.lock().unwrap();
            assert!(f.len() >= 5, "frames flow: {}", f.len());
            assert!(f[0].0, "the first frame is a keyframe");
            assert!(f.windows(2).all(|w| w[1].1 > w[0].1), "timestamps go forward");
        }
        assert!(*sink.audio.lock().unwrap() >= 10, "sound flows");
        assert_eq!(sink.events.lock().unwrap()[0]["width"], 640);
        // A new size on the same display: same stream, a new keyframe.
        sink.frames.lock().unwrap().clear();
        c.capture(CaptureRequest { max_edge: 1280, fps: 30, kbps: 1500, ..Default::default() });
        let until = std::time::Instant::now() + Duration::from_secs(5);
        while !sink.frames.lock().unwrap().iter().any(|f| f.0) && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(sink.frames.lock().unwrap().iter().any(|f| f.0), "a keyframe starts the new size");
        assert_eq!(sink.events.lock().unwrap().last().unwrap()["width"], 1280);
        // One window.
        c.capture(CaptureRequest { max_edge: 1920, window: Some(system::SYNTHETIC_WINDOW), ..Default::default() });
        let e = sink.events.lock().unwrap().last().unwrap().clone();
        assert_eq!((e["width"].as_u64(), e["height"].as_u64(), e["window"].as_u64()), (Some(800), Some(600), Some(7)));
        assert_eq!(c.shown.lock().unwrap().as_ref().unwrap().input_bounds(), Rect::new(200.0, 100.0, 800.0, 600.0));
        c.capture(CaptureRequest { window: Some(99), ..Default::default() });
        assert!(sink.events.lock().unwrap().iter().any(|e| e["e"] == "window-gone"));
        c.stop("requested", true);
        assert_eq!(sink.events.lock().unwrap().last().unwrap()["e"], "capture-stopped");
        let n = sink.frames.lock().unwrap().len();
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(sink.frames.lock().unwrap().len(), n, "nothing after stop");
    }
}
