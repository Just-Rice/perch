//! roost.exe's brain: starts the host process (and restarts it if it dies), turns its commands into capture, input,
//! tray, power and notification changes, and reports what happens on the PC back to it as events.
//! docs/PROTOCOL.md "App ⇄ host process (IPC)" and docs/WINDOWS-APP.md. Runs on its own thread; the Windows UI
//! (tray, curtain) lives on the main thread in sys.
use crate::capture::{CaptureController, Shown, Sink};
use crate::host::{HostEvent, HostProcess, Link};
use crate::ipc::{self, kind};
use crate::jsonv::{self, Obj};
use crate::options::{paths, Options, VERSION};
use crate::planner::{Planned, Planner, Rect};
use crate::sizing::{AudioLevels, CaptureRequest};
use crate::system::{self, AudioCapture, VideoSource};
use crate::sys;
use serde_json::{json, Value};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub enum AppMsg {
    Host(u64, HostEvent),
    /// A tray action: the same names as the protocol's `menu` event.
    Menu(String),
    Quit,
    Lock(bool),
    DisplaysChanged,
    CurtainLifted,
    Elevation(Value),
}

/// Above this many bytes waiting for the host, video frames are dropped (a keyframe follows once it catches up)
/// instead of queueing up seconds of delay.
const VIDEO_BACKLOG_LIMIT: usize = 4 << 20;
const CLIPBOARD_MAX: usize = 30_000;
const CLIPBOARD_IMAGE_MAX: usize = 20 << 20;

/// The current host link, shared with the capture and input threads.
#[derive(Clone, Default)]
pub struct HostOut(Arc<Mutex<Option<Link>>>);

impl HostOut {
    fn link(&self) -> Option<Link> { self.0.lock().unwrap().clone() }
    pub fn event(&self, e: Value) { if let Some(l) = self.link() { l.send(kind::EVENT, &ipc::json(&e)); } }
}

impl Sink for HostOut {
    fn video(&self, keyframe: bool, pts: u64, data: &[u8]) -> bool {
        self.link().is_some_and(|l| l.send(kind::VIDEO, &ipc::video_payload(keyframe, pts, data)))
    }
    fn can_send_video(&self) -> bool { self.link().is_some_and(|l| l.pending() < VIDEO_BACKLOG_LIMIT) }
    fn audio(&self, pts: u64, packet: &[u8]) { if let Some(l) = self.link() { l.send(kind::AUDIO, &ipc::audio_payload(pts, packet)); } }
    fn event(&self, e: Value) { HostOut::event(self, e) }
}

/// Input runs on its own thread, so pointer and keys keep flowing while the controller is busy.
enum InputMsg { Frame(Vec<u8>), Paste, ReleaseAll(Option<mpsc::Sender<()>>) }

pub struct App {
    o: Options,
    tx: Sender<AppMsg>,
    rx: Receiver<AppMsg>,
    out: HostOut,
    host: Option<HostProcess>,
    generation: u64,
    restarts: u32,
    restart_at: Option<Instant>,
    last_host_status: Option<i32>,
    capture: CaptureController,
    input_tx: Sender<InputMsg>,
    mic_tx: Sender<Vec<u8>>,
    mic: Arc<Mutex<Option<sys::MicPlayer>>>,
    pc: sys::Pc,
    session: Option<String>,
    locked: bool,
    shutting_down: bool,
    clip_seq: u32,
    clip_watch: bool,
    test_clipboard: (String, Option<Vec<u8>>),
    last_status: Obj,
}

impl App {
    /// Test and development runs never change anything on the PC (start with Windows, the clipboard, windows, the
    /// curtain, locking), unless explicitly allowed.
    fn system_changes_allowed(o: &Options) -> bool {
        o.allow_system_changes || (!o.no_ui && !o.synthetic && !o.echo_input && std::env::var("ROOST_TEST").as_deref() != Ok("1"))
    }

