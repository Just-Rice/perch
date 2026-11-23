//! The Node host process: started by the app, talked to over its stdin/stdout (docs/PROTOCOL.md, "IPC"), its stderr
//! copied into the log. One HostProcess is one run of the child; the app makes a new one to restart it.
use crate::ipc::{self, FrameParser};
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Writes frames to the host's stdin from any thread, in order, without ever blocking the caller. `pending` lets
/// the video path notice a backlog and drop frames instead of piling them up.
#[derive(Clone)]
pub struct Link {
    tx: mpsc::Sender<Vec<u8>>,
    pending: Arc<AtomicUsize>,
    closed: Arc<AtomicBool>,
}

impl Link {
    pub fn send(&self, kind: u8, payload: &[u8]) -> bool {
        if self.closed.load(Ordering::Relaxed) { return false; }
        let f = ipc::frame(kind, payload);
        self.pending.fetch_add(f.len(), Ordering::Relaxed);
        if self.tx.send(f).is_err() { self.closed.store(true, Ordering::Relaxed); return false; }
        true
    }
    pub fn pending(&self) -> usize { self.pending.load(Ordering::Relaxed) }
    pub fn close(&self) { self.closed.store(true, Ordering::Relaxed); let _ = self.tx.send(Vec::new()); }
}

pub enum HostEvent {
    Frame(u8, Vec<u8>),
    BadFrame(String),
    Exited { code: i32, ran: Duration },
}

pub struct HostProcess {
    pub link: Link,
    child: Arc<std::sync::Mutex<Child>>,
    pub pid: u32,
}

impl HostProcess {
    /// Starts `node script` with `env`; `on_event` is called on the reader threads.
    pub fn launch(node: &str, script: &str, env: Vec<(String, String)>, on_event: Arc<dyn Fn(HostEvent) + Send + Sync>) -> std::io::Result<Self> {
        let mut cmd = Command::new(node);
        cmd.arg(script).envs(env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(dir) = std::path::Path::new(script).parent() { cmd.current_dir(dir); }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // No console window for the helper.
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = cmd.spawn()?;
        let pid = child.id();
        #[cfg(windows)]
        crate::sys::bind_child_to_job(&child);
        let mut stdin = child.stdin.take().expect("stdin");
        let mut stdout = child.stdout.take().expect("stdout");
        let mut stderr = child.stderr.take().expect("stderr");
        let started = Instant::now();

        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let pending = Arc::new(AtomicUsize::new(0));
        let closed = Arc::new(AtomicBool::new(false));
        let link = Link { tx, pending: pending.clone(), closed: closed.clone() };
        std::thread::Builder::new().name("roost-ipc-write".into()).spawn(move || {
            for buf in rx {
                if buf.is_empty() || closed.load(Ordering::Relaxed) { break; }
                let n = buf.len();
                let ok = stdin.write_all(&buf).and_then(|_| stdin.flush()).is_ok();
                pending.fetch_sub(n, Ordering::Relaxed);
                // A broken pipe: the host is gone. Its exit is handled elsewhere; just stop writing.
                if !ok { closed.store(true, Ordering::Relaxed); break; }
            }
            // Dropping stdin closes it: the host sees the end of its input and quits.
        })?;

        let ev = on_event.clone();
        std::thread::Builder::new().name("roost-ipc-read".into()).spawn(move || {
            let mut parser = FrameParser::default();
            let mut buf = vec![0u8; 1 << 16];
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => match parser.push(&buf[..n]) {
                        Ok(frames) => for (k, p) in frames { ev(HostEvent::Frame(k, p)); },
                        Err(e) => { ev(HostEvent::BadFrame(e.to_string())); break; }
                    },
                }
            }
        })?;

        std::thread::Builder::new().name("roost-host-log".into()).spawn(move || {
            let mut pending: Vec<u8> = Vec::new();
            let mut buf = vec![0u8; 1 << 14];
            let emit = |line: &[u8]| {
                let text = String::from_utf8_lossy(line);
                let text = text.trim_end_matches('\r');
                if !text.is_empty() { crate::log::write("", "host", text); }
            };
            loop {
                match stderr.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        while let Some(nl) = pending.iter().position(|b| *b == b'\n') {
                            emit(&pending[..nl]);
                            pending.drain(..=nl);
                        }
                        // A runaway line without newlines still gets logged, in pieces.
                        if pending.len() > 16_384 { emit(&pending); pending.clear(); }
                    }
                }
            }
            emit(&pending);
        })?;

        let child = Arc::new(std::sync::Mutex::new(child));
        let watch = child.clone();
        std::thread::Builder::new().name("roost-host-wait".into()).spawn(move || {
            let code = loop {
                if let Ok(Some(status)) = watch.lock().unwrap().try_wait() { break status.code().unwrap_or(-1); }
                std::thread::sleep(Duration::from_millis(100));
            };
            info!("host exited with status {code} after {:.1} s", started.elapsed().as_secs_f64());
            on_event(HostEvent::Exited { code, ran: started.elapsed() });
        })?;
        Ok(Self { link, child, pid })
    }

    /// Ends the host the polite way: close its stdin (it exits by itself), wait up to `timeout`, then kill it.
    pub fn shutdown(&self, timeout: Duration) -> Option<i32> {
        self.link.close();
        let until = Instant::now() + timeout;
        while Instant::now() < until {
            if let Ok(Some(s)) = self.child.lock().unwrap().try_wait() { return s.code(); }
            std::thread::sleep(Duration::from_millis(50));
        }
        warn!("host did not exit within {} s of its input closing; stopping it", timeout.as_secs());
        let mut c = self.child.lock().unwrap();
        let _ = c.kill();
        c.wait().ok().and_then(|s| s.code())
    }

    /// Stops a misbehaving host at once (it will be restarted).
    pub fn terminate(&self) {
        self.link.close();
        let _ = self.child.lock().unwrap().kill();
    }
}
