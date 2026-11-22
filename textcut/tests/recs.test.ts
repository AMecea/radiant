import { describe, expect, it } from "vitest";
import { parseTranscript } from "../src/core/transcript";
import { parseRecs, placeRecs, recsFile, siblingRecsUrl, snapToWords } from "../src/core/recs";
import { buildLink, packJson, readLink, unpackJson } from "../src/core/link";
import { moveEdge } from "../src/core/ranges";

// ten one-second words, half a second apart: word i spans [1.5 i, 1.5 i + 1]
const words = parseTranscript({
  segments: [{ words: Array.from({ length: 10 }, (_, i) => ({ start: i * 1.5, end: i * 1.5 + 1, word: `w${i}` })) }],
}).words;

describe("recommended clips", () => {
  it("reads the file form, best first", () => {
    const recs = parseRecs({
      v: 1,
      clips: [
        { title: "Second", score: 70, ranges: [[3, 6]] },
        { title: "First", score: 95, why: "strong hook", tags: ["question"], ranges: [[0, 2.5], [9, 11.5]] },
        { title: "Unscored", ranges: [[12, 14]] },
      ],
    });
    expect(recs.map((r) => r.title)).toEqual(["First", "Second", "Unscored"]);
    expect(recs[0]).toMatchObject({ score: 95, why: "strong hook", tags: ["question"] });
    expect(recs[0]!.ranges).toEqual([{ s: 0, e: 2.5 }, { s: 9, e: 11.5 }]);
    expect(recs[2]!.score).toBeNull();
  });

  it("is lenient about how a clip is written", () => {
    const recs = parseRecs(JSON.stringify([
      { name: "Clock times", start: "0:03", end: "0:06", reason: "because", tags: "a, b", score: 0.9 },
      { ranges: [{ start: 1, end: 2 }, "4-5.5", [7, 6], "nonsense"], score: 0.5 },
      { title: "No range at all" },
      "junk",
    ]));
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ title: "Clock times", why: "because", tags: ["a", "b"], score: 90, ranges: [{ s: 3, e: 6 }] });
    // fractions became percentages; the backwards and unreadable ranges are gone
    expect(recs[1]).toMatchObject({ title: "Clip 2", score: 50, ranges: [{ s: 1, e: 2 }, { s: 4, e: 5.5 }] });
    expect(() => parseRecs({ segments: [] })).toThrow(/recommendations/);
  });

  it("snaps a range to the words it means", () => {
    expect(snapToWords(words, { s: 3, e: 7 })).toEqual({ a: 2, b: 4 });       // exact word edges
    expect(snapToWords(words, { s: 2.8, e: 7.2 })).toEqual({ a: 2, b: 4 });   // in the gaps around them
    expect(snapToWords(words, { s: 3.3, e: 6.7 })).toEqual({ a: 2, b: 4 });   // a little inside them
    expect(snapToWords(words, { s: 3.6, e: 6.4 })).toEqual({ a: 3, b: 3 });   // mostly past the edge words
    expect(snapToWords(words, { s: 100, e: 110 })).toBeNull();
  });

  it("drops what falls outside the transcript", () => {
    const placed = placeRecs(parseRecs([
      { title: "In", ranges: [[0, 2.5], [200, 210]] },
      { title: "Out", ranges: [[200, 210]] },
    ]), words);
    expect(placed.map((r) => r.title)).toEqual(["In"]);
    expect(placed[0]!.parts).toEqual([{ a: 0, b: 1 }]);
  });

  it("travels in a link, by URL or packed", async () => {
    const recs = parseRecs([{ title: "Întârziere sau răbdare?", score: 91, why: "arc", tags: ["q"], ranges: [[21.361, 34.48]] }]);
    const rx = await packJson(recsFile(recs));
    const link = buildLink("https://h/t/", { words: "https://h/a.words.json", recs: "https://h/a.clips.json", rx });
    const back = readLink(new URL(link));
    expect(back.recs).toBe("https://h/a.clips.json");
    expect(parseRecs(await unpackJson(back.rx!))).toEqual([{ ...recs[0], ranges: [{ s: 21.36, e: 34.48 }] }]);
  });

  it("looks for the file next to the transcript", () => {
    expect(siblingRecsUrl("https://h/v/c0345.words.json")).toBe("https://h/v/c0345.clips.json");
    expect(siblingRecsUrl("https://h/v/c0345.words.json?v=2")).toBe("https://h/v/c0345.clips.json?v=2");
    expect(siblingRecsUrl("https://h/v/transcript.json")).toBeNull();
  });
});

describe("moving a segment's edge", () => {
  // w0 w1 w2. | w3 w4 [2 s pause] w5 w6 w7? | w8 w9   — "|" = sentence end
  const t = parseTranscript({
    segments: [{ words: ["w0", "w1", "w2.", "w3", "w4", "w5", "w6", "w7?", "w8", "w9"].map((word, i) => {
      const start = i * 1.5 + (i >= 5 ? 2 : 0);
      return { start, end: start + 1, word };
    }) }],
  }).words;

  it("moves by a word and never empties the range or leaves the transcript", () => {
    expect(moveEdge(t, { a: 3, b: 4 }, "end", 1)).toEqual({ a: 3, b: 5 });
    expect(moveEdge(t, { a: 3, b: 4 }, "end", -1)).toEqual({ a: 3, b: 3 });
    expect(moveEdge(t, { a: 3, b: 3 }, "end", -1)).toEqual({ a: 3, b: 3 });
    expect(moveEdge(t, { a: 3, b: 4 }, "start", -1)).toEqual({ a: 2, b: 4 });
    expect(moveEdge(t, { a: 4, b: 4 }, "start", 1)).toEqual({ a: 4, b: 4 });
    expect(moveEdge(t, { a: 0, b: 9 }, "start", -1)).toEqual({ a: 0, b: 9 });
    expect(moveEdge(t, { a: 0, b: 9 }, "end", 1)).toEqual({ a: 0, b: 9 });
  });

  it("moves by a phrase: to a sentence end or a pause", () => {
    expect(moveEdge(t, { a: 3, b: 3 }, "end", 1, 1)).toEqual({ a: 3, b: 4 });     // stops at the pause
    expect(moveEdge(t, { a: 3, b: 4 }, "end", 1, 1)).toEqual({ a: 3, b: 7 });     // on to the "?"
    expect(moveEdge(t, { a: 3, b: 7 }, "end", 1, 1)).toEqual({ a: 3, b: 9 });     // last words
    expect(moveEdge(t, { a: 3, b: 7 }, "end", -1, 1)).toEqual({ a: 3, b: 4 });    // back to the pause
    expect(moveEdge(t, { a: 6, b: 7 }, "start", -1, 1)).toEqual({ a: 5, b: 7 });  // start of the phrase
    expect(moveEdge(t, { a: 5, b: 7 }, "start", -1, 1)).toEqual({ a: 3, b: 7 });  // start of the sentence
    expect(moveEdge(t, { a: 3, b: 7 }, "start", -1, 1)).toEqual({ a: 0, b: 7 });
    expect(moveEdge(t, { a: 0, b: 7 }, "start", 1, 1)).toEqual({ a: 3, b: 7 });
    expect(moveEdge(t, { a: 3, b: 4 }, "start", 1, 1)).toEqual({ a: 4, b: 4 });   // can't pass the end
    // without the pause threshold reaching 2 s, only punctuation breaks
    expect(moveEdge(t, { a: 3, b: 3 }, "end", 1, 5)).toEqual({ a: 3, b: 7 });
  });
});
