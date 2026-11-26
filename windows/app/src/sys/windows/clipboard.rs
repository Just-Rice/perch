//! The Windows clipboard: text both ways, pictures both ways (as PNG on the wire; "PNG" and CF_DIB here, which is
//! what Paint, Office, browsers and chat apps read), and the privacy marks password managers set.
use std::time::{Duration, Instant};
use windows::core::w;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::*;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{CF_DIB, CF_DIBV5, CF_UNICODETEXT};

/// The clipboard can be held by another app for a moment; keep trying briefly.
fn open() -> bool {
    let until = Instant::now() + Duration::from_millis(500);
    loop {
        if unsafe { OpenClipboard(None) }.is_ok() { return true; }
        if Instant::now() > until { return false; }
        std::thread::sleep(Duration::from_millis(20));
    }
}

struct Opened;
impl Drop for Opened { fn drop(&mut self) { unsafe { let _ = CloseClipboard(); } } }

fn png_format() -> u32 { unsafe { RegisterClipboardFormatW(w!("PNG")) } }

pub fn sequence() -> u32 { unsafe { GetClipboardSequenceNumber() } }

/// Password managers and the like mark what they copy as not for clipboard history or monitoring.
pub fn is_private() -> bool {
    unsafe {
        let exclude = RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing"));
        let history = RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory"));
        let cloud = RegisterClipboardFormatW(w!("CanUploadToCloudClipboard"));
        IsClipboardFormatAvailable(exclude).is_ok() || IsClipboardFormatAvailable(history).is_ok() || IsClipboardFormatAvailable(cloud).is_ok()
    }
}

unsafe fn global_bytes(h: HANDLE) -> Option<Vec<u8>> {
    let g = HGLOBAL(h.0);
    let p = unsafe { GlobalLock(g) } as *const u8;
    if p.is_null() { return None; }
    let n = unsafe { GlobalSize(g) };
    let v = unsafe { std::slice::from_raw_parts(p, n) }.to_vec();
    unsafe { let _ = GlobalUnlock(g); }
    Some(v)
}

pub fn text() -> String {
    if !open() { return String::new(); }
    let _c = Opened;
    unsafe {
        let Ok(h) = GetClipboardData(CF_UNICODETEXT.0 as u32) else { return String::new() };
        let Some(bytes) = global_bytes(h) else { return String::new() };
        let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|u| *u != 0).collect();
        String::from_utf16_lossy(&units)
    }
}

/// The clipboard's picture as PNG, if it holds one.
pub fn png() -> Option<Vec<u8>> {
    if !open() { return None; }
    let _c = Opened;
    unsafe {
        if let Ok(h) = GetClipboardData(png_format()) { if let Some(b) = global_bytes(h) { if b.starts_with(&[0x89, b'P', b'N', b'G']) { return Some(b); } } }
        let h = GetClipboardData(CF_DIBV5.0 as u32).or_else(|_| GetClipboardData(CF_DIB.0 as u32)).ok()?;
        let dib = global_bytes(h)?;
        dib_to_png(&dib)
    }
}

/// A DIB (BITMAPINFOHEADER or V5 + pixels) as PNG. 24- and 32-bit, which is what screenshots and apps put there.
fn dib_to_png(dib: &[u8]) -> Option<Vec<u8>> {
    let rd = |o: usize| -> Option<u32> { Some(u32::from_le_bytes(dib.get(o..o + 4)?.try_into().ok()?)) };
    let header: u32 = rd(0)?;
    let w = rd(4).map(|v: u32| v as i32)?;
    let h = rd(8).map(|v: u32| v as i32)?;
    let bits = u16::from_le_bytes(dib.get(14..16)?.try_into().ok()?);
    let compression: u32 = rd(16)?;
    if w <= 0 || h == 0 || !(bits == 24 || bits == 32) { return None; }
    let mut offset = header as usize;
    if compression == 3 && header == 40 { offset += 12; } // BI_BITFIELDS masks follow a plain header
    let (w, top_down, h) = (w as usize, h < 0, h.unsigned_abs() as usize);
    let bpp = bits as usize / 8;
    let stride = (w * bpp + 3) & !3;
    let px = dib.get(offset..offset + stride * h)?;
    // 32-bit DIBs often have a meaningless alpha of 0: treat an all-zero alpha as opaque.
    let alpha_used = bits == 32 && px.chunks(4).any(|p| p[3] != 0);
    let mut rgba = vec![0u8; w * h * 4];
    for y in 0..h {
        let sy = if top_down { y } else { h - 1 - y };
        for x in 0..w {
            let s = &px[sy * stride + x * bpp..];
            let d = &mut rgba[(y * w + x) * 4..(y * w + x) * 4 + 4];
            d[0] = s[2]; d[1] = s[1]; d[2] = s[0];
            d[3] = if alpha_used { s[3] } else { 255 };
        }
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut wr = enc.write_header().ok()?;
        wr.write_image_data(&rgba).ok()?;
    }
    Some(out)
}

unsafe fn put(format: u32, bytes: &[u8]) -> bool {
    unsafe {
        let Ok(g) = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)) else { return false };
        let p = GlobalLock(g) as *mut u8;
        if p.is_null() { let _ = GlobalFree(Some(g)); return false; }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        let _ = GlobalUnlock(g);
        if SetClipboardData(format, Some(HANDLE(g.0))).is_err() { let _ = GlobalFree(Some(g)); return false; }
        true
    }
}

/// Puts text and/or a picture (PNG, JPEG, GIF, BMP or WebP) on the clipboard. A picture Windows apps can't read is
/// refused.
pub fn set(text: Option<&str>, image: Option<&[u8]>) -> bool {
    let picture = match image {
        Some(bytes) => match image::load_from_memory(bytes) {
            Ok(img) => Some(img.to_rgba8()),
            Err(_) => return false,
        },
        None => None,
    };
    if !open() { return false; }
    let _c = Opened;
    unsafe {
        if EmptyClipboard().is_err() { return false; }
        let mut ok = true;
        if let Some(img) = picture {
            let (w, h) = img.dimensions();
            // PNG keeps transparency for apps that read it; the DIB is for everything else.
            let mut png_bytes = Vec::new();
            if image::DynamicImage::ImageRgba8(img.clone()).write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png).is_ok() {
                ok &= put(png_format(), &png_bytes);
            }
            let mut dib = Vec::with_capacity(40 + (w * h * 4) as usize);
            dib.extend_from_slice(&40u32.to_le_bytes());
            dib.extend_from_slice(&(w as i32).to_le_bytes());
            dib.extend_from_slice(&(h as i32).to_le_bytes()); // bottom-up
            dib.extend_from_slice(&1u16.to_le_bytes());
            dib.extend_from_slice(&32u16.to_le_bytes());
            dib.extend_from_slice(&[0u8; 24]); // BI_RGB, size, resolution, colours
            for y in (0..h).rev() {
                for x in 0..w {
                    let p = img.get_pixel(x, y).0;
                    dib.extend_from_slice(&[p[2], p[1], p[0], p[3]]);
                }
            }
            ok &= put(CF_DIB.0 as u32, &dib);
        }
        if let Some(t) = text {
            let units: Vec<u8> = t.encode_utf16().chain([0]).flat_map(|u| u.to_le_bytes()).collect();
            ok &= put(CF_UNICODETEXT.0 as u32, &units);
        }
        ok
    }
}
