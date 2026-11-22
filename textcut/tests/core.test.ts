import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTranscript, compactTranscript, wordAt, textOf, type Transcript } from "../src/core/transcript";
import { findPauses, splitAtPauses, rangeOf, mergeRanges, wordsIn } from "../src/core/ranges";
import { buildSearchIndex, normalize, search } from "../src/core/search";
import { fmtTime, fmtShort, parseTime } from "../src/core/time";
import { formatClips } from "../src/core/formats";
import { buildLink, readLink, normalizeUrl, packJson, unpackJson, decodeRanges } from "../src/core/link";
import { encodeWav, parseWavHeader, pcmToFloat, wavByteRange } from "../src/core/wav";

const fixture = readFileSync(new URL("./fixtures/sample.words.json", import.meta.url), "utf8");

const mk = (spec: Array<[number, number, string]>): Transcript =>
  parseTranscript({ segments: [{ words: spec.map(([start, end, word]) => ({ start, end, word })) }] });

describe("parseTranscript", () => {
  it("reads radiant .words.json", () => {
    const t = parseTranscript(fixture);
    expect(t.language).toBe("ro");
    expect(t.duration).toBeGreaterThan(t.words.at(-1)!.e);
    expect(t.words.length).toBe(64);
    expect(t.segments[0]!.first).toBe(0);
    expect(t.words[0]!.w).toBe("Bună");
    for (let i = 1; i < t.words.length; i++) expect(t.words[i]!.s).toBeGreaterThanOrEqual(t.words[i - 1]!.s);
  });

  it("round-trips through the compact form", () => {
    const t = parseTranscript(fixture);
    const back = parseTranscript(compactTranscript(t));
    expect(back.words.map((w) => w.w)).toEqual(t.words.map((w) => w.w));
    expect(back.words[10]!.s).toBeCloseTo(t.words[10]!.s, 3);
    expect(back.segments.length).toBe(t.segments.length);
  });

  it("interpolates word times from a segment .txt", () => {
    const t = parseTranscript("0.000000\t2.000000\tab cd\n2.5\t3.5\tefg\n");
    expect(t.words.map((w) => w.w)).toEqual(["ab", "cd", "efg"]);
    expect(t.words[0]!.s).toBe(0);
    expect(t.words[1]!.e).toBeCloseTo(2);
    expect(t.words.every((w) => w.approx)).toBe(true);
  });

  it("explains a segments-only JSON", () => {
    expect(() => parseTranscript({ segments: [{ start: 0, end: 1, text: "x" }] })).toThrow(/word_timestamps/);
  });

  it("keeps starts monotonic", () => {
    const t = mk([[1, 2, "a"], [0.5, 0.4, "b"]]);
    expect(t.words[1]!.s).toBe(1);
    expect(t.words[1]!.e).toBe(1);
  });
});

describe("lookup & ranges", () => {
  const t = mk([[0.5, 1, "a"], [1, 1.5, "b"], [3, 3.5, "c"], [3.6, 4, "d"]]);

  it("wordAt", () => {
    expect(wordAt(t.words, 0.2)).toBe(-1);
    expect(wordAt(t.words, 1.2)).toBe(1);
    expect(wordAt(t.words, 2.5)).toBe(1);
    expect(wordAt(t.words, 9)).toBe(3);
  });

  it("findPauses includes leading and trailing silence", () => {
    const p = findPauses(t.words, 0.5, 6);
    expect(p.map((x) => [x.after, +x.d.toFixed(2)])).toEqual([[-1, 0.5], [1, 1.5], [3, 2]]);
  });

  it("splitAtPauses", () => {
    expect(splitAtPauses(t.words, 0, 3, 1)).toEqual([{ a: 0, b: 1 }, { a: 2, b: 3 }]);
    expect(splitAtPauses(t.words, 0, 3, 5)).toEqual([{ a: 0, b: 3 }]);
  });

  it("rangeOf pads but never into the neighbour", () => {
    expect(rangeOf(t.words, 2, 2, 0.2)).toEqual({ s: 2.8, e: 3.55 });
    expect(rangeOf(t.words, 0, 0, 1)).toEqual({ s: 0, e: 1 });
  });

  it("mergeRanges & wordsIn", () => {
    expect(mergeRanges([{ s: 3, e: 4 }, { s: 0, e: 1 }, { s: 0.5, e: 2 }])).toEqual([{ s: 0, e: 2 }, { s: 3, e: 4 }]);
    expect(wordsIn(t.words, 1.2, 3.1)).toEqual({ a: 1, b: 2 });
    expect(wordsIn(t.words, 2, 2.9)).toBeNull();
    expect(textOf(t.words, 2, 1)).toBe("b c");
  });
});

