//! Windows: everything roost.exe does on the PC itself (docs/WINDOWS-APP.md).
mod audio;
mod brightness;
mod capture;
mod clipboard;
mod input;
mod screens;
mod uia;
mod ui;

pub use audio::AudioOut;
pub use ui::{run, Pc};

use crate::options::paths;
use crate::planner::Planned;
use crate::sizing::AudioLevels;
use crate::system::{AudioCapture, AudioSink, DisplayInfo, VideoSource, WindowInfo};
use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::sync::OnceLock;
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::JobObjects::*;
use windows::Win32::System::Registry::*;
use windows::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken, WaitForSingleObject, INFINITE};
use windows::Win32::UI::Shell::{ShellExecuteExW, ShellExecuteW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNORMAL};

const NO_WINDOW: u32 = 0x0800_0000;
const RUN_KEY: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
const TASK: &str = "\\Roost\\Roost";

// ---- what this PC is -------------------------------------------------------------------------------------------

fn reg_string(root: HKEY, key: &str, value: &str) -> Option<String> {
    unsafe {
        let (k, v) = (HSTRING::from(key), HSTRING::from(value));
        let mut size = 0u32;
        if RegGetValueW(root, &k, &v, RRF_RT_REG_SZ, None, None, Some(&mut size)).is_err() { return None; }
        let mut buf = vec![0u16; size as usize / 2 + 1];
        if RegGetValueW(root, &k, &v, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut size)).is_err() { return None; }
        let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }
}

fn reg_dword(root: HKEY, key: &str, value: &str) -> Option<u32> {
    unsafe {
        let mut d = 0u32;
        let mut size = 4u32;
        RegGetValueW(root, &HSTRING::from(key), &HSTRING::from(value), RRF_RT_REG_DWORD, None, Some((&mut d as *mut u32).cast()), Some(&mut size)).ok().ok()?;
        Some(d)
    }
}

const NT: &str = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";

pub fn build_number() -> u32 {
    static B: OnceLock<u32> = OnceLock::new();
    *B.get_or_init(|| reg_string(HKEY_LOCAL_MACHINE, NT, "CurrentBuildNumber").and_then(|s| s.parse().ok()).unwrap_or(0))
}

pub fn os_info() -> Value {
    let ubr = reg_dword(HKEY_LOCAL_MACHINE, NT, "UBR").unwrap_or(0);
    let arch = match std::env::consts::ARCH { "x86_64" => "x64", "aarch64" => "arm64", a => a };
    json!({"os": "windows", "osVersion": format!("10.0.{}.{}", build_number(), ubr), "arch": arch,
           "edition": reg_string(HKEY_LOCAL_MACHINE, NT, "ProductName").unwrap_or_default()})
}

pub fn sound_tap_available() -> bool { audio::process_loopback_available() }
/// WDA_EXCLUDEFROMCAPTURE is in Windows 10 version 2004 and later.
pub fn curtain_supported() -> bool { build_number() >= 19041 }

pub fn is_elevated() -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() { return false; }
        let mut e = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(token, TokenElevation, Some((&mut e as *mut TOKEN_ELEVATION).cast()), 4, &mut len).is_ok();
        let _ = CloseHandle(token);
        ok && e.TokenIsElevated != 0
    }
}

fn schtasks(args: &[&str]) -> bool {
    std::process::Command::new("schtasks.exe").args(args).creation_flags(NO_WINDOW)
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success())
}

pub fn elevated_task_exists() -> bool { schtasks(&["/Query", "/TN", TASK]) }

// ---- the rest of the PC ----------------------------------------------------------------------------------------

