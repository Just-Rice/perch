//! Roost's icon, drawn in code (the same drawing as site/img/icon.svg, on its 64-unit grid) at whatever size the
//! tray, the notification or the .exe needs: crisp at every DPI with no image files to keep in step.

#[derive(Clone, Copy, PartialEq)]
pub enum Variant {
    Normal,
    /// Someone is connected: a green dot in the corner.
    Connected,
    /// Paused, or the helper isn't running: grey.
    Dimmed,
}

/// RGBA pixels, `size × size`, not premultiplied.
pub fn render(size: usize, variant: Variant) -> Vec<u8> {
    const SS: usize = 4; // 4×4 samples a pixel
    let mut out = vec![0u8; size * size * 4];
    let scale = 64.0 / size as f64;
    for py in 0..size {
        for px in 0..size {
            let mut acc = [0f64; 4]; // premultiplied
            for sy in 0..SS {
                for sx in 0..SS {
                    let x = (px as f64 + (sx as f64 + 0.5) / SS as f64) * scale;
                    let y = (py as f64 + (sy as f64 + 0.5) / SS as f64) * scale;
                    let c = sample(x, y, variant);
                    for i in 0..4 { acc[i] += c[i]; }
                }
            }
            let n = (SS * SS) as f64;
            let a = acc[3] / n;
            let o = (py * size + px) * 4;
            if a > 0.0 {
                for i in 0..3 { out[o + i] = ((acc[i] / n / a) * 255.0).round().clamp(0.0, 255.0) as u8; }
            }
            out[o + 3] = (a * 255.0).round() as u8;
        }
    }
    out
}

fn mix(under: [f64; 4], color: [f64; 3], alpha: f64) -> [f64; 4] {
    // `under` is premultiplied; paint `color` with coverage `alpha` over it.
    [color[0] * alpha + under[0] * (1.0 - alpha), color[1] * alpha + under[1] * (1.0 - alpha),
     color[2] * alpha + under[2] * (1.0 - alpha), alpha + under[3] * (1.0 - alpha)]
}

fn in_round_rect(x: f64, y: f64, x0: f64, y0: f64, x1: f64, y1: f64, r: f64) -> bool {
    let cx = x.clamp(x0 + r, x1 - r);
    let cy = y.clamp(y0 + r, y1 - r);
    (x - cx).powi(2) + (y - cy).powi(2) <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1
}

fn in_ellipse(x: f64, y: f64, cx: f64, cy: f64, rx: f64, ry: f64) -> bool { ((x - cx) / rx).powi(2) + ((y - cy) / ry).powi(2) <= 1.0 }

