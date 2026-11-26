//! One clock for video and audio timestamps (µs since roost.exe started), so they line up in the viewer.
use std::sync::OnceLock;
use std::time::Instant;

static START: OnceLock<Instant> = OnceLock::new();

pub fn now_us() -> u64 {
    START.get_or_init(Instant::now).elapsed().as_micros() as u64 + 1_000_000
}

/// Timestamps that only ever go forward (the protocol promises monotonic pts).
#[derive(Default)]
pub struct Monotonic { last: u64 }

impl Monotonic {
    pub fn next(&mut self, candidate: u64) -> u64 {
        self.last = (self.last + 1).max(candidate);
        self.last
    }
}