pub fn displays() -> Vec<DisplayInfo> { screens::displays() }
pub fn windows() -> Vec<WindowInfo> { screens::windows() }
pub fn find_window(id: u32) -> Option<WindowInfo> { screens::find_window(id) }
pub fn raise_window(id: u32) -> bool { screens::raise_window(id) }
pub fn fit_window(id: u32, aspect: f64) -> Result<(), String> { screens::fit_window(id, aspect) }
pub fn video_source(d: &DisplayInfo) -> Result<Box<dyn VideoSource>, String> { capture::source(d) }
pub fn audio_capture(sink: AudioSink, levels: AudioLevels) -> Result<Box<dyn AudioCapture>, String> { audio::capture(sink, levels) }
pub fn audio_outputs() -> Vec<(String, String, bool)> { audio::outputs() }
pub fn audio_outputs_changed() -> bool { audio::outputs_changed() }
pub fn post_input(plan: &[Planned]) { input::post(plan) }
pub fn text_focus() -> Option<(bool, bool)> { uia::text_focus() }
pub fn clipboard_text() -> String { clipboard::text() }
pub fn clipboard_png() -> Option<Vec<u8>> { clipboard::png() }
pub fn set_clipboard(text: Option<&str>, image: Option<&[u8]>) -> bool { clipboard::set(text, image) }
pub fn clipboard_sequence() -> u32 { clipboard::sequence() }
pub fn clipboard_is_private() -> bool { clipboard::is_private() }

pub fn lock_screen() -> bool { unsafe { windows::Win32::System::Shutdown::LockWorkStation().is_ok() } }

/// Locked (or at a UAC prompt): the input desktop isn't ours to open.
pub fn is_locked() -> bool {
    unsafe {
        match OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_ACCESS_FLAGS(0x0100)) {
            Ok(d) => { let _ = CloseDesktop(d); false }
            Err(_) => true,
        }
    }
}

pub fn open_url(url: &str) {
    unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(url), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL); }
}

// ---- start with Windows ----------------------------------------------------------------------------------------

fn run_key_value() -> Option<String> { reg_string(HKEY_CURRENT_USER, "Software\\Microsoft\\Windows\\CurrentVersion\\Run", "Roost") }

pub fn login_item_state() -> Value {
    if elevated_task_exists() { return json!({"on": true, "status": "task"}); }
    let on = run_key_value().is_some();
    json!({"on": on, "status": if on { "enabled" } else { "disabled" }})
}

fn set_run_key(on: bool) -> Result<(), String> {
    unsafe {
        let mut key = HKEY::default();
        RegCreateKeyExW(HKEY_CURRENT_USER, RUN_KEY, None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, None, &mut key, None)
            .ok().map_err(|e| e.to_string())?;
        let r = if on {
            let cmd = format!("\"{}\" --startup", paths::exe().display());
            let data: Vec<u8> = cmd.encode_utf16().chain([0]).flat_map(|u| u.to_le_bytes()).collect();
            RegSetValueExW(key, w!("Roost"), None, REG_SZ, Some(&data)).ok()
        } else {
            let r = RegDeleteValueW(key, w!("Roost"));
            if r == windows::Win32::Foundation::ERROR_FILE_NOT_FOUND { Ok(()) } else { r.ok() }
        };
        let _ = RegCloseKey(key);
        r.map_err(|e| e.to_string())
    }
}

pub fn set_login_item(on: bool) -> Value {
    // With "Control admin apps" on, the scheduled task starts Roost; the Run key stays out of the way.
    if elevated_task_exists() { return json!({"on": true, "status": "task"}); }
    match set_run_key(on) {
        Ok(()) => login_item_state(),
        Err(e) => { let mut s = login_item_state(); s["error"] = json!(e); s }
    }
}

// ---- "Control admin apps": the highest-privileges scheduled task -----------------------------------------------

/// Runs a program as administrator (Windows shows its UAC prompt) and waits for it. False if refused or failed.
fn run_elevated(file: &str, args: &str) -> bool {
    unsafe {
        let (f, a) = (HSTRING::from(file), HSTRING::from(args));
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32, fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: w!("runas"), lpFile: PCWSTR(f.as_ptr()), lpParameters: PCWSTR(a.as_ptr()), nShow: SW_HIDE.0, ..Default::default()
        };
        if ShellExecuteExW(&mut info).is_err() { return false; }
        if info.hProcess.is_invalid() { return true; }
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code = 1u32;
        let _ = windows::Win32::System::Threading::GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
        code == 0
    }
}

fn task_xml() -> String {
    let user = format!("{}\\{}", std::env::var("USERDOMAIN").unwrap_or_default(), std::env::var("USERNAME").unwrap_or_default());
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Starts Roost when you sign in, able to control apps that run as administrator.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>{exe}</Command><Arguments>--startup</Arguments></Exec></Actions>
</Task>"#, user = esc(&user), exe = esc(&paths::exe().display().to_string()))
}

