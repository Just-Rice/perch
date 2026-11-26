//! The UI thread: Roost's tray icon and its panel (Roost's own flyout, drawn with Direct2D, with Windows 11's
//! acrylic backdrop where available), notifications, the privacy curtain, staying awake, and the system's news
//! (lock and unlock, display changes, Explorer restarting). The controller (app.rs) runs on its own thread and
//! talks to this one through `Pc`, which posts window messages.
use super::input::ROOST_MARK;
use crate::app::{App, AppMsg};
use crate::icon::{self, Variant};
use crate::jsonv::{self, Obj};
use crate::options::{paths, Options};
use std::cell::RefCell;
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Direct2D::Common::*;
use windows::Win32::Graphics::Direct2D::*;
use windows::Win32::Graphics::DirectWrite::*;
use windows::Win32::Graphics::Dwm::*;
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::*;
use windows::Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION};
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::Controls::MARGINS;
use windows::Win32::UI::HiDpi::*;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows_numerics::Vector2;

const WM_TRAY: u32 = WM_APP + 1;
const WM_REFRESH: u32 = WM_APP + 2;
const WM_NOTIFY_SHOW: u32 = WM_APP + 3;
const WM_POWER: u32 = WM_APP + 4;
const WM_CURTAIN: u32 = WM_APP + 6;
const WM_REMOVE_TRAY: u32 = WM_APP + 7;
const WM_SHOW_PANEL: u32 = WM_APP + 8;
const WM_QUIT_APP: u32 = WM_APP + 9;
const TRAY_ID: u32 = 1;
/// NIN_SELECT | NINF_KEY: the tray icon chosen with the keyboard.
const NIN_KEYSELECT: u32 = NIN_SELECT | 1;
use windows::Win32::UI::Controls::WM_MOUSELEAVE;
const WTS_SESSION_LOCK: usize = 7;
const WTS_SESSION_UNLOCK: usize = 8;

/// What the tray shows, as the controller last said (shared between threads).
#[derive(Default)]
struct Shared {
    status: Obj,
    viewer: Option<String>,
    problem: Option<String>,
    notifications: Vec<(String, String)>,
    keep_awake: bool,
    session: bool,
}

static SHARED: Mutex<Option<Shared>> = Mutex::new(None);
static TX: OnceLock<Sender<AppMsg>> = OnceLock::new();
static UI_HWND: OnceLock<usize> = OnceLock::new();

fn with<R>(f: impl FnOnce(&mut Shared) -> R) -> R { f(SHARED.lock().unwrap().get_or_insert_with(Shared::default)) }
fn send(m: AppMsg) { if let Some(tx) = TX.get() { let _ = tx.send(m); } }
fn hwnd() -> HWND { HWND(*UI_HWND.get().unwrap_or(&0) as *mut _) }
fn post(msg: u32, w: usize) { unsafe { let _ = PostMessageW(Some(hwnd()), msg, WPARAM(w), LPARAM(0)); } }
fn send_msg(msg: u32, w: usize) -> isize { unsafe { SendMessageW(hwnd(), msg, Some(WPARAM(w)), Some(LPARAM(0))).0 } }

/// The controller's handle on the UI thread.
pub struct Pc;

impl Pc {
    pub fn tray_problem(&self, p: Option<String>) { with(|s| s.problem = p); post(WM_REFRESH, 0); }
    pub fn tray_status(&self, st: &Obj) { with(|s| s.status = st.clone()); post(WM_REFRESH, 0); }
    pub fn tray_session(&self, v: Option<String>) { with(|s| s.viewer = v); post(WM_REFRESH, 0); }
    pub fn notify(&self, title: &str, body: &str) { with(|s| s.notifications.push((title.into(), body.into()))); post(WM_NOTIFY_SHOW, 0); }
    pub fn keep_awake(&self, on: bool) { with(|s| s.keep_awake = on); send_msg(WM_POWER, 0); }
    pub fn session_active(&self, on: bool) { with(|s| s.session = on); send_msg(WM_POWER, 0); }
    pub fn curtain(&self, on: bool) -> bool { send_msg(WM_CURTAIN, on as usize) != 0 }
    pub fn remove_tray(&self) { send_msg(WM_REMOVE_TRAY, 0); }
}

// ---- start-up ----------------------------------------------------------------------------------------------------

fn relaunch_flag() -> std::path::PathBuf { paths::home().join("relaunch.flag") }

/// Marks that a new copy of Roost is being started on purpose, so it waits for this one to quit.
pub fn mark_relaunch() { let _ = std::fs::write(relaunch_flag(), b"1"); }

pub fn run(o: Options) -> i32 {
    unsafe { let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); }
    // One Roost per Windows user. A second launch (the Start menu shortcut while running) opens the panel of the
    // first; a relaunch (elevation, updates) waits for the old copy to go.
    let name = HSTRING::from(format!("Local\\RoostApp-{}", std::env::var("USERNAME").unwrap_or_default()));
    let mutex = unsafe { CreateMutexW(None, true, &name) };
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS && !o.no_ui {
        let fresh = std::fs::metadata(relaunch_flag()).and_then(|m| m.modified()).ok()
            .and_then(|t| t.elapsed().ok()).is_some_and(|age| age.as_secs() < 60);
        let mut got = false;
        if fresh {
            for _ in 0..150 {
                std::thread::sleep(std::time::Duration::from_millis(100));
                let m = unsafe { CreateMutexW(None, true, &name) };
                if unsafe { GetLastError() } != ERROR_ALREADY_EXISTS { got = true; let _ = m; break; }
                if let Ok(m) = m { unsafe { let _ = CloseHandle(m); } }
            }
        }
        if !got {
            if let Ok(other) = unsafe { FindWindowW(w!("RoostTray"), PCWSTR::null()) } {
                unsafe { let _ = PostMessageW(Some(other), WM_SHOW_PANEL, WPARAM(0), LPARAM(0)); }
            }
            return 0;
        }
    }
    let _ = std::fs::remove_file(relaunch_flag());
    let _keep = mutex;

    let (tx, rx) = mpsc::channel::<AppMsg>();
    let _ = TX.set(tx.clone());
    let ui = !o.no_ui;
    let (ready_tx, ready_rx) = mpsc::channel();
    let ui_thread_id = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
    // The controller runs on its own thread; this one keeps the message loop.
    let controller = std::thread::Builder::new().name("roost-app".into()).spawn(move || {
        let _ = ready_rx.recv();
        let code = App::new(o, tx, rx, Pc).run();
        unsafe { let _ = PostThreadMessageW(ui_thread_id, WM_QUIT, WPARAM(code as usize), LPARAM(0)); }
        code
    }).expect("controller thread");

    if let Err(e) = create_main_window(ui) { warn!("no tray: {e}"); }
    let _ = ready_tx.send(());
    let mut msg = MSG::default();
    unsafe {
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_QUIT { break; }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    controller.join().unwrap_or(1)
}

