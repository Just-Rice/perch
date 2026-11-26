//! Pictures: BGRA (what Windows captures) scaled with an area filter and converted to I420 (what H.264 encodes),
//! in BT.709 video range, which the encoder also writes into the stream's VUI so browsers show the right colours.
use openh264::formats::YUVSource;

/// An I420 picture with tightly packed planes.
#[derive(Clone)]
pub struct I420 {
    pub width: usize,
    pub height: usize,
    pub y: Vec<u8>,
    pub u: Vec<u8>,
    pub v: Vec<u8>,
}

impl I420 {
    pub fn new(width: usize, height: usize) -> Self {
        let (cw, ch) = (width.div_ceil(2), height.div_ceil(2));
        Self { width, height, y: vec![16; width * height], u: vec![128; cw * ch], v: vec![128; cw * ch] }
    }
    pub fn chroma_width(&self) -> usize { self.width.div_ceil(2) }
}

impl YUVSource for I420 {
    fn dimensions(&self) -> (usize, usize) { (self.width, self.height) }
    fn strides(&self) -> (usize, usize, usize) { (self.width, self.chroma_width(), self.chroma_width()) }
    fn y(&self) -> &[u8] { &self.y }
    fn u(&self) -> &[u8] { &self.u }
    fn v(&self) -> &[u8] { &self.v }
}

/// A borrowed BGRA picture (bytes B, G, R, A per pixel, rows `stride` bytes apart).
pub struct Bgra<'a> {
    pub width: usize,
    pub height: usize,
    pub stride: usize,
    pub data: &'a [u8],
}

/// For one output coordinate: the first source index and the weights (in 1/4096) of the source pixels it covers.
#[derive(Clone, Debug)]
struct Taps { start: usize, weights: Vec<u16> }

/// Area-filter taps for scaling `src` samples to `dst`: each output sample averages exactly the stretch of source it
/// covers, so small text stays as legible as the size allows instead of shimmering.
fn taps(src: usize, dst: usize) -> Vec<Taps> {
    let scale = src as f64 / dst as f64;
    (0..dst).map(|i| {
        if scale <= 1.0 {
            // Upscaling (rare: a picture smaller than asked never happens, but a display smaller than 2 px might):
            // nearest source pixel.
            let s = (((i as f64 + 0.5) * scale) as usize).min(src - 1);
            return Taps { start: s, weights: vec![4096] };
        }
        let (a, b) = (i as f64 * scale, (i as f64 + 1.0) * scale);
        let (first, last) = (a.floor() as usize, (b.ceil() as usize).min(src));
        let mut w: Vec<f64> = (first..last).map(|s| (b.min(s as f64 + 1.0) - a.max(s as f64)).max(0.0)).collect();
        let sum: f64 = w.iter().sum();
        w.iter_mut().for_each(|x| *x /= sum);
        let mut q: Vec<u16> = w.iter().map(|x| (x * 4096.0).round() as u16).collect();
        // Make the weights add up to exactly 4096 so flat colours stay flat.
        let total: i32 = q.iter().map(|x| *x as i32).sum();
        if let Some(m) = q.iter_mut().max() { *m = (*m as i32 + 4096 - total) as u16; }
        Taps { start: first, weights: q }
    }).collect()
}

/// Scales `src` to `dst_w × dst_h` BGR (3 bytes a pixel, no alpha), splitting the work across a few threads.
pub fn scale_bgra(src: &Bgra, dst_w: usize, dst_h: usize, out: &mut Vec<u8>) {
    out.resize(dst_w * dst_h * 3, 0);
    if src.width == dst_w && src.height == dst_h {
        for y in 0..dst_h {
            let row = &src.data[y * src.stride..y * src.stride + dst_w * 4];
            let o = &mut out[y * dst_w * 3..(y + 1) * dst_w * 3];
            for x in 0..dst_w { o[x * 3..x * 3 + 3].copy_from_slice(&row[x * 4..x * 4 + 3]); }
        }
        return;
    }
    let xt = taps(src.width, dst_w);
    let yt = taps(src.height, dst_h);
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).clamp(1, 6);
    let rows_each = dst_h.div_ceil(threads).max(1);
    std::thread::scope(|scope| {
        for (band, chunk) in out.chunks_mut(rows_each * dst_w * 3).enumerate() {
            let (xt, yt) = (&xt, &yt);
            scope.spawn(move || {
                let mut line = vec![0u32; dst_w * 3];
                for (r, orow) in chunk.chunks_mut(dst_w * 3).enumerate() {
                    let ty = &yt[band * rows_each + r];
                    line.iter_mut().for_each(|v| *v = 0);
                    for (k, wy) in ty.weights.iter().enumerate() {
                        let srow = &src.data[(ty.start + k) * src.stride..];
                        for (x, tx) in xt.iter().enumerate() {
                            let (mut b, mut g, mut rr) = (0u32, 0u32, 0u32);
                            for (j, wx) in tx.weights.iter().enumerate() {
                                let p = (tx.start + j) * 4;
                                let w = *wx as u32;
                                b += srow[p] as u32 * w;
                                g += srow[p + 1] as u32 * w;
                                rr += srow[p + 2] as u32 * w;
                            }
                            let wy = *wy as u32;
                            // Horizontal sums are ≤ 255·4096; keep 8 fractional bits before the vertical weight.
                            line[x * 3] += (b >> 4) * wy;
                            line[x * 3 + 1] += (g >> 4) * wy;
                            line[x * 3 + 2] += (rr >> 4) * wy;
                        }
                    }
                    for (o, v) in orow.iter_mut().zip(line.iter()) { *o = ((v + (1 << 19)) >> 20).min(255) as u8; }
                }
            });
        }
    });
}

