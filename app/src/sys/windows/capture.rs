//! Screen pictures on Windows: DXGI Desktop Duplication (Windows 8 and later; fast, tells us when the screen
//! changed, gives the pointer separately), with a GDI fallback for the PCs where it isn't available (some virtual
//! machines and remote sessions, hybrid-graphics laptops where the display hangs off the other GPU).
use super::screens;
use crate::media::yuv::{Bgra, Converter, I420};
use crate::planner::Rect;
use crate::system::{DisplayInfo, SourceError, VideoSource};
use std::time::{Duration, Instant};
use windows::core::Interface;
use windows::Win32::Foundation::{HMODULE, POINT};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_9_1};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, SetThreadDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_ACCESS_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::{DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSOR_SHOWING, DI_NORMAL, ICONINFO};

pub fn source(d: &DisplayInfo) -> Result<Box<dyn VideoSource>, String> {
    follow_input_desktop();
    let (device, rect) = screens::device_name(d.id).ok_or("That display is no longer connected.")?;
    match Duplication::new(&device, rect) {
        Ok(s) => Ok(Box::new(s)),
        Err(e) => {
            crate::info!("Desktop Duplication isn't available for {device} ({e}); using GDI capture");
            Ok(Box::new(GdiSource::new(rect)))
        }
    }
}

/// Capture follows whichever desktop has the input (after a UAC prompt or the lock screen, Windows switches back
/// to "Default"; an elevated Roost can also see some it otherwise couldn't).
fn follow_input_desktop() {
    unsafe {
        if let Ok(d) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_ACCESS_FLAGS(0x0100 /* GENERIC_ALL-ish: DESKTOP_READOBJECTS */ | 0x0001)) {
            let _ = SetThreadDesktop(d);
            let _ = CloseDesktop(d);
        }
    }
}

/// The pointer as Desktop Duplication reports it: where it is, whether it shows, and its picture.
#[derive(Default)]
struct Pointer {
    visible: bool,
    x: i32,
    y: i32,
    kind: u32,
    w: usize,
    h: usize,
    pitch: usize,
    shape: Vec<u8>,
}

impl Pointer {
    /// Draws the pointer into a BGRA picture whose top-left is at (ox, oy) on the display.
    fn draw(&self, img: &mut [u8], iw: usize, ih: usize, ox: i32, oy: i32) {
        if !self.visible || self.shape.is_empty() { return; }
        let rows = if self.kind == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME.0 as u32 { self.h / 2 } else { self.h };
        for row in 0..rows {
            let ty = self.y - oy + row as i32;
            if ty < 0 || ty >= ih as i32 { continue; }
            for col in 0..self.w {
                let tx = self.x - ox + col as i32;
                if tx < 0 || tx >= iw as i32 { continue; }
                let d = (ty as usize * iw + tx as usize) * 4;
                let px = &mut img[d..d + 4];
                match self.kind {
                    k if k == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME.0 as u32 => {
                        let bit = 0x80u8 >> (col % 8);
                        let and = self.shape[row * self.pitch + col / 8] & bit != 0;
                        let xor = self.shape[(row + rows) * self.pitch + col / 8] & bit != 0;
                        match (and, xor) {
                            (false, false) => { px[0] = 0; px[1] = 0; px[2] = 0; }
                            (false, true) => { px[0] = 255; px[1] = 255; px[2] = 255; }
                            (true, true) => { px[0] ^= 255; px[1] ^= 255; px[2] ^= 255; }
                            (true, false) => {}
                        }
                    }
                    k if k == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR.0 as u32 => {
                        let s = &self.shape[row * self.pitch + col * 4..];
                        if s[3] == 0 { px[..3].copy_from_slice(&s[..3]); } else { px[0] ^= s[0]; px[1] ^= s[1]; px[2] ^= s[2]; }
                    }
                    _ => {
                        let s = &self.shape[row * self.pitch + col * 4..];
                        let a = s[3] as u32;
                        for c in 0..3 { px[c] = ((s[c] as u32 * a + px[c] as u32 * (255 - a)) / 255) as u8; }
                    }
                }
            }
        }
    }
}