fn instance() -> HINSTANCE { unsafe { GetModuleHandleW(None).map(|m| HINSTANCE(m.0)).unwrap_or_default() } }

fn create_main_window(tray: bool) -> Result<(), String> {
    unsafe {
        let wc = WNDCLASSW { lpfnWndProc: Some(main_proc), hInstance: instance(), lpszClassName: w!("RoostTray"), ..Default::default() };
        RegisterClassW(&wc);
        let h = CreateWindowExW(WINDOW_EX_STYLE(0), w!("RoostTray"), w!("Roost"), WS_OVERLAPPED, 0, 0, 0, 0, None, None, Some(instance()), None)
            .map_err(|e| e.to_string())?;
        let _ = UI_HWND.set(h.0 as usize);
        let _ = WTSRegisterSessionNotification(h, NOTIFY_FOR_THIS_SESSION);
        if tray { add_tray(h); }
        Ok(())
    }
}

fn taskbar_created() -> u32 {
    static M: OnceLock<u32> = OnceLock::new();
    *M.get_or_init(|| unsafe { RegisterWindowMessageW(w!("TaskbarCreated")) })
}

unsafe extern "system" fn main_proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_TRAY => {
            // NOTIFYICON_VERSION_4: the event is in the low word of lParam.
            match (lp.0 & 0xFFFF) as u32 {
                NIN_SELECT | NIN_KEYSELECT | WM_CONTEXTMENU => toggle_panel(),
                NIN_BALLOONUSERCLICK => show_panel(),
                _ => {}
            }
            LRESULT(0)
        }
        WM_REFRESH => { refresh_tray(h); panel_refresh(); LRESULT(0) }
        WM_NOTIFY_SHOW => {
            let queued = with(|s| std::mem::take(&mut s.notifications));
            for (t, b) in queued { balloon(h, &t, &b); }
            LRESULT(0)
        }
        WM_POWER => {
            let (keep, session) = with(|s| (s.keep_awake, s.session));
            // Keep PC Awake stops sleep; while someone is connected the screen stays on too.
            let mut f = ES_CONTINUOUS;
            if keep || session { f |= ES_SYSTEM_REQUIRED; }
            if session { f |= ES_DISPLAY_REQUIRED; }
            unsafe { SetThreadExecutionState(f); }
            LRESULT(0)
        }
        WM_CURTAIN => LRESULT(curtain(wp.0 != 0) as isize),
        WM_REMOVE_TRAY => {
            hide_panel();
            let nid = NOTIFYICONDATAW { cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32, hWnd: h, uID: TRAY_ID, ..Default::default() };
            unsafe { let _ = Shell_NotifyIconW(NIM_DELETE, &nid); }
            LRESULT(0)
        }
        WM_SHOW_PANEL => { show_panel(); LRESULT(0) }
        WM_CURTAIN_LIFT => { handle_lift(); LRESULT(0) }
        WM_QUIT_APP => { send(AppMsg::Quit); LRESULT(0) }
        WM_WTSSESSION_CHANGE => {
            match wp.0 { WTS_SESSION_LOCK => send(AppMsg::Lock(true)), WTS_SESSION_UNLOCK => send(AppMsg::Lock(false)), _ => {} }
            LRESULT(0)
        }
        WM_DISPLAYCHANGE => { send(AppMsg::DisplaysChanged); curtain_refit(); LRESULT(0) }
        WM_SETTINGCHANGE => { theme_changed(); LRESULT(0) }
        WM_QUERYENDSESSION => LRESULT(1),
        WM_ENDSESSION => { if wp.0 != 0 { send(AppMsg::Quit); } LRESULT(0) }
        m if m == taskbar_created() => { add_tray(h); LRESULT(0) }
        _ => unsafe { DefWindowProcW(h, msg, wp, lp) },
    }
}

// ---- the tray icon -----------------------------------------------------------------------------------------------

thread_local! { static ICONS: RefCell<Vec<(i32, u8, HICON)>> = const { RefCell::new(vec![]) }; }

/// The icon at a size, made once and kept (the tray is updated often; icons aren't free).
fn make_icon(size: i32, v: Variant) -> HICON {
    let key = v as u8;
    if let Some(h) = ICONS.with(|c| c.borrow().iter().find(|(s, k, _)| *s == size && *k == key).map(|(_, _, h)| *h)) { return h; }
    let png = icon::png(size as usize, v);
    let h = unsafe { CreateIconFromResourceEx(&png, true, 0x0003_0000, size, size, LR_DEFAULTCOLOR).unwrap_or_default() };
    ICONS.with(|c| c.borrow_mut().push((size, key, h)));
    h
}

fn tray_size() -> i32 { unsafe { GetSystemMetricsForDpi(SM_CXSMICON, GetDpiForSystem()).max(16) } }

fn copy_wide(dst: &mut [u16], s: &str) {
    let w: Vec<u16> = s.encode_utf16().take(dst.len() - 1).collect();
    dst[..w.len()].copy_from_slice(&w);
    dst[w.len()] = 0;
}

fn add_tray(h: HWND) {
    let mut nid = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32, hWnd: h, uID: TRAY_ID,
        uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP, uCallbackMessage: WM_TRAY, hIcon: make_icon(tray_size(), Variant::Normal),
        ..Default::default()
    };
    copy_wide(&mut nid.szTip, "Roost — starting…");
    unsafe {
        let _ = Shell_NotifyIconW(NIM_ADD, &nid);
        nid.Anonymous.uVersion = NOTIFYICON_VERSION_4;
        let _ = Shell_NotifyIconW(NIM_SETVERSION, &nid);
    }
    refresh_tray(h);
}

fn refresh_tray(h: HWND) {
    let m = Model::now();
    let mut nid = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32, hWnd: h, uID: TRAY_ID, uFlags: NIF_ICON | NIF_TIP | NIF_SHOWTIP,
        hIcon: make_icon(tray_size(), if m.connected { Variant::Connected } else if m.dimmed { Variant::Dimmed } else { Variant::Normal }),
        ..Default::default()
    };
    copy_wide(&mut nid.szTip, &format!("Roost — {}", m.state_text));
    unsafe { let _ = Shell_NotifyIconW(NIM_MODIFY, &nid); }
}

/// A notification: Windows 10 and 11 show the tray's balloon as a toast.
fn balloon(h: HWND, title: &str, body: &str) {
    let mut nid = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32, hWnd: h, uID: TRAY_ID, uFlags: NIF_INFO,
        dwInfoFlags: NIIF_USER | NIIF_LARGE_ICON, hBalloonIcon: make_icon(64, Variant::Normal), ..Default::default()
    };
    copy_wide(&mut nid.szInfoTitle, title);
    copy_wide(&mut nid.szInfo, if body.is_empty() { " " } else { body });
    unsafe { let _ = Shell_NotifyIconW(NIM_MODIFY, &nid); }
}

// ---- what the panel shows (worked out from the host's status, like Perch's MenuModel) ----------------------------

