import type { Word } from "./transcript";
import { mergeRanges, type TimeRange } from "./ranges";

/**
 * Text-based edits: what the user struck out of the transcript.
 *
 *  - `words`: indices of deleted words.
 *  - `gaps`:  deleted silences, keyed like {@link Pause.after}: the index of the word
 *             before the gap; -1 is the leading silence, `words.length - 1` the trailing one.
 *
 * Edits never touch the media; they're turned into time ranges to remove, and the
 * cut is everything else ({@link keptRanges}).
 */
export interface Edits {
  words: ReadonlySet<number>;
  gaps: ReadonlySet<number>;
}

export interface CutParams {
  /** seconds of air kept next to every surviving word, so cuts don't clip syllables */
  pad: number;
  /** a deleted pause is shortened to this many seconds (not removed outright) */
  pauseKeep: number;
  /** media duration; the end of the timeline */
  duration: number;
}

export const NO_EDITS: Edits = { words: new Set(), gaps: new Set() };

export function hasEdits(ed: Edits): boolean {
  return ed.words.size > 0 || ed.gaps.size > 0;
}

/**
 * Time ranges removed by the edits, merged and sorted.
 *
 * A run of deleted words takes the silence around it with it: the cut runs from
 * `pad` after the previous surviving word to `pad` before the next one (and always
 * covers the deleted words themselves). A run at the very start/end trims the head/tail.
 * A deleted pause is shortened to `pauseKeep` (at least 2×pad), centred in the gap.
 */
export function removedRanges(words: readonly Word[], ed: Edits, p: CutParams): TimeRange[] {
  const n = words.length;
  if (!n) return [];
  const dur = Math.max(p.duration || 0, words[n - 1]!.e);
  const out: TimeRange[] = [];

  for (let i = 0; i < n; i++) {
    if (!ed.words.has(i)) continue;
    let j = i;
    while (j + 1 < n && ed.words.has(j + 1)) j++;
    const s = i > 0 ? Math.min(words[i - 1]!.e + p.pad, words[i]!.s) : 0;
    const e = j < n - 1 ? Math.max(words[j + 1]!.s - p.pad, words[j]!.e) : dur;
    if (e > s) out.push({ s, e });
    i = j;
  }

  const keep = Math.max(p.pauseKeep, 2 * p.pad);
  for (const g of ed.gaps) {
    if (g === -1) {
      const e = words[0]!.s - p.pad;
      if (e > 0.001) out.push({ s: 0, e });
    } else if (g === n - 1) {
      const s = words[n - 1]!.e + p.pad;
      if (dur - s > 0.001) out.push({ s, e: dur });
    } else if (g >= 0 && g < n - 1) {
      const a = words[g]!.e, b = words[g + 1]!.s;
      if (b - a > keep + 0.001) out.push({ s: a + keep / 2, e: b - keep / 2 });
    }
  }
  return mergeRanges(out);
}

/**
 * `keep` minus `cut`, preserving the order of `keep` (clips may be reordered).
 * `cut` must be sorted and non-overlapping ({@link mergeRanges}). Slivers shorter
 * than `minLen` are dropped — they'd only be audible as clicks.
 */
export function subtractRanges(keep: readonly TimeRange[], cut: readonly TimeRange[], minLen = 0.04): TimeRange[] {
  const out: TimeRange[] = [];
  for (const k of keep) {
    let s = k.s;
    for (const c of cut) {
      if (c.e <= s) continue;
      if (c.s >= k.e) break;
      if (c.s > s) out.push({ s, e: c.s });
      s = Math.max(s, c.e);
    }
    if (k.e > s) out.push({ s, e: k.e });
  }
  return out.filter((r) => r.e - r.s >= minLen);
}

/** The edited cut: the whole timeline minus what the edits removed. */
export function keptRanges(words: readonly Word[], ed: Edits, p: CutParams): TimeRange[] {
  const dur = Math.max(p.duration || 0, words.length ? words[words.length - 1]!.e : 0);
  return subtractRanges([{ s: 0, e: dur }], removedRanges(words, ed, p));
}

/** The removal containing t, by binary search over sorted ranges. */
export function rangeAt(ranges: readonly TimeRange[], t: number): TimeRange | null {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, r = ranges[mid]!;
    if (t < r.s) hi = mid - 1;
    else if (t >= r.e) lo = mid + 1;
    else return r;
  }
  return null;
}

// ------------------------------------------------------------ (de)serialising

/** [1,2,3,7,9,10] → "1-3,7,9-10" */
export function encodeIdx(xs: Iterable<number>): string {
  const v = [...new Set(xs)].filter((x) => Number.isInteger(x) && x >= 0).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < v.length; i++) {
    let j = i;
    while (j + 1 < v.length && v[j + 1] === v[j]! + 1) j++;
    parts.push(j > i ? `${v[i]}-${v[j]}` : String(v[i]));
    i = j;
  }
  return parts.join(",");
}

export function decodeIdx(s: string): number[] {
  const out: number[] = [];
  for (const p of s.split(",")) {
    const m = p.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    if (b - a > 1e6) continue;
    for (let i = a; i <= b; i++) out.push(i);
  }
  return out;
}

/** Link/storage form. Gaps are stored +1 so the leading silence (-1) becomes 0. */
export interface PackedEdits {
  dw?: string;
  dg?: string;
}

export function packEdits(ed: Edits): PackedEdits {
  const out: PackedEdits = {};
  if (ed.words.size) out.dw = encodeIdx(ed.words);
  if (ed.gaps.size) out.dg = encodeIdx([...ed.gaps].map((g) => g + 1));
  return out;
}

export function unpackEdits(p: PackedEdits | null | undefined, nWords: number): Edits {
  const words = new Set(decodeIdx(p?.dw ?? "").filter((i) => i < nWords));
  const gaps = new Set(decodeIdx(p?.dg ?? "").map((g) => g - 1).filter((g) => g < nWords));
  return { words, gaps };
}