struct Duplication {
    device: ID3D11Device,
    ctx: ID3D11DeviceContext,
    dup: IDXGIOutputDuplication,
    staging: Option<ID3D11Texture2D>,
    /// Desktop size as duplicated (before rotation).
    dw: usize,
    dh: usize,
    rotation: DXGI_MODE_ROTATION,
    display: Rect,
    region: Option<Rect>,
    w: usize,
    h: usize,
    have: bool,
    pointer: Pointer,
    crop: Vec<u8>,
    conv: Converter,
}

// The D3D objects are only ever used from the one capture thread that owns this source.
unsafe impl Send for Duplication {}

impl Duplication {
    fn new(device_name: &str, display: Rect) -> Result<Self, String> {
        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(|e| e.to_string())?;
            let mut a = 0;
            while let Ok(adapter) = factory.EnumAdapters1(a) {
                a += 1;
                let mut o = 0;
                while let Ok(output) = adapter.EnumOutputs(o) {
                    o += 1;
                    let desc = output.GetDesc().map_err(|e| e.to_string())?;
                    let name = String::from_utf16_lossy(&desc.DeviceName[..desc.DeviceName.iter().position(|c| *c == 0).unwrap_or(32)]);
                    if !name.eq_ignore_ascii_case(device_name) { continue; }
                    let (mut device, mut ctx) = (None, None);
                    D3D11CreateDevice(&adapter, D3D_DRIVER_TYPE_UNKNOWN, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                        Some(&[D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_9_1]), D3D11_SDK_VERSION,
                        Some(&mut device), None, Some(&mut ctx)).map_err(|e| format!("Direct3D: {e}"))?;
                    let (device, ctx) = (device.ok_or("no device")?, ctx.ok_or("no context")?);
                    // DuplicateOutput1 lets Windows convert HDR desktops to ordinary 8-bit colour for us.
                    let dup = match output.cast::<IDXGIOutput5>() {
                        Ok(o5) => o5.DuplicateOutput1(&device, 0, &[DXGI_FORMAT_B8G8R8A8_UNORM]),
                        Err(_) => output.cast::<IDXGIOutput1>().map_err(|e| e.to_string())?.DuplicateOutput(&device),
                    }.map_err(|e| format!("DuplicateOutput: {e}"))?;
                    let dd = dup.GetDesc();
                    return Ok(Self { device, ctx, dup, staging: None, dw: dd.ModeDesc.Width as usize, dh: dd.ModeDesc.Height as usize,
                        rotation: dd.Rotation, display, region: None, w: 0, h: 0, have: false, pointer: Pointer::default(),
                        crop: vec![], conv: Converter::default() });
                }
            }
            Err(format!("no DXGI output for {device_name}"))
        }
    }

    fn staging(&mut self) -> Result<ID3D11Texture2D, String> {
        if let Some(s) = &self.staging { return Ok(s.clone()); }
        let desc = D3D11_TEXTURE2D_DESC {
            Width: self.dw as u32, Height: self.dh as u32, MipLevels: 1, ArraySize: 1, Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 }, Usage: D3D11_USAGE_STAGING,
            BindFlags: 0, CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32, MiscFlags: 0,
        };
        let mut tex = None;
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut tex)).map_err(|e| e.to_string())?; }
        let tex = tex.ok_or("no staging texture")?;
        self.staging = Some(tex.clone());
        Ok(tex)
    }

    /// Copies what is shown out of the staging texture (turning it upright if the display is rotated), draws the
    /// pointer on it, and converts it.
    fn compose(&mut self, out: &mut I420) -> Result<(), String> {
        let staging = self.staging()?;
        let rotated = matches!(self.rotation, DXGI_MODE_ROTATION_ROTATE90 | DXGI_MODE_ROTATION_ROTATE270);
        let (fw, fh) = if rotated { (self.dh, self.dw) } else { (self.dw, self.dh) };
        let r = self.region.unwrap_or(Rect::new(0.0, 0.0, fw as f64, fh as f64));
        let (rx, ry) = (r.x.max(0.0) as usize, r.y.max(0.0) as usize);
        let (rw, rh) = ((r.w as usize).min(fw.saturating_sub(rx)), (r.h as usize).min(fh.saturating_sub(ry)));
        if rw < 2 || rh < 2 { return Err("nothing to show".into()); }
        self.crop.resize(rw * rh * 4, 0);
        unsafe {
            let mut map = D3D11_MAPPED_SUBRESOURCE::default();
            self.ctx.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut map)).map_err(|e| e.to_string())?;
            let pitch = map.RowPitch as usize;
            let src = std::slice::from_raw_parts(map.pData as *const u8, pitch * self.dh);
            if !rotated && self.rotation != DXGI_MODE_ROTATION_ROTATE180 {
                for y in 0..rh {
                    let s = (ry + y) * pitch + rx * 4;
                    self.crop[y * rw * 4..(y + 1) * rw * 4].copy_from_slice(&src[s..s + rw * 4]);
                }
            } else {
                // Upright (x, y) on the display ← (sx, sy) in the duplicated, unrotated desktop.
                for y in 0..rh {
                    for x in 0..rw {
                        let (ux, uy) = (rx + x, ry + y);
                        let (sx, sy) = match self.rotation {
                            DXGI_MODE_ROTATION_ROTATE90 => (uy, self.dh - 1 - ux),
                            DXGI_MODE_ROTATION_ROTATE180 => (self.dw - 1 - ux, self.dh - 1 - uy),
                            _ => (self.dw - 1 - uy, ux), // 270
                        };
                        let s = sy * pitch + sx * 4;
                        self.crop[(y * rw + x) * 4..(y * rw + x) * 4 + 4].copy_from_slice(&src[s..s + 4]);
                    }
                }
            }
            self.ctx.Unmap(&staging, 0);
        }
        self.pointer.draw(&mut self.crop, rw, rh, rx as i32, ry as i32);
        let src = Bgra { width: rw, height: rh, stride: rw * 4, data: &self.crop };
        self.conv.convert(&src, self.w, self.h, out);
        Ok(())
    }
}