#[derive(Clone, PartialEq)]
enum Action { Event(&'static str), OpenSetup(String), Quit, None }

#[derive(Clone)]
struct Toggle { label: &'static str, detail: Option<String>, on: bool, enabled: bool, action: Action }

struct Model {
    state_text: String,
    name: String,
    connected: bool,
    viewer: Option<String>,
    dimmed: bool,
    live: bool,
    tone: Tone,
    toggles: Vec<Toggle>,
    setup: Option<String>,
    update_label: String,
    update_action: Action,
}

#[derive(Clone, Copy, PartialEq)]
enum Tone { Good, Busy, Quiet, Bad }

impl Model {
    fn now() -> Self {
        let (status, viewer, problem) = with(|s| (s.status.clone(), s.viewer.clone(), s.problem.clone()));
        let state = jsonv::s(&status, "state").unwrap_or("starting").to_string();
        let empty = Obj::new();
        let settings = jsonv::obj(&status, "settings").unwrap_or(&empty);
        let connected = viewer.is_some() || state == "connected";
        let paused = state == "paused" || jsonv::b(settings, "paused") == Some(true);
        let state_text = problem.clone().or_else(|| jsonv::s(&status, "text").filter(|t| !t.is_empty()).map(str::to_owned)).unwrap_or_else(|| match state.as_str() {
            "ready" => "Ready".into(),
            "needs-setup" => "Needs setting up".into(),
            "offline" => "Offline".into(),
            "paused" => "Paused".into(),
            "connected" => viewer.as_ref().map(|v| format!("{v} is connected")).unwrap_or_else(|| "Someone is connected".into()),
            "error" => "Something went wrong".into(),
            _ => "Starting…".into(),
        });
        let live = problem.is_none();
        let tone = if !live || state == "error" { Tone::Bad } else if connected { Tone::Busy }
            else if paused || state == "offline" || state == "needs-setup" || state == "starting" { Tone::Quiet } else { Tone::Good };
        let flag = |k: &str| jsonv::b(settings, k) == Some(true);
        let backup = flag("backupOn");
        let password = jsonv::b(&status, "backupSet").or_else(|| jsonv::b(settings, "backupSet")).unwrap_or(false);
        let toggles = vec![
            Toggle { label: "Pause Roost", detail: Some("Nobody can connect while paused".into()), on: paused, enabled: live,
                action: Action::Event(if paused { "resume" } else { "pause" }) },
            Toggle { label: "Keep this PC awake", detail: Some("So you can always reach it".into()), on: flag("keepAwake"), enabled: live,
                action: Action::Event(if flag("keepAwake") { "keep-awake-off" } else { "keep-awake-on" }) },
            Toggle { label: "Start with Windows", detail: None, on: flag("loginItem"), enabled: live,
                action: Action::Event(if flag("loginItem") { "login-item-off" } else { "login-item-on" }) },
            Toggle { label: "Backup sign-in", detail: (!password && !backup).then(|| "Choose a backup password first".into()), on: backup,
                enabled: live && (password || backup), action: Action::Event(if backup { "backup-off" } else { "backup-on" }) },
        ];
        let version = |k: &str| -> Option<String> {
            jsonv::s(&status, k).map(str::to_owned).or_else(|| jsonv::obj(&status, k).and_then(|o| jsonv::s(o, "version")).map(str::to_owned))
                .filter(|v| !v.is_empty()).map(|v| v.chars().take(32).collect())
        };
        let (update_label, update_action) = if let Some(v) = version("restart") {
            (format!("Restart to finish updating to {v}"), Action::Event("restart"))
        } else if let Some(v) = version("update") {
            (format!("Update to {v}"), Action::Event("update"))
        } else {
            ("Check for updates".into(), Action::Event("check-updates"))
        };
        let setup = jsonv::s(&status, "setupUrl").filter(|u| u.starts_with("http://") || u.starts_with("https://")).map(str::to_owned);
        Self { state_text, name: jsonv::s(&status, "macName").unwrap_or("").to_string(), connected, viewer, dimmed: problem.is_some() || (paused && !connected),
            live, tone, toggles, setup, update_label, update_action }
    }
}

// ---- the panel ---------------------------------------------------------------------------------------------------

struct Palette { bg: D2D1_COLOR_F, surface: D2D1_COLOR_F, line: D2D1_COLOR_F, text: D2D1_COLOR_F, muted: D2D1_COLOR_F,
    accent: D2D1_COLOR_F, accent2: D2D1_COLOR_F, accent_text: D2D1_COLOR_F, good: D2D1_COLOR_F, bad: D2D1_COLOR_F, warn: D2D1_COLOR_F, hover: D2D1_COLOR_F }

fn rgb(hex: u32, a: f32) -> D2D1_COLOR_F {
    D2D1_COLOR_F { r: ((hex >> 16) & 255) as f32 / 255.0, g: ((hex >> 8) & 255) as f32 / 255.0, b: (hex & 255) as f32 / 255.0, a }
}

fn palette(dark: bool, backdrop: bool) -> Palette {
    // docs/BRAND.md, "Ember".
    if dark {
        Palette { bg: rgb(0x0B0D12, if backdrop { 0.72 } else { 1.0 }), surface: rgb(0x1C202B, 0.85), line: rgb(0x272C38, 1.0),
            text: rgb(0xF2EEE8, 1.0), muted: rgb(0xA39E96, 1.0), accent: rgb(0xFF7A3D, 1.0), accent2: rgb(0xFFC15E, 1.0),
            accent_text: rgb(0x1A0D05, 1.0), good: rgb(0x4ADE9B, 1.0), bad: rgb(0xFF5C6C, 1.0), warn: rgb(0xFFC15E, 1.0), hover: rgb(0xFFFFFF, 0.06) }
    } else {
        Palette { bg: rgb(0xFAF7F2, if backdrop { 0.78 } else { 1.0 }), surface: rgb(0xFFFFFF, 0.9), line: rgb(0xE7E0D5, 1.0),
            text: rgb(0x1B1712, 1.0), muted: rgb(0x6E665C, 1.0), accent: rgb(0xD9531A, 1.0), accent2: rgb(0xE79A1E, 1.0),
            accent_text: rgb(0xFFFFFF, 1.0), good: rgb(0x178A55, 1.0), bad: rgb(0xC8323F, 1.0), warn: rgb(0xA86A00, 1.0), hover: rgb(0x000000, 0.05) }
    }
}

fn dark_mode() -> bool {
    let v = unsafe {
        let mut d = 1u32;
        let mut size = 4u32;
        let _ = windows::Win32::System::Registry::RegGetValueW(windows::Win32::System::Registry::HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"), w!("AppsUseLightTheme"),
            windows::Win32::System::Registry::RRF_RT_REG_DWORD, None, Some((&mut d as *mut u32).cast()), Some(&mut size));
        d
    };
    v == 0
}

#[derive(Clone, Copy, PartialEq)]
enum Hit { Disconnect, Toggle(usize), Setup, Update, Quit }

struct Panel {
    hwnd: HWND,
    target: Option<ID2D1HwndRenderTarget>,
    factory: ID2D1Factory,
    dwrite: IDWriteFactory,
    logo: Option<ID2D1Bitmap>,
    hits: Vec<(D2D_RECT_F, Hit, bool)>,
    hover: Option<Hit>,
    focus: Option<usize>,
    pressed: Option<Hit>,
    height: f32,
    backdrop: bool,
    hidden_at: std::time::Instant,
}

thread_local! { static PANEL: RefCell<Option<Panel>> = const { RefCell::new(None) }; }

const PANEL_W: f32 = 344.0;

fn toggle_panel() {
    let visible = PANEL.with(|p| p.borrow().as_ref().is_some_and(|p| unsafe { IsWindowVisible(p.hwnd).as_bool() }));
    // A click on the tray icon while the panel is open first deactivates it (hiding it): don't reopen at once.
    let just_hidden = PANEL.with(|p| p.borrow().as_ref().is_some_and(|p| p.hidden_at.elapsed().as_millis() < 300));
    if visible || just_hidden { hide_panel(); } else { show_panel(); }
}

fn hide_panel() {
    PANEL.with(|p| if let Some(p) = p.borrow_mut().as_mut() {
        unsafe { let _ = ShowWindow(p.hwnd, SW_HIDE); }
        p.hidden_at = std::time::Instant::now();
    });
}

fn panel_refresh() {
    PANEL.with(|p| if let Some(p) = p.borrow().as_ref() { unsafe { let _ = InvalidateRect(Some(p.hwnd), None, false); } });
    let visible = PANEL.with(|p| p.borrow().as_ref().is_some_and(|p| unsafe { IsWindowVisible(p.hwnd).as_bool() }));
    if visible { place_panel(); }
}

fn theme_changed() {
    PANEL.with(|p| if let Some(p) = p.borrow().as_ref() { apply_dwm(p.hwnd); unsafe { let _ = InvalidateRect(Some(p.hwnd), None, false); } });
}

fn apply_dwm(h: HWND) -> bool {
    unsafe {
        let dark: windows::core::BOOL = dark_mode().into();
        let _ = DwmSetWindowAttribute(h, DWMWA_USE_IMMERSIVE_DARK_MODE, (&dark as *const windows::core::BOOL).cast(), 4);
        let corner = DWMWCP_ROUND;
        let _ = DwmSetWindowAttribute(h, DWMWA_WINDOW_CORNER_PREFERENCE, (&corner as *const DWM_WINDOW_CORNER_PREFERENCE).cast(), 4);
        // Windows 11 (22H2+): the acrylic "transient window" backdrop, as Windows' own flyouts have.
        if super::build_number() >= 22621 {
            let backdrop = DWMSBT_TRANSIENTWINDOW;
            if DwmSetWindowAttribute(h, DWMWA_SYSTEMBACKDROP_TYPE, (&backdrop as *const DWM_SYSTEMBACKDROP_TYPE).cast(), 4).is_ok() {
                let m = MARGINS { cxLeftWidth: -1, cxRightWidth: -1, cyTopHeight: -1, cyBottomHeight: -1 };
                let _ = DwmExtendFrameIntoClientArea(h, &m);
                return true;
            }
        }
        false
    }
}

fn show_panel() {
    let exists = PANEL.with(|p| p.borrow().is_some());
    if !exists {
        let made = unsafe {
            let wc = WNDCLASSW { lpfnWndProc: Some(panel_proc), hInstance: instance(), lpszClassName: w!("RoostPanel"),
                hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(), style: CS_DROPSHADOW, ..Default::default() };
            RegisterClassW(&wc);
            CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, w!("RoostPanel"), w!("Roost"), WS_POPUP, 0, 0, 10, 10, None, None, Some(instance()), None)
        };
        let Ok(h) = made else { return };
        let backdrop = apply_dwm(h);
        let factory: Result<ID2D1Factory, _> = unsafe { D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None) };
        let dwrite: Result<IDWriteFactory, _> = unsafe { DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED) };
        let (Ok(factory), Ok(dwrite)) = (factory, dwrite) else { return };
        PANEL.with(|p| *p.borrow_mut() = Some(Panel { hwnd: h, target: None, factory, dwrite, logo: None, hits: vec![], hover: None,
            focus: None, pressed: None, height: 400.0, backdrop, hidden_at: std::time::Instant::now() - std::time::Duration::from_secs(5) }));
    }
    place_panel();
    PANEL.with(|p| if let Some(p) = p.borrow().as_ref() {
        unsafe {
            let _ = ShowWindow(p.hwnd, SW_SHOW);
            let _ = SetForegroundWindow(p.hwnd);
            let _ = InvalidateRect(Some(p.hwnd), None, false);
        }
    });
}

