//! The pipe between roost.exe and its Node host (docs/PROTOCOL.md, "App ⇄ host process (IPC)").
//!
//! Every frame is `[u32 big-endian length of the rest][u8 type][payload]`, so either side can split a byte stream
//! back into frames however the operating system chopped it up.
use serde_json::Value;

pub const IPC_VERSION: u32 = 1;
/// The host sends small JSON, except a clipboard picture from the viewer (at most 20 MB, as base64). Anything
/// bigger means the stream is out of step, and the app restarts the host rather than buffer without limit.
pub const MAX_INCOMING_FRAME: usize = 40 << 20;

pub mod kind {
    pub const HELLO: u8 = 0x01; // app → host, JSON
    pub const VIDEO: u8 = 0x02; // app → host, u8 flags · u64 BE pts µs · Annex-B access unit
    pub const AUDIO: u8 = 0x03; // app → host, u64 BE pts µs · one Opus packet
    pub const EVENT: u8 = 0x04; // app → host, JSON
    pub const COMMAND: u8 = 0x10; // host → app, JSON
    pub const INPUT: u8 = 0x11; // host → app, JSON input message
    pub const MIC: u8 = 0x12; // host → app, u16 BE sequence · one Opus packet
}

pub fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.extend_from_slice(&((payload.len() as u32 + 1).to_be_bytes()));
    out.push(kind);
    out.extend_from_slice(payload);
    out
}

pub fn video_payload(keyframe: bool, pts_us: u64, annex_b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(9 + annex_b.len());
    out.push(keyframe as u8);
    out.extend_from_slice(&pts_us.to_be_bytes());
    out.extend_from_slice(annex_b);
    out
}

pub fn audio_payload(pts_us: u64, packet: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + packet.len());
    out.extend_from_slice(&pts_us.to_be_bytes());
    out.extend_from_slice(packet);
    out
}

pub fn json(v: &Value) -> Vec<u8> {
    serde_json::to_vec(v).unwrap_or_else(|_| b"{}".to_vec())
}

/// Parses a JSON object payload; None for anything that isn't one.
pub fn parse_object(data: &[u8]) -> Option<serde_json::Map<String, Value>> {
    match serde_json::from_slice::<Value>(data) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    }
}

#[derive(Debug, PartialEq)]
pub enum ParseError {
    TooLarge(usize),
    Empty,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::TooLarge(n) => write!(f, "frame of {n} bytes is larger than the {MAX_INCOMING_FRAME}-byte limit"),
            ParseError::Empty => write!(f, "frame with no type byte"),
        }
    }
}

/// Splits a byte stream into frames, keeping a partial frame until the rest arrives.
pub struct FrameParser {
    max: usize,
    buf: Vec<u8>,
    start: usize,
}

impl Default for FrameParser {
    fn default() -> Self { Self::new(MAX_INCOMING_FRAME) }
}

impl FrameParser {
    pub fn new(max: usize) -> Self { Self { max, buf: Vec::new(), start: 0 } }

    pub fn buffered(&self) -> usize { self.buf.len() - self.start }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<(u8, Vec<u8>)>, ParseError> {
        self.buf.extend_from_slice(chunk);
        let mut frames = Vec::new();
        while self.buf.len() - self.start >= 4 {
            let s = self.start;
            let len = u32::from_be_bytes([self.buf[s], self.buf[s + 1], self.buf[s + 2], self.buf[s + 3]]) as usize;
            if len == 0 { return Err(ParseError::Empty); }
            if len > self.max { return Err(ParseError::TooLarge(len)); }
            if self.buf.len() - s < 4 + len { break; }
            frames.push((self.buf[s + 4], self.buf[s + 5..s + 4 + len].to_vec()));
            self.start += 4 + len;
        }
        // Drop consumed bytes once they make up most of the buffer, so a long session doesn't grow it forever.
        if self.start > 0 && self.start * 2 >= self.buf.len() {
            self.buf.drain(..self.start);
            self.start = 0;
        }
        Ok(frames)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_however_the_bytes_are_split() {
        let mut stream = frame(kind::COMMAND, br#"{"c":"keyframe"}"#);
        stream.extend(frame(kind::INPUT, br#"{"t":"rel"}"#));
        stream.extend(frame(kind::MIC, &[0, 1, 0xfc, 0xff]));
        for step in [1, 2, 3, 7, stream.len()] {
            let mut p = FrameParser::default();
            let mut got = Vec::new();
            for chunk in stream.chunks(step) { got.extend(p.push(chunk).unwrap()); }
            assert_eq!(got.len(), 3, "step {step}");
            assert_eq!(got[0], (kind::COMMAND, br#"{"c":"keyframe"}"#.to_vec()));
            assert_eq!(got[2], (kind::MIC, vec![0, 1, 0xfc, 0xff]));
            assert_eq!(p.buffered(), 0);
        }
    }

    #[test]
    fn oversized_and_empty_frames_are_refused() {
        let mut p = FrameParser::new(10);
        assert_eq!(p.push(&[0, 0, 0, 11, 1]).unwrap_err(), ParseError::TooLarge(11));
        let mut p = FrameParser::default();
        assert_eq!(p.push(&[0, 0, 0, 0]).unwrap_err(), ParseError::Empty);
    }

    #[test]
    fn payloads_have_the_documented_layout() {
        let v = video_payload(true, 0x0102, &[9, 9]);
        assert_eq!(v, vec![1, 0, 0, 0, 0, 0, 0, 1, 2, 9, 9]);
        let a = audio_payload(5, &[7]);
        assert_eq!(a, vec![0, 0, 0, 0, 0, 0, 0, 5, 7]);
        assert_eq!(&frame(kind::EVENT, b"{}")[..5], &[0, 0, 0, 3, kind::EVENT]);
    }
}
