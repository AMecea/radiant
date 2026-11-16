import { gluesToPrev, type Word } from "./transcript";
import type { WordRange } from "./ranges";

/** Lowercase, strip diacritics (ș→s, ă→a, é→e…) and punctuation. */
export function normalize(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export interface SearchIndex {
  /** every word normalised, separated by one space (none before a glued clitic) */
  text: string;
  /** char offset in `text` where word i starts */
  starts: number[];
}

export function buildSearchIndex(words: readonly Word[]): SearchIndex {
  let text = "";
  const starts: number[] = new Array(words.length);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!.w;
    if (i > 0 && gluesToPrev(w) && text.endsWith(" ")) text = text.slice(0, -1);
    starts[i] = text.length;
    text += normalize(w) + " ";
  }
  return { text, starts };
}

/**
 * Every match of `query` as a word range. Matching is diacritic-, case- and
 * punctuation-insensitive and may span words ("dumnezeu ne" finds "Dumnezeu ne").
 * A query matches anywhere inside a word ("rug" finds "rugăciune").
 */
export function search(index: SearchIndex, query: string): WordRange[] {
  const q = query.split(/\s+/).map(normalize).filter(Boolean).join(" ");
  if (!q) return [];
  const toWord = (c: number) => {
    let lo = 0, hi = index.starts.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (index.starts[mid]! <= c) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  };
  const hits: WordRange[] = [];
  for (let from = 0; ;) {
    const at = index.text.indexOf(q, from);
    if (at < 0) break;
    const h = { a: toWord(at), b: toWord(at + q.length - 1) };
    const prev = hits[hits.length - 1];
    if (!prev || prev.a !== h.a || prev.b !== h.b) hits.push(h);
    from = at + 1;
  }
  return hits;
}
