// Video and sound that came over the Worker relay (shared/wsrelay.js), turned into an ordinary MediaStream, so the
// viewer (viewer/viewer.js) shows it exactly as it shows a WebRTC stream.
//
// Video: H.264 access units → WebCodecs VideoDecoder → a canvas → canvas.captureStream(). Sound: Opus packets →
// WebCodecs AudioDecoder → an AudioContext → a MediaStreamAudioDestinationNode's track. A browser without AudioDecoder
// still gets the picture, without sound.

const MAX_DECODE_QUEUE = 4;   // frames waiting to decode before we skip ahead to the next keyframe
const AUDIO_LEAD_S = 0.04;     // how far ahead of "now" sound is scheduled
const AUDIO_MAX_LAG_S = 0.25;  // more queued than this and we drop back to "now" (latency beats smoothness here)

export function relayMediaSupported() {
  return typeof globalThis.VideoDecoder === 'function' && typeof globalThis.EncodedVideoChunk === 'function'
    && typeof globalThis.HTMLCanvasElement?.prototype.captureStream === 'function';
}

// "avc1.PPCCLL" from the SPS in an Annex-B access unit, or null when it has none.
export function codecFromAnnexB(data) {
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    let at;
    if (data[i + 2] === 1) at = i + 3;
    else if (data[i + 2] === 0 && data[i + 3] === 1) at = i + 4;
    else continue;
    if (at + 3 < data.length && (data[at] & 0x1f) === 7) {
      const hex = b => b.toString(16).padStart(2, '0');
      return `avc1.${hex(data[at + 1])}${hex(data[at + 2])}${hex(data[at + 3])}`;
    }
    i = at - 1;
  }
  return null;
}

export class RelayMedia {
  constructor({ log = () => {}, onKeyframeNeeded = () => {} } = {}) {
    this.log = log;
    this.onKeyframeNeeded = onKeyframeNeeded;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 16;
    this.canvas.height = 16;
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.stream = this.canvas.captureStream();
    this.decoder = null;
    this.codec = null;
    this.waitKey = true;
    this.closed = false;
    this.stats = { frames: 0, decoded: 0, skipped: 0, audio: 0 };
    this.audio = null;
    if (typeof globalThis.AudioDecoder === 'function' && typeof globalThis.AudioContext === 'function') {
      try { this._startAudio(); } catch (e) { this.log(`relay sound unavailable: ${e.message}`); this.audio = null; }
    }
  }

  _startAudio() {
    const ac = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    const dest = ac.createMediaStreamDestination();
    const decoder = new AudioDecoder({
      output: d => this._play(d),
      error: e => this.log(`relay sound: ${e.message}`),
    });
    decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
    this.audio = { ac, dest, decoder, playAt: 0 };
    this.stream.addTrack(dest.stream.getAudioTracks()[0]);
    ac.resume?.().catch(() => {});
  }

  // One H.264 access unit: {keyframe, ptsUs, data}.
  video({ keyframe, ptsUs, data }) {
    if (this.closed) return;
    this.stats.frames++;
    if (keyframe) {
      const codec = codecFromAnnexB(data) ?? this.codec ?? 'avc1.42e01f';
      if (!this.decoder || this.decoder.state === 'closed' || codec !== this.codec) this._configure(codec);
      this.waitKey = false;
    } else if (this.waitKey || !this.decoder) {
      this.stats.skipped++;
      return;
    } else if (this.decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      // Falling behind (a slow device): skip to the next keyframe rather than show a picture seconds late.
      this.stats.skipped++;
      this.waitKey = true;
      this.onKeyframeNeeded();
      return;
    }
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: keyframe ? 'key' : 'delta', timestamp: ptsUs, data }));
    } catch (e) {
      this.log(`relay video: ${e.message}`);
      this._reset();
    }
  }

  _configure(codec) {
    try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); } catch {}
    this.codec = codec;
    this.decoder = new VideoDecoder({
      output: frame => this._draw(frame),
      error: e => { this.log(`relay video decoder: ${e.message}`); this._reset(); },
    });
    // No description: the access units are Annex B, as the Mac sends them.
    this.decoder.configure({ codec, optimizeForLatency: true });
  }

  _reset() {
    try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); } catch {}
    this.decoder = null;
    this.waitKey = true;
    if (!this.closed) this.onKeyframeNeeded();
  }

  _draw(frame) {
    try {
      if (this.closed) return;
      const w = frame.displayWidth, h = frame.displayHeight;
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
      this.ctx.drawImage(frame, 0, 0, w, h);
      this.stats.decoded++;
    } finally {
      frame.close();
    }
  }

  // A batch of Opus packets: [{ptsUs, data}].
  audioPackets(packets) {
    if (this.closed || !this.audio) return;
    for (const p of packets) {
      try {
        this.audio.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: p.ptsUs, data: p.data }));
        this.stats.audio++;
      } catch (e) {
        this.log(`relay sound: ${e.message}`);
        return;
      }
    }
  }

  _play(data) {
    try {
      const a = this.audio;
      if (!a || this.closed) return;
      const frames = data.numberOfFrames, channels = data.numberOfChannels;
      const buffer = a.ac.createBuffer(channels, frames, data.sampleRate);
      for (let c = 0; c < channels; c++) {
        const plane = new Float32Array(frames);
        data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        buffer.copyToChannel(plane, c);
      }
      const now = a.ac.currentTime;
      if (a.playAt < now + 0.005 || a.playAt > now + AUDIO_MAX_LAG_S) a.playAt = now + AUDIO_LEAD_S;
      const src = a.ac.createBufferSource();
      src.buffer = buffer;
      src.connect(a.dest);
      src.start(a.playAt);
      a.playAt += buffer.duration;
    } catch (e) {
      this.log(`relay sound: ${e.message}`);
    } finally {
      data.close();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); } catch {}
    if (this.audio) {
      try { if (this.audio.decoder.state !== 'closed') this.audio.decoder.close(); } catch {}
      try { this.audio.ac.close(); } catch {}
    }
    for (const t of this.stream.getTracks()) { try { t.stop(); } catch {} }
  }
}
