// H.264 over RTP (RFC 6184, packetization-mode 1). werift can unpack H.264 but has no packetizer, so this is ours:
// small NAL units go out as they are, runs of small ones (SPS + PPS + SEI before a keyframe) share one STAP-A
// packet, and big ones are cut into FU-A fragments of at most `mtu` bytes. The last packet of a frame carries the
// RTP marker bit so the browser knows the frame is complete. Ported from the spike in .reference/webrtc-media.

export const NAL = Object.freeze({ SLICE: 1, IDR: 5, SEI: 6, SPS: 7, PPS: 8, AUD: 9, STAP_A: 24, FU_A: 28 });
export const nalType = nal => nal[0] & 0x1f;
const isVcl = t => t >= 1 && t <= 5;

// Splits an Annex-B byte stream (00 00 01 / 00 00 00 01 start codes) into NAL units without their start codes.
export function splitAnnexB(buf) {
  const nals = [];
  const n = buf.length;
  let i = 0, start = -1;
  while (i + 2 < n) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        // The extra zero of a 4-byte start code belongs to the start code, not the NAL before it.
        while (end > start && buf[end - 1] === 0) end--;
        if (end > start) nals.push(buf.subarray(start, end));
      }
      i += 3;
      start = i;
      continue;
    }
    i++;
  }
  if (start >= 0 && start < n) nals.push(buf.subarray(start, n));
  return nals;
}

// Groups NAL units into access units (frames): a new one starts at an AUD, at SPS/PPS/SEI after a slice, or at a
// slice whose first_mb_in_slice is 0 after a slice. Used for test fixtures; the app sends whole access units.
export function groupAccessUnits(nals) {
  const aus = [];
  let cur = { nals: [], keyframe: false };
  let sawVcl = false;
  const flush = () => {
    if (cur.nals.length) aus.push(cur);
    cur = { nals: [], keyframe: false };
    sawVcl = false;
  };
  for (const nal of nals) {
    const t = nalType(nal);
    if (t === NAL.AUD) { flush(); continue; }
    if (sawVcl && (t === NAL.SPS || t === NAL.PPS || t === NAL.SEI)) flush();
    if (isVcl(t)) {
      if (sawVcl && (nal[1] & 0x80) !== 0) flush();
      sawVcl = true;
      if (t === NAL.IDR) cur.keyframe = true;
    }
    cur.nals.push(nal);
  }
  flush();
  return aus;
}

// Returns [{payload: Buffer, marker: boolean}] for one access unit.
export function packetizeAccessUnit(nals, { mtu = 1200 } = {}) {
  const out = [];
  const list = nals.filter(n => n.length > 0 && nalType(n) !== NAL.AUD);
  let i = 0;
  while (i < list.length) {
    const nal = list[i];
    if (nal.length > mtu) {
      // FU-A: the NAL header is replaced by an FU indicator (F + NRI, type 28) and an FU header (S, E, type).
      const indicator = (nal[0] & 0xe0) | NAL.FU_A;
      const type = nal[0] & 0x1f;
      const maxFrag = mtu - 2;
      for (let off = 1; off < nal.length; off += maxFrag) {
        const len = Math.min(maxFrag, nal.length - off);
        const p = Buffer.allocUnsafe(2 + len);
        p[0] = indicator;
        p[1] = (off === 1 ? 0x80 : 0) | (off + len >= nal.length ? 0x40 : 0) | type;
        p.set(nal.subarray(off, off + len), 2);
        out.push({ payload: p, marker: false });
      }
      i++;
      continue;
    }
    // STAP-A: aggregate this NAL and the small ones that follow while they fit.
    let size = 1 + 2 + nal.length;
    let j = i + 1;
    while (j < list.length && list[j].length <= mtu && size + 2 + list[j].length <= mtu) {
      size += 2 + list[j].length;
      j++;
    }
    if (j - i >= 2) {
      const p = Buffer.allocUnsafe(size);
      let nri = 0, f = 0;
      for (let k = i; k < j; k++) { nri = Math.max(nri, list[k][0] & 0x60); f |= list[k][0] & 0x80; }
      p[0] = f | nri | NAL.STAP_A;
      let o = 1;
      for (let k = i; k < j; k++) {
        p.writeUInt16BE(list[k].length, o);
        p.set(list[k], o + 2);
        o += 2 + list[k].length;
      }
      out.push({ payload: p, marker: false });
      i = j;
      continue;
    }
    out.push({ payload: Buffer.from(nal), marker: false });
    i++;
  }
  if (out.length) out[out.length - 1].marker = true;
  return out;
}

// Reverses packetizeAccessUnit (used by tests and the soft viewer).
export function depacketize(payloads) {
  const nals = [];
  let fu = null;
  for (const p of payloads) {
    const t = p[0] & 0x1f;
    if (t >= 1 && t <= 23) nals.push(p);
    else if (t === NAL.STAP_A) {
      for (let o = 1; o + 2 <= p.length;) {
        const l = p.readUInt16BE(o);
        nals.push(p.subarray(o + 2, o + 2 + l));
        o += 2 + l;
      }
    } else if (t === NAL.FU_A) {
      if (p[1] & 0x80) fu = [Buffer.of((p[0] & 0xe0) | (p[1] & 0x1f))];
      if (!fu) continue;
      fu.push(p.subarray(2));
      if (p[1] & 0x40) { nals.push(Buffer.concat(fu)); fu = null; }
    }
  }
  return nals;
}
