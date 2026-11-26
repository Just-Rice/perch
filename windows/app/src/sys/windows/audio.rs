//! Sound on Windows (WASAPI).
//!
//! What the PC plays goes to the viewer through *process loopback* (Windows 10 2004+), told to leave out Roost's
//! own process: so the viewer's microphone, which Roost plays here, never comes back to them as an echo. On older
//! Windows it falls back to ordinary loopback of the default output. While someone is connected the PC's own
//! speakers can be turned down ("PC speakers" level): process loopback takes the sound before the output's volume,
//! so the viewer still hears it at full level. The volume is put back when capture stops.
//!
//! The viewer's microphone is played on a chosen output (AudioOut), by device id, or the default one.
use crate::sizing::AudioLevels;
use crate::system::{AudioCapture, AudioSink};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use windows::core::{implement, Interface, Ref, GUID, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::*;
use windows::Win32::Media::KernelStreaming::{KSDATAFORMAT_SUBTYPE_PCM, WAVE_FORMAT_EXTENSIBLE};
use windows::Win32::Media::Multimedia::{KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT};
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
use windows::Win32::System::Com::*;
use windows::Win32::System::Threading::{CreateEventW, GetCurrentProcessId, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;
use windows::Win32::Foundation::PROPERTYKEY;

const RATE: u32 = 48_000;

fn com() { unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); } }

fn float_stereo_48k() -> WAVEFORMATEX {
    WAVEFORMATEX { wFormatTag: WAVE_FORMAT_IEEE_FLOAT as u16, nChannels: 2, nSamplesPerSec: RATE, nAvgBytesPerSec: RATE * 8,
        nBlockAlign: 8, wBitsPerSample: 32, cbSize: 0 }
}

/// Process loopback is in Windows 10 version 2004 (build 19041) and later.
pub fn process_loopback_available() -> bool { super::build_number() >= 19041 }

// ---- the default output's volume (for "PC speakers") -----------------------------------------------------------

fn endpoint_volume() -> Option<IAudioEndpointVolume> {
    com();
    unsafe {
        let e: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let d = e.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        d.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).ok()
    }
}

/// Holds the output's volume at `saved × level` while capture runs; puts it back when dropped.
struct SpeakerLevel { vol: Option<IAudioEndpointVolume>, saved: f32, applied: bool }

impl SpeakerLevel {
    fn new() -> Self {
        let vol = endpoint_volume();
        let saved = vol.as_ref().and_then(|v| unsafe { v.GetMasterVolumeLevelScalar().ok() }).unwrap_or(1.0);
        Self { vol, saved, applied: false }
    }

    fn set(&mut self, level: f64) {
        let Some(v) = &self.vol else { return };
        if level >= 0.999 && !self.applied { return; }
        // Someone at the PC may have changed the volume since: take that as the new "usual".
        if !self.applied { self.saved = unsafe { v.GetMasterVolumeLevelScalar() }.unwrap_or(self.saved); }
        let target = (self.saved as f64 * level.clamp(0.0, 1.0)) as f32;
        unsafe { let _ = v.SetMasterVolumeLevelScalar(target, std::ptr::null()); }
        self.applied = level < 0.999;
    }
}

impl Drop for SpeakerLevel {
    fn drop(&mut self) {
        if let (true, Some(v)) = (self.applied, &self.vol) { unsafe { let _ = v.SetMasterVolumeLevelScalar(self.saved, std::ptr::null()); } }
    }
}

// SAFETY: the endpoint volume interface is free-threaded (MTA).
unsafe impl Send for SpeakerLevel {}

// ---- capture -------------------------------------------------------------------------------------------------------

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Activated(mpsc::Sender<()>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
    fn ActivateCompleted(&self, _op: Ref<IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
        let _ = self.0.send(());
        Ok(())
    }
}

/// An audio client for everything the PC plays except Roost's own sound.
fn process_loopback_client() -> Result<IAudioClient, String> {
    unsafe {
        let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 { ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: GetCurrentProcessId(), ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE } },
        };
        let pv = PROPVARIANT { Anonymous: PROPVARIANT_0 { Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
            vt: VT_BLOB, wReserved1: 0, wReserved2: 0, wReserved3: 0,
            Anonymous: PROPVARIANT_0_0_0 { blob: windows::Win32::System::Com::BLOB {
                cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32, pBlobData: &mut params as *mut _ as *mut u8 } },
        }) } };
        let (tx, rx) = mpsc::channel();
        let handler: IActivateAudioInterfaceCompletionHandler = Activated(tx).into();
        let op = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&pv), &handler)
            .map_err(|e| format!("process loopback: {e}"))?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "process loopback didn't start".to_string())?;
        let (mut hr, mut unknown) = (windows::core::HRESULT(0), None);
        op.GetActivateResult(&mut hr, &mut unknown).map_err(|e| e.to_string())?;
        hr.ok().map_err(|e| format!("process loopback: {e}"))?;
        unknown.ok_or("no audio client")?.cast::<IAudioClient>().map_err(|e| e.to_string())
    }
}

