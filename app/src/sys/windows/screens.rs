//! The PC's displays and windows: the list a viewer picks from, where a window is now (the picture follows it),
//! bringing a window to the front and reshaping it to fit the viewer's screen. All in physical pixels (roost.exe is
//! per-monitor DPI aware), matching what Desktop Duplication captures.
use crate::planner::Rect;
use crate::system::{DisplayInfo, WindowInfo};
use windows::core::{BOOL, PWSTR};
use windows::Win32::Devices::Display::*;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP, VK_MENU};
use windows::Win32::UI::WindowsAndMessaging::*;

/// A stable id for a display: FNV-1a of its device name (\\.\DISPLAY1), never 0.
pub fn display_id(device: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for b in device.bytes() { h ^= b as u32; h = h.wrapping_mul(0x01000193); }
    h.max(1)
}

fn wide_to_string(w: &[u16]) -> String {
    let end = w.iter().position(|c| *c == 0).unwrap_or(w.len());
    String::from_utf16_lossy(&w[..end])
}

fn rect(r: RECT) -> Rect { Rect::new(r.left as f64, r.top as f64, (r.right - r.left) as f64, (r.bottom - r.top) as f64) }

/// Friendly monitor names ("DELL U2720Q") by GDI device name, from the display configuration.
fn friendly_names() -> Vec<(String, String)> {
    let mut out = vec![];
    unsafe {
        let (mut np, mut nm) = (0u32, 0u32);
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut np, &mut nm).is_err() { return out; }
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); np as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); nm as usize];
        if QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &mut np, paths.as_mut_ptr(), &mut nm, modes.as_mut_ptr(), None).is_err() { return out; }
        for p in &paths[..np as usize] {
            let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME::default();
            target.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
            target.header.size = std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32;
            target.header.adapterId = p.targetInfo.adapterId;
            target.header.id = p.targetInfo.id;
            let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
            source.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
            source.header.size = std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
            source.header.adapterId = p.sourceInfo.adapterId;
            source.header.id = p.sourceInfo.id;
            if DisplayConfigGetDeviceInfo(&mut target.header) == 0 && DisplayConfigGetDeviceInfo(&mut source.header) == 0 {
                let name = wide_to_string(&target.monitorFriendlyDeviceName);
                if !name.is_empty() { out.push((wide_to_string(&source.viewGdiDeviceName), name)); }
            }
        }
    }
    out
}

/// One entry per monitor (mirrored monitors share one), in physical pixels of the virtual desktop.
pub fn displays() -> Vec<DisplayInfo> {
    struct Found { list: Vec<(HMONITOR, MONITORINFOEXW)> }
    unsafe extern "system" fn each(m: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        let found = unsafe { &mut *(data.0 as *mut Found) };
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if unsafe { GetMonitorInfoW(m, &mut info as *mut _ as *mut MONITORINFO) }.as_bool() { found.list.push((m, info)); }
        BOOL(1)
    }
    let mut found = Found { list: vec![] };
    unsafe { let _ = EnumDisplayMonitors(None, None, Some(each), LPARAM(&mut found as *mut _ as isize)); }
    let names = friendly_names();
    let mut out: Vec<DisplayInfo> = vec![];
    for (i, (_, info)) in found.list.iter().enumerate() {
        let device = wide_to_string(&info.szDevice);
        let r = rect(info.monitorInfo.rcMonitor);
        if out.iter().any(|d| d.rect == r) { continue; } // a mirror of one already listed
        let main = info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0;
        let name = names.iter().find(|(d, _)| *d == device).map(|(_, n)| n.clone())
            .unwrap_or_else(|| if main { "Main display".into() } else { format!("Display {}", i + 1) });
        out.push(DisplayInfo { id: display_id(&device), name, rect: r, main });
    }
    out
}

/// The GDI device name (\\.\DISPLAY2) of a display id, for matching it to a DXGI output.
pub fn device_name(id: u32) -> Option<(String, Rect)> {
    struct Found { id: u32, hit: Option<(String, Rect)> }
    unsafe extern "system" fn each(m: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        let f = unsafe { &mut *(data.0 as *mut Found) };
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if unsafe { GetMonitorInfoW(m, &mut info as *mut _ as *mut MONITORINFO) }.as_bool() {
            let dev = wide_to_string(&info.szDevice);
            if display_id(&dev) == f.id { f.hit = Some((dev, rect(info.monitorInfo.rcMonitor))); return BOOL(0); }
        }
        BOOL(1)
    }
    let mut f = Found { id, hit: None };
    unsafe { let _ = EnumDisplayMonitors(None, None, Some(each), LPARAM(&mut f as *mut _ as isize)); }
    f.hit
}