    pub fn new(o: Options, tx: Sender<AppMsg>, rx: Receiver<AppMsg>, pc: sys::Pc) -> Self {
        let out = HostOut::default();
        let synthetic = o.synthetic;
        let sources: crate::capture::SourceFactory = Arc::new(move |d, fps| {
            if synthetic { Ok(Box::new(system::SyntheticVideo::new(fps)) as Box<dyn VideoSource>) } else { sys::video_source(d) }
        });
        let audio: crate::capture::AudioFactory = Arc::new(move |feed, levels| {
            if synthetic { Ok(Box::new(system::SyntheticAudio::start(feed)) as Box<dyn AudioCapture>) } else { sys::audio_capture(feed, levels) }
        });
        let displays: crate::capture::Displays = Arc::new(move || if synthetic { vec![system::synthetic_display()] } else { sys::displays() });
        let find: crate::capture::FindWindow = Arc::new(move |id| {
            if synthetic { (id == system::SYNTHETIC_WINDOW).then(system::synthetic_window) } else { sys::find_window(id) }
        });
        let capture = CaptureController::new(Arc::new(out.clone()), sources, audio, displays, find);
        let input_tx = Self::start_input(&o, out.clone(), capture.shown.clone());
        let mic: Arc<Mutex<Option<sys::MicPlayer>>> = Arc::new(Mutex::new(None));
        let (mic_tx, mic_rx) = mpsc::channel::<Vec<u8>>();
        let m = mic.clone();
        std::thread::Builder::new().name("roost-mic".into()).spawn(move || {
            for frame in mic_rx { if let Some(p) = m.lock().unwrap().as_mut() { p.push(&frame); } }
        }).expect("mic thread");
        Self { o, tx, rx, out, host: None, generation: 0, restarts: 0, restart_at: None, last_host_status: None, capture,
            input_tx, mic_tx, mic, pc, session: None, locked: false, shutting_down: false, clip_seq: 0, clip_watch: false,
            test_clipboard: (String::new(), None), last_status: Obj::new() }
    }

    fn start_input(o: &Options, out: HostOut, shown: Arc<Mutex<Option<Shown>>>) -> Sender<InputMsg> {
        let (tx, rx) = mpsc::channel::<InputMsg>();
        let echo = o.echo_input;
        let synthetic = o.synthetic;
        let pretend_focus = o.echo_input || o.synthetic;
        let focus_out = out.clone();
        std::thread::Builder::new().name("roost-input".into()).spawn(move || {
            let mut planner = Planner::new(Rect::default());
            let focus_seq = Arc::new(std::sync::atomic::AtomicU64::new(0));
            let bounds = |shown: &Arc<Mutex<Option<Shown>>>| -> Rect {
                if let Some(s) = shown.lock().unwrap().as_ref() { return s.input_bounds(); }
                if synthetic { return system::synthetic_display().rect; }
                sys::displays().into_iter().find(|d| d.main).map(|d| d.rect).unwrap_or(Rect::new(0.0, 0.0, 1920.0, 1080.0))
            };
            let perform = |plan: Vec<Planned>, msg: Value| {
                if echo {
                    out.event(json!({"e": "input-echo", "ev": msg, "out": plan.iter().map(Planned::json).collect::<Vec<_>>()}));
                } else if !plan.is_empty() {
                    sys::post_input(&plan);
                }
            };
            for m in rx {
                match m {
                    InputMsg::Frame(payload) => {
                        let Some(msg) = ipc::parse_object(&payload) else { warn!("ignored an input frame that isn't a JSON object"); continue };
                        planner.bounds = bounds(&shown);
                        perform(planner.plan(&msg), Value::Object(msg.clone()));
                        // After a left click is let go: does the PC now wait for typing? (So a phone opens its keyboard.)
                        if jsonv::s(&msg, "t") == Some("b") && jsonv::b(&msg, "d") == Some(false) && jsonv::i(&msg, "b") == Some(0) {
                            let y = jsonv::n(&msg, "y").unwrap_or(0.0);
                            let seq = focus_seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                            let (fo, fs) = (focus_out.clone(), focus_seq.clone());
                            std::thread::spawn(move || {
                                // Test runs click nothing for real, so they get a pretend text box: the top half.
                                let ask = || if pretend_focus { Some((y < 0.5, false)) } else { sys::text_focus() };
                                std::thread::sleep(Duration::from_millis(150));
                                if fs.load(std::sync::atomic::Ordering::SeqCst) != seq { return; }
                                let first = ask();
                                if let Some((editable, secure)) = first { fo.event(json!({"e": "text-focus", "editable": editable, "secure": secure})); }
                                // Again a little later, for apps slow to move the focus; sent only if it changed.
                                std::thread::sleep(Duration::from_millis(350));
                                if fs.load(std::sync::atomic::Ordering::SeqCst) != seq { return; }
                                let second = ask();
                                if second != first { if let Some((e, s)) = second { fo.event(json!({"e": "text-focus", "editable": e, "secure": s})); } }
                            });
                        }
                    }
                    InputMsg::Paste => {
                        planner.bounds = bounds(&shown);
                        for msg in [json!({"t":"k","c":"ControlLeft","k":"Control","d":true,"m":2}), json!({"t":"k","c":"KeyV","k":"v","d":true,"m":2}),
                                    json!({"t":"k","c":"KeyV","k":"v","d":false,"m":2}), json!({"t":"k","c":"ControlLeft","k":"Control","d":false,"m":0})] {
                            let plan = planner.plan(msg.as_object().unwrap());
                            perform(plan, msg);
                        }
                    }
                    InputMsg::ReleaseAll(done) => {
                        let plan = planner.release_all();
                        if !plan.is_empty() { perform(plan, json!({"t": "rel", "source": "app"})); }
                        if let Some(d) = done { let _ = d.send(()); }
                    }
                }
            }
        }).expect("input thread");
        tx
    }

