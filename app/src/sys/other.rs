//! Not Windows: only --synthetic capture works; everything that would change the computer is a no-op.
use crate::app::AppMsg;
use crate::jsonv::Obj;
use crate::planner::Planned;
use crate::sizing::AudioLevels;
use crate::system::{AudioCapture, AudioSink, DisplayInfo, VideoSource, WindowInfo};
use serde_json::{json, Value};
use std::sync::mpsc::Sender;

pub fn os_info() -> Value { json!({"os": std::env::consts::OS, "osVersion": "", "arch": std::env::consts::ARCH}) }
pub fn sound_tap_available() -> bool { false }
pub fn is_elevated() -> bool { false }
pub fn elevated_task_exists() -> bool { false }
pub fn curtain_supported() -> bool { false }
pub fn displays() -> Vec<DisplayInfo> { vec![] }
pub fn windows() -> Vec<WindowInfo> { vec![] }
pub fn find_window(_id: u32) -> Option<WindowInfo> { None }
pub fn raise_window(_id: u32) -> bool { false }
pub fn fit_window(_id: u32, _aspect: f64) -> Result<(), String> { Err("not on this system".into()) }
pub fn video_source(_d: &DisplayInfo) -> Result<Box<dyn VideoSource>, String> { Err("Only --synthetic works on this system.".into()) }
pub fn audio_capture(_s: AudioSink, _l: AudioLevels) -> Result<Box<dyn AudioCapture>, String> { Err("no sound capture on this system".into()) }
pub fn audio_outputs() -> Vec<(String, String, bool)> { vec![] }
pub fn audio_outputs_changed() -> bool { false }
pub fn post_input(_plan: &[Planned]) {}
pub fn text_focus() -> Option<(bool, bool)> { None }
pub fn clipboard_text() -> String { String::new() }
pub fn clipboard_png() -> Option<Vec<u8>> { None }
pub fn set_clipboard(_t: Option<&str>, _i: Option<&[u8]>) -> bool { false }
pub fn clipboard_sequence() -> u32 { 0 }
pub fn clipboard_is_private() -> bool { false }
pub fn lock_screen() -> bool { false }
pub fn is_locked() -> bool { false }
pub fn set_elevation(_on: bool) -> Value { json!({"ok": false, "elevated": false, "task": false, "error": "Only on Windows."}) }
pub fn relaunch_after_exit() -> Result<(), String> { Err("Only on Windows.".into()) }
pub fn open_url(_u: &str) {}
pub fn login_item_state() -> Value { json!({"on": false, "status": "unavailable"}) }
pub fn set_login_item(_on: bool) -> Value { login_item_state() }
pub fn uninstall() {}
pub fn secrets(_cmd: &str, _home: &str) -> i32 { eprintln!("--secrets needs Windows (DPAPI)"); 1 }

pub struct AudioOut;
impl AudioOut {
    pub fn open(_device: Option<&str>) -> Result<Self, String> { Err("no sound output on this system".into()) }
    pub fn push(&mut self, _pcm: &[f32]) -> Result<(), String> { Ok(()) }
}

/// The tray and other things tied to the UI thread. Elsewhere: nothing to show.
pub struct Pc;
impl Pc {
    pub fn tray_problem(&self, _p: Option<String>) {}
    pub fn tray_status(&self, _s: &Obj) {}
    pub fn tray_session(&self, _v: Option<String>) {}
    pub fn notify(&self, title: &str, body: &str) { crate::info!("notification (not shown here): {title} — {body}"); }
    pub fn keep_awake(&self, _on: bool) {}
    pub fn session_active(&self, _on: bool) {}
    pub fn curtain(&self, _on: bool) -> bool { false }
    pub fn remove_tray(&self) {}
}

/// Runs the app: here there is no UI thread, so the controller runs on the main thread.
pub fn run(o: crate::options::Options) -> i32 {
    let (tx, rx) = std::sync::mpsc::channel::<AppMsg>();
    let _keep: Sender<AppMsg> = tx.clone();
    crate::app::App::new(o, tx, rx, Pc).run()
}
pub fn selftest() -> Vec<(String, Result<String, String>)> { vec![] }