/// The incoming format, and how to turn it into 48 kHz stereo floats.
#[derive(Clone, Copy)]
struct Format { rate: u32, channels: usize, float: bool, bits: u16 }

impl Format {
    unsafe fn of(f: *const WAVEFORMATEX) -> Self {
        let w = unsafe { *f };
        let mut float = w.wFormatTag == WAVE_FORMAT_IEEE_FLOAT as u16;
        if w.wFormatTag == WAVE_FORMAT_EXTENSIBLE as u16 {
            let x = unsafe { *(f as *const WAVEFORMATEXTENSIBLE) };
            let sub = x.SubFormat;
            float = sub == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
            if !float && sub != KSDATAFORMAT_SUBTYPE_PCM { warn!("unusual sound format; it may sound wrong"); }
        }
        Self { rate: w.nSamplesPerSec, channels: w.nChannels.max(1) as usize, float, bits: w.wBitsPerSample }
    }

    /// Interleaved stereo floats at the source rate.
    fn to_stereo(&self, data: &[u8], frames: usize, out: &mut Vec<f32>) {
        out.clear();
        let bps = (self.bits / 8) as usize;
        let sample = |i: usize| -> f32 {
            let b = &data[i * bps..i * bps + bps];
            match (self.float, bps) {
                (true, 4) => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
                (false, 2) => i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0,
                (false, 3) => (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8_388_608.0,
                (false, 4) => i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0,
                _ => 0.0,
            }
        };
        for f in 0..frames {
            let base = f * self.channels;
            let (l, r) = if self.channels == 1 { let v = sample(base); (v, v) } else { (sample(base), sample(base + 1)) };
            out.push(l);
            out.push(r);
        }
    }
}

/// A small linear resampler for stereo frames, keeping its position between buffers.
struct Resampler { ratio: f64, pos: f64, last: (f32, f32) }

impl Resampler {
    fn run(&mut self, input: &[f32], out: &mut Vec<f32>) {
        out.clear();
        if (self.ratio - 1.0).abs() < 1e-9 { out.extend_from_slice(input); return; }
        let n = input.len() / 2;
        let at = |i: isize| -> (f32, f32) { if i < 0 { self.last } else { (input[i as usize * 2], input[i as usize * 2 + 1]) } };
        while self.pos < n as f64 - 1.0 + 1.0 {
            let i = self.pos.floor() as isize - 1;
            let t = (self.pos - self.pos.floor()) as f32;
            let (a, b) = (at(i), at(i + 1));
            out.push(a.0 + (b.0 - a.0) * t);
            out.push(a.1 + (b.1 - a.1) * t);
            self.pos += self.ratio;
        }
        self.pos -= n as f64;
        if n > 0 { self.last = (input[(n - 1) * 2], input[(n - 1) * 2 + 1]); }
    }
}

pub struct Loopback {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    speakers: Arc<Mutex<Option<SpeakerLevel>>>,
    process_mode: bool,
}

pub fn capture(mut sink: AudioSink, levels: AudioLevels) -> Result<Box<dyn AudioCapture>, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::channel::<Result<bool, String>>();
    let s = stop.clone();
    let thread = std::thread::Builder::new().name("roost-sound".into()).spawn(move || {
        com();
        let (client, process_mode) = match process_loopback_available().then(process_loopback_client) {
            Some(Ok(c)) => (c, true),
            other => {
                if let Some(Err(e)) = other { info!("{e}; using ordinary loopback"); }
                match default_loopback_client() { Ok(c) => (c, false), Err(e) => { let _ = ready_tx.send(Err(e)); return; } }
            }
        };
        match run_capture(client, process_mode, &s, &mut sink, &ready_tx) {
            Ok(()) => {}
            Err(e) => { let _ = ready_tx.send(Err(e.clone())); warn!("sound capture stopped: {e}"); }
        }
    }).map_err(|e| e.to_string())?;
    let process_mode = ready_rx.recv_timeout(Duration::from_secs(6)).map_err(|_| "sound capture didn't start".to_string())??;
    let mut l = Loopback { stop, thread: Some(thread), speakers: Arc::new(Mutex::new(None)), process_mode };
    l.set_speakers(levels.speakers);
    Ok(Box::new(l))
}