/// Switches "Control admin apps" on or off. `relaunch: true` means Roost should quit: the task (or Explorer) has
/// started the new copy, which waits for this one to go.
pub fn set_elevation(on: bool) -> Value {
    let state = |ok: bool, err: Option<&str>, relaunch: bool| {
        let mut v = json!({"ok": ok, "elevated": is_elevated(), "task": elevated_task_exists(), "relaunch": relaunch});
        if let Some(e) = err { v["error"] = json!(e); }
        v
    };
    if on {
        let file = std::env::temp_dir().join("roost-task.xml");
        let utf16: Vec<u8> = [0xFF, 0xFE].into_iter().chain(task_xml().encode_utf16().flat_map(|u| u.to_le_bytes())).collect();
        if std::fs::write(&file, utf16).is_err() { return state(false, Some("Couldn't write the task file."), false); }
        let ok = run_elevated("schtasks.exe", &format!("/Create /TN \"{TASK}\" /XML \"{}\" /F", file.display()));
        let _ = std::fs::remove_file(&file);
        if !ok { return state(false, Some("Windows didn't allow it (the administrator prompt was declined)."), false); }
        let _ = set_run_key(false);
        if is_elevated() { return state(true, None, false); }
        // Start the elevated copy through the task (no prompt: the task already has the rights).
        let started = relaunch_via(|| schtasks(&["/Run", "/TN", TASK]));
        state(started, (!started).then_some("The task was made but didn't start; it will next time you sign in."), started)
    } else {
        if elevated_task_exists() {
            let removed = schtasks(&["/Delete", "/TN", TASK, "/F"]) || run_elevated("schtasks.exe", &format!("/Delete /TN \"{TASK}\" /F"));
            if !removed { return state(false, Some("Windows didn't allow removing the task."), false); }
        }
        let _ = set_run_key(true);
        if !is_elevated() { return state(true, None, false); }
        // Explorer starts programs without administrator rights: the usual way to drop them.
        let exe = paths::exe().display().to_string();
        let started = relaunch_via(|| std::process::Command::new("explorer.exe").arg(&exe).spawn().is_ok());
        state(started, None, started)
    }
}

/// Starts the new copy with `start`, telling it (through an environment variable picked up from the parent's
/// environment where possible, and in any case through its single-instance wait) to wait for this one to quit.
fn relaunch_via(start: impl FnOnce() -> bool) -> bool { ui::mark_relaunch(); start() }

pub fn relaunch_after_exit() -> Result<(), String> {
    ui::mark_relaunch();
    let pid = std::process::id();
    let exe = paths::exe().display().to_string().replace('\'', "''");
    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &format!("Wait-Process -Id {pid} -Timeout 30 -ErrorAction SilentlyContinue; Start-Process -FilePath '{exe}'")])
        .creation_flags(NO_WINDOW).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Removes Roost from this PC once roost.exe has quit: the uninstall script next to it, if there is one.
pub fn uninstall() {
    let _ = set_run_key(false);
    let _ = schtasks(&["/Delete", "/TN", TASK, "/F"]);
    let dir = paths::install_dir();
    let script = dir.join("uninstall.ps1");
    let pid = std::process::id();
    let cmd = if script.is_file() {
        format!("Wait-Process -Id {pid} -Timeout 30 -ErrorAction SilentlyContinue; & '{}' -FromApp", script.display().to_string().replace('\'', "''"))
    } else {
        format!("Wait-Process -Id {pid} -Timeout 30 -ErrorAction SilentlyContinue; Remove-Item -Recurse -Force -LiteralPath '{}'", dir.display().to_string().replace('\'', "''"))
    };
    let _ = std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &cmd])
        .creation_flags(NO_WINDOW).spawn();
}

// ---- the host's helpers ----------------------------------------------------------------------------------------

/// The host dies with roost.exe, even if roost.exe crashes: it runs in a job that closes with us.
pub fn bind_child_to_job(child: &std::process::Child) {
    use std::os::windows::io::AsRawHandle;
    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let Ok(job) = CreateJobObjectW(None, PCWSTR::null()) else { return 0 };
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        // Only the host itself is tied to us: whatever it starts (the updater's PowerShell, which replaces roost.exe)
        // leaves the job by itself and outlives us.
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
        let _ = SetInformationJobObject(job, JobObjectExtendedLimitInformation, (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
        job.0 as usize
    });
    if job != 0 { unsafe { let _ = AssignProcessToJobObject(HANDLE(job as *mut _), HANDLE(child.as_raw_handle())); } }
}

