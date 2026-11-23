//! Plays the viewer's microphone on the PC: Opus packets from the host are decoded and handed to a sound output
//! (sys::AudioOut). Test runs decode but never play, and report what they got (`mic-level`) so tests can check it.
use crate::media::opus::MicDecoder;
use serde_json::{json, Value};
use std::time::Instant;

pub struct MicPlayer {
    dec: MicDecoder,
    out: Option<crate::sys::AudioOut>,
    on_fail: Box<dyn Fn(String) + Send>,
    on_level: Box<dyn Fn(Value) + Send>,
    failed: bool,
    packets: u64,
    frames: u64,
    sum_sq: f64,
    last_report: Instant,
}

impl MicPlayer {
    pub fn start(device: Option<&str>, dry_run: bool, on_fail: Box<dyn Fn(String) + Send>, on_level: Box<dyn Fn(Value) + Send>) -> Result<Self, String> {
        let out = if dry_run { None } else { Some(crate::sys::AudioOut::open(device)?) };
        Ok(Self { dec: MicDecoder::new()?, out, on_fail, on_level, failed: false, packets: 0, frames: 0, sum_sq: 0.0, last_report: Instant::now() })
    }

    pub fn push(&mut self, frame: &[u8]) {
        if self.failed { return; }
        let pcm = self.dec.decode(frame);
        if pcm.is_empty() { return; }
        self.packets += 1;
        self.frames += pcm.len() as u64 / 2;
        match self.out.as_mut() {
            Some(o) => if let Err(e) = o.push(&pcm) { self.failed = true; (self.on_fail)(e); },
            None => {
                self.sum_sq += pcm.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>();
                if self.last_report.elapsed().as_millis() >= 500 {
                    self.last_report = Instant::now();
                    let rms = (self.sum_sq / (self.frames.max(1) * 2) as f64).sqrt();
                    (self.on_level)(json!({"packets": self.packets, "frames": self.frames, "late": 0, "rms": (rms * 1000.0).round() / 1000.0}));
                }
            }
        }
    }
}