fn default_loopback_client() -> Result<IAudioClient, String> {
    unsafe {
        let e: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let d = e.GetDefaultAudioEndpoint(eRender, eConsole).map_err(|_| "This PC has no sound output.".to_string())?;
        d.Activate::<IAudioClient>(CLSCTX_ALL, None).map_err(|e| e.to_string())
    }
}

fn run_capture(client: IAudioClient, process_mode: bool, stop: &AtomicBool, sink: &mut AudioSink,
               ready: &mpsc::Sender<Result<bool, String>>) -> Result<(), String> {
    unsafe {
        let event = CreateEventW(None, false, false, None).map_err(|e| e.to_string())?;
        let _guard = scopeguard(event);
        let wanted = float_stereo_48k();
        let format = if process_mode {
            // Process loopback has no mix format of its own: it delivers whatever is asked for.
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                200_000, 0, &wanted, None).map_err(|e| format!("Initialize: {e}"))?;
            client.SetEventHandle(event).map_err(|e| e.to_string())?;
            Format { rate: RATE, channels: 2, float: true, bits: 32 }
        } else {
            let mix = client.GetMixFormat().map_err(|e| e.to_string())?;
            let f = Format::of(mix);
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 200_000, 0, mix, None).map_err(|e| format!("Initialize: {e}"))?;
            CoTaskMemFree(Some(mix as *const _));
            f
        };
        let cap: IAudioCaptureClient = client.GetService().map_err(|e| e.to_string())?;
        client.Start().map_err(|e| e.to_string())?;
        let _ = ready.send(Ok(process_mode));
        let mut stereo = Vec::new();
        let mut resampled = Vec::new();
        let mut rs = Resampler { ratio: format.rate as f64 / RATE as f64, pos: 0.0, last: (0.0, 0.0) };
        while !stop.load(Ordering::Relaxed) {
            if process_mode { WaitForSingleObject(event, 20); } else { std::thread::sleep(Duration::from_millis(10)); }
            loop {
                let n = cap.GetNextPacketSize().map_err(|e| e.to_string())?;
                if n == 0 { break; }
                let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0u32, 0u32);
                cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None).map_err(|e| e.to_string())?;
                let now = crate::clock::now_us();
                let bytes = frames as usize * format.channels * (format.bits / 8) as usize;
                if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                    stereo.clear();
                    stereo.resize(frames as usize * 2, 0.0);
                } else {
                    format.to_stereo(std::slice::from_raw_parts(data, bytes), frames as usize, &mut stereo);
                }
                cap.ReleaseBuffer(frames).map_err(|e| e.to_string())?;
                rs.run(&stereo, &mut resampled);
                if !resampled.is_empty() {
                    let dur = (resampled.len() / 2) as u64 * 1_000_000 / RATE as u64;
                    sink(&resampled, now.saturating_sub(dur));
                }
            }
        }
        let _ = client.Stop();
        Ok(())
    }
}

struct EventGuard(HANDLE);
impl Drop for EventGuard { fn drop(&mut self) { unsafe { let _ = CloseHandle(self.0); } } }
fn scopeguard(h: HANDLE) -> EventGuard { EventGuard(h) }

impl AudioCapture for Loopback {
    fn set_speakers(&mut self, level: f64) {
        // Only with process loopback is the viewer's copy independent of the PC's volume.
        if !self.process_mode { return; }
        let mut s = self.speakers.lock().unwrap();
        if level >= 0.999 && s.is_none() { return; }
        s.get_or_insert_with(SpeakerLevel::new).set(level);
    }

    fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() { let _ = t.join(); }
        // The PC's speakers play as before.
        self.speakers.lock().unwrap().take();
    }
}

impl Drop for Loopback { fn drop(&mut self) { self.stop(); } }

// ---- outputs ---------------------------------------------------------------------------------------------------

const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0), pid: 14 };

/// The PC's sound outputs: (device id, name, is the default).
pub fn outputs() -> Vec<(String, String, bool)> {
    com();
    let mut out = vec![];
    unsafe {
        let Ok(e) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return out };
        let default = e.GetDefaultAudioEndpoint(eRender, eConsole).ok().and_then(|d| d.GetId().ok()).map(|p| pwstr(p)).unwrap_or_default();
        let Ok(list) = e.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else { return out };
        for i in 0..list.GetCount().unwrap_or(0) {
            let Ok(d) = list.Item(i) else { continue };
            let Ok(id) = d.GetId() else { continue };
            let id = pwstr(id);
            let name = d.OpenPropertyStore(STGM_READ).ok().and_then(|s| s.GetValue(&PKEY_DEVICE_FRIENDLY_NAME).ok())
                .map(|v| v.to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "Sound output".into());
            out.push((id.clone(), name, id == default));
        }
    }
    out
}

