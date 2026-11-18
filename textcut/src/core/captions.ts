/**
 * Burned-in captions: the transcript's words, retimed onto the cut, grouped into
 * short on-screen chunks and written as an ASS subtitle script that ffmpeg's `ass`
 * filter (libass) renders: real fonts, outlines, boxes, the spoken word highlighted,
 * karaoke fills, pop-in animation.
 *
 * Fonts are open-licensed (OFL), fetched from pinned jsDelivr URLs: the browser
 * writes them into ffmpeg.wasm's file system, the shell script and the radiant plan
 * download them next to the captions file (`fontsdir`).
 */

import type { TimeRange } from "./ranges";

/** A word in source time (the transcript's). */
export interface CaptionWord {
  s: number;
  e: number;
  w: string;
}

export interface Frame {
  width: number;
  height: number;
}

// ------------------------------------------------------------------ fonts

const GOOGLE = "https://cdn.jsdelivr.net/gh/google/fonts@7af0d90b4d532ffa4b041937b560c6df4e7b1e95/ofl/";
// Inter's static OTFs (4.x ships only woff2, which libass can't count on reading)
const INTER = "https://cdn.jsdelivr.net/gh/rsms/inter@v3.19/docs/font-files/";

interface FontDef {
  url: string;
  /**
   * line height (usWinAscent + usWinDescent) in em. libass sizes text so that this
   * height equals the ASS font size, so the same size looks very different across
   * fonts; we size in em and convert.
   */
  lh: number;
  /** average advance of upper / lower-case letters, in em (for line fitting) */
  upper: number;
  lower: number;
}

/** ASS font name (the font's family name) → where to get it and its metrics. */
export const FONTS: Record<string, FontDef> = {
  "Inter Black": { url: INTER + "Inter-Black.otf", lh: 1.2102, upper: 0.688, lower: 0.561 },
  "Poppins Black": { url: GOOGLE + "poppins/Poppins-Black.ttf", lh: 1.762, upper: 0.672, lower: 0.595 },
  "Poppins ExtraBold": { url: GOOGLE + "poppins/Poppins-ExtraBold.ttf", lh: 1.762, upper: 0.661, lower: 0.586 },
  "Poppins SemiBold": { url: GOOGLE + "poppins/Poppins-SemiBold.ttf", lh: 1.762, upper: 0.638, lower: 0.568 },
  "Anton": { url: GOOGLE + "anton/Anton-Regular.ttf", lh: 1.7334, upper: 0.452, lower: 0.444 },
};

export interface FontFile {
  /** file name inside the fonts directory */
  file: string;
  url: string;
}

const fontDef = (name: string): FontDef => FONTS[name] ?? FONTS["Poppins ExtraBold"]!;

export function fontFile(name: string): FontFile {
  const url = fontDef(name).url;
  return { file: url.split("/").pop()!, url };
}

// ------------------------------------------------------------------ styles

type Mode =
  | "highlight"  // the whole chunk shown, the word being spoken in the accent colour
  | "karaoke"    // words fill with the accent colour as they're spoken
  | "plain";     // the chunk as is

export interface CaptionStyle {
  id: string;
  label: string;
  font: string;
  /** letter size (em), as a fraction of the frame's shorter side */
  size: number;
  upper: boolean;
  mode: Mode;
  /** words / characters per caption (before the user's override) */
  words: number;
  chars: number;
  /** lines a caption may take; longer ones get fewer words */
  lines: number;
  /** drop , . ; : at word ends (keeps ? and !) */
  stripPunct: boolean;
  /** scale-in animation at each caption */
  pop: boolean;
  /** outline (or box padding) and shadow, in em */
  outline: number;
  shadow: number;
  /** text on a translucent box instead of an outline */
  box: boolean;
}

export const CAPTION_STYLES: CaptionStyle[] = [
  {
    id: "pop", label: "Bold pop — word highlight", font: "Poppins Black", size: 0.08, upper: true,
    mode: "highlight", words: 3, chars: 16, lines: 1, stripPunct: true, pop: true, outline: 0.17, shadow: 0.09, box: false,
  },
  {
    id: "word", label: "One word at a time", font: "Anton", size: 0.115, upper: true,
    mode: "plain", words: 1, chars: 14, lines: 1, stripPunct: true, pop: true, outline: 0.14, shadow: 0.07, box: false,
  },
  {
    id: "karaoke", label: "Karaoke fill", font: "Poppins ExtraBold", size: 0.057, upper: false,
    mode: "karaoke", words: 5, chars: 24, lines: 2, stripPunct: false, pop: false, outline: 0.16, shadow: 0.07, box: false,
  },
  {
    id: "box", label: "Clean subtitles on a box", font: "Poppins SemiBold", size: 0.034, upper: false,
    mode: "plain", words: 9, chars: 42, lines: 2, stripPunct: false, pop: false, outline: 0.62, shadow: 0, box: true,
  },
];

