import { gluesToPrev, type Word } from "./transcript";
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
  /** corrected spellings: word index → text (the timing stays the word's) */
  fixes?: ReadonlyMap<number, string>;
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
  /** spelling fixes, see {@link encodeFixes} */
  fx?: string;
}

export function packEdits(ed: Edits): PackedEdits {
  const out: PackedEdits = {};
  if (ed.words.size) out.dw = encodeIdx(ed.words);
  if (ed.gaps.size) out.dg = encodeIdx([...ed.gaps].map((g) => g + 1));
  if (ed.fixes?.size) out.fx = encodeFixes(ed.fixes);
  return out;
}

export function unpackEdits(p: PackedEdits | null | undefined, nWords: number): Edits & { fixes: Map<number, string> } {
  const words = new Set(decodeIdx(p?.dw ?? "").filter((i) => i < nWords));
  const gaps = new Set(decodeIdx(p?.dg ?? "").map((g) => g - 1).filter((g) => g < nWords));
  const fixes = new Map([...decodeFixes(p?.fx ?? "")].filter(([i]) => i < nWords));
  return { words, gaps, fixes };
}

// ------------------------------------------------------------ spelling fixes

// "~" separates an index from its text, "|" separates entries; both (and "%")
// are percent-escaped inside the text, everything else is left as typed.
const escFix = (s: string) => s.replace(/[%|~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** {3 → "Kenobi", 10 → "a|b"} → "3~Kenobi|10~a%7Cb" */
export function encodeFixes(fixes: ReadonlyMap<number, string>): string {
  return [...fixes].sort(([a], [b]) => a - b).map(([i, t]) => `${i}~${escFix(t)}`).join("|");
}

export function decodeFixes(s: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const part of s ? s.split("|") : []) {
    const k = part.indexOf("~");
    const i = Number(part.slice(0, k));
    if (k < 1 || !Number.isInteger(i) || i < 0) continue;
    try { out.set(i, decodeURIComponent(part.slice(k + 1))); } catch { out.set(i, part.slice(k + 1)); }
  }
  return out;
}

/**
 * New text typed over `n` words → one text per word. The same number of words
 * maps one to one; otherwise the words are spread evenly over the old timings
 * (fewer words than before leaves some empty: they're merged into a neighbour).
 */
export function spreadText(text: string, n: number): string[] {
  const toks = text.trim().split(/\s+/).filter(Boolean);
  const m = toks.length;
  if (m === n) return toks;
  return Array.from({ length: n }, (_, k) => toks.slice(Math.floor((k * m) / n), Math.floor(((k + 1) * m) / n)).join(" "));
}

/**
 * New text typed over the words `old` → one text per word, moving as little as
 * possible: every word left as it was keeps its place (and so its timing), and
 * only the stretches that changed are spread over the words they replace (see
 * {@link spreadText}). That is what lets a long passage be fixed in one go: a
 * word added near its start doesn't shift the rest.
 */
export function spreadEdit(old: readonly string[], text: string): string[] {
  const toks = text.trim().split(/\s+/).filter(Boolean);
  // What reads as one word: a word with the clitics / punctuation glued to it and
  // the words emptied into it (textOf writes those without a space).
  const units: { a: number; n: number; text: string }[] = [];
  old.forEach((w, i) => {
    const u = units[units.length - 1];
    if (u && (!w || !u.text || gluesToPrev(w))) { u.n++; u.text += w; }
    else units.push({ a: i, n: 1, text: w });
  });
  const out = [...old];
  let ui = 0, ti = 0;
  /** units ui..u2-1 were replaced by the words ti..t2-1 */
  const replace = (u2: number, t2: number): void => {
    const typed = toks.slice(ti, t2);
    if (u2 > ui) {
      const a = units[ui]!.a, last = units[u2 - 1]!;
      if (typed.join(" ") === units.slice(ui, u2).map((u) => u.text).join(" ")) return;
      spreadText(typed.join(" "), last.a + last.n - a).forEach((t, k) => { out[a + k] = t; });
    } else if (typed.length) {
      // typed where no word was: they ride on a neighbour, the one before if there is one
      const p = units[ui - 1];
      const i = p ? p.a + p.n - 1 : 0;
      out[i] = (p ? [out[i]!, ...typed] : [...typed, out[i]!]).filter(Boolean).join(" ");
    }
  };
  for (const [u, t] of [...sameWords(units.map((x) => x.text), toks), [units.length, toks.length] as const]) {
    replace(u, t);
    ui = u + 1;
    ti = t + 1;
  }
  return out;
}

/**
 * The words two texts share, in order: [index in a, index in b] pairs (a longest
 * common subsequence). The same start and end are taken as they are; a middle too
 * long to compare is left unmatched.
 */
function sameWords(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length, m = b.length;
  let head = 0;
  while (head < n && head < m && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < n - head && tail < m - head && a[n - 1 - tail] === b[m - 1 - tail]) tail++;
  const pairs: [number, number][] = [];
  for (let i = 0; i < head; i++) pairs.push([i, i]);
  const N = n - head - tail, M = m - head - tail, W = M + 1;
  if (N && M && N * M <= 1e6) {
    const len = new Uint16Array((N + 1) * W); // len[i, j]: shared words in a[i..], b[j..]
    for (let i = N - 1; i >= 0; i--) {
      for (let j = M - 1; j >= 0; j--) {
        len[i * W + j] = a[head + i] === b[head + j]
          ? len[(i + 1) * W + j + 1]! + 1
          : Math.max(len[(i + 1) * W + j]!, len[i * W + j + 1]!);
      }
    }
    for (let i = 0, j = 0; i < N && j < M;) {
      if (a[head + i] === b[head + j]) pairs.push([head + i++, head + j++]);
      else if (len[(i + 1) * W + j]! >= len[i * W + j + 1]!) i++;
      else j++;
    }
  }
  for (let k = tail; k > 0; k--) pairs.push([n - k, m - k]);
  return pairs;
}
