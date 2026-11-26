//! --synthetic: a moving test pattern and a test tone instead of the real screen and sound, the same on every
//! machine. Tests and CI use it (no desktop or sound card needed), and it works on any OS for development.
use super::yuv::I420;

/// The pretend display: 1920×1080 pixels, id 1.
pub const DISPLAY_ID: u32 = 1;
pub const DISPLAY_W: u32 = 1920;
pub const DISPLAY_H: u32 = 1080;
pub const DISPLAY_NAME: &str = "Roost Test Pattern";

/// Draws frame `index` of the pattern at `out`'s size: warm diagonal bands drifting right, a bright block sweeping
/// across (so motion is obvious), and a strip of 16 boxes that count frames in binary (so a test can tell frames
/// apart and see they advance).
pub fn draw(out: &mut I420, index: u64, region: Option<(f64, f64, f64, f64)>) {
    let (w, h) = (out.width, out.height);
    // With one window shown, the pattern behaves as if the window's part of the display were cropped out.
    let (rx, ry, rw, rh) = region.unwrap_or((0.0, 0.0, DISPLAY_W as f64, DISPLAY_H as f64));
    let sx = rw / w as f64;
    let sy = rh / h as f64;
    let shift = (index * 6) as f64;
    for y in 0..h {
        let gy = ry + y as f64 * sy;
        for x in 0..w {
            let gx = rx + x as f64 * sx;
            let band = (((gx + gy + shift) / 96.0) as i64 & 1) as u8;
            out.y[y * w + x] = 60 + band * 50 + ((gy / DISPLAY_H as f64) * 60.0) as u8;
        }
    }
    // The sweeping block.
    let bx = ((index * 12) % DISPLAY_W as u64) as f64;
    fill(out, (bx - rx) / sx, (400.0 - ry) / sy, 160.0 / sx, 160.0 / sy, 235);
    // The frame counter.
    for bit in 0..16 {
        let on = (index >> bit) & 1 == 1;
        fill(out, (40.0 + bit as f64 * 40.0 - rx) / sx, (40.0 - ry) / sy, 32.0 / sx, 32.0 / sy, if on { 235 } else { 16 });
    }
    // Warm chroma: orange-ish everywhere, so a decoded frame is visibly colourful.
    let cw = out.chroma_width();
    for cy in 0..h.div_ceil(2) {
        for cx in 0..cw {
            out.u[cy * cw + cx] = 100 + ((cx * 40 / cw.max(1)) as u8);
            out.v[cy * cw + cx] = 170 - ((cy * 30 / h.div_ceil(2).max(1)) as u8);
        }
    }
}

fn fill(out: &mut I420, x: f64, y: f64, w: f64, h: f64, luma: u8) {
    let (x0, y0) = (x.max(0.0) as usize, y.max(0.0) as usize);
    let (x1, y1) = (((x + w).max(0.0) as usize).min(out.width), ((y + h).max(0.0) as usize).min(out.height));
    for yy in y0..y1 { for xx in x0..x1 { out.y[yy * out.width + xx] = luma; } }
}

/// A 440 Hz tone with a gentle once-a-second pulse, as interleaved 48 kHz stereo floats.
pub struct Tone { phase: f64, sample: u64 }

impl Default for Tone { fn default() -> Self { Self { phase: 0.0, sample: 0 } } }

impl Tone {
    pub fn next(&mut self, frames: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(frames * 2);
        for _ in 0..frames {
            let pulse = if (self.sample / 24_000) % 2 == 0 { 0.25 } else { 0.12 };
            let v = (self.phase.sin() * pulse) as f32;
            out.push(v);
            out.push(v);
            self.phase += 2.0 * std::f64::consts::PI * 440.0 / 48_000.0;
            if self.phase > 2.0 * std::f64::consts::PI { self.phase -= 2.0 * std::f64::consts::PI; }
            self.sample += 1;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_differ_and_the_counter_counts() {
        let (mut a, mut b) = (I420::new(640, 360), I420::new(640, 360));
        draw(&mut a, 1, None);
        draw(&mut b, 2, None);
        assert_ne!(a.y, b.y);
        // Bit 0 box at (40,40) in a 1920-wide display, i.e. (13,13) at 640 wide: on for frame 1, off for frame 2.
        assert_eq!(a.y[13 * 640 + 14], 235);
        assert_eq!(b.y[13 * 640 + 14], 16);
    }

    #[test]
    fn tone_is_stereo_and_bounded() {
        let s = Tone::default().next(960);
        assert_eq!(s.len(), 1920);
        assert!(s.iter().all(|v| v.abs() <= 0.25));
        assert!(s.iter().any(|v| v.abs() > 0.2));
    }
}