const ENTROPY: &[u8] = b"roost secrets v1";

/// `roost --secrets read|write --home <dir>` (docs/WINDOWS-APP.md): exit 0 ok, 3 no file yet, 1 anything else.
pub fn secrets(cmd: &str, home: &str) -> i32 {
    use std::io::{Read, Write};
    let path = std::path::Path::new(home).join("secrets.dpapi");
    let blob = |b: &[u8]| CRYPT_INTEGER_BLOB { cbData: b.len() as u32, pbData: b.as_ptr() as *mut u8 };
    match cmd {
        "read" => {
            let Ok(data) = std::fs::read(&path) else { return 3 };
            let mut out = CRYPT_INTEGER_BLOB::default();
            let ent = blob(ENTROPY);
            unsafe {
                if CryptUnprotectData(&blob(&data), None, Some(&ent), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out).is_err() {
                    eprintln!("could not decrypt {} (made by another Windows user?)", path.display());
                    return 1;
                }
                let plain = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
                let _ = LocalFree(Some(HLOCAL(out.pbData.cast())));
                if std::io::stdout().write_all(&plain).is_err() { return 1; }
            }
            0
        }
        "write" => {
            let mut plain = Vec::new();
            if std::io::stdin().read_to_end(&mut plain).is_err() || serde_json::from_slice::<Value>(&plain).is_err() {
                eprintln!("expected the secrets as JSON on stdin");
                return 1;
            }
            let mut out = CRYPT_INTEGER_BLOB::default();
            let ent = blob(ENTROPY);
            let sealed = unsafe {
                if CryptProtectData(&blob(&plain), w!("Roost"), Some(&ent), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out).is_err() {
                    eprintln!("DPAPI refused to encrypt");
                    return 1;
                }
                let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
                let _ = LocalFree(Some(HLOCAL(out.pbData.cast())));
                v
            };
            let _ = std::fs::create_dir_all(home);
            let tmp = path.with_extension("tmp");
            if std::fs::write(&tmp, sealed).is_err() || std::fs::rename(&tmp, &path).is_err() {
                eprintln!("could not write {}", path.display());
                return 1;
            }
            0
        }
        _ => { eprintln!("--secrets read|write"); 1 }
    }
}

pub fn selftest() -> Vec<(String, Result<String, String>)> {
    let mut out = vec![];
    let ds = displays();
    out.push(("displays".into(), if ds.is_empty() { Err("none found".into()) } else {
        Ok(ds.iter().map(|d| format!("{} {}x{}{}", d.name, d.rect.w, d.rect.h, if d.main { " main" } else { "" })).collect::<Vec<_>>().join(", "))
    }));
    if let Some(main) = ds.iter().find(|d| d.main) {
        out.push(("screen capture".into(), (|| {
            let mut s = video_source(main)?;
            let name = s.name();
            s.configure(None, 640, 360);
            let mut pic = crate::media::yuv::I420::new(640, 360);
            // The first picture comes at once on a fresh duplication; GDI always has one.
            for _ in 0..20 {
                match s.next(&mut pic, std::time::Duration::from_millis(100)) {
                    Ok(true) => return Ok(name),
                    Ok(false) => continue,
                    Err(e) => return Err(format!("{e:?}")),
                }
            }
            Err(format!("{name}: no picture in 2 s"))
        })()));
    }
    out.push(("sound outputs".into(), Ok(audio_outputs().into_iter().map(|o| o.1).collect::<Vec<_>>().join(", "))));
    out.push(("process loopback (sound without echo, speaker level)".into(), Ok(if sound_tap_available() { "yes".into() } else { "no (older Windows)".into() })));
    out.push(("privacy curtain".into(), Ok(if curtain_supported() { "available".into() } else { "needs Windows 10 2004+".into() })));
    out.push(("administrator".into(), Ok(format!("elevated {}, task {}", is_elevated(), elevated_task_exists()))));
    out
}