export const ACCENTS: Array<[string, string]> = [
  ["#FFB013", "Radiant yellow"],
  ["#FFE11A", "Yellow"],
  ["#3DFF6E", "Green"],
  ["#2EE6FF", "Cyan"],
  ["#FF4FA3", "Pink"],
  ["#FF8A1F", "Orange"],
  ["#FFFFFF", "White"],
];

export interface CaptionOptions {
  style: string;
  /** font family (a key of {@link FONTS}); "" = the style's */
  font: string;
  /** letter size in % of the frame's shorter side (10 → em = 10% of a 9:16 frame's width); 0 = the style's */
  size: number;
  /** vertical centre of the captions, 0 (top) … 1 (bottom) */
  y: number;
  /** accent colour, #RRGGBB */
  accent: string;
  /** max words per caption; 0 = the style's */
  words: number;
  /** "style" (the style's), "upper", "asis" */
  case: string;
  /** transcript language (for upper-casing: Turkish İ…) */
  lang?: string;
}

export const CAPTION_DEFAULTS: CaptionOptions = {
  style: "pop", font: "Inter Black", size: 10, y: 0.7, accent: "#FFB013", words: 0, case: "style",
};

export function captionStyle(id: string): CaptionStyle {
  return CAPTION_STYLES.find((s) => s.id === id) ?? CAPTION_STYLES[0]!;
}

// ------------------------------------------------------------------ timing

/** A word on the output timeline. */
export interface CueWord {
  s: number;
  e: number;
  w: string;
}

/**
 * The words heard in the cut, timed on its output timeline (ranges played back to
 * back, in the given order). A word belongs to the range holding its midpoint, and
 * is clipped to it.
 */
export function wordsOnCut(words: readonly CaptionWord[], ranges: readonly TimeRange[]): CueWord[] {
  const out: CueWord[] = [];
  let off = 0;
  for (const r of ranges) {
    // first word that ends after the range starts (words are in time order)
    let lo = 0, hi = words.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (words[m]!.e <= r.s) lo = m + 1; else hi = m;
    }
    for (let i = lo; i < words.length && words[i]!.s < r.e; i++) {
      const w = words[i]!;
      const mid = (w.s + w.e) / 2;
      if (mid < r.s || mid >= r.e) continue;
      const s = Math.max(w.s, r.s), e = Math.min(w.e, r.e);
      out.push({ s: off + s - r.s, e: off + Math.max(s, e) - r.s, w: w.w });
    }
    off += r.e - r.s;
  }
  return out;
}

export interface Chunk {
  words: CueWord[];
  /** when it's on screen */
  s: number;
  e: number;
}

