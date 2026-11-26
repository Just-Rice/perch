//! Opus: the PC's sound out (48 kHz stereo, 20 ms packets, 64 kbit/s) and the viewer's microphone back in.
use super::super::sizing::GainStage;

pub const SAMPLE_RATE: u32 = 48_000;
pub const FRAMES_PER_PACKET: usize = 960; // 20 ms

/// Interleaved stereo float → 20 ms Opus packets with their timestamps (µs). Frames left over from one buffer go
/// first into the next packet.
pub struct AudioPipeline {
    enc: opus::Encoder,
    pending: Vec<f32>,
    last_pts: u64,
    pub gain: GainStage,
}

impl AudioPipeline {
    pub fn new() -> Result<Self, String> {
        let mut enc = opus::Encoder::new(SAMPLE_RATE, opus::Channels::Stereo, opus::Application::Audio)
            .map_err(|e| format!("Opus: {e}"))?;
        enc.set_bitrate(opus::Bitrate::Bits(64_000)).map_err(|e| format!("Opus: {e}"))?;
        let _ = enc.set_inband_fec(true);
        Ok(Self { enc, pending: Vec::with_capacity(FRAMES_PER_PACKET * 4), last_pts: 0, gain: GainStage::default() })
    }

    /// `pts` is the time (µs) of the first frame in `pcm`.
    pub fn feed(&mut self, pcm: &[f32], pts: u64, mut out: impl FnMut(u64, Vec<u8>)) {
        let mut pcm = pcm.to_vec();
        self.gain.apply(&mut pcm);
        let buffered = (self.pending.len() / 2) as u64;
        let mut t = pts.saturating_sub(buffered * 1_000_000 / SAMPLE_RATE as u64);
        self.pending.extend_from_slice(&pcm);
        let per = FRAMES_PER_PACKET * 2;
        let mut offset = 0;
        while self.pending.len() - offset >= per {
            if let Ok(packet) = self.enc.encode_vec_float(&self.pending[offset..offset + per], 4000) {
                // Timestamps only ever go forward (the protocol promises monotonic pts).
                self.last_pts = (self.last_pts + 1).max(t);
                out(self.last_pts, packet);
            }
            t += 20_000;
            offset += per;
        }
        self.pending.drain(..offset);
    }
}

/// Decodes the viewer's microphone (Opus, 48 kHz stereo) to interleaved floats; a missing packet is concealed.
pub struct MicDecoder { dec: opus::Decoder, last_seq: Option<u16> }

impl MicDecoder {
    pub fn new() -> Result<Self, String> {
        Ok(Self { dec: opus::Decoder::new(SAMPLE_RATE, opus::Channels::Stereo).map_err(|e| format!("Opus: {e}"))?, last_seq: None })
    }

    /// `frame` is the MIC frame payload: u16 BE sequence number · one Opus packet.
    pub fn decode(&mut self, frame: &[u8]) -> Vec<f32> {
        if frame.len() < 3 { return vec![]; }
        let seq = u16::from_be_bytes([frame[0], frame[1]]);
        let mut out = Vec::new();
        let mut buf = vec![0f32; 5760 * 2];
        if let Some(last) = self.last_seq {
            let gap = seq.wrapping_sub(last);
            if gap == 0 || gap > 0x8000 { return vec![]; } // a duplicate or one that came too late
            // Up to three lost packets are concealed; more than that, start afresh.
            if (2..=4).contains(&gap) {
                for _ in 1..gap {
                    if let Ok(n) = self.dec.decode_float(&[], &mut buf, false) { out.extend_from_slice(&buf[..n * 2]); }
                }
            }
        }
        self.last_seq = Some(seq);
        if let Ok(n) = self.dec.decode_float(&frame[2..], &mut buf, false) { out.extend_from_slice(&buf[..n * 2]); }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::synthetic::Tone;

    #[test]
    fn sound_becomes_20ms_packets_with_steady_timestamps_and_back() {
        let mut p = AudioPipeline::new().unwrap();
        let mut tone = Tone::default();
        let mut packets = vec![];
        // 7 ms buffers, as a sound card might deliver them.
        let mut pts = 1_000_000u64;
        for _ in 0..30 {
            p.feed(&tone.next(336), pts, |t, pk| packets.push((t, pk)));
            pts += 7_000;
        }
        assert_eq!(packets.len(), 30 * 336 / 960);
        for w in packets.windows(2) { assert!((w[1].0 - w[0].0).abs_diff(20_000) <= 1, "{:?}", (w[0].0, w[1].0)); }
        let mut d = MicDecoder::new().unwrap();
        let mut f = vec![0, 1];
        f.extend_from_slice(&packets[5].1);
        assert_eq!(d.decode(&f).len(), 1920);
        assert!(d.decode(&f).is_empty(), "the same sequence number twice is dropped");
    }
}