impl VideoSource for Duplication {
    fn configure(&mut self, region: Option<Rect>, w: usize, h: usize) {
        self.region = region;
        self.w = w;
        self.h = h;
    }

    fn next(&mut self, out: &mut I420, timeout: Duration) -> Result<bool, SourceError> {
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut res: Option<IDXGIResource> = None;
        unsafe {
            match self.dup.AcquireNextFrame(timeout.as_millis() as u32, &mut info, &mut res) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(false),
                // ACCESS_LOST: a mode change, full-screen app, the lock screen or a UAC prompt. Rebuild.
                Err(e) => return Err(SourceError::Lost(e.message())),
            }
            let mut changed = false;
            if info.LastMouseUpdateTime != 0 {
                self.pointer.visible = info.PointerPosition.Visible.as_bool();
                self.pointer.x = info.PointerPosition.Position.x;
                self.pointer.y = info.PointerPosition.Position.y;
                changed = true;
            }
            if info.PointerShapeBufferSize > 0 {
                let mut buf = vec![0u8; info.PointerShapeBufferSize as usize];
                let mut needed = 0u32;
                let mut si = DXGI_OUTDUPL_POINTER_SHAPE_INFO::default();
                if self.dup.GetFramePointerShape(buf.len() as u32, buf.as_mut_ptr().cast(), &mut needed, &mut si).is_ok() {
                    self.pointer.kind = si.Type;
                    self.pointer.w = si.Width as usize;
                    self.pointer.h = si.Height as usize;
                    self.pointer.pitch = si.Pitch as usize;
                    self.pointer.shape = buf;
                }
            }
            if info.LastPresentTime != 0 {
                if let Some(r) = res.as_ref() {
                    if let (Ok(tex), Ok(staging)) = (r.cast::<ID3D11Texture2D>(), self.staging()) {
                        self.ctx.CopyResource(&staging, &tex);
                        self.have = true;
                        changed = true;
                    }
                }
            }
            let _ = self.dup.ReleaseFrame();
            if !changed || !self.have { return Ok(false); }
        }
        self.compose(out).map_err(SourceError::Lost)?;
        Ok(true)
    }

    fn name(&self) -> String { format!("Desktop Duplication {}x{}", self.display.w, self.display.h) }
}