describe("search", () => {
  const t = mk([[0, 1, "Dumnezeu"], [1, 2, "ne-a"], [2, 3, "dat,"], [3, 4, "o"], [4, 5, "rugăciune."]]);
  const idx = buildSearchIndex(t.words);

  it("normalises diacritics and punctuation", () => {
    expect(normalize("Rugăciune.")).toBe("rugaciune");
    expect(normalize("ȘȚ-ăî")).toBe("stai");
  });
  it("finds within and across words", () => {
    expect(search(idx, "rug")).toEqual([{ a: 4, b: 4 }]);
    expect(search(idx, "nea dat")).toEqual([{ a: 1, b: 2 }]);
    expect(search(idx, "DUMNEZEU NE")).toEqual([{ a: 0, b: 1 }]);
    expect(search(idx, "zzz")).toEqual([]);
    expect(search(idx, "  ")).toEqual([]);
  });
  it("works on the fixture", () => {
    const f = parseTranscript(fixture);
    expect(search(buildSearchIndex(f.words), "iisus").length).toBeGreaterThan(1);
  });
});

describe("time", () => {
  it("formats and parses", () => {
    expect(fmtTime(83.45)).toBe("00:01:23.450");
    expect(fmtTime(3725.0005)).toBe("01:02:05.001");
    expect(fmtTime(83.45, "seconds")).toBe("83.450");
    expect(fmtShort(59.96)).toBe("1:00.0");
    expect(fmtShort(3723.4)).toBe("1:02:03.4");
    expect(parseTime("1:23.5")).toBe(83.5);
    expect(parseTime("00:01:23.5")).toBe(83.5);
    expect(parseTime("12")).toBe(12);
  });
});

describe("formats", () => {
  const clips = [{ s: 1, e: 2.5, text: "hello there" }, { s: 10, e: 12, text: 'say "x"' }];
  it("trim yaml", () => {
    const y = formatClips(clips, "trim-yaml", { input: "in.mp4" });
    expect(y).toContain('input: "in.mp4"');
    expect(y).toContain('- { start: "00:00:01.000", end: "00:00:02.500" }   # hello there');
    expect(formatClips(clips, "trim-yaml", { style: "seconds" })).toContain("- { start: 1.000, end: 2.500 }");
    const r = formatClips(clips, "radiant", { input: "in.mp4" });
    expect(r).toContain("action: ffmpeg");
    expect(r).toContain('input: "in.mp4"');
  });
  it("clip yaml / ffmpeg / csv / srt", () => {
    expect(formatClips(clips, "clip-yaml")).toContain("id: reel2");
    expect(formatClips([clips[0]!], "ffmpeg")).toContain("-ss 1.000 -t 1.500 -i");
    const ff = formatClips(clips, "ffmpeg");
    expect(ff).toContain("-ss 10.000 -t 2.000 -i INPUT.mp4");
    expect(ff).toContain("[0:v:0][a0][1:v:0][a1]concat=n=2:v=1:a=1[vc][ac]");
    expect(formatClips(clips, "ffmpeg", { hasVideo: false, output: "a.m4a", fade: 0 }))
      .toContain("-filter_complex '[0:a:0][1:a:0]concat=n=2:v=0:a=1[ac]'");
    expect(formatClips(clips, "csv")).toContain('"say ""x"""');
    expect(formatClips(clips, "srt")).toContain("00:00:01,500 --> 00:00:03,500");
  });
});