    // ---- the host process ----------------------------------------------------------------------------------------

    fn start_host(&mut self) {
        self.restart_at = None;
        if self.shutting_down { return; }
        let Some(node) = paths::node(self.o.node.as_deref()) else { return self.host_could_not_start("Roost can't find Node.js to run its helper.".into()) };
        let Some(script) = paths::host_script(self.o.host.as_deref()) else {
            return self.host_could_not_start(format!("Roost's helper is missing{}.", self.o.host.as_deref().map(|h| format!(" ({h})")).unwrap_or_default()));
        };
        let mut env = vec![
            ("ROOST_APP_VERSION".into(), VERSION.into()),
            ("ROOST_APP_EXE".into(), paths::exe().display().to_string()),
            ("ROOST_INSTALL_DIR".into(), paths::install_dir().display().to_string()),
        ];
        if std::env::var("ROOST_HOME").is_err() { env.push(("ROOST_HOME".into(), paths::home().display().to_string())); }
        self.generation += 1;
        let gen = self.generation;
        let tx = self.tx.clone();
        let input = self.input_tx.clone();
        let mic = self.mic_tx.clone();
        // INPUT and MIC frames go straight to their threads; everything else to the controller.
        let on_event: Arc<dyn Fn(HostEvent) + Send + Sync> = Arc::new(move |e| match e {
            HostEvent::Frame(kind::INPUT, p) => { let _ = input.send(InputMsg::Frame(p)); }
            HostEvent::Frame(kind::MIC, p) => { let _ = mic.send(p); }
            other => { let _ = tx.send(AppMsg::Host(gen, other)); }
        });
        match HostProcess::launch(&node.display().to_string(), &script.display().to_string(), env, on_event) {
            Ok(h) => {
                info!("host started: {} {} (pid {})", node.display(), script.display(), h.pid);
                *self.out.0.lock().unwrap() = Some(h.link.clone());
                self.host = Some(h);
                self.pc.tray_problem(None);
                self.send_hello();
            }
            Err(e) => self.host_could_not_start(format!("Roost couldn't start its helper: {e}")),
        }
    }

