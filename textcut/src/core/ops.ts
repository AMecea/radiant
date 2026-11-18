/**
 * Processing applied to the cut, after the ranges are joined: crop, scale,
 * audio clean-up… Each op is a small declarative object that turns its params into
 * one ffmpeg filter. The export dialog renders its fields generically, so adding
 * an op means adding an entry to {@link OPS}, nothing else.
 *
 * Video ops see the frame size left by the ops before them (a crop changes what a
 * later scale works on), so they can emit exact pixel sizes.
 *
 * An op can also need files next to the command (captions: an .ass script and its
 * font). It gets what it needs to write them from {@link OpEnv}.
 */

import { ACCENTS, CAPTION_DEFAULTS, CAPTION_STYLES, FONTS, captionScript, type FontFile } from "./captions";
import type { TimeRange } from "./ranges";

export interface Frame {
  width: number;
  height: number;
}

export type Params = Record<string, string | number>;

/** What ops that write files need besides their params. */
export interface OpEnv {
  /** the transcript's words, source time (for captions) */
  words?: ReadonlyArray<{ s: number; e: number; w: string }>;
  /** transcript language */
  lang?: string;
  /** the cut's ranges, in output order */
  ranges: readonly TimeRange[];
  /** prefix for the files an op writes (e.g. "textcut_" → textcut_captions.ass) */
  tmp: string;
  /** directory the fonts go to */
  fontsDir: string;
}

export interface OpResult {
  filter: string;
  frame: Frame | null;
  /** extra output options */
  out?: string[];
  /** text files the filter reads, written before ffmpeg runs */
  files?: Array<{ path: string; text: string }>;
  /** fonts the filter needs in `OpEnv.fontsDir` */
  fonts?: FontFile[];
  notes?: string[];
}

export type Field =
  | { key: string; label: string; type: "select"; options: Array<[value: string, label: string]> }
  | { key: string; label: string; type: "range"; min: number; max: number; step: number; unit?: string };

export interface OpDef {
  id: string;
  label: string;
  help: string;
  stream: "video" | "audio";
  fields: Field[];
  defaults: Params;
  /**
   * The ffmpeg filter for these params, and the frame size it outputs. `frame` is
   * null when the source size isn't known (then emit an expression-based filter).
   * Returns null when the op is a no-op for this input. `out`: extra output options.
   */
  build(p: Params, frame: Frame | null, env?: OpEnv): OpResult | null;
}

/** One op as configured by the user. */
export interface OpState {
  id: string;
  on: boolean;
  p: Params;
}

const even = (x: number) => Math.max(2, 2 * Math.round(x / 2));
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

export const ASPECTS: Array<[string, string]> = [
  ["9:16", "9:16 — vertical (Reels, Shorts, TikTok)"],
  ["1:1", "1:1 — square"],
  ["4:5", "4:5 — portrait (feed)"],
  ["16:9", "16:9 — landscape"],
  ["4:3", "4:3"],
];

/** The crop rectangle (source pixels, even sizes) for crop params on a w×h frame. */
export function cropRect(p: Params, f: Frame): { w: number; h: number; x: number; y: number } {
  const [aw, ah] = String(p.aspect ?? "9:16").split(":").map(Number);
  const a = aw && ah ? aw / ah : f.width / f.height;
  const size = clamp(Number(p.size ?? 100), 5, 100) / 100;
  let w = f.width / f.height > a ? f.height * a : f.width;
  let h = w / a;
  w = Math.min(f.width - (f.width % 2), even(w * size));
  h = Math.min(f.height - (f.height % 2), even(h * size));
  const x = 2 * Math.floor(clamp(Number(p.cx ?? 0.5) * f.width - w / 2, 0, f.width - w) / 2);
  const y = 2 * Math.floor(clamp(Number(p.cy ?? 0.5) * f.height - h / 2, 0, f.height - h) / 2);
  return { w, h, x, y };
}