/// BGR (3 bytes a pixel) → I420, BT.709 video range. Chroma is the average of each 2×2 block.
pub fn bgr_to_i420(bgr: &[u8], w: usize, h: usize, out: &mut I420) {
    if out.width != w || out.height != h { *out = I420::new(w, h); }
    // BT.709 in 8-bit video range, ×256 fixed point.
    const YR: i32 = 47; const YG: i32 = 157; const YB: i32 = 16;
    const UR: i32 = -26; const UG: i32 = -86; const UB: i32 = 112;
    const VR: i32 = 112; const VG: i32 = -102; const VB: i32 = -10;
    for y in 0..h {
        let row = &bgr[y * w * 3..(y + 1) * w * 3];
        let yo = &mut out.y[y * w..(y + 1) * w];
        for x in 0..w {
            let (b, g, r) = (row[x * 3] as i32, row[x * 3 + 1] as i32, row[x * 3 + 2] as i32);
            yo[x] = (((YR * r + YG * g + YB * b + 128) >> 8) + 16) as u8;
        }
    }
    let cw = out.chroma_width();
    for cy in 0..h.div_ceil(2) {
        for cx in 0..cw {
            let (mut r, mut g, mut b, mut n) = (0i32, 0i32, 0i32, 0i32);
            for dy in 0..2 {
                let yy = cy * 2 + dy;
                if yy >= h { continue; }
                for dx in 0..2 {
                    let xx = cx * 2 + dx;
                    if xx >= w { continue; }
                    let p = (yy * w + xx) * 3;
                    b += bgr[p] as i32; g += bgr[p + 1] as i32; r += bgr[p + 2] as i32; n += 1;
                }
            }
            let (r, g, b) = (r / n, g / n, b / n);
            out.u[cy * cw + cx] = (((UR * r + UG * g + UB * b + 128) >> 8) + 128).clamp(16, 240) as u8;
            out.v[cy * cw + cx] = (((VR * r + VG * g + VB * b + 128) >> 8) + 128).clamp(16, 240) as u8;
        }
    }
}

/// Converts a captured BGRA picture (already cropped to what is shown) into `out` at `w × h`.
pub struct Converter { bgr: Vec<u8> }

impl Default for Converter { fn default() -> Self { Self { bgr: Vec::new() } } }

impl Converter {
    pub fn convert(&mut self, src: &Bgra, w: usize, h: usize, out: &mut I420) {
        scale_bgra(src, w, h, &mut self.bgr);
        bgr_to_i420(&self.bgr, w, h, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: usize, h: usize, bgra: [u8; 4]) -> Vec<u8> { bgra.repeat(w * h) }

    #[test]
    fn taps_cover_the_source_exactly() {
        for (s, d) in [(3840, 1920), (2560, 1280), (1920, 1279), (5, 2), (7, 7)] {
            let t = taps(s, d);
            assert_eq!(t.len(), d);
            for x in &t { assert_eq!(x.weights.iter().map(|w| *w as u32).sum::<u32>(), 4096, "{s}->{d}"); }
            let last = t.last().unwrap();
            assert!(last.start + last.weights.len() <= s);
        }
    }

    #[test]
    fn flat_colours_stay_flat_through_scaling_and_conversion() {
        let data = solid(64, 48, [255, 255, 255, 255]);
        let src = Bgra { width: 64, height: 48, stride: 64 * 4, data: &data };
        let mut out = I420::new(2, 2);
        Converter::default().convert(&src, 30, 22, &mut out);
        assert!(out.y.iter().all(|v| *v == 235), "white is 235 in video range");
        assert!(out.u.iter().all(|v| *v == 128) && out.v.iter().all(|v| *v == 128));
        let data = solid(10, 10, [0, 0, 0, 255]);
        let src = Bgra { width: 10, height: 10, stride: 40, data: &data };
        Converter::default().convert(&src, 10, 10, &mut out);
        assert!(out.y.iter().all(|v| *v == 16));
    }

    #[test]
    fn a_red_picture_is_red() {
        let data = solid(8, 8, [0, 0, 255, 255]);
        let src = Bgra { width: 8, height: 8, stride: 32, data: &data };
        let mut out = I420::new(8, 8);
        Converter::default().convert(&src, 4, 4, &mut out);
        assert!((60..=66).contains(&out.y[0]), "BT.709 red luma is 63, got {}", out.y[0]);
        assert!(out.v[0] > 230, "strong red difference, got {}", out.v[0]);
    }
}
