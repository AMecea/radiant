/**
 * Just enough of the OpenType / TrueType format to use somebody's own font for
 * captions: its family name (what the ASS script asks libass for) and the metrics
 * the caption layout needs (see FontDef in captions.ts).
 */

export interface FontInfo {
  /** family name (name ID 1), as libass matches it */
  family: string;
  /** line height (usWinAscent + usWinDescent) in em */
  lh: number;
  /** average advance of upper / lower-case letters, in em */
  upper: number;
  lower: number;
}

const tag = (d: DataView, o: number) => String.fromCharCode(d.getUint8(o), d.getUint8(o + 1), d.getUint8(o + 2), d.getUint8(o + 3));

/** Read a .ttf / .otf file. Throws with a message for the user when it can't be used. */
export function parseFontFile(bytes: Uint8Array): FontInfo {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (d.byteLength < 12) throw new Error("That file is not a font.");
  const kind = tag(d, 0);
  if (kind === "wOFF" || kind === "wOF2") throw new Error("Web fonts (.woff / .woff2) can't be burned in — use the .ttf or .otf version.");
  if (kind === "ttcf") throw new Error("Font collections (.ttc) aren't supported — use a single .ttf or .otf.");
  if (kind !== "OTTO" && kind !== "true" && d.getUint32(0) !== 0x00010000) throw new Error("That file is not a .ttf or .otf font.");

  const tables = new Map<string, { off: number; len: number }>();
  const n = d.getUint16(4);
  for (let i = 0; i < n && 12 + 16 * i + 16 <= d.byteLength; i++) {
    const r = 12 + 16 * i;
    tables.set(tag(d, r), { off: d.getUint32(r + 8), len: d.getUint32(r + 12) });
  }
  const need = (t: string) => {
    const x = tables.get(t);
    if (!x || x.off + x.len > d.byteLength) throw new Error(`The font is missing its '${t}' table.`);
    return x;
  };

  try {
    const upm = d.getUint16(need("head").off + 18) || 1000;
    const hhea = need("hhea").off;
    const os2 = tables.get("OS/2");
    const height = os2 && os2.len >= 78
      ? d.getUint16(os2.off + 74) + d.getUint16(os2.off + 76)
      : d.getInt16(hhea + 4) - d.getInt16(hhea + 6);
    const lh = height / upm;

    const glyph = cmapLookup(d, need("cmap").off);
    const nH = d.getUint16(hhea + 34), hmtx = need("hmtx").off;
    const advance = (g: number) => (nH ? d.getUint16(hmtx + 4 * Math.min(g, nH - 1)) : 0);
    const avg = (from: string, fallback: number) => {
      let sum = 0, k = 0;
      for (let c = from.charCodeAt(0); c < from.charCodeAt(0) + 26; c++) {
        const g = glyph(c);
        if (g) { sum += advance(g); k++; }
      }
      const v = k ? sum / k / upm : fallback;
      return v > 0.1 && v < 2 ? v : fallback;
    };

    const family = familyName(d, need("name").off);
    if (!family) throw new Error("The font has no family name.");
    return { family, lh: lh > 0.5 && lh < 4 ? lh : 1.4, upper: avg("A", 0.66), lower: avg("a", 0.56) };
  } catch (e) {
    if (e instanceof RangeError) throw new Error("The font file is damaged or cut short.");
    throw e;
  }
}

/** A character-code → glyph-index function from the font's best Unicode cmap. */
function cmapLookup(d: DataView, cmap: number): (c: number) => number {
  let best = -1, rank = -1;
  for (let i = 0, n = d.getUint16(cmap + 2); i < n; i++) {
    const r = cmap + 4 + 8 * i;
    const plat = d.getUint16(r), enc = d.getUint16(r + 2), off = cmap + d.getUint32(r + 4);
    const fmt = d.getUint16(off);
    if (fmt !== 4 && fmt !== 12) continue;
    const score = plat === 3 && enc === 10 ? 4 : plat === 3 && enc === 1 ? 3 : plat === 0 ? 2 : -1;
    if (score > rank) { rank = score; best = off; }
  }
  if (best < 0) return () => 0;
  if (d.getUint16(best) === 12) {
    const n = d.getUint32(best + 12);
    return (c) => {
      for (let i = 0; i < n; i++) {
        const g = best + 16 + 12 * i, start = d.getUint32(g);
        if (c < start) break;
        if (c <= d.getUint32(g + 4)) return d.getUint32(g + 8) + (c - start);
      }
      return 0;
    };
  }
  const segs = d.getUint16(best + 6) / 2;
  const ends = best + 14, starts = ends + 2 * segs + 2, deltas = starts + 2 * segs, offsets = deltas + 2 * segs;
  return (c) => {
    for (let i = 0; i < segs; i++) {
      if (d.getUint16(ends + 2 * i) < c) continue;
      const start = d.getUint16(starts + 2 * i);
      if (start > c) return 0;
      const delta = d.getUint16(deltas + 2 * i), ro = d.getUint16(offsets + 2 * i);
      if (!ro) return (c + delta) & 0xffff;
      const g = d.getUint16(offsets + 2 * i + ro + 2 * (c - start));
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  };
}

/** Name ID 1, preferring the Windows English record. */
function familyName(d: DataView, name: number): string {
  const count = d.getUint16(name + 2), strings = name + d.getUint16(name + 4);
  let best = "", rank = -1;
  for (let i = 0; i < count; i++) {
    const r = name + 6 + 12 * i;
    if (d.getUint16(r + 6) !== 1) continue;
    const plat = d.getUint16(r), lang = d.getUint16(r + 4), len = d.getUint16(r + 8), off = strings + d.getUint16(r + 10);
    const score = plat === 3 ? (lang === 0x409 ? 3 : 2) : plat === 0 ? 1 : 0;
    if (score <= rank) continue;
    let s = "";
    if (plat === 1) for (let k = 0; k < len; k++) s += String.fromCharCode(d.getUint8(off + k));
    else for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(d.getUint16(off + k));
    if (s.trim()) { best = s.trim(); rank = score; }
  }
  return best;
}