/// Above the tray icon (or beside it, for a taskbar on the side), inside the work area.
fn place_panel() {
    PANEL.with(|cell| {
        let mut b = cell.borrow_mut();
        let Some(p) = b.as_mut() else { return };
        // Lay out once to know the height.
        p.height = layout(&Model::now(), &mut vec![]);
        let id = NOTIFYICONIDENTIFIER { cbSize: std::mem::size_of::<NOTIFYICONIDENTIFIER>() as u32, hWnd: hwnd(), uID: TRAY_ID, ..Default::default() };
        let icon = unsafe { Shell_NotifyIconGetRect(&id) }.unwrap_or_else(|_| {
            let mut pt = POINT::default();
            unsafe { let _ = GetCursorPos(&mut pt); }
            RECT { left: pt.x, top: pt.y, right: pt.x + 1, bottom: pt.y + 1 }
        });
        let mon = unsafe { MonitorFromPoint(POINT { x: icon.left, y: icon.top }, MONITOR_DEFAULTTONEAREST) };
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        unsafe { let _ = GetMonitorInfoW(mon, &mut mi); }
        let work = mi.rcWork;
        let dpi = { let (mut x, mut y) = (96u32, 96u32); unsafe { let _ = windows::Win32::UI::HiDpi::GetDpiForMonitor(mon, MDT_EFFECTIVE_DPI, &mut x, &mut y); } x as f32 / 96.0 };
        let (w, h) = ((PANEL_W * dpi) as i32, (p.height * dpi) as i32);
        let gap = (12.0 * dpi) as i32;
        let (x, y) = if icon.top >= work.bottom - 4 {
            (icon.right - w / 2 - (icon.right - icon.left) / 2, work.bottom - h - gap)
        } else if icon.bottom <= work.top + 4 {
            (icon.right - w / 2, work.top + gap)
        } else if icon.left >= work.right - 4 {
            (work.right - w - gap, icon.top - h / 2)
        } else {
            (work.left + gap, icon.top - h / 2)
        };
        let x = x.clamp(work.left + gap, (work.right - w - gap).max(work.left));
        let y = y.clamp(work.top + gap, (work.bottom - h - gap).max(work.top));
        unsafe { let _ = SetWindowPos(p.hwnd, Some(HWND_TOPMOST), x, y, w, h, SWP_NOACTIVATE); }
        if let Some(t) = &p.target { unsafe { let _ = t.Resize(&D2D_SIZE_U { width: w as u32, height: h as u32 }); } }
    });
}