    fn send_hello(&mut self) {
        let synthetic = self.o.synthetic;
        let displays: Vec<Value> = if synthetic { vec![system::synthetic_display().json()] } else { sys::displays().iter().map(|d| d.json()).collect() };
        let os = sys::os_info();
        let hello = json!({
            "app": "Roost", "version": VERSION, "ipc": ipc::IPC_VERSION,
            "os": os["os"], "osVersion": os["osVersion"], "arch": os["arch"],
            "synthetic": synthetic,
            "soundTap": !synthetic && sys::sound_tap_available(),
            "permissions": {"screen": true, "accessibility": true, "elevated": sys::is_elevated()},
            "displays": displays,
            "loginItem": sys::login_item_state(),
            "features": {"curtain": sys::curtain_supported(), "encoder": crate::media::h264::NAME, "elevatedTask": sys::elevated_task_exists()},
        });
        if let Some(h) = &self.host { h.link.send(kind::HELLO, &ipc::json(&hello)); }
        self.locked = sys::is_locked();
        self.out.event(json!({"e": "lock", "locked": self.locked}));
        self.out.event(json!({"e": "elevation", "elevated": sys::is_elevated(), "task": sys::elevated_task_exists()}));
        self.send_audio_outputs();
    }

    fn host_could_not_start(&mut self, message: String) {
        error!("{message}");
        self.pc.tray_problem(Some(message));
        self.schedule_restart();
    }

    fn host_exited(&mut self, code: i32, ran: Duration) {
        self.host = None;
        *self.out.0.lock().unwrap() = None;
        self.last_host_status = Some(code);
        // Everything the host had switched on goes with it; a new host starts from a clean slate and resends.
        self.capture.stop("host-exited", false);
        self.end_session();
        self.pc.keep_awake(false);
        if self.shutting_down { return; }
        if ran > Duration::from_secs(60) { self.restarts = 0; }
        self.pc.tray_problem(Some("Roost's helper stopped. Restarting…".into()));
        self.schedule_restart();
    }

    /// 1, 2, 4 … 30 seconds between attempts; back to 1 s once a host has run for a minute.
    fn schedule_restart(&mut self) {
        if self.shutting_down || self.restart_at.is_some() { return; }
        let delay = 2f64.powi(self.restarts as i32).min(30.0);
        self.restarts += 1;
        info!("restarting the host in {delay} s");
        self.restart_at = Some(Instant::now() + Duration::from_secs_f64(delay));
    }

    // ---- the loop -------------------------------------------------------------------------------------------------

