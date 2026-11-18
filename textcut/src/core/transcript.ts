import { parseTime } from "./time";

export interface Word {
  /** start / end, seconds */
  s: number;
  e: number;
  /** the word as written (with punctuation) */
  w: string;
  /** Whisper confidence 0..1, null when unknown */
  p: number | null;
  /** true when timing was interpolated (segment-level .txt input) */
  approx: boolean;
  /** index into Transcript.segments */
  seg: number;
}

export interface Segment {
  s: number;
  e: number;
  /** inclusive word-index range */
  first: number;
  last: number;
}

export interface Transcript {
  language: string;
  duration: number;
  words: Word[];
  segments: Segment[];
}

/** radiant `transcribe … word_timestamps: true` output (<stem>.words.json). */
export interface WordsJson {
  language?: string;
  duration?: number;
  segments: Array<{
    start?: number;
    end?: number;
    text?: string;
    words?: Array<{ start: number; end: number; word: string; probability?: number | null }>;
  }>;
}

/** Compact form used when a transcript is embedded in a link. */
export interface CompactTranscript {
  v: 1;
  language?: string;
  duration?: number;
  /** [segStart, segEnd, [[wordStart, wordEnd, word, prob?], …]] */
  segs: Array<[number, number, Array<[number, number, string, number?]>]>;
}

interface RawWord {
  start: number;
  end: number;
  word: string;
  probability?: number | null;
  approx?: boolean;
}

/**
 * Normalise any supported transcript into a {@link Transcript}. Accepts radiant's
 * `<stem>.words.json`, the compact link form, a bare `[{start,end,word}]` list, and
 * radiant's segment-level `.txt` (`start\tend\ttext` lines — word times are
 * interpolated across each segment, so they're approximate).
 */
export function parseTranscript(input: unknown): Transcript {
  if (typeof input === "string") {
    const t = input.trim();
    if (t.startsWith("{") || t.startsWith("[")) return parseTranscript(JSON.parse(t));
    return fromSegments(parseSegmentTxt(t), {});
  }
  if (Array.isArray(input)) {
    return fromSegments([{ words: input as RawWord[] }], {});
  }
  if (isObject(input) && input.v === 1 && Array.isArray(input.segs)) {
    const c = input as unknown as CompactTranscript;
    return fromSegments(
      c.segs.map(([, , ws]) => ({
        words: ws.map(([s, e, w, p]) => ({ start: s, end: e, word: w, probability: p ?? null })),
      })),
      c,
    );
  }
  if (isObject(input) && Array.isArray(input.segments)) {
    const j = input as unknown as WordsJson;
    if (!j.segments.some((s) => Array.isArray(s.words) && s.words.length)) {
      throw new Error("This JSON has segments but no per-word timings — re-run the " +
                      "transcribe step with `word_timestamps: true`.");
    }
    return fromSegments(j.segments as Array<{ words?: RawWord[] }>, j);
  }
  throw new Error("Unrecognised transcript: expected a radiant .words.json " +
                  "({segments:[{words:[…]}]}) or a start<TAB>end<TAB>text .txt");
}

export function parseSegmentTxt(text: string): Array<{ words: RawWord[] }> {
  const segs: Array<{ words: RawWord[] }> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([\d.:]+)\s*\t\s*([\d.:]+)\s*\t(.*)$/);
    if (!m) continue;
    const start = parseTime(m[1]!), end = parseTime(m[2]!);
    const toks = m[3]!.trim().split(/\s+/).filter(Boolean);
    if (!toks.length || !(end > start)) continue;
    // Spread words across the segment, proportionally to their length.
    const weights = toks.map((w) => w.length + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let t = start;
    const words = toks.map((w, i): RawWord => {
      const d = ((end - start) * weights[i]!) / total;
      const rec = { start: t, end: t + d, word: w, probability: null, approx: true };
      t += d;
      return rec;
    });
    segs.push({ words });
  }
  if (!segs.length) throw new Error("No 'start<TAB>end<TAB>text' lines found");
  return segs;
}

