//! The app's log: stderr, plus %ROOST_HOME%\roost-app.log (kept under 2 MB by starting afresh). The host's own
//! log lines arrive here too, prefixed "host".
use std::io::Write;
use std::sync::Mutex;

static FILE: Mutex<Option<std::fs::File>> = Mutex::new(None);

pub fn init(home: Option<&std::path::Path>) {
    let Some(home) = home else { return };
    let _ = std::fs::create_dir_all(home);
    let path = home.join("roost-app.log");
    if std::fs::metadata(&path).map(|m| m.len() > 2 << 20).unwrap_or(false) {
        let _ = std::fs::rename(&path, home.join("roost-app.old.log"));
    }
    if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        *FILE.lock().unwrap() = Some(f);
    }
}

pub fn write(level: &str, source: &str, msg: &str) {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let line = format!("{t} {level} [{source}] {msg}\n");
    let _ = std::io::stderr().write_all(line.as_bytes());
    if let Ok(mut f) = FILE.lock() {
        if let Some(f) = f.as_mut() { let _ = f.write_all(line.as_bytes()); }
    }
}

#[macro_export]
macro_rules! info { ($($a:tt)*) => { $crate::log::write("INFO", "app", &format!($($a)*)) } }
#[macro_export]
macro_rules! warn { ($($a:tt)*) => { $crate::log::write("WARN", "app", &format!($($a)*)) } }
#[macro_export]
macro_rules! error { ($($a:tt)*) => { $crate::log::write("ERROR", "app", &format!($($a)*)) } }