/// GDI: BitBlt from the screen. No change notification, so each picture is compared with the last.
struct GdiSource {
    display: Rect,
    region: Option<Rect>,
    w: usize,
    h: usize,
    last: Vec<u8>,
    buf: Vec<u8>,
    conv: Converter,
    last_at: Instant,
}

unsafe impl Send for GdiSource {}

impl GdiSource {
    fn new(display: Rect) -> Self {
        Self { display, region: None, w: 0, h: 0, last: vec![], buf: vec![], conv: Converter::default(), last_at: Instant::now() }
    }

    fn grab(&mut self, r: Rect) -> Result<(), String> {
        let (x, y, w, h) = ((self.display.x + r.x) as i32, (self.display.y + r.y) as i32, r.w as i32, r.h as i32);
        unsafe {
            let screen = GetDC(None);
            let mem = CreateCompatibleDC(Some(screen));
            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bmi.bmiHeader.biWidth = w;
            bmi.bmiHeader.biHeight = -h; // top-down
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            let mut bits = std::ptr::null_mut();
            let result = (|| -> Result<(), String> {
                let dib = CreateDIBSection(Some(mem), &bmi, DIB_RGB_COLORS, &mut bits, None, 0).map_err(|e| e.to_string())?;
                let old = SelectObject(mem, dib.into());
                let r = BitBlt(mem, 0, 0, w, h, Some(screen), x, y, SRCCOPY | CAPTUREBLT).map_err(|e| e.to_string());
                // The pointer isn't part of the screen's picture: draw it like Windows would.
                let mut ci = CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
                if GetCursorInfo(&mut ci).is_ok() && ci.flags == CURSOR_SHOWING {
                    let mut ii = ICONINFO::default();
                    if GetIconInfo(ci.hCursor.into(), &mut ii).is_ok() {
                        let p = POINT { x: ci.ptScreenPos.x - x - ii.xHotspot as i32, y: ci.ptScreenPos.y - y - ii.yHotspot as i32 };
                        let _ = DrawIconEx(mem, p.x, p.y, ci.hCursor.into(), 0, 0, 0, None, DI_NORMAL);
                        if !ii.hbmMask.is_invalid() { let _ = DeleteObject(ii.hbmMask.into()); }
                        if !ii.hbmColor.is_invalid() { let _ = DeleteObject(ii.hbmColor.into()); }
                    }
                }
                if r.is_ok() {
                    let n = (w * h * 4) as usize;
                    self.buf.resize(n, 0);
                    std::ptr::copy_nonoverlapping(bits as *const u8, self.buf.as_mut_ptr(), n);
                }
                SelectObject(mem, old);
                let _ = DeleteObject(dib.into());
                r
            })();
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            result
        }
    }
}

impl VideoSource for GdiSource {
    fn configure(&mut self, region: Option<Rect>, w: usize, h: usize) {
        self.region = region;
        self.w = w;
        self.h = h;
        self.last.clear();
    }

    fn next(&mut self, out: &mut I420, timeout: Duration) -> Result<bool, SourceError> {
        // Look about every 33 ms at most; the session paces the frame rate itself.
        let wait = Duration::from_millis(33).saturating_sub(self.last_at.elapsed()).min(timeout);
        std::thread::sleep(wait);
        self.last_at = Instant::now();
        let r = self.region.unwrap_or(Rect::new(0.0, 0.0, self.display.w, self.display.h));
        self.grab(r).map_err(SourceError::Lost)?;
        if self.buf == self.last { return Ok(false); }
        std::mem::swap(&mut self.buf, &mut self.last);
        let src = Bgra { width: r.w as usize, height: r.h as usize, stride: r.w as usize * 4, data: &self.last };
        self.conv.convert(&src, self.w, self.h, out);
        Ok(true)
    }

    fn name(&self) -> String { format!("GDI {}x{}", self.display.w, self.display.h) }
}