unsafe fn pwstr(p: PWSTR) -> String {
    let s = unsafe { p.to_string() }.unwrap_or_default();
    unsafe { CoTaskMemFree(Some(p.0 as *const _)); }
    s
}

static LAST_OUTPUTS: Mutex<Vec<(String, String, bool)>> = Mutex::new(Vec::new());

/// True when the list changed since last asked.
pub fn outputs_changed() -> bool {
    let now = outputs();
    let mut last = LAST_OUTPUTS.lock().unwrap();
    if *last == now { return false; }
    *last = now;
    true
}

// ---- playing the viewer's microphone -----------------------------------------------------------------------------

pub struct AudioOut {
    tx: mpsc::SyncSender<Vec<f32>>,
    failed: Arc<Mutex<Option<String>>>,
    stop: Arc<AtomicBool>,
}

impl AudioOut {
    pub fn open(device: Option<&str>) -> Result<Self, String> {
        let (tx, rx) = mpsc::sync_channel::<Vec<f32>>(50);
        let failed = Arc::new(Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel();
        let (f, s, dev) = (failed.clone(), stop.clone(), device.map(str::to_owned));
        std::thread::Builder::new().name("roost-mic-out".into()).spawn(move || {
            com();
            if let Err(e) = play(dev.as_deref(), rx, &s, &ready_tx) {
                let _ = ready_tx.send(Err(e.clone()));
                *f.lock().unwrap() = Some(e);
            }
        }).map_err(|e| e.to_string())?;
        ready_rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "the sound output didn't start".to_string())??;
        Ok(Self { tx, failed, stop })
    }

    pub fn push(&mut self, pcm: &[f32]) -> Result<(), String> {
        if let Some(e) = self.failed.lock().unwrap().clone() { return Err(e); }
        // A full queue means the output stalled: drop rather than build up delay.
        let _ = self.tx.try_send(pcm.to_vec());
        Ok(())
    }
}

impl Drop for AudioOut { fn drop(&mut self) { self.stop.store(true, Ordering::Relaxed); } }

fn play(device: Option<&str>, rx: mpsc::Receiver<Vec<f32>>, stop: &AtomicBool, ready: &mpsc::Sender<Result<(), String>>) -> Result<(), String> {
    unsafe {
        let e: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let d = match device {
            Some(id) => {
                let w: Vec<u16> = id.encode_utf16().chain([0]).collect();
                e.GetDevice(PCWSTR(w.as_ptr())).map_err(|_| "That sound output is no longer connected.".to_string())?
            }
            None => e.GetDefaultAudioEndpoint(eRender, eConsole).map_err(|_| "This PC has no sound output.".to_string())?,
        };
        let client: IAudioClient = d.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())?;
        let fmt = float_stereo_48k();
        // Windows converts to the output's own format and rate.
        client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            1_000_000, 0, &fmt, None).map_err(|e| format!("Initialize: {e}"))?;
        let size = client.GetBufferSize().map_err(|e| e.to_string())?;
        let render: IAudioRenderClient = client.GetService().map_err(|e| e.to_string())?;
        client.Start().map_err(|e| e.to_string())?;
        let _ = ready.send(Ok(()));
        let mut queue: std::collections::VecDeque<f32> = Default::default();
        // About 60 ms of the viewer's voice is kept in hand before playing, to ride out network jitter.
        let prime = (RATE as usize * 6 / 100) * 2;
        let mut primed = false;
        while !stop.load(Ordering::Relaxed) {
            while let Ok(chunk) = rx.try_recv() { queue.extend(chunk); }
            if !primed && queue.len() >= prime { primed = true; }
            // Too far behind (over 300 ms): skip ahead.
            if queue.len() > RATE as usize * 6 / 10 { let n = queue.len() - prime; queue.drain(..n & !1); }
            let padding = client.GetCurrentPadding().map_err(|e| e.to_string())?;
            let free = (size - padding) as usize;
            if free > 0 && primed {
                let n = free.min(queue.len() / 2);
                if n > 0 {
                    let buf = render.GetBuffer(n as u32).map_err(|e| e.to_string())?;
                    let out = std::slice::from_raw_parts_mut(buf as *mut f32, n * 2);
                    for v in out.iter_mut() { *v = queue.pop_front().unwrap_or(0.0); }
                    render.ReleaseBuffer(n as u32, 0).map_err(|e| e.to_string())?;
                }
                if queue.is_empty() { primed = false; }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = client.Stop();
        Ok(())
    }
}
