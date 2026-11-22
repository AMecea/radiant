import { parseTime } from "./time";
import type { TimeRange, WordRange } from "./ranges";
import type { Word } from "./transcript";

/**
 * Recommended clips: proposals for reels / shorts that somebody (a person, a script,
 * an LLM reading the transcript) wrote down for a recording. textcut only shows
 * them — play one, look at its words, turn it into a clip.
 *
 * The file is `<stem>.clips.json`, next to `<stem>.words.json`:
 *
 *   { "v": 1, "clips": [
 *     { "title": "Why hasn't he come yet?", "score": 92, "tags": ["question"],
 *       "why": "Opens on a question and answers it within the clip.",
 *       "ranges": [[14.2, 36.1], [1802.4, 1851.0]] } ] }
 *
 * `ranges` are seconds (or clock times) in the recording, played back to back; one
 * range is the usual case. They don't have to be exact: every range is snapped to
 * the words it covers.
 */
export interface Rec {
  title: string;
  /** 0–100, higher is better; null when the file gives none */
  score: number | null;
  /** why it would work as a reel */
  why: string;
  tags: string[];
  ranges: TimeRange[];
}

/** A recommendation matched to the transcript: its ranges as word ranges. */
export interface PlacedRec extends Rec {
  parts: WordRange[];
}

export interface RecsFile {
  v: 1;
  clips: Array<{ title: string; score?: number; why?: string; tags?: string[]; ranges: Array<[number, number]> }>;
}

function time(v: unknown): number {
  return typeof v === "number" || typeof v === "string" ? parseTime(v) : NaN;
}

function range(v: unknown): TimeRange | null {
  let s = NaN, e = NaN;
  if (Array.isArray(v)) [s, e] = [time(v[0]), time(v[1])];
  else if (typeof v === "string") {
    const m = v.match(/^\s*([\d.:]+)\s*-\s*([\d.:]+)\s*$/);
    if (m) [s, e] = [time(m[1]), time(m[2])];
  } else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    [s, e] = [time(o.s ?? o.start), time(o.e ?? o.end)];
  }
  return Number.isFinite(s) && Number.isFinite(e) && e > s ? { s, e } : null;
}

/**
 * Read a recommendations file (parsed JSON, or its text). Lenient about shape —
 * a bare list works, a single range can be `start` / `end` on the clip, `reason`
 * is read as `why` — and silent about clips it can't make sense of. Best first.
 */
export function parseRecs(input: unknown): Rec[] {
  if (typeof input === "string") return parseRecs(JSON.parse(input));
  const list: unknown = Array.isArray(input) ? input : (input as { clips?: unknown } | null)?.clips;
  if (!Array.isArray(list)) throw new Error("Not a recommendations file: expected { \"clips\": [ … ] }");
  const out: Rec[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const raw = Array.isArray(o.ranges) ? o.ranges : [o];
    const ranges = raw.map(range).filter((r): r is TimeRange => !!r);
    if (!ranges.length) continue;
    const score = typeof o.score === "number" && Number.isFinite(o.score) ? o.score : null;
    const tags = Array.isArray(o.tags) ? o.tags : typeof o.tags === "string" ? o.tags.split(",") : [];
    out.push({
      title: String(o.title ?? o.name ?? "").trim() || `Clip ${out.length + 1}`,
      score,
      why: String(o.why ?? o.reason ?? "").trim(),
      tags: tags.map((t) => String(t).trim()).filter(Boolean),
      ranges,
    });
  }
  // Scores given as 0–1 fractions are read as percentages.
  const frac = out.some((r) => r.score != null) && out.every((r) => r.score == null || (r.score >= 0 && r.score <= 1));
  for (const r of out) if (r.score != null) r.score = Math.round(Math.max(0, Math.min(100, frac ? r.score * 100 : r.score)));
  return out.map((r, i) => ({ r, i })).sort((x, y) => (y.r.score ?? -1) - (x.r.score ?? -1) || x.i - y.i).map((x) => x.r);
}

/**
 * The words a range means: from the first word that is mostly after `s` to the last
 * one that is mostly before `e`, so a time that lands inside a word (or in the gap
 * next to it) still picks the word that was meant.
 */
export function snapToWords(words: readonly Word[], r: TimeRange): WordRange | null {
  let a = -1, b = -1;
  for (let i = 0; i < words.length; i++) {
    const mid = (words[i]!.s + words[i]!.e) / 2;
    if (mid < r.s) continue;
    if (mid > r.e) break;
    if (a < 0) a = i;
    b = i;
  }
  return a < 0 ? null : { a, b };
}

/** Match recommendations to a transcript; those that cover no words are dropped. */
export function placeRecs(recs: readonly Rec[], words: readonly Word[]): PlacedRec[] {
  return recs.flatMap((r) => {
    const parts = r.ranges.map((x) => snapToWords(words, x)).filter((p): p is WordRange => !!p);
    return parts.length ? [{ ...r, parts }] : [];
  });
}

/** The file form of a list of recommendations (also what a link carries, packed). */
export function recsFile(recs: readonly Rec[]): RecsFile {
  return {
    v: 1,
    clips: recs.map((r) => ({
      title: r.title,
      ...(r.score != null ? { score: r.score } : {}),
      ...(r.why ? { why: r.why } : {}),
      ...(r.tags.length ? { tags: r.tags } : {}),
      ranges: r.ranges.map((x) => [+x.s.toFixed(2), +x.e.toFixed(2)] as [number, number]),
    })),
  };
}

/** Where a transcript's recommendations live by convention: `x.words.json` → `x.clips.json`. */
export function siblingRecsUrl(wordsUrl: string): string | null {
  const m = wordsUrl.match(/^([^?#]*)\.words\.json([?#].*)?$/i);
  return m ? `${m[1]}.clips.json${m[2] ?? ""}` : null;
}