fn rect(l: f32, t: f32, r: f32, b: f32) -> D2D_RECT_F { D2D_RECT_F { left: l, top: t, right: r, bottom: b } }

/// Works out where everything goes (in DIPs) and returns the panel's height. `hits` gets the clickable parts.
fn layout(m: &Model, hits: &mut Vec<(D2D_RECT_F, Hit, bool)>) -> f32 {
    let pad = 16.0;
    let mut y = pad + 44.0 + 14.0; // header
    y += 64.0 + 12.0; // status card
    if m.connected {
        hits.push((rect(PANEL_W - pad - 112.0, pad + 44.0 + 14.0 + 16.0, PANEL_W - pad - 14.0, pad + 44.0 + 14.0 + 48.0), Hit::Disconnect, m.live));
    }
    for (i, t) in m.toggles.iter().enumerate() {
        let h = if t.detail.is_some() { 52.0 } else { 40.0 };
        hits.push((rect(pad, y, PANEL_W - pad, y + h), Hit::Toggle(i), t.enabled));
        y += h;
    }
    y += 12.0;
    hits.push((rect(pad, y, PANEL_W - pad, y + 40.0), Hit::Setup, m.setup.is_some() && m.live));
    y += 40.0 + 8.0;
    let half = (PANEL_W - pad * 2.0 - 8.0) * 0.62;
    hits.push((rect(pad, y, pad + half, y + 36.0), Hit::Update, m.live));
    hits.push((rect(pad + half + 8.0, y, PANEL_W - pad, y + 36.0), Hit::Quit, true));
    y + 36.0 + pad
}

fn wide(s: &str) -> Vec<u16> { s.encode_utf16().collect() }

fn text_format(dw: &IDWriteFactory, size: f32, weight: DWRITE_FONT_WEIGHT, align: DWRITE_TEXT_ALIGNMENT) -> Option<IDWriteTextFormat> {
    let family = if super::build_number() >= 22000 { w!("Segoe UI Variable Text") } else { w!("Segoe UI") };
    unsafe {
        let f = dw.CreateTextFormat(family, None, weight, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, size, w!("en-us")).ok()?;
        let _ = f.SetTextAlignment(align);
        let _ = f.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
        let _ = f.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
        Some(f)
    }
}

