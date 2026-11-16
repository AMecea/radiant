/** Minimal WAV reading/writing: enough to cut ranges out of a PCM .wav without
 *  decoding the whole file, and to write the result back out. */

export interface WavHeader {
  /** 1 = integer PCM, 3 = IEEE float */
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  /** byte offset of the first sample */
  dataOffset: number;
  dataSize: number;
}

/**
 * Parse a RIFF/WAVE header from the first bytes of a file (it needs everything up
 * to and including the `data` chunk header — a few KB is plenty in practice).
 * Returns null for anything that isn't uncompressed PCM/float WAV.
 */
export function parseWavHeader(bytes: Uint8Array): WavHeader | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) =>
    String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (dv.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let fmt: Omit<WavHeader, "dataOffset" | "dataSize"> | null = null;
  for (let o = 12; o + 8 <= dv.byteLength;) {
    const id = tag(o), size = dv.getUint32(o + 4, true);
    if (id === "fmt ") {
      let format = dv.getUint16(o + 8, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(o + 32, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = {
        format,
        channels: dv.getUint16(o + 10, true),
        sampleRate: dv.getUint32(o + 12, true),
        blockAlign: dv.getUint16(o + 20, true),
        bitsPerSample: dv.getUint16(o + 22, true),
      };
      if (format !== 1 && format !== 3) return null;
    } else if (id === "data") {
      return fmt ? { ...fmt, dataOffset: o + 8, dataSize: size } : null;
    }
    o += 8 + size + (size & 1);
  }
  return null;
}

/** Byte range [start, end) of the samples covering [s, e] seconds. */
export function wavByteRange(h: WavHeader, s: number, e: number): [number, number] {
  const frames = Math.floor(h.dataSize / h.blockAlign);
  const f0 = Math.max(0, Math.min(frames, Math.floor(s * h.sampleRate)));
  const f1 = Math.max(f0, Math.min(frames, Math.ceil(e * h.sampleRate)));
  return [h.dataOffset + f0 * h.blockAlign, h.dataOffset + f1 * h.blockAlign];
}

/** Interleaved PCM bytes → one Float32Array per channel. */
export function pcmToFloat(bytes: Uint8Array, h: WavHeader): Float32Array[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bps = h.bitsPerSample / 8, ch = h.channels;
  const frames = Math.floor(bytes.byteLength / h.blockAlign);
  const out = Array.from({ length: ch }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < ch; c++) {
      const o = f * h.blockAlign + c * bps;
      let v: number;
      if (h.format === 3) v = bps === 8 ? dv.getFloat64(o, true) : dv.getFloat32(o, true);
      else if (bps === 2) v = dv.getInt16(o, true) / 32768;
      else if (bps === 3) {
        let x = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
        if (x & 0x800000) x |= ~0xffffff;
        v = x / 8388608;
      } else if (bps === 4) v = dv.getInt32(o, true) / 2147483648;
      else v = (dv.getUint8(o) - 128) / 128;
      out[c]![f] = v;
    }
  }
  return out;
}

/**
 * Concatenate pieces (each: one Float32Array per channel) into a WAV file, with a
 * short fade at every cut so the joins don't click. 16-bit PCM, or 32-bit float.
 */
export function encodeWav(pieces: Float32Array[][], sampleRate: number, opts: { float?: boolean; fadeMs?: number } = {}): Uint8Array {
  const { float = false, fadeMs = 6 } = opts;
  if (!pieces.length) throw new Error("nothing to encode");
  const ch = pieces[0]!.length;
  const total = pieces.reduce((n, p) => n + p[0]!.length, 0);
  const bps = float ? 4 : 2;
  const dataBytes = total * ch * bps;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); dv.setUint32(4, 36 + dataBytes, true); w(8, "WAVE");
  w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, float ? 3 : 1, true);
  dv.setUint16(22, ch, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * ch * bps, true); dv.setUint16(32, ch * bps, true);
  dv.setUint16(34, bps * 8, true); w(36, "data"); dv.setUint32(40, dataBytes, true);
  let o = 44;
  const fade = Math.round((sampleRate * fadeMs) / 1000);
  for (const p of pieces) {
    const n = p[0]!.length, fn = Math.min(fade, n >> 1);
    for (let i = 0; i < n; i++) {
      const g = i < fn ? i / fn : i >= n - fn ? (n - 1 - i) / fn : 1;
      for (let c = 0; c < ch; c++) {
        const v = Math.max(-1, Math.min(1, p[c]![i]! * g));
        if (float) dv.setFloat32(o, v, true);
        else dv.setInt16(o, v < 0 ? v * 32768 : v * 32767, true);
        o += bps;
      }
    }
  }
  return new Uint8Array(buf);
}