export const OPS: OpDef[] = [
  {
    id: "crop",
    label: "Crop",
    help: "Reframe to another aspect ratio. Drag the frame on the preview to position it.",
    stream: "video",
    fields: [
      { key: "aspect", label: "Aspect", type: "select", options: ASPECTS },
      { key: "size", label: "Size", type: "range", min: 20, max: 100, step: 1, unit: "%" },
      { key: "cx", label: "Horizontal centre", type: "range", min: 0, max: 1, step: 0.005 },
      { key: "cy", label: "Vertical centre", type: "range", min: 0, max: 1, step: 0.005 },
    ],
    defaults: { aspect: "9:16", size: 100, cx: 0.5, cy: 0.5 },
    build(p, f) {
      if (!f) {
        // Size unknown: let ffmpeg compute the biggest centred box of that aspect.
        const [aw, ah] = String(p.aspect).split(":").map(Number);
        if (!aw || !ah) return null;
        const r = `${aw}/${ah}`;
        return { filter: `crop=w=trunc(min(iw\\,ih*${r})/2)*2:h=trunc(min(ih\\,iw/(${r}))/2)*2`, frame: null };
      }
      const c = cropRect(p, f);
      if (c.w >= f.width - 1 && c.h >= f.height - 1) return null;
      return { filter: `crop=${c.w}:${c.h}:${c.x}:${c.y}`, frame: { width: c.w, height: c.h } };
    },
  },
  {
    id: "scale",
    label: "Resize",
    help: "Limit the output size (the shorter side). Never upscales.",
    stream: "video",
    fields: [{
      key: "short", label: "Shorter side", type: "select",
      options: [["2160", "2160 (4K)"], ["1440", "1440"], ["1080", "1080"], ["720", "720"], ["540", "540"], ["480", "480"]],
    }],
    defaults: { short: "1080" },
    build(p, f) {
      const s = Number(p.short) || 1080;
      if (!f) return { filter: `scale=w=-2:h=${s}`, frame: null };
      const short = Math.min(f.width, f.height);
      if (short <= s) return null;
      const k = s / short;
      const frame = { width: even(f.width * k), height: even(f.height * k) };
      return { filter: `scale=${frame.width}:${frame.height}:flags=lanczos`, frame };
    },
  },
  {
    id: "captions",
    label: "Captions",
    help: "Burn the transcript into the video as styled, word-timed captions (rendered by libass).",
    stream: "video",
    fields: [
      { key: "style", label: "Style", type: "select", options: CAPTION_STYLES.map((c) => [c.id, c.label]) },
      { key: "font", label: "Font", type: "select", options: [["", "Style default"], ...Object.keys(FONTS).map((f): [string, string] => [f, f])] },
      {
        key: "size", label: "Size (% of width)", type: "select",
        options: [["0", "Style default"], ...[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 20].map((n): [string, string] => [String(n), String(n)])],
      },
      { key: "accent", label: "Accent colour", type: "select", options: ACCENTS },
      { key: "y", label: "Position from top", type: "range", min: 5, max: 95, step: 1, unit: "%" },
      {
        key: "words", label: "Words per caption", type: "select",
        options: [["0", "Style default"], ["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"], ["6", "6"], ["8", "8"], ["12", "12"]],
      },
      { key: "case", label: "Case", type: "select", options: [["style", "Style default"], ["upper", "UPPER CASE"], ["asis", "As transcribed"]] },
    ],
    defaults: {
      style: CAPTION_DEFAULTS.style, font: CAPTION_DEFAULTS.font, size: String(CAPTION_DEFAULTS.size),
      accent: CAPTION_DEFAULTS.accent, y: 70, words: "0", case: "style",
    },
    build(p, f, env) {
      if (!env?.words?.length) return null;
      const notes: string[] = [];
      if (!f) notes.push("Video size unknown — captions are laid out for 1080×1920 and may look stretched.");
      const frame = f ?? { width: 1080, height: 1920 };
      const cap = captionScript(env.words, env.ranges, frame, {
        style: String(p.style), font: String(p.font ?? ""), size: Number(p.size), accent: String(p.accent), y: Number(p.y) / 100,
        words: Number(p.words), case: String(p.case), lang: env.lang,
      });
      if (!cap.count) return null;
      const path = `${env.tmp}captions.ass`;
      return {
        filter: `ass=filename=${filterArg(path)}:fontsdir=${filterArg(env.fontsDir)}`,
        frame: f, files: [{ path, text: cap.ass }], fonts: [cap.font], notes,
      };
    },
  },
  {
    id: "denoise",
    label: "Reduce noise",
    help: "Removes steady background noise (hum, fans, hiss) with ffmpeg's afftdn.",
    stream: "audio",
    fields: [{ key: "nr", label: "Strength", type: "select", options: [["6", "Light"], ["12", "Medium"], ["20", "Strong"]] }],
    defaults: { nr: "12" },
    build: (p) => ({ filter: `afftdn=nr=${Number(p.nr) || 12}:nf=-40`, frame: null }),
  },
  {
    id: "loudnorm",
    label: "Normalise loudness",
    help: "EBU R128 loudness normalisation (single pass).",
    stream: "audio",
    fields: [{
      key: "i", label: "Target", type: "select",
      options: [["-14", "−14 LUFS (YouTube, Spotify)"], ["-16", "−16 LUFS (podcasts)"], ["-23", "−23 LUFS (EBU broadcast)"]],
    }],
    defaults: { i: "-16" },
    // loudnorm outputs 192 kHz. Resample at the output: an aresample/aformat inside the
    // graph fails channel-layout negotiation for some (e.g. mono Opus) inputs.
    build: (p) => ({ filter: `loudnorm=I=${Number(p.i) || -16}:TP=-1.5:LRA=11`, frame: null, out: ["-ar", "48000"] }),
  },
];