const SENTENCE_END = /[.?!…]["'»”)]*$/;
const CLAUSE_END = /[,;:]["'»”)]*$/;

/** Group words into captions of at most `maxWords` words / `maxChars` characters. */
export function chunkWords(words: readonly CueWord[], maxWords: number, maxChars: number): Chunk[] {
  const groups: CueWord[][] = [];
  let cur: CueWord[] = [];
  let chars = 0;
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const brk = prev && (
      cur.length >= maxWords ||
      chars + 1 + w.w.length > maxChars ||
      w.s - prev.e > 0.45 ||
      SENTENCE_END.test(prev.w) ||
      // at a comma once the caption is about half full
      (CLAUSE_END.test(prev.w) && cur.length >= Math.max(2, Math.ceil(maxWords / 2))));
    if (brk) {
      groups.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(w);
    chars += (chars ? 1 : 0) + w.w.length;
  }
  if (cur.length) groups.push(cur);

  // On screen from the first word until the next caption — or, after a real
  // pause, a short hold after the last word.
  return groups.map((g, i) => {
    const s = g[0]!.s, last = g[g.length - 1]!.e;
    const next = groups[i + 1]?.[0]!.s ?? Infinity;
    let e = next - last < 0.6 ? next : Math.min(next, last + 0.3);
    e = Math.max(e, Math.min(next, s + 0.35)); // flashes are unreadable
    return { words: g, s, e };
  });
}

// ------------------------------------------------------------------ ASS

/** ASS time: H:MM:SS.cc */
export function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** #RRGGBB (+ alpha 0 = opaque … 255 = clear) → ASS &HAABBGGRR */
export function assColor(hex: string, alpha = 0): string {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  const [r, g, b] = m ? [m[1]!, m[2]!, m[3]!] : ["FF", "FF", "FF"];
  const a = Math.max(0, Math.min(255, Math.round(alpha))).toString(16).padStart(2, "0");
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/** #RRGGBB → the &HBBGGRR& form of inline colour tags (\1c…) */
export function assInlineColor(hex: string): string {
  return assColor(hex).replace(/^&H00/, "&H") + "&";
}

/** Text safe inside an ASS dialogue line (braces open override blocks). */
function assText(s: string): string {
  return s.replace(/[{}]/g, (c) => (c === "{" ? "(" : ")")).replace(/\\/g, "/").replace(/\s+/g, " ");
}

function display(w: string, st: CaptionStyle, upper: boolean, lang?: string): string {
  let s = st.stripPunct ? w.replace(/[.,;:…]+(["'»”)]*)$/, "$1") : w;
  if (upper) {
    try { s = s.toLocaleUpperCase(lang || undefined); } catch { s = s.toUpperCase(); }
  }
  return assText(s);
}

export interface CaptionScript {
  ass: string;
  /** the font the script uses */
  font: FontFile;
  /** number of captions */
  count: number;
}

/**
 * The ASS script for a cut. `frame` is the size of the video the captions are drawn
 * on (after crop / resize); everything is laid out in its pixels.
 */
export function captionScript(words: readonly CaptionWord[], ranges: readonly TimeRange[],
                              frame: Frame, o: Partial<CaptionOptions> = {}): CaptionScript {
  const opt = { ...CAPTION_DEFAULTS, ...o };
  const st = captionStyle(opt.style);
  const W = Math.round(frame.width), H = Math.round(frame.height);
  const unit = Math.min(W, H);
  const fontName = opt.font && FONTS[opt.font] ? opt.font : st.font;
  const font = fontDef(fontName);
  const em = unit * (Number(opt.size) > 0 ? clamp(Number(opt.size), 1, 50) / 100 : st.size);
  const size = Math.round(em * font.lh); // the ASS size that renders letters `em` tall
  const upper = opt.case === "upper" || (opt.case !== "asis" && st.upper);
  const maxWords = Number(opt.words) > 0 ? Number(opt.words) : st.words;
  const margin = Math.round(W * 0.07);
  // More words than the style's default → allow proportionally longer captions,
  // but no more than fits on the style's lines at this size.
  const perLine = (W - 2 * margin) / (em * (upper ? font.upper : font.lower));
  const maxChars = Math.max(4, Math.min(Math.max(st.chars, Math.round((st.chars / st.words) * maxWords)),
    Math.floor(perLine * st.lines)));
  const accent = /^#[0-9a-f]{6}$/i.test(opt.accent) ? opt.accent : CAPTION_DEFAULTS.accent;

  const white = assColor("#FFFFFF");
  const outlineW = Math.max(1, Math.round(em * st.outline));
  const shadowW = Math.round(em * st.shadow);
  const x = Math.round(W / 2), y = Math.round(H * clamp(Number(opt.y), 0.05, 0.95));

  // karaoke: SecondaryColour is the not-yet-sung text, PrimaryColour the sung.
  const primary = st.mode === "karaoke" ? assColor(accent) : white;
  const outlineC = st.box ? assColor("#000000", 0x60) : assColor("#000000");
  const style = [
    "Cap", fontName, size, primary, white, outlineC, assColor("#000000", 0x80),
    0, 0, 0, 0, 100, 100, 0, 0, st.box ? 3 : 1, outlineW, shadowW, 5, margin, margin, 0, 1,
  ].join(",");

  const shown = wordsOnCut(words, ranges).map((w) => ({ ...w, w: display(w.w, st, upper, opt.lang) }))
    .filter((w) => w.w.trim() !== "");
  const chunks = chunkWords(shown, maxWords, maxChars);

  const pos = `\\an5\\pos(${x},${y})`;
  const pop = st.pop ? "\\fscx78\\fscy78\\t(0,90,\\fscx106\\fscy106)\\t(90,150,\\fscx100\\fscy100)" : "";
  const fade = st.pop ? "" : "\\fad(60,40)";
  const hi = assInlineColor(accent), back = assInlineColor("#FFFFFF");
  const events: string[] = [];
  const ev = (s: number, e: number, tags: string, text: string) => {
    if (Math.round(e * 100) > Math.round(s * 100)) {
      events.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Cap,,0,0,0,,{${tags}}${text}`);
    }
  };

  for (const c of chunks) {
    const ws = c.words;
    if (st.mode === "highlight") {
      // One event per word: the same text, a different word lit. Event boundaries
      // are the word starts, so the line itself never blinks.
      ws.forEach((w, i) => {
        const s = i === 0 ? c.s : w.s;
        const e = i + 1 < ws.length ? ws[i + 1]!.s : c.e;
        const text = ws.map((v, k) => (k === i ? `{\\1c${hi}}${v.w}{\\1c${back}}` : v.w)).join(" ");
        ev(s, e, pos + (i === 0 ? pop : ""), text);
      });
    } else if (st.mode === "karaoke") {
      let t = c.s;
      const parts = ws.map((w) => {
        const gap = Math.round((w.s - t) * 100);
        const dur = Math.max(1, Math.round((w.e - Math.max(w.s, t)) * 100));
        t = Math.max(w.e, t);
        return (gap > 0 ? `{\\k${gap}}` : "") + `{\\kf${dur}}${w.w}`;
      });
      ev(c.s, c.e, pos + fade, parts.join(" "));
    } else {
      ev(c.s, c.e, pos + (pop || fade), ws.map((w) => w.w).join(" "));
    }
  }

  const ass = [
    "[Script Info]",
    "; captions by textcut",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: None",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, " +
      "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, " +
      "MarginL, MarginR, MarginV, Encoding",
    `Style: ${style}`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
  return { ass, font: fontFile(fontName), count: chunks.length };
}

const clamp = (v: number, a: number, b: number) => (Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : a);
