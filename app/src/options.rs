//! Command-line flags. Normal launches (Start menu, sign-in) pass none or --startup; the rest are for development,
//! tests and the installer (docs/PROTOCOL.md "Test mode", docs/WINDOWS-APP.md).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Default, Debug, Clone)]
pub struct Options {
    /// A moving test pattern and a test tone instead of the real screen and sound.
    pub synthetic: bool,
    /// Report input back to the host instead of performing it.
    pub echo_input: bool,
    /// No tray icon (and no notifications).
    pub no_ui: bool,
    pub node: Option<String>,
    pub host: Option<String>,
    /// When the app quits, exit with the host's exit status (so a test host's verdict reaches the shell).
    pub exit_with_host: bool,
    /// Let a test or development run really change start-with-Windows, the clipboard, windows and the curtain.
    pub allow_system_changes: bool,
    /// Started by Windows at sign-in (the Run key): don't open the Control Center on first run.
    pub startup: bool,
    pub selftest: bool,
    /// `--secrets read|write --home <dir>`: the host's DPAPI helper.
    pub secrets: Option<String>,
    pub home: Option<String>,
    /// Used by the uninstaller: stop starting with Windows and exit.
    pub unregister_startup: bool,
    /// Show the curtain for two seconds to check it is left out of the picture, then exit.
    pub curtain_check: bool,
    pub help: bool,
    pub ignored: Vec<String>,
}

pub const USAGE: &str = "usage: roost [--synthetic] [--echo-input] [--no-ui] [--node <path>] [--host <path>]
             [--exit-with-host] [--allow-system-changes] [--selftest] [--startup]

  --synthetic             test pattern and tone instead of the real screen and sound
  --echo-input            report input to the host instead of performing it
  --no-ui                 no tray icon, no notifications (tests, CI)
  --node <path>           Node.js to run the host with (else %ROOST_NODE%, the bundled one, node on PATH)
  --host <path>           host script (else <install dir>\\host\\roost-host.mjs)
  --exit-with-host        on quit, exit with the host process's exit status
  --allow-system-changes  let a test run change start-with-Windows, the clipboard and windows
  --selftest              run the built-in checks and exit
  --startup               started at sign-in
  --secrets read|write --home <dir>
                          read or write the host's DPAPI-protected secrets (stdout / stdin)
  --unregister-startup    stop Roost starting with Windows and exit (used by the uninstaller)
  --curtain-check         show the privacy curtain briefly and check it is left out of the picture";

impl Options {
    pub fn parse(args: impl IntoIterator<Item = String>) -> Self {
        let mut o = Options::default();
        let mut it = args.into_iter();
        while let Some(a) = it.next() {
            match a.as_str() {
                "--synthetic" => o.synthetic = true,
                "--echo-input" => o.echo_input = true,
                "--no-ui" => o.no_ui = true,
                "--node" => o.node = it.next(),
                "--host" => o.host = it.next(),
                "--exit-with-host" => o.exit_with_host = true,
                "--allow-system-changes" => o.allow_system_changes = true,
                "--startup" => o.startup = true,
                "--selftest" => o.selftest = true,
                "--secrets" => o.secrets = it.next(),
                "--home" => o.home = it.next(),
                "--unregister-startup" => o.unregister_startup = true,
                "--curtain-check" => o.curtain_check = true,
                "-h" | "--help" | "/?" => o.help = true,
                _ => o.ignored.push(a),
            }
        }
        o
    }
}

/// Where things are: next to roost.exe when installed, or given by flags and environment during development.
pub mod paths {
    use std::path::{Path, PathBuf};

    pub fn exe() -> PathBuf { std::env::current_exe().unwrap_or_else(|_| PathBuf::from("roost.exe")) }
    pub fn install_dir() -> PathBuf { exe().parent().map(Path::to_path_buf).unwrap_or_default() }

    /// %ROOST_HOME%, else %LOCALAPPDATA%\Roost (or ~/.roost elsewhere).
    pub fn home() -> PathBuf {
        if let Ok(h) = std::env::var("ROOST_HOME") { if !h.is_empty() { return h.into(); } }
        if let Ok(l) = std::env::var("LOCALAPPDATA") { return Path::new(&l).join("Roost"); }
        std::env::var("HOME").map(|h| Path::new(&h).join(".roost")).unwrap_or_else(|_| ".roost".into())
    }

    fn executable(p: &Path) -> bool { p.is_file() }

    pub fn node(explicit: Option<&str>) -> Option<PathBuf> {
        // An explicit choice that doesn't exist is a mistake worth reporting, not something to quietly replace.
        if let Some(p) = explicit.map(PathBuf::from).or_else(|| std::env::var("ROOST_NODE").ok().filter(|s| !s.is_empty()).map(PathBuf::from)) {
            return executable(&p).then_some(p);
        }
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        let bundled = install_dir().join("node").join(name);
        if executable(&bundled) { return Some(bundled); }
        std::env::var_os("PATH").and_then(|path| std::env::split_paths(&path).map(|d| d.join(name)).find(|p| executable(p)))
    }

    pub fn host_script(explicit: Option<&str>) -> Option<PathBuf> {
        let p = explicit.map(PathBuf::from).unwrap_or_else(|| install_dir().join("host").join("roost-host.mjs"));
        let p = std::path::absolute(&p).unwrap_or(p);
        p.is_file().then_some(p)
    }
}