export function opDef(id: string): OpDef | undefined {
  return OPS.find((o) => o.id === id);
}

/** Every known op, merged with the saved state (unknown ids dropped, new ops added off). */
export function normalizeOps(saved: readonly OpState[] | null | undefined): OpState[] {
  return OPS.map((d) => {
    const s = saved?.find((x) => x.id === d.id);
    return { id: d.id, on: !!s?.on, p: { ...d.defaults, ...(s?.p ?? {}) } };
  });
}

/** Escape a value for a filter option (`:` separates options, `'` and `\\` quote). */
export function filterArg(v: string): string {
  return v.replace(/[\\':]/g, (c) => `\\${c}`);
}

export interface OpChains {
  video: string[];
  audio: string[];
  frame: Frame | null;
  out: string[];
  files: Array<{ path: string; text: string }>;
  fonts: FontFile[];
  notes: string[];
}

/** Filter chains for the enabled ops, in registry order, and the final frame size. */
export function opFilters(ops: readonly OpState[], frame: Frame | null, withVideo: boolean, env?: OpEnv): OpChains {
  const r: OpChains = { video: [], audio: [], frame, out: [], files: [], fonts: [], notes: [] };
  for (const d of OPS) {
    const st = ops.find((o) => o.id === d.id);
    if (!st?.on || (d.stream === "video" && !withVideo)) continue;
    const b = d.build({ ...d.defaults, ...st.p }, r.frame, env);
    if (!b) continue;
    (d.stream === "video" ? r.video : r.audio).push(b.filter);
    if (b.out) r.out.push(...b.out);
    if (b.files) r.files.push(...b.files);
    if (b.fonts) for (const f of b.fonts) if (!r.fonts.some((x) => x.file === f.file)) r.fonts.push(f);
    if (b.notes) r.notes.push(...b.notes);
    if (d.stream === "video") r.frame = b.frame;
  }
  return r;
}
