//! roost.exe: Roost's Windows app. The tray icon and its panel, screen and sound capture, H.264 and Opus encoding,
//! the viewer's mouse and keyboard, and the Node host process it starts (docs/WINDOWS-APP.md).
#![cfg_attr(all(windows, not(test)), windows_subsystem = "windows")]
// Some helpers exist for tests and the other platform only.
#![allow(dead_code)]

#[macro_use]
mod log;
mod app;
mod capture;
mod clock;
mod host;
mod icon;
mod ipc;
mod jsonv;
mod keymap;
mod media;
mod mic;
mod options;
mod planner;
mod selftest;
mod sizing;
mod sys;
mod system;

use options::Options;

fn main() {
    let o = Options::parse(std::env::args().skip(1));
    if o.help {
        println!("{}", options::USAGE);
        return;
    }
    if let Some(cmd) = &o.secrets {
        let home = o.home.clone().unwrap_or_else(|| options::paths::home().display().to_string());
        std::process::exit(sys::secrets(cmd, &home));
    }
    if o.selftest { std::process::exit(selftest::run()); }
    log::init(Some(&options::paths::home()));
    std::process::exit(sys::run(o));
}