    pub fn run(mut self) -> i32 {
        info!("Roost {VERSION} starting (pid {}{}{}{})", std::process::id(), if self.o.synthetic { ", synthetic" } else { "" },
            if self.o.echo_input { ", echo input" } else { "" }, if self.o.no_ui { ", no UI" } else { "" });
        if !self.o.ignored.is_empty() { info!("ignoring arguments: {}", self.o.ignored.join(" ")); }
        self.start_host();
        let mut last_tick = Instant::now();
        let mut last_outputs = Instant::now();
        loop {
            match self.rx.recv_timeout(Duration::from_millis(100)) {
                Ok(m) => if !self.handle(m) { break },
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if self.restart_at.is_some_and(|t| Instant::now() >= t) { self.start_host(); }
            if last_tick.elapsed() >= Duration::from_millis(300) {
                last_tick = Instant::now();
                self.capture.tick();
                self.watch_clipboard();
            }
            if last_outputs.elapsed() >= Duration::from_secs(5) && !self.o.synthetic {
                last_outputs = Instant::now();
                if sys::audio_outputs_changed() { self.send_audio_outputs(); }
            }
        }
        let code = if self.o.exit_with_host { self.last_host_status.unwrap_or(1) } else { 0 };
        info!("bye (exit {code})");
        code
    }

    /// False: quit.
    fn handle(&mut self, m: AppMsg) -> bool {
        match m {
            AppMsg::Host(gen, e) if gen == self.generation => match e {
                HostEvent::Frame(kind::COMMAND, p) => self.command(&p),
                HostEvent::Frame(k, _) => warn!("ignored a frame of type 0x{k:02x} from the host"),
                HostEvent::BadFrame(why) => {
                    error!("host sent a bad frame ({why}); restarting it");
                    if let Some(h) = &self.host { h.terminate(); }
                }
                HostEvent::Exited { code, ran } => {
                    self.host_exited(code, ran);
                    if self.shutting_down { return false; }
                }
            },
            AppMsg::Host(..) => {}
            AppMsg::Menu(action) => self.out.event(json!({"e": "menu", "action": action})),
            AppMsg::Quit => { self.shut_down(); return false; }
            AppMsg::Lock(locked) => {
                if locked != self.locked { self.locked = locked; self.out.event(json!({"e": "lock", "locked": locked})); }
            }
            AppMsg::DisplaysChanged => {
                let d: Vec<Value> = if self.o.synthetic { vec![system::synthetic_display().json()] } else { sys::displays().iter().map(|d| d.json()).collect() };
                self.out.event(json!({"e": "displays", "displays": d}));
            }
            AppMsg::CurtainLifted => self.out.event(json!({"e": "curtain", "up": false, "lifted": true})),
            AppMsg::Elevation(mut e) => { e["e"] = json!("elevation"); self.out.event(e); }
        }
        true
    }

    fn command(&mut self, payload: &[u8]) {
        let Some(cmd) = ipc::parse_object(payload) else { return self.warn_host("ignored a command that isn't a JSON object") };
        let Some(c) = jsonv::s(&cmd, "c").map(str::to_owned) else { return self.warn_host("ignored a command without \"c\"") };
        let allowed = Self::system_changes_allowed(&self.o);
        match c.as_str() {
            "capture" => match jsonv::b(&cmd, "on") {
                // Only an explicit `on: true` starts showing the screen; a malformed command never switches it on.
                Some(true) => {
                    if cmd.contains_key("speakers") || cmd.contains_key("stream") {
                        self.capture.set_levels(AudioLevels::from_command(&cmd, self.capture.levels()));
                    }
                    let request = CaptureRequest::from_command(&cmd);
                    // A window just chosen comes to the front, so what the viewer sees is what their clicks reach.
                    if let Some(w) = request.window {
                        if Some(w) != self.capture.window_id() && !self.o.synthetic && allowed { sys::raise_window(w); }
                    }
                    self.capture.capture(request);
                }
                Some(false) => self.capture.stop("requested", true),
                None => self.warn_host("capture without on"),
            },
            "audio-levels" => {
                let l = AudioLevels::from_command(&cmd, self.capture.levels());
                self.capture.set_levels(l);
                info!("sound levels: PC speakers {}%, sent {}%", (l.speakers * 100.0) as i32, (l.stream * 100.0) as i32);
            }
            "clipboard-get" => {
                let mut e = json!({"e": "clipboard", "ok": true, "text": self.clipboard_text(allowed)});
                if jsonv::b(&cmd, "images") == Some(true) {
                    if let Some(png) = self.clipboard_png(allowed) {
                        use base64::Engine;
                        e["image"] = json!(base64::engine::general_purpose::STANDARD.encode(png));
                        e["mime"] = json!("image/png");
                    }
                }
                if jsonv::b(&cmd, "auto") == Some(true) { e["auto"] = json!(true); }
                self.out.event(e);
            }
            "clipboard-set" => {
                use base64::Engine;
                let text = jsonv::s(&cmd, "text").map(str::to_owned);
                let image = jsonv::s(&cmd, "image").map(|b| base64::engine::general_purpose::STANDARD.decode(b).unwrap_or_default());
                let fits = text.as_ref().map_or(0, |t| t.encode_utf16().count()) <= CLIPBOARD_MAX && image.as_ref().map_or(0, Vec::len) <= CLIPBOARD_IMAGE_MAX;
                let ok = fits && (text.is_some() || image.is_some()) && self.set_clipboard(allowed, text, image);
                if ok && jsonv::b(&cmd, "paste") == Some(true) { let _ = self.input_tx.send(InputMsg::Paste); }
                self.out.event(json!({"e": "clipboard-set", "ok": ok}));
            }
            "mic" => self.set_mic(jsonv::b(&cmd, "on") == Some(true), jsonv::s(&cmd, "device").map(str::to_owned), allowed),
            "windows" => {
                let list: Vec<Value> = if self.o.synthetic { vec![system::synthetic_window().json()] } else { sys::windows().iter().map(|w| w.json()).collect() };
                self.out.event(json!({"e": "windows", "list": list}));
            }
            "window-fit" => {
                let (Some(id), Some(w), Some(h)) = (jsonv::i(&cmd, "window"), jsonv::n(&cmd, "w"), jsonv::n(&cmd, "h")) else { return self.warn_host("window-fit without window, w and h") };
                if id <= 0 || w <= 0.0 || h <= 0.0 { return self.warn_host("window-fit without window, w and h"); }
                let (ok, err) = if self.o.synthetic {
                    (system::synthetic_fit(w / h, Rect::new(0.0, 0.0, 1920.0, 1040.0)), None)
                } else if !allowed {
                    (false, Some("Windows are not reshaped in test runs."))
                } else {
                    match sys::fit_window(id as u32, w / h) { Ok(()) => (true, None), Err(_) => (false, Some("This window can't be reshaped.")) }
                };
                let mut e = json!({"e": "window-fit", "window": id, "ok": ok});
                if let Some(err) = err { e["error"] = json!(err); }
                self.out.event(e);
            }
            "keyframe" => self.capture.keyframe(),
            "bitrate" => match jsonv::i(&cmd, "kbps") { Some(k) => self.capture.set_bitrate(k.max(0) as u32), None => self.warn_host("bitrate without kbps") },
            "session" => {
                if jsonv::b(&cmd, "active") == Some(true) {
                    self.start_session(jsonv::s(&cmd, "viewer").map(str::to_owned), jsonv::s(&cmd, "route").map(str::to_owned));
                    self.set_curtain(jsonv::b(&cmd, "curtain") == Some(true), allowed);
                } else {
                    self.end_session();
                }
            }
            "lock" => {
                if !allowed {
                    info!("lock requested (not done in a test run)");
                    self.out.event(json!({"e": "lock-request", "performed": false, "available": true}));
                } else {
                    let ok = sys::lock_screen();
                    info!("{}", if ok { "locked the PC (session ended)" } else { "could not lock the PC" });
                    self.out.event(json!({"e": "lock-request", "performed": ok, "available": true}));
                }
            }
            "status" => { self.last_status = cmd.clone(); self.pc.tray_status(&cmd); }
            "notify" => self.pc.notify(jsonv::s(&cmd, "title").unwrap_or("Roost"), jsonv::s(&cmd, "body").unwrap_or("")),
            "permissions" => self.out.event(json!({"e": "permissions", "screen": true, "accessibility": true, "elevated": sys::is_elevated()})),
            "request-permission" => self.out.event(json!({"e": "permissions", "screen": true, "accessibility": true, "elevated": sys::is_elevated()})),
            "reset-permission" => self.out.event(json!({"e": "permission-reset", "which": jsonv::s(&cmd, "which").unwrap_or(""), "ok": false, "error": "Not needed on Windows."})),
            "elevation" => {
                let on = jsonv::b(&cmd, "on") == Some(true);
                if !allowed {
                    self.out.event(json!({"e": "elevation", "ok": false, "elevated": sys::is_elevated(), "task": sys::elevated_task_exists(), "error": "Not done in test runs."}));
                } else {
                    let tx = self.tx.clone();
                    // UAC can take as long as the person likes to answer: never on the controller thread.
                    std::thread::spawn(move || {
                        let r = sys::set_elevation(on);
                        let _ = tx.send(AppMsg::Elevation(r.clone()));
                        if r["relaunch"] == json!(true) { let _ = tx.send(AppMsg::Quit); }
                    });
                }
            }
            "relaunch" => {
                if !allowed { return self.out.event(json!({"e": "relaunch", "ok": false, "error": "Not done in test runs."})); }
                match sys::relaunch_after_exit() {
                    Ok(()) => { info!("relaunching"); let _ = self.tx.send(AppMsg::Quit); }
                    Err(e) => self.out.event(json!({"e": "relaunch", "ok": false, "error": e})),
                }
            }
            "open-url" => match jsonv::s(&cmd, "url") {
                // Only web pages: the host never needs to open anything else, so nothing else is allowed.
                Some(u) if u.starts_with("http://") || u.starts_with("https://") => sys::open_url(u),
                _ => self.warn_host("refused to open a URL that isn't http or https"),
            },
            "login-item" => match jsonv::b(&cmd, "on") {
                Some(on) => {
                    let e = if allowed { sys::set_login_item(on) } else {
                        let mut s = sys::login_item_state(); s["error"] = json!("Not changed in test runs."); s
                    };
                    let mut e = e; e["e"] = json!("login-item");
                    self.out.event(e);
                }
                None => self.warn_host("login-item without on"),
            },
            "keep-awake" => self.pc.keep_awake(jsonv::b(&cmd, "on") == Some(true)),
            "uninstall" => {
                info!("uninstalling");
                if allowed { sys::uninstall(); } else { self.warn_host("uninstall: not removing anything (test run)"); }
                let _ = self.tx.send(AppMsg::Quit);
            }
            "quit" => { let _ = self.tx.send(AppMsg::Quit); }
            other => self.warn_host(&format!("ignored unknown command \"{other}\"")),
        }
    }

    /// A warning in the log, also sent to the host so it shows up in its log next to whatever caused it.
    fn warn_host(&self, message: &str) {
        warn!("{message}");
        self.out.event(json!({"e": "log", "level": "warn", "message": message}));
    }

    // ---- clipboard ------------------------------------------------------------------------------------------------

    fn clipboard_text(&self, allowed: bool) -> String {
        let t = if allowed { sys::clipboard_text() } else { self.test_clipboard.0.clone() };
        // Cut on a whole character, so nothing half-encoded goes out.
        let mut units = 0;
        t.chars().take_while(|c| { units += c.len_utf16(); units <= CLIPBOARD_MAX }).collect()
    }

    fn clipboard_png(&self, allowed: bool) -> Option<Vec<u8>> {
        if allowed { sys::clipboard_png().filter(|p| p.len() <= CLIPBOARD_IMAGE_MAX) } else { self.test_clipboard.1.clone() }
    }

    fn set_clipboard(&mut self, allowed: bool, text: Option<String>, image: Option<Vec<u8>>) -> bool {
        if !allowed {
            // Test runs use a pretend clipboard, but still refuse what isn't a picture.
            if let Some(img) = &image { if !img.starts_with(&[0x89, b'P', b'N', b'G']) && !img.starts_with(&[0xFF, 0xD8]) { return false; } }
            self.test_clipboard = (text.unwrap_or_default(), image);
            return true;
        }
        let ok = sys::set_clipboard(text.as_deref(), image.as_deref());
        // Our own change is not sent back to the viewer.
        if ok { self.clip_seq = sys::clipboard_sequence(); }
        ok
    }

    /// While a viewer is connected the clipboard is checked a few times a second; a change (other than our own) is
    /// reported, so the viewer's device gets what was just copied here. Password managers mark copied passwords as
    /// private (ExcludeClipboardContentFromMonitorProcessing): those are never sent by themselves.
    fn watch_clipboard(&mut self) {
        if !self.clip_watch { return; }
        let n = sys::clipboard_sequence();
        if n == self.clip_seq { return; }
        self.clip_seq = n;
        if sys::clipboard_is_private() { info!("clipboard changed: marked private, not shared"); return; }
        self.out.event(json!({"e": "clipboard-changed"}));
    }

    // ---- sessions, microphone, curtain ----------------------------------------------------------------------------

    fn set_mic(&mut self, on: bool, device: Option<String>, allowed: bool) {
        if !on {
            if self.mic.lock().unwrap().take().is_some() { info!("microphone off"); }
            return self.out.event(json!({"e": "mic", "on": false, "ok": true}));
        }
        if self.session.is_none() { return self.out.event(json!({"e": "mic", "on": false, "ok": false, "error": "Nobody is connected."})); }
        let out = self.out.clone();
        let on_fail: Box<dyn Fn(String) + Send> = Box::new(move |why| {
            warn!("microphone playback stopped: {why}");
            out.event(json!({"e": "mic", "on": false, "ok": false, "error": why}));
        });
        let level_out = self.out.clone();
        let on_level: Box<dyn Fn(Value) + Send> = Box::new(move |mut v| { v["e"] = json!("mic-level"); level_out.event(v); });
        match sys::MicPlayer::start(device.as_deref().filter(|d| !d.is_empty()), !allowed, on_fail, on_level) {
            Ok(p) => {
                *self.mic.lock().unwrap() = Some(p);
                info!("microphone on{}{}", device.map(|d| format!(", playing on {d}")).unwrap_or_default(), if allowed { "" } else { " (not played in a test run)" });
                self.out.event(json!({"e": "mic", "on": true, "ok": true}));
            }
            Err(e) => {
                warn!("could not play the microphone: {e}");
                self.out.event(json!({"e": "mic", "on": false, "ok": false, "error": e}));
            }
        }
    }

    fn send_audio_outputs(&self) {
        let list: Vec<Value> = if self.o.synthetic {
            vec![json!({"uid": "test-speakers", "name": "Test Speakers", "main": true})]
        } else {
            sys::audio_outputs().into_iter().map(|(uid, name, main)| json!({"uid": uid, "name": name, "main": main})).collect()
        };
        self.out.event(json!({"e": "audio-outputs", "list": list}));
    }

    fn start_session(&mut self, viewer: Option<String>, route: Option<String>) {
        let is_new = self.session.as_ref() != Some(&viewer.clone().unwrap_or_default()) ;
        let name = viewer.clone().unwrap_or_else(|| "Viewer".into());
        self.session = Some(name.clone());
        self.pc.session_active(true);
        if !self.clip_watch && Self::system_changes_allowed(&self.o) { self.clip_watch = true; self.clip_seq = sys::clipboard_sequence(); }
        self.pc.tray_session(Some(name.clone()));
        if is_new {
            info!("session started: {} via {}", name, route.as_deref().unwrap_or("unknown route"));
            self.pc.notify(&format!("{} is viewing this PC", viewer.as_deref().unwrap_or("Someone")), "You can disconnect them from Roost in the system tray.");
        }
    }

    /// The privacy curtain only ever shows from a real Roost (never in test runs: a test must not black out the
    /// screen of the PC it runs on).
    fn set_curtain(&mut self, on: bool, allowed: bool) {
        if !allowed || self.o.no_ui {
            if on { info!("privacy curtain requested (not shown in a test run)"); }
            return self.out.event(json!({"e": "curtain", "up": false, "requested": on}));
        }
        let up = self.pc.curtain(on);
        self.out.event(json!({"e": "curtain", "up": up, "requested": on}));
    }

    fn end_session(&mut self) {
        self.pc.curtain(false);
        let _ = self.input_tx.send(InputMsg::ReleaseAll(None));
        if self.mic.lock().unwrap().take().is_some() { info!("microphone off (session ended)"); }
        if self.session.take().is_none() { return; }
        self.clip_watch = false;
        self.pc.session_active(false);
        self.pc.tray_session(None);
        info!("session ended");
    }

    /// Stops everything and exits: release input and power, stop capture, close the host's stdin, wait up to 2 s
    /// for it to exit, then stop it. Quit in the tray, the `quit` command, signing out and Ctrl+C all end here.
    fn shut_down(&mut self) {
        if self.shutting_down { return; }
        self.shutting_down = true;
        info!("quitting");
        let (done_tx, done_rx) = mpsc::channel();
        let _ = self.input_tx.send(InputMsg::ReleaseAll(Some(done_tx)));
        let _ = done_rx.recv_timeout(Duration::from_secs(1));
        self.pc.curtain(false);
        self.pc.keep_awake(false);
        self.pc.session_active(false);
        self.capture.stop("quit", false);
        *self.out.0.lock().unwrap() = None;
        if let Some(h) = self.host.take() {
            if let Some(code) = h.shutdown(Duration::from_secs(2)) { self.last_host_status = Some(code); }
        }
        self.pc.remove_tray();
    }
}

/// Selftest helper: the checks that need no host.
pub fn selftest_input() -> bool {
    let mut p = Planner::new(Rect::new(0.0, 0.0, 100.0, 100.0));
    let plan = p.plan(json!({"t":"b","b":0,"d":true,"x":0.5,"y":0.5,"n":1}).as_object().unwrap());
    plan.len() == 2
}