/// Where a display's taskbar isn't: windows are reshaped to fit here.
pub fn work_area_at(p: (f64, f64)) -> Option<Rect> {
    unsafe {
        let m = MonitorFromPoint(POINT { x: p.0 as i32, y: p.1 as i32 }, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        GetMonitorInfoW(m, &mut info).as_bool().then(|| rect(info.rcWork))
    }
}

// ---- windows ---------------------------------------------------------------------------------------------------

/// Smaller than this (either side, in pixels) isn't a window anyone wants to look at.
const MIN_SIDE: f64 = 120.0;
const MAX_LISTED: usize = 40;

fn hwnd(id: u32) -> HWND { HWND(id as usize as *mut _) }

fn window_rect(h: HWND) -> Option<Rect> {
    unsafe {
        let mut r = RECT::default();
        // The visible frame, without the invisible resize borders GetWindowRect includes on Windows 10 and 11.
        if DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut _ as *mut _, std::mem::size_of::<RECT>() as u32).is_err()
            && GetWindowRect(h, &mut r).is_err() { return None; }
        Some(rect(r))
    }
}

fn is_cloaked(h: HWND) -> bool {
    let mut cloaked: u32 = 0;
    unsafe { DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, 4).is_ok() && cloaked != 0 }
}

fn app_name(pid: u32) -> String {
    unsafe {
        let Ok(p) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(p, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(p);
        if !ok { return String::new(); }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let file = path.rsplit(['\\', '/']).next().unwrap_or(&path);
        file.strip_suffix(".exe").or_else(|| file.strip_suffix(".EXE")).unwrap_or(file).to_string()
    }
}

/// Is this an ordinary top-level window someone would want to look at? Then its info.
fn describe(h: HWND, me: u32) -> Option<WindowInfo> {
    unsafe {
        if !IsWindowVisible(h).as_bool() || IsIconic(h).as_bool() || is_cloaked(h) { return None; }
        let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW.0 != 0 && ex & WS_EX_APPWINDOW.0 == 0 { return None; }
        if GetWindow(h, GW_OWNER).is_ok_and(|o| !o.is_invalid()) && ex & WS_EX_APPWINDOW.0 == 0 { return None; }
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, Some(&mut pid));
        if pid == me { return None; }
        let mut title = [0u16; 512];
        let n = GetWindowTextW(h, &mut title);
        if n <= 0 { return None; }
        let r = window_rect(h)?;
        if r.w < MIN_SIDE || r.h < MIN_SIDE { return None; }
        let title: String = String::from_utf16_lossy(&title[..n as usize]).chars().take(160).collect();
        let app: String = app_name(pid).chars().take(80).collect();
        Some(WindowInfo { id: h.0 as usize as u32, app, title, rect: r })
    }
}

/// Ordinary windows on screen, front to back, without Roost's own.
pub fn windows() -> Vec<WindowInfo> {
    struct Found { me: u32, list: Vec<WindowInfo> }
    unsafe extern "system" fn each(h: HWND, data: LPARAM) -> BOOL {
        let f = unsafe { &mut *(data.0 as *mut Found) };
        if let Some(w) = describe(h, f.me) { f.list.push(w); }
        BOOL((f.list.len() < MAX_LISTED) as i32)
    }
    let mut f = Found { me: unsafe { GetCurrentProcessId() }, list: vec![] };
    unsafe { let _ = EnumWindows(Some(each), LPARAM(&mut f as *mut _ as isize)); }
    f.list
}

/// Where this window is now, or None once it is closed, minimised or on another virtual desktop.
pub fn find_window(id: u32) -> Option<WindowInfo> {
    let h = hwnd(id);
    unsafe { if !IsWindow(Some(h)).as_bool() { return None; } }
    describe(h, unsafe { GetCurrentProcessId() })
}

/// Brings a window to the front. Windows only lets the foreground app do that, so first "press" Alt (which counts
/// as input to us), the standard way around the rule for apps acting on the user's behalf.
pub fn raise_window(id: u32) -> bool {
    let h = hwnd(id);
    unsafe {
        if !IsWindow(Some(h)).as_bool() { return false; }
        if IsIconic(h).as_bool() { let _ = ShowWindow(h, SW_RESTORE); }
        keybd_event(VK_MENU.0 as u8, 0, Default::default(), 0);
        keybd_event(VK_MENU.0 as u8, 0, KEYEVENTF_KEYUP, 0);
        SetForegroundWindow(h).as_bool()
    }
}

/// Reshapes a window to `aspect` (w/h), as large as its display's work area allows.
pub fn fit_window(id: u32, aspect: f64) -> Result<(), String> {
    let h = hwnd(id);
    let w = find_window(id).ok_or("That window is no longer on screen.")?;
    let area = work_area_at(w.rect.mid()).ok_or("no display")?;
    let target = crate::system::fit_rect(w.rect, aspect, area);
    unsafe {
        if IsZoomed(h).as_bool() { let _ = ShowWindow(h, SW_RESTORE); }
        // The frame bounds exclude the invisible borders; SetWindowPos includes them, so add the difference.
        let mut outer = RECT::default();
        let _ = GetWindowRect(h, &mut outer);
        let (dl, dt) = (w.rect.x - outer.left as f64, w.rect.y - outer.top as f64);
        let (dr, db) = (outer.right as f64 - (w.rect.x + w.rect.w), outer.bottom as f64 - (w.rect.y + w.rect.h));
        SetWindowPos(h, None, (target.x - dl) as i32, (target.y - dt) as i32, (target.w + dl + dr) as i32, (target.h + dt + db) as i32,
            SWP_NOZORDER | SWP_NOACTIVATE).map_err(|e| e.to_string())
    }
}