fn in_triangle(x: f64, y: f64, a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> bool {
    let s = |p: (f64, f64), q: (f64, f64)| (x - q.0) * (p.1 - q.1) - (p.0 - q.0) * (y - q.1);
    let (d1, d2, d3) = (s(a, b), s(b, c), s(c, a));
    !((d1 < 0.0 || d2 < 0.0 || d3 < 0.0) && (d1 > 0.0 || d2 > 0.0 || d3 > 0.0))
}

/// Distance from (x, y) to the segment a–b.
fn seg_dist(x: f64, y: f64, a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let t = (((x - a.0) * dx + (y - a.1) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
    ((x - a.0 - t * dx).powi(2) + (y - a.1 - t * dy).powi(2)).sqrt()
}

fn grey(c: [f64; 3]) -> [f64; 3] { let l = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]; [l, l, l] }

fn sample(x: f64, y: f64, v: Variant) -> [f64; 4] {
    let mut p = [0.0; 4];
    let tone = |c: [f64; 3]| if v == Variant::Dimmed { grey(c) } else { c };
    if in_round_rect(x, y, 2.0, 2.0, 62.0, 62.0, 16.0) {
        // Ember: #FF6A2E at the top left to #FFC15E at the bottom right.
        let t = ((x + y) / 128.0).clamp(0.0, 1.0);
        let c = [1.0, (0x6A as f64 + t * (0xC1 - 0x6A) as f64) / 255.0, (0x2E as f64 + t * (0x5E - 0x2E) as f64) / 255.0];
        p = mix(p, tone(c), 1.0);
    }
    let white = [1.0, 1.0, 1.0];
    let dark = tone([0x2A as f64 / 255.0, 0x14 as f64 / 255.0, 0x08 as f64 / 255.0]);
    // The branch, then the bird on it.
    if seg_dist(x, y, (10.0, 46.5), (54.0, 46.5)) <= 1.6 { p = mix(p, dark, 1.0); }
    if seg_dist(x, y, (28.0, 41.0), (28.0, 46.5)) <= 1.2 || seg_dist(x, y, (34.0, 41.0), (34.0, 46.5)) <= 1.2 { p = mix(p, white, 1.0); }
    if in_ellipse(x, y, 30.0, 34.5, 13.0, 9.0) || in_ellipse(x, y, 38.5, 25.5, 8.0, 7.5)
        || in_triangle(x, y, (18.4, 33.5), (11.0, 38.0), (20.0, 38.5)) || in_triangle(x, y, (45.9, 23.6), (51.5, 26.8), (45.9, 29.0)) {
        p = mix(p, white, 1.0);
    }
    if in_ellipse(x, y, 40.6, 24.2, 1.9, 1.9) { p = mix(p, dark, 1.0); }
    if v == Variant::Connected {
        // A green "someone is here" dot with a white ring, bottom right.
        if in_ellipse(x, y, 52.0, 52.0, 12.0, 12.0) { p = mix(p, white, 1.0); }
        if in_ellipse(x, y, 52.0, 52.0, 9.0, 9.0) { p = mix(p, [0x22 as f64 / 255.0, 0xC5 as f64 / 255.0, 0x5E as f64 / 255.0], 1.0); }
    }
    p
}

/// A Windows .ico file with the icon at the usual sizes (PNG-compressed entries).
pub fn ico(variant: Variant) -> Vec<u8> {
    let sizes = [16usize, 20, 24, 32, 40, 48, 64, 128, 256];
    let pngs: Vec<Vec<u8>> = sizes.iter().map(|s| png(*s, variant)).collect();
    let mut out = vec![0, 0, 1, 0];
    out.extend_from_slice(&(sizes.len() as u16).to_le_bytes());
    let mut offset = 6 + 16 * sizes.len();
    for (s, p) in sizes.iter().zip(&pngs) {
        let b = if *s >= 256 { 0 } else { *s as u8 };
        out.extend_from_slice(&[b, b, 0, 0, 1, 0, 32, 0]);
        out.extend_from_slice(&(p.len() as u32).to_le_bytes());
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += p.len();
    }
    for p in pngs { out.extend(p); }
    out
}

pub fn png(size: usize, variant: Variant) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut e = png::Encoder::new(&mut out, size as u32, size as u32);
        e.set_color(png::ColorType::Rgba);
        e.set_depth(png::BitDepth::Eight);
        let mut w = e.write_header().expect("png header");
        w.write_image_data(&render(size, variant)).expect("png data");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_icon_has_ember_corners_a_white_bird_and_transparent_edges() {
        let px = render(64, Variant::Normal);
        let at = |x: usize, y: usize| &px[(y * 64 + x) * 4..(y * 64 + x) * 4 + 4];
        assert_eq!(at(0, 0)[3], 0, "outside the rounded corner");
        assert_eq!(at(10, 10)[0], 255);
        assert_eq!(at(30, 35), &[255, 255, 255, 255], "the bird's body");
        let grey = render(32, Variant::Dimmed);
        let p = &grey[(8 * 32 + 8) * 4..];
        assert!(p[0] == p[1] && p[1] == p[2]);
        let ico = ico(Variant::Connected);
        assert_eq!(&ico[..4], &[0, 0, 1, 0]);
        std::fs::write(std::env::temp_dir().join("roost-icon-test.png"), png(256, Variant::Connected)).unwrap();
    }
}