fn paint(p: &mut Panel) -> windows::core::Result<()> {
    let m = Model::now();
    let mut hits = vec![];
    p.height = layout(&m, &mut hits);
    p.hits = hits;
    let dpi = unsafe { GetDpiForWindow(p.hwnd) } as f32;
    if p.target.is_none() {
        let mut rc = RECT::default();
        unsafe { let _ = GetClientRect(p.hwnd, &mut rc); }
        let props = D2D1_RENDER_TARGET_PROPERTIES {
            r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
            pixelFormat: D2D1_PIXEL_FORMAT { format: DXGI_FORMAT_B8G8R8A8_UNORM, alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED },
            dpiX: dpi, dpiY: dpi, ..Default::default()
        };
        let hprops = D2D1_HWND_RENDER_TARGET_PROPERTIES { hwnd: p.hwnd, pixelSize: D2D_SIZE_U { width: rc.right as u32, height: rc.bottom as u32 }, presentOptions: D2D1_PRESENT_OPTIONS_NONE };
        p.target = Some(unsafe { p.factory.CreateHwndRenderTarget(&props, &hprops)? });
        p.logo = None;
    }
    let t = p.target.clone().unwrap();
    let c = palette(dark_mode(), p.backdrop);
    let brush = |col: D2D1_COLOR_F| unsafe { t.CreateSolidColorBrush(&col, None) };
    let (title, body, small, button) = (
        text_format(&p.dwrite, 16.0, DWRITE_FONT_WEIGHT_SEMI_BOLD, DWRITE_TEXT_ALIGNMENT_LEADING),
        text_format(&p.dwrite, 13.0, DWRITE_FONT_WEIGHT_NORMAL, DWRITE_TEXT_ALIGNMENT_LEADING),
        text_format(&p.dwrite, 11.5, DWRITE_FONT_WEIGHT_NORMAL, DWRITE_TEXT_ALIGNMENT_LEADING),
        text_format(&p.dwrite, 13.0, DWRITE_FONT_WEIGHT_SEMI_BOLD, DWRITE_TEXT_ALIGNMENT_CENTER),
    );
    let (Some(title), Some(body), Some(small), Some(button)) = (title, body, small, button) else { return Ok(()) };
    let text = |s: &str, f: &IDWriteTextFormat, r: D2D_RECT_F, b: &ID2D1SolidColorBrush| unsafe {
        t.DrawText(&wide(s), f, &r, b, D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
    };
    unsafe {
        t.SetDpi(dpi, dpi);
        t.BeginDraw();
        t.Clear(Some(&c.bg));
        let pad = 16.0;
        let (tx, mx, mu) = (brush(c.text)?, brush(c.muted)?, brush(c.line)?);

        // Header: the logo, "Roost" and the PC's name, and a state chip.
        if p.logo.is_none() {
            let px = (40.0 * dpi / 96.0).round() as usize;
            let mut bgra = icon::render(px, Variant::Normal);
            for q in bgra.chunks_mut(4) {
                let a = q[3] as u32;
                let (r, g, b) = (q[0] as u32 * a / 255, q[1] as u32 * a / 255, q[2] as u32 * a / 255);
                q[0] = b as u8; q[1] = g as u8; q[2] = r as u8;
            }
            let bp = D2D1_BITMAP_PROPERTIES { pixelFormat: D2D1_PIXEL_FORMAT { format: DXGI_FORMAT_B8G8R8A8_UNORM, alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED }, dpiX: dpi, dpiY: dpi };
            p.logo = t.CreateBitmap(D2D_SIZE_U { width: px as u32, height: px as u32 }, Some(bgra.as_ptr().cast()), (px * 4) as u32, &bp).ok();
        }
        if let Some(logo) = &p.logo {
            t.DrawBitmap(logo, Some(&rect(pad, pad + 2.0, pad + 40.0, pad + 42.0)), 1.0, D2D1_BITMAP_INTERPOLATION_MODE_LINEAR, None);
        }
        text("Roost", &title, rect(pad + 52.0, pad + 2.0, PANEL_W - 110.0, pad + 24.0), &tx);
        let sub = if m.name.is_empty() { "Your PC, from anywhere".to_string() } else { format!("This PC is {}", m.name) };
        text(&sub, &small, rect(pad + 52.0, pad + 22.0, PANEL_W - 110.0, pad + 42.0), &mx);
        let (chip_col, chip_text) = match m.tone {
            Tone::Good => (c.good, "Ready"), Tone::Busy => (c.accent, "In use"), Tone::Quiet => (c.warn, "Idle"), Tone::Bad => (c.bad, "Problem"),
        };
        let chip = rect(PANEL_W - pad - 82.0, pad + 10.0, PANEL_W - pad, pad + 34.0);
        let chip_bg = brush(D2D1_COLOR_F { a: 0.16, ..chip_col })?;
        t.FillRoundedRectangle(&D2D1_ROUNDED_RECT { rect: chip, radiusX: 12.0, radiusY: 12.0 }, &chip_bg);
        let dot = brush(chip_col)?;
        t.FillEllipse(&D2D1_ELLIPSE { point: Vector2 { X: chip.left + 14.0, Y: (chip.top + chip.bottom) / 2.0 }, radiusX: 4.0, radiusY: 4.0 }, &dot);
        text(chip_text, &small, rect(chip.left + 24.0, chip.top, chip.right - 6.0, chip.bottom), &tx);

        // The status card: what Roost is doing, with Disconnect while someone is connected.
        let top = pad + 44.0 + 14.0;
        let card = rect(pad, top, PANEL_W - pad, top + 64.0);
        let surface = brush(c.surface)?;
        t.FillRoundedRectangle(&D2D1_ROUNDED_RECT { rect: card, radiusX: 14.0, radiusY: 14.0 }, &surface);
        t.DrawRoundedRectangle(&D2D1_ROUNDED_RECT { rect: card, radiusX: 14.0, radiusY: 14.0 }, &mu, 1.0, None);
        if m.tone == Tone::Busy {
            // An ember bar down the card's left side while someone is connected.
            let stops = [D2D1_GRADIENT_STOP { position: 0.0, color: c.accent }, D2D1_GRADIENT_STOP { position: 1.0, color: c.accent2 }];
            let coll = t.CreateGradientStopCollection(&stops, D2D1_GAMMA_2_2, D2D1_EXTEND_MODE_CLAMP)?;
            let g = t.CreateLinearGradientBrush(&D2D1_LINEAR_GRADIENT_BRUSH_PROPERTIES { startPoint: Vector2 { X: 0.0, Y: card.top }, endPoint: Vector2 { X: 0.0, Y: card.bottom } }, None, &coll)?;
            t.FillRoundedRectangle(&D2D1_ROUNDED_RECT { rect: rect(card.left + 6.0, card.top + 12.0, card.left + 10.0, card.bottom - 12.0), radiusX: 2.0, radiusY: 2.0 }, &g);
        }
        let right = if m.connected { PANEL_W - pad - 124.0 } else { PANEL_W - pad - 14.0 };
        let (headline, detail) = if m.connected {
            (m.viewer.clone().map(|v| format!("{v}")).unwrap_or_else(|| "Someone".into()), "is using this PC".to_string())
        } else {
            (m.state_text.clone(), match m.tone { Tone::Good => "Open the Roost website on your phone to connect".into(), Tone::Bad => "Roost will keep trying".into(), _ => String::new() })
        };
        text(&headline, &body, rect(card.left + 18.0, card.top + 10.0, right, card.top + (if detail.is_empty() { 54.0 } else { 34.0 })), &tx);
        if !detail.is_empty() { text(&detail, &small, rect(card.left + 18.0, card.top + 32.0, right, card.top + 54.0), &mx); }
        for (r, hit, enabled) in p.hits.clone() {
            if hit != Hit::Disconnect { continue; }
            let hover = p.hover == Some(hit) && enabled;
            let bad = brush(c.bad)?;
            let fill = brush(D2D1_COLOR_F { a: if hover { 0.18 } else { 0.1 }, ..c.bad })?;
            t.FillRoundedRectangle(&D2D1_ROUNDED_RECT { rect: r, radiusX: 10.0, radiusY: 10.0 }, &fill);
            text("Disconnect", &button, r, &bad);
        }

        // The switches.
        for (r, hit, enabled) in p.hits.clone() {
            let Hit::Toggle(i) = hit else { continue };
            let tg = &m.toggles[i];
            let focused = p.focus.and_then(|f| p.hits.get(f)).is_some_and(|h| h.1 == hit);
            if (p.hover == Some(hit) && enabled) || focused {
                let hv = brush(c.hover)?;
                t.FillRoundedRectangle(&D2D1_ROUNDED_RECT { rect: r, radiusX: 10.0, radiusY: 10.0 }, &hv);
            }
            let label_col = if enabled { &tx } else { &mx };
            if let Some(d) = &tg.detail {
                text(tg.label, &body, rect(r.left + 10.0, r.top + 6.0, r.right - 64.0, r.top + 28.0), label_col);
                text(d, &small, rect(r.left + 10.0, r.top + 26.0, r.right - 64.0, r.bottom - 6.0), &mx);
            } else {
                text(tg.label, &body, rect(r.left + 10.0, r.top, r.right - 64.0, r.bottom), label_col);
            }
            // The switch: a pill with a knob, ember when on.
            let cy = (r.top + r.bottom) / 2.0;
            let sw = rect(r.right - 54.0, cy - 10.0, r.right - 10.0, cy + 10.0);
            let alpha = if enabled { 1.0 } else { 0.4 };
            if tg.on {
                let on = brush(D2D1_COLOR_F { a: alpha, ..c.accent })?;
                t.FillRoundedRectangle(&D2D1_ROUNDED_RECT { rect: sw, radiusX: 10.0, radiusY: 10.0 }, &on);
                let knob = brush(D2D1_COLOR_F { a: alpha, ..c.accent_text })?;
                t.FillEllipse(&D2D1_ELLIPSE { point: Vector2 { X: sw.right - 10.0, Y: cy }, radiusX: 6.5, radiusY: 6.5 }, &knob);
            } else {
                let off = brush(D2D1_COLOR_F { a: alpha, ..c.muted })?;
                t.DrawRoundedRectangle(&D2D1_ROUNDED_RECT { rect: rect(sw.left + 0.5, sw.top + 0.5, sw.right - 0.5, sw.bottom - 0.5), radiusX: 9.5, radiusY: 9.5 }, &off, 1.0, None);
                t.FillEllipse(&D2D1_ELLIPSE { point: Vector2 { X: sw.left + 10.0, Y: cy }, radiusX: 5.0, radiusY: 5.0 }, &off);
            }
        }

        // Buttons: Open Control Center (ember), updates, quit.
        for (r, hit, enabled) in p.hits.clone() {
            let hover = p.hover == Some(hit) && enabled;
            let focused = p.focus.and_then(|f| p.hits.get(f)).is_some_and(|h| h.1 == hit);
            let rr = D2D1_ROUNDED_RECT { rect: r, radiusX: 12.0, radiusY: 12.0 };
            match hit {
                Hit::Setup => {
                    let stops = [D2D1_GRADIENT_STOP { position: 0.0, color: c.accent }, D2D1_GRADIENT_STOP { position: 1.0, color: c.accent2 }];
                    let coll = t.CreateGradientStopCollection(&stops, D2D1_GAMMA_2_2, D2D1_EXTEND_MODE_CLAMP)?;
                    let g = t.CreateLinearGradientBrush(&D2D1_LINEAR_GRADIENT_BRUSH_PROPERTIES { startPoint: Vector2 { X: r.left, Y: r.top }, endPoint: Vector2 { X: r.right, Y: r.bottom } }, None, &coll)?;
                    g.SetOpacity(if !enabled { 0.45 } else if hover { 0.92 } else { 1.0 });
                    t.FillRoundedRectangle(&rr, &g);
                    let at = brush(c.accent_text)?;
                    text("Open Control Center", &button, r, &at);
                }
                Hit::Update | Hit::Quit => {
                    let fill = brush(if hover { D2D1_COLOR_F { a: c.surface.a.max(0.9), ..c.surface } } else { D2D1_COLOR_F { a: 0.0, ..c.surface } })?;
                    t.FillRoundedRectangle(&rr, &fill);
                    t.DrawRoundedRectangle(&rr, &mu, 1.0, None);
                    let label = if hit == Hit::Quit { "Quit Roost".to_string() } else { m.update_label.clone() };
                    let col = if !enabled { &mx } else if hit == Hit::Update && m.update_action != Action::Event("check-updates") { &dot } else { &tx };
                    text(&label, &button, rect(r.left + 6.0, r.top, r.right - 6.0, r.bottom), col);
                }
                _ => continue,
            }
            if focused {
                let fb = brush(c.accent)?;
                t.DrawRoundedRectangle(&D2D1_ROUNDED_RECT { rect: rect(r.left - 2.0, r.top - 2.0, r.right + 2.0, r.bottom + 2.0), radiusX: 14.0, radiusY: 14.0 }, &fb, 2.0, None);
            }
        }
        match t.EndDraw(None, None) {
            Err(e) if e.code() == D2DERR_RECREATE_TARGET => { p.target = None; p.logo = None; Ok(()) }
            r => r,
        }
    }
}

fn activate(hit: Hit) {
    let m = Model::now();
    let action = match hit {
        Hit::Disconnect => Action::Event("disconnect"),
        Hit::Toggle(i) => m.toggles.get(i).map(|t| t.action.clone()).unwrap_or(Action::None),
        Hit::Setup => m.setup.clone().map(Action::OpenSetup).unwrap_or(Action::None),
        Hit::Update => m.update_action.clone(),
        Hit::Quit => Action::Quit,
    };
    match action {
        Action::Event(e) => send(AppMsg::Menu(e.into())),
        Action::OpenSetup(url) => { super::open_url(&url); hide_panel(); }
        Action::Quit => { hide_panel(); send(AppMsg::Quit); }
        Action::None => {}
    }
}

fn hit_at(p: &Panel, x: f32, y: f32) -> Option<(Hit, bool)> {
    p.hits.iter().find(|(r, _, _)| x >= r.left && x <= r.right && y >= r.top && y <= r.bottom).map(|(_, h, e)| (*h, *e))
}

unsafe extern "system" fn panel_proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let dip = |lp: LPARAM| -> (f32, f32) {
        let s = 96.0 / unsafe { GetDpiForWindow(h) }.max(96) as f32;
        (((lp.0 & 0xFFFF) as i16) as f32 * s, (((lp.0 >> 16) & 0xFFFF) as i16) as f32 * s)
    };
    match msg {
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            unsafe { BeginPaint(h, &mut ps); }
            PANEL.with(|p| if let Some(p) = p.borrow_mut().as_mut() { if let Err(e) = paint(p) { warn!("panel: {e}"); } });
            unsafe { let _ = EndPaint(h, &ps); }
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_SIZE => {
            PANEL.with(|p| if let Some(p) = p.borrow().as_ref() {
                if let Some(t) = &p.target { unsafe { let _ = t.Resize(&D2D_SIZE_U { width: (lp.0 & 0xFFFF) as u32, height: ((lp.0 >> 16) & 0xFFFF) as u32 }); } }
            });
            LRESULT(0)
        }
        WM_DPICHANGED => { PANEL.with(|p| if let Some(p) = p.borrow_mut().as_mut() { p.target = None; p.logo = None; }); place_panel(); LRESULT(0) }
        WM_MOUSEMOVE => {
            let (x, y) = dip(lp);
            let changed = PANEL.with(|p| {
                let mut b = p.borrow_mut();
                let Some(p) = b.as_mut() else { return false };
                let now = hit_at(p, x, y).filter(|(_, e)| *e).map(|(hh, _)| hh);
                let changed = now != p.hover;
                p.hover = now;
                changed
            });
            let mut tme = TRACKMOUSEEVENT { cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE, hwndTrack: h, dwHoverTime: 0 };
            unsafe { let _ = TrackMouseEvent(&mut tme); }
            if changed {
                let hand = PANEL.with(|p| p.borrow().as_ref().is_some_and(|p| p.hover.is_some()));
                unsafe { SetCursor(LoadCursorW(None, if hand { IDC_HAND } else { IDC_ARROW }).ok()); let _ = InvalidateRect(Some(h), None, false); }
            }
            LRESULT(0)
        }
        WM_MOUSELEAVE => { PANEL.with(|p| if let Some(p) = p.borrow_mut().as_mut() { p.hover = None; }); unsafe { let _ = InvalidateRect(Some(h), None, false); } LRESULT(0) }
        WM_LBUTTONDOWN => {
            let (x, y) = dip(lp);
            PANEL.with(|p| if let Some(p) = p.borrow_mut().as_mut() { p.pressed = hit_at(p, x, y).filter(|(_, e)| *e).map(|(hh, _)| hh); });
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            let (x, y) = dip(lp);
            let hit = PANEL.with(|p| p.borrow_mut().as_mut().and_then(|p| {
                let pressed = p.pressed.take();
                hit_at(p, x, y).filter(|(hh, e)| *e && Some(*hh) == pressed).map(|(hh, _)| hh)
            }));
            if let Some(hit) = hit { activate(hit); }
            LRESULT(0)
        }
        WM_KEYDOWN => {
            let key = VIRTUAL_KEY(wp.0 as u16);
            if key == VK_ESCAPE { hide_panel(); return LRESULT(0); }
            let shift = unsafe { GetKeyState(VK_SHIFT.0 as i32) } < 0;
            let target = PANEL.with(|p| {
                let mut b = p.borrow_mut();
                let p = b.as_mut()?;
                let usable: Vec<usize> = p.hits.iter().enumerate().filter(|(_, h)| h.2).map(|(i, _)| i).collect();
                if usable.is_empty() { return None; }
                match key {
                    VK_TAB | VK_DOWN | VK_UP => {
                        let pos = p.focus.and_then(|f| usable.iter().position(|u| *u == f));
                        let back = key == VK_UP || (key == VK_TAB && shift);
                        let next = match pos {
                            None => if back { usable.len() - 1 } else { 0 },
                            Some(i) => if back { (i + usable.len() - 1) % usable.len() } else { (i + 1) % usable.len() },
                        };
                        p.focus = Some(usable[next]);
                        None
                    }
                    VK_RETURN | VK_SPACE => p.focus.and_then(|f| p.hits.get(f)).map(|h| h.1),
                    _ => None,
                }
            });
            if let Some(hit) = target { activate(hit); }
            unsafe { let _ = InvalidateRect(Some(h), None, false); }
            LRESULT(0)
        }
        WM_ACTIVATE => {
            if (wp.0 & 0xFFFF) as u32 == WA_INACTIVE { hide_panel(); }
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(h, msg, wp, lp) },
    }
}