describe("links", () => {
  it("round-trips params through the fragment", () => {
    const url = buildLink("https://x.test/textcut/?a=1#old", {
      media: "https://cdn.test/a b.mp4", words: "https://cdn.test/a.words.json",
      clips: [{ s: 1, e: 2.5 }], sel: { s: 3, e: 4 }, at: 5.25, title: "T",
    });
    expect(url.startsWith("https://x.test/textcut/?a=1#title=T")).toBe(true);
    const u = new URL(url);
    const p = readLink({ search: u.search, hash: u.hash });
    expect(p.media).toBe("https://cdn.test/a b.mp4");
    expect(p.clips).toEqual([{ s: 1, e: 2.5 }]);
    expect(p.sel).toEqual({ s: 3, e: 4 });
    expect(p.at).toBe(5.25);
  });
  it("carries a full-quality original next to the preview media", () => {
    const url = buildLink("https://x.test/textcut/", {
      media: "https://cdn.test/talk_480p.mp4", full: "https://cdn.test/talk.mov", words: "w.json",
    });
    expect(url).toContain("media=https://cdn.test/talk_480p.mp4&full=https://cdn.test/talk.mov");
    const u = new URL(url);
    const p = readLink({ search: u.search, hash: u.hash });
    expect(p.media).toBe("https://cdn.test/talk_480p.mp4");
    expect(p.full).toBe("https://cdn.test/talk.mov");
    expect(readLink({ search: "", hash: "#words=w.json" }).full).toBeUndefined();
  });
  it("query works too, fragment wins", () => {
    const p = readLink({ search: "?media=q&at=1:00", hash: "#media=h" });
    expect(p.media).toBe("h");
    expect(p.at).toBe(60);
  });
  it("decodeRanges skips junk", () => {
    expect(decodeRanges("1-2,bad,5-3,1:00-1:02.5")).toEqual([{ s: 1, e: 2 }, { s: 60, e: 62.5 }]);
  });
  it("normalizeUrl", () => {
    expect(normalizeUrl("https://github.com/u/r/blob/main/a.json")).toBe("https://raw.githubusercontent.com/u/r/main/a.json");
    expect(normalizeUrl("https://www.dropbox.com/scl/fi/abc/a.mp3?rlkey=k&dl=0"))
      .toBe("https://dl.dropboxusercontent.com/scl/fi/abc/a.mp3?rlkey=k");
    expect(normalizeUrl("https://drive.google.com/file/d/XYZ/view?usp=sharing"))
      .toBe("https://drive.google.com/uc?export=download&id=XYZ");
    expect(normalizeUrl(" https://e.test/a.mp4 ")).toBe("https://e.test/a.mp4");
  });
  it("packs a transcript compactly", async () => {
    const t = parseTranscript(fixture);
    const packed = await packJson(compactTranscript(t));
    expect(packed.length).toBeLessThan(fixture.length / 5);
    expect(packed).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = parseTranscript(await unpackJson(packed));
    expect(back.words.length).toBe(t.words.length);
  });
});

describe("wav", () => {
  it("encodes, parses and slices", () => {
    const sr = 1000;
    const ch0 = new Float32Array(2000).map((_, i) => Math.sin(i / 10) * 0.5);
    const ch1 = ch0.map((v) => -v);
    const bytes = encodeWav([[ch0, ch1]], sr, { fadeMs: 0 });
    const h = parseWavHeader(bytes)!;
    expect(h).toMatchObject({ format: 1, channels: 2, sampleRate: 1000, bitsPerSample: 16, dataOffset: 44, dataSize: 8000 });
    const [a, b] = wavByteRange(h, 0.5, 1);
    expect([a, b]).toEqual([44 + 500 * 4, 44 + 1000 * 4]);
    const back = pcmToFloat(bytes.subarray(a, b), h);
    expect(back[0]!.length).toBe(500);
    expect(back[0]![10]!).toBeCloseTo(ch0[510]!, 3);
    expect(back[1]![10]!).toBeCloseTo(ch1[510]!, 3);
  });
  it("float output and fades", () => {
    const one = new Float32Array(100).fill(1);
    const bytes = encodeWav([[one], [one]], 1000, { float: true, fadeMs: 10 });
    const h = parseWavHeader(bytes)!;
    expect(h.format).toBe(3);
    const f = pcmToFloat(bytes.subarray(h.dataOffset), h)[0]!;
    expect(f.length).toBe(200);
    expect(f[0]).toBe(0);
    expect(f[50]).toBe(1);
    expect(f[100]).toBe(0); // second piece fades in again
  });
  it("rejects non-wav", () => {
    expect(parseWavHeader(new Uint8Array(64))).toBeNull();
  });
});

describe("clitics", () => {
  const t = mk([[0, 1, "Și"], [1, 2, "m"], [2, 2.2, "-am"], [2.2, 3, "gândit"], [3, 3.5, "într"], [3.5, 3.8, "-o"], [3.8, 4, "zi."]]);
  it("textOf glues them", () => {
    expect(textOf(t.words, 0, 6)).toBe("Și m-am gândit într-o zi.");
  });
  it("search matches the written form", () => {
    const idx = buildSearchIndex(t.words);
    expect(search(idx, "m-am gandit")).toEqual([{ a: 1, b: 3 }]);
    expect(search(idx, "intr-o zi")).toEqual([{ a: 4, b: 6 }]);
    expect(search(idx, "si m")).toEqual([{ a: 0, b: 1 }]);
  });
});
