//! H.264 encoding with OpenH264 (Cisco, BSD): software, so it works on every Windows PC, including N editions with
//! no Media Foundation. Constrained Baseline, which every browser decodes; its rate control meets the bitrate by
//! skipping frames rather than overshooting (the same behaviour Perch gets from VideoToolbox's low-latency mode).
use super::yuv::I420;
use openh264::encoder::{BitRate, Complexity, Encoder, EncoderConfig, FrameRate, FrameType, QpRange, RateControlMode,
    SpsPpsStrategy, UsageType, VuiConfig};
use openh264::OpenH264API;

pub struct Encoded {
    pub keyframe: bool,
    pub annex_b: Vec<u8>,
}

pub struct H264 {
    enc: Encoder,
    pub width: usize,
    pub height: usize,
    pub fps: u32,
    pub kbps: u32,
    pub max_qp: Option<u8>,
    force_next: bool,
}

pub const NAME: &str = "OpenH264";

impl H264 {
    pub fn new(width: usize, height: usize, fps: u32, kbps: u32, max_qp: Option<u8>) -> Result<Self, String> {
        // Bigger pictures get the faster search, so 4K at 30 frames a second stays real time on ordinary CPUs.
        let complexity = if width * height > 2_100_000 { Complexity::Low } else { Complexity::Medium };
        let config = EncoderConfig::new()
            .usage_type(UsageType::ScreenContentRealTime)
            .rate_control_mode(RateControlMode::Bitrate)
            .bitrate(BitRate::from_bps(kbps * 1000))
            .max_frame_rate(FrameRate::from_hz(fps as f32))
            .skip_frames(true)
            .complexity(complexity)
            .sps_pps_strategy(SpsPpsStrategy::ConstantId)
            .qp(QpRange::new(10, max_qp.unwrap_or(51).max(10)))
            .scene_change_detect(true)
            .adaptive_quantization(false)
            .background_detection(false)
            .vui(VuiConfig::bt709())
            .num_threads(0);
        let enc = Encoder::with_api_config(OpenH264API::from_source(), config).map_err(|e| format!("OpenH264: {e}"))?;
        Ok(Self { enc, width, height, fps, kbps, max_qp, force_next: true })
    }

    /// Encodes one picture. None means rate control skipped it (the link is full): the caller tries again soon.
    pub fn encode(&mut self, pic: &I420, force_keyframe: bool, pts_ms: u64) -> Result<Option<Encoded>, String> {
        if force_keyframe || self.force_next {
            self.enc.force_intra_frame();
            self.force_next = false;
        }
        let bs = self.enc.encode_at(pic, openh264::Timestamp::from_millis(pts_ms)).map_err(|e| format!("encode: {e}"))?;
        let ft = bs.frame_type();
        let data = bs.to_vec();
        match ft {
            FrameType::Skip | FrameType::Invalid => {
                // A forced keyframe that rate control threw away must be asked for again.
                if force_keyframe { self.force_next = true; }
                Ok(None)
            }
            _ if data.is_empty() => { if force_keyframe { self.force_next = true; } Ok(None) }
            FrameType::IDR | FrameType::I => Ok(Some(Encoded { keyframe: true, annex_b: data })),
            _ => Ok(Some(Encoded { keyframe: false, annex_b: data })),
        }
    }

    /// A new target bitrate on the running encoder (no keyframe needed).
    pub fn set_bitrate(&mut self, kbps: u32) {
        self.kbps = kbps;
        let mut info = openh264_sys2::SBitrateInfo { iLayer: openh264_sys2::SPATIAL_LAYER_ALL, iBitrate: (kbps * 1000) as i32 };
        let mut max = openh264_sys2::SBitrateInfo { iLayer: openh264_sys2::SPATIAL_LAYER_ALL, iBitrate: (kbps * 1000) as i32 };
        unsafe {
            let api = self.enc.raw_api();
            // The max has to go first when raising the target, or the encoder clamps the target to the old max.
            api.set_option(openh264_sys2::ENCODER_OPTION_MAX_BITRATE, (&raw mut max).cast());
            api.set_option(openh264_sys2::ENCODER_OPTION_BITRATE, (&raw mut info).cast());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::synthetic;

    fn nal_types(annex_b: &[u8]) -> Vec<u8> {
        openh264::nal_units(annex_b).map(|n| {
            let skip = if n.starts_with(&[0, 0, 0, 1]) { 4 } else { 3 };
            n[skip] & 0x1f
        }).collect()
    }

    #[test]
    fn the_first_frame_is_a_keyframe_with_its_parameter_sets_and_later_ones_are_not() {
        let mut e = H264::new(640, 360, 30, 2000, None).unwrap();
        let mut pic = I420::new(640, 360);
        synthetic::draw(&mut pic, 0, None);
        let first = e.encode(&pic, false, 0).unwrap().unwrap();
        assert!(first.keyframe);
        let types = nal_types(&first.annex_b);
        assert!(types.contains(&7) && types.contains(&8) && types.contains(&5), "SPS, PPS and IDR: {types:?}");
        let mut later = None;
        for i in 1..5 {
            synthetic::draw(&mut pic, i, None);
            if let Some(f) = e.encode(&pic, false, i * 33).unwrap() { later = Some(f); }
        }
        assert!(!later.expect("some frame gets through").keyframe);
        e.set_bitrate(500);
        synthetic::draw(&mut pic, 9, None);
        let mut key = None;
        for i in 0..10 {
            if let Some(f) = e.encode(&pic, i == 0, 400 + i * 33).unwrap() { key = Some(f); break; }
        }
        assert!(key.expect("the keyframe comes, even if rate control skips one").keyframe);
    }
}