// ---- the privacy curtain ------------------------------------------------------------------------------------------

thread_local! {
    static CURTAINS: RefCell<Vec<HWND>> = const { RefCell::new(vec![]) };
    static HOOK: RefCell<Option<HHOOK>> = const { RefCell::new(None) };
    static ESCAPES: RefCell<Vec<std::time::Instant>> = const { RefCell::new(vec![]) };
}

/// Black windows over every display, left out of the picture (WDA_EXCLUDEFROMCAPTURE) so the viewer sees the real
/// screen through them, and click-through so the viewer's clicks reach the apps underneath. Three presses of Esc
/// on the PC's own keyboard lift it. Returns whether it is up.
fn curtain(on: bool) -> bool {
    if !on {
        CURTAINS.with(|c| for h in c.borrow_mut().drain(..) { unsafe { let _ = DestroyWindow(h); } });
        HOOK.with(|k| if let Some(k) = k.borrow_mut().take() { unsafe { let _ = UnhookWindowsHookEx(k); } });
        return false;
    }
    if !super::curtain_supported() { return false; }
    if CURTAINS.with(|c| !c.borrow().is_empty()) { return true; }
    unsafe {
        let wc = WNDCLASSW { lpfnWndProc: Some(curtain_proc), hInstance: instance(), lpszClassName: w!("RoostCurtain"),
            hbrBackground: HBRUSH(GetStockObject(BLACK_BRUSH).0), hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(), ..Default::default() };
        RegisterClassW(&wc);
    }
    for d in super::displays() {
        let made = unsafe {
            CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE, w!("RoostCurtain"), w!("Roost"),
                WS_POPUP, d.rect.x as i32, d.rect.y as i32, d.rect.w as i32, d.rect.h as i32, None, None, Some(instance()), None)
        };
        let Ok(h) = made else { continue };
        unsafe {
            let _ = SetLayeredWindowAttributes(h, COLORREF(0), 255, LWA_ALPHA);
            if SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE).is_err() {
                // Never show a curtain the viewer would see as black.
                let _ = DestroyWindow(h);
                continue;
            }
            let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
        }
        CURTAINS.with(|c| c.borrow_mut().push(h));
    }
    let up = CURTAINS.with(|c| !c.borrow().is_empty());
    if up {
        let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), Some(instance()), 0) };
        HOOK.with(|k| *k.borrow_mut() = hook.ok());
        unsafe { let _ = SetTimer(Some(hwnd()), 77, 1000, Some(curtain_timer)); }
        info!("privacy curtain up");
    }
    up
}