function fromSegments(segments: Array<{ words?: RawWord[] }>, meta: { language?: string; duration?: number }): Transcript {
  const words: Word[] = [];
  const segs: Segment[] = [];
  for (const seg of segments) {
    const list = (seg.words ?? []).filter((w) => w && String(w.word ?? "").trim() !== "");
    if (!list.length) continue;
    const first = words.length;
    for (const w of list) {
      const s = num(w.start);
      let e = num(w.end);
      if (!(e >= s)) e = s;
      words.push({
        s, e,
        w: String(w.word).trim(),
        p: w.probability == null ? null : num(w.probability),
        approx: !!w.approx,
        seg: segs.length,
      });
    }
    segs.push({ s: words[first]!.s, e: words[words.length - 1]!.e, first, last: words.length - 1 });
  }
  // Whisper occasionally emits a word starting before its predecessor; keep
  // starts monotonic so binary search and the pause maths stay sane.
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!, prev = words[i - 1]!;
    if (w.s < prev.s) w.s = prev.s;
    if (w.e < w.s) w.e = w.s;
  }
  const lastEnd = words.length ? words[words.length - 1]!.e : 0;
  return {
    language: meta.language ?? "",
    duration: Math.max(num(meta.duration), lastEnd),
    words,
    segments: segs,
  };
}

/** Compact, link-friendly form (drops probabilities unless asked). */
export function compactTranscript(t: Transcript, keepProb = false): CompactTranscript {
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    v: 1,
    language: t.language,
    duration: r3(t.duration),
    segs: t.segments.map((sg) => [
      r3(sg.s),
      r3(sg.e),
      t.words.slice(sg.first, sg.last + 1).map((w): [number, number, string, number?] =>
        keepProb && w.p != null ? [r3(w.s), r3(w.e), w.w, Math.round(w.p * 100) / 100]
                                : [r3(w.s), r3(w.e), w.w]),
    ]),
  };
}

/** Index of the last word whose start <= t (-1 if t precedes every word). */
export function wordAt(words: readonly Word[], t: number): number {
  let lo = 0, hi = words.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid]!.s <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Whisper emits clitics and trailing punctuation as their own words ("m" "-am",
 * "într" "-o", "said" "."). Such a word attaches to the previous one with no space.
 */
export function gluesToPrev(w: string): boolean {
  return /^[-\u2010\u2011'’.,;:!?…)\]}»”]/.test(w);
}

/** The text of words a..b, spaced as it would be written. */
export function textOf(words: readonly Word[], a: number, b: number): string {
  let out = "";
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
    const w = words[i]!.w;
    if (!w) continue; // merged into a neighbour by a spelling fix
    out += out && !gluesToPrev(w) ? " " + w : w;
  }
  return out;
}

function num(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/** How the editor breaks the transcript into lines. */
export type LineMode =
  | "seg"       // the transcript's own segments
  | "sentence"  // at sentence ends
  | number;     // at sentence ends, and at most this many words per line

export interface Line {
  /** inclusive word-index range */
  first: number;
  last: number;
}

const SENTENCE_END = /[.?!…]["'»”)\]]*$/;

export function parseLineMode(v: unknown): LineMode {
  if (v === "sentence") return "sentence";
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : "seg";
}

/**
 * Lines of the transcript. With a word limit, a long sentence is split into
 * lines of about equal length (22 words at 10 → 8 + 7 + 7, not 10 + 10 + 2).
 */
export function transcriptLines(t: Pick<Transcript, "segments">, words: readonly Word[], mode: LineMode): Line[] {
  if (mode === "seg") return t.segments.map((s) => ({ first: s.first, last: s.last }));
  const out: Line[] = [];
  const max = mode === "sentence" ? Infinity : Math.max(1, mode);
  let start = 0;
  const flush = (end: number) => {
    const len = end - start + 1;
    const k = Math.max(1, Math.ceil(len / max));
    for (let j = 0; j < k; j++) {
      const a = start + Math.floor((j * len) / k), b = start + Math.floor(((j + 1) * len) / k) - 1;
      if (b >= a) out.push({ first: a, last: b });
    }
    start = end + 1;
  };
  for (let i = 0; i < words.length; i++) {
    if (SENTENCE_END.test(words[i]!.w) || i === words.length - 1) flush(i);
  }
  return out;
}
