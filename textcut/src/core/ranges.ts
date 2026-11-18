import type { Word } from "./transcript";

export interface TimeRange {
  s: number;
  e: number;
}

export interface WordRange {
  /** inclusive word indices */
  a: number;
  b: number;
}

export interface Pause extends TimeRange {
  /** index of the word before the gap; -1 = leading silence */
  after: number;
  /** duration, seconds */
  d: number;
}

/**
 * Silences of at least `min` seconds: before the first word, between words, and
 * after the last word (when the media duration is known). Detected purely from the
 * word timings — Whisper sometimes stretches a word over a short silence, so very
 * short pauses can be under-reported.
 */
export function findPauses(words: readonly Word[], min: number, duration = 0): Pause[] {
  const out: Pause[] = [];
  if (!words.length) return out;
  const first = words[0]!, last = words[words.length - 1]!;
  if (first.s >= min) out.push({ after: -1, s: 0, e: first.s, d: first.s });
  for (let i = 0; i < words.length - 1; i++) {
    const d = words[i + 1]!.s - words[i]!.e;
    if (d >= min) out.push({ after: i, s: words[i]!.e, e: words[i + 1]!.s, d });
  }
  if (duration && duration - last.e >= min) {
    out.push({ after: words.length - 1, s: last.e, e: duration, d: duration - last.e });
  }
  return out;
}

/** Split the word range [a, b] wherever the gap between words is >= minPause. */
export function splitAtPauses(words: readonly Word[], a: number, b: number, minPause: number): WordRange[] {
  const out: WordRange[] = [];
  let start = a;
  for (let i = a; i < b; i++) {
    if (words[i + 1]!.s - words[i]!.e >= minPause) {
      out.push({ a: start, b: i });
      start = i + 1;
    }
  }
  out.push({ a: start, b });
  return out;
}

/**
 * Time span of words a..b, widened by `pad` seconds each side — but never past the
 * midpoint of the gap to the neighbouring word, and clamped to [0, duration].
 */
export function rangeOf(words: readonly Word[], a: number, b: number, pad = 0, duration = Infinity): TimeRange {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const wl = words[lo]!, wh = words[hi]!;
  let s = wl.s - pad, e = wh.e + pad;
  if (lo > 0) s = Math.max(s, Math.min(wl.s, (words[lo - 1]!.e + wl.s) / 2));
  if (hi < words.length - 1) e = Math.min(e, Math.max(wh.e, (wh.e + words[hi + 1]!.s) / 2));
  return { s: Math.max(0, s), e: Math.min(duration || Infinity, e) };
}

/** Merge overlapping or touching ranges; output sorted by start. */
export function mergeRanges(ranges: readonly TimeRange[], eps = 0.001): TimeRange[] {
  const sorted = ranges.map((x) => ({ s: x.s, e: x.e })).sort((x, y) => x.s - y.s);
  const out: TimeRange[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.s <= last.e + eps) last.e = Math.max(last.e, x.e);
    else out.push(x);
  }
  return out;
}

/** Word indices whose span overlaps [s, e]. Returns null if none. */
export function wordsIn(words: readonly Word[], s: number, e: number): WordRange | null {
  let a = -1, b = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.e > s && w.s < e) {
      if (a < 0) a = i;
      b = i;
    } else if (w.s >= e) break;
  }
  return a < 0 ? null : { a, b };
}

/**
 * The part of a cut (ranges played back to back) between output times `from` and
 * `from + dur`, as source ranges — e.g. a few seconds of it, for a preview render.
 */
export function sliceOutput(ranges: readonly TimeRange[], from: number, dur: number): TimeRange[] {
  const out: TimeRange[] = [];
  const end = from + dur;
  let t = 0;
  for (const r of ranges) {
    const d = r.e - r.s;
    const a = Math.max(from, t), b = Math.min(end, t + d);
    if (b - a > 0.001) out.push({ s: r.s + (a - t), e: r.s + (b - t) });
    t += d;
    if (t >= end) break;
  }
  return out;
}