fn curtain_refit() {
    let up = CURTAINS.with(|c| !c.borrow().is_empty());
    if up { curtain(false); curtain(true); }
}

unsafe extern "system" fn curtain_timer(_: HWND, _: u32, _: usize, _: u32) {
    // Other always-on-top windows can come over it; put it back on top now and then.
    CURTAINS.with(|c| for h in c.borrow().iter() {
        unsafe { let _ = SetWindowPos(*h, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE); }
    });
}

unsafe extern "system" fn keyboard_hook(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code >= 0 && (wp.0 as u32 == WM_KEYDOWN) {
        let k = unsafe { &*(lp.0 as *const KBDLLHOOKSTRUCT) };
        // Only the PC's own keyboard: not the viewer's keys (marked by Roost) or anything else injected.
        if k.vkCode == VK_ESCAPE.0 as u32 && k.flags.0 & LLKHF_INJECTED.0 == 0 && k.dwExtraInfo != ROOST_MARK {
            let lift = ESCAPES.with(|e| {
                let mut e = e.borrow_mut();
                let now = std::time::Instant::now();
                e.retain(|t| now.duration_since(*t).as_millis() < 2000);
                e.push(now);
                e.len() >= 3
            });
            if lift {
                ESCAPES.with(|e| e.borrow_mut().clear());
                post(WM_CURTAIN_LIFT, 0);
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wp, lp) }
}

const WM_CURTAIN_LIFT: u32 = WM_APP + 10;

unsafe extern "system" fn curtain_proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            unsafe {
                let dc = BeginPaint(h, &mut ps);
                let mut rc = RECT::default();
                let _ = GetClientRect(h, &mut rc);
                FillRect(dc, &rc, HBRUSH(GetStockObject(BLACK_BRUSH).0));
                SetBkMode(dc, TRANSPARENT);
                let dpi = GetDpiForWindow(h) as i32;
                let big = CreateFontW(-(28 * dpi / 96), 0, 0, 0, 600, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                    CLEARTYPE_QUALITY, 0, w!("Segoe UI"));
                let small = CreateFontW(-(15 * dpi / 96), 0, 0, 0, 400, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                    CLEARTYPE_QUALITY, 0, w!("Segoe UI"));
                let mid = (rc.top + rc.bottom) / 2;
                let old = SelectObject(dc, big.into());
                SetTextColor(dc, COLORREF(0x003D7AFF)); // ember, as 0x00BBGGRR
                let mut r1 = RECT { left: rc.left, top: mid - 40 * dpi / 96, right: rc.right, bottom: mid };
                let mut t1 = wide("Roost is in use");
                DrawTextW(dc, &mut t1, &mut r1, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
                SelectObject(dc, small.into());
                SetTextColor(dc, COLORREF(0x00B4B9BE));
                let mut r2 = RECT { left: rc.left, top: mid + 4 * dpi / 96, right: rc.right, bottom: mid + 36 * dpi / 96 };
                let mut t2 = wide("This PC is being used from another device. Press Esc three times to show the screen here.");
                DrawTextW(dc, &mut t2, &mut r2, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
                SelectObject(dc, old);
                let _ = DeleteObject(big.into());
                let _ = DeleteObject(small.into());
                let _ = EndPaint(h, &ps);
            }
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(h, msg, wp, lp) },
    }
}

/// Esc ×3 at the PC (the lift message arrives on the main window).
fn handle_lift() {
    curtain(false);
    info!("privacy curtain lifted at the PC");
    send(AppMsg::CurtainLifted);
}
