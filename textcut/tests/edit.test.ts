import { describe, expect, it } from "vitest";
import { parseTranscript, type Transcript } from "../src/core/transcript";
import {
  decodeIdx, encodeIdx, keptRanges, packEdits, rangeAt, removedRanges, subtractRanges, unpackEdits, type Edits,
} from "../src/core/edits";
import { buildJob, jobToShell, outputExt, shQuote } from "../src/core/ffjob";
import { cropRect, normalizeOps, opFilters } from "../src/core/ops";
import { buildLink, readLink } from "../src/core/link";

const mk = (spec: Array<[number, number, string]>): Transcript =>
  parseTranscript({ segments: [{ words: spec.map(([start, end, word]) => ({ start, end, word })) }] });

//            0            1             2             3            4
const t = mk([[1, 1.5, "a"], [1.6, 2, "um"], [2.1, 2.5, "b"], [5, 5.5, "c"], [5.6, 6, "d"]]);
const P = { pad: 0.05, pauseKeep: 0.3, duration: 8 };
const ed = (words: number[], gaps: number[] = []): Edits => ({ words: new Set(words), gaps: new Set(gaps) });

describe("text edits → removed ranges", () => {
  it("cuts a word together with the silence around it, keeping the padding", () => {
    const r = removedRanges(t.words, ed([1]), P);
    expect(r).toHaveLength(1);
    expect(r[0]!.s).toBeCloseTo(1.55); // a.e + pad
    expect(r[0]!.e).toBeCloseTo(2.05); // b.s - pad
  });

  it("merges a run of words into one cut", () => {
    expect(removedRanges(t.words, ed([1, 2]), P)).toEqual([{ s: 1.55, e: 4.95 }]);
  });

  it("always covers the deleted word, even when the padding overlaps it", () => {
    const tight = mk([[0, 1, "x"], [1, 2, "y"], [2, 3, "z"]]);
    expect(removedRanges(tight.words, ed([1]), { ...P, pad: 0.2 })).toEqual([{ s: 1, e: 2 }]);
  });

  it("trims the head and tail", () => {
    expect(removedRanges(t.words, ed([0]), P)[0]).toEqual({ s: 0, e: 1.55 });
    expect(removedRanges(t.words, ed([4]), P).at(-1)).toEqual({ s: 5.55, e: 8 });
  });

  it("shortens a deleted pause to pauseKeep, centred", () => {
    const [r] = removedRanges(t.words, ed([], [2]), P);
    expect(r!.s).toBeCloseTo(2.65);
    expect(r!.e).toBeCloseTo(4.85);
    // too short to shorten
    expect(removedRanges(t.words, ed([], [0]), P)).toEqual([]);
  });

  it("removes leading / trailing silence down to the padding", () => {
    expect(removedRanges(t.words, ed([], [-1, 4]), P)).toEqual([{ s: 0, e: 0.95 }, { s: 6.05, e: 8 }]);
  });

  it("keeps the complement", () => {
    const k = keptRanges(t.words, ed([1], [2]), P);
    expect(k.map((r) => [+r.s.toFixed(2), +r.e.toFixed(2)])).toEqual([[0, 1.55], [2.05, 2.65], [4.85, 8]]);
  });

  it("subtracts cuts from clips in clip order", () => {
    const cut = [{ s: 2, e: 3 }, { s: 10, e: 11 }];
    expect(subtractRanges([{ s: 9, e: 12 }, { s: 1, e: 4 }], cut)).toEqual([
      { s: 9, e: 10 }, { s: 11, e: 12 }, { s: 1, e: 2 }, { s: 3, e: 4 },
    ]);
    expect(subtractRanges([{ s: 2.01, e: 2.99 }], cut)).toEqual([]);
  });

  it("rangeAt", () => {
    const rs = [{ s: 1, e: 2 }, { s: 4, e: 5 }];
    expect(rangeAt(rs, 1.5)).toBe(rs[0]);
    expect(rangeAt(rs, 2)).toBeNull();
    expect(rangeAt(rs, 4)).toBe(rs[1]);
  });

  it("packs edits for links and storage", () => {
    expect(encodeIdx([5, 1, 2, 3, 9, 10])).toBe("1-3,5,9-10");
    expect(decodeIdx("1-3,5,x,9-10")).toEqual([1, 2, 3, 5, 9, 10]);
    const p = packEdits(ed([1, 2, 3], [-1, 4]));
    expect(p).toEqual({ dw: "1-3", dg: "0,5" });
    const back = unpackEdits(p, 5);
    expect([...back.words]).toEqual([1, 2, 3]);
    expect([...back.gaps].sort()).toEqual([-1, 4]);
    const link = buildLink("https://x/", { words: "w.json", ...p });
    expect(readLink({ search: "", hash: link.slice(link.indexOf("#")) }))
      .toMatchObject({ dw: "1-3", dg: "0,5" });
  });
});

describe("processing ops", () => {
  const f = { width: 1920, height: 1080 };
  it("crops to an aspect, centred, even sizes", () => {
    expect(cropRect({ aspect: "9:16", size: 100, cx: 0.5, cy: 0.5 }, f)).toEqual({ w: 608, h: 1080, x: 656, y: 0 });
    expect(cropRect({ aspect: "1:1", size: 50, cx: 0, cy: 1 }, f)).toEqual({ w: 540, h: 540, x: 0, y: 540 });
  });
  it("chains crop → scale with the cropped size", () => {
    const ops = normalizeOps([{ id: "crop", on: true, p: { aspect: "1:1" } }, { id: "scale", on: true, p: { short: "720" } },
                              { id: "loudnorm", on: true, p: {} }]);
    const r = opFilters(ops, f, true);
    expect(r.video).toEqual(["crop=1080:1080:420:0", "scale=720:720:flags=lanczos"]);
    expect(r.audio).toEqual(["loudnorm=I=-16:TP=-1.5:LRA=11"]);
    expect(r.out).toEqual(["-ar", "48000"]);
    expect(opFilters(ops, f, false).video).toEqual([]);
  });
  it("never upscales", () => {
    expect(opFilters(normalizeOps([{ id: "scale", on: true, p: { short: "1080" } }]), { width: 1280, height: 720 }, true).video).toEqual([]);
  });
});

describe("ffmpeg jobs", () => {
  const base = { input: "in put.mp4", output: "out.mp4", hasVideo: true } as const;

  it("one range: fast-seeked input, no filter graph", () => {
    const j = buildJob({ ...base, mode: "exact", ranges: [{ s: 1, e: 3 }] });
    expect(j.steps).toHaveLength(1);
    expect(j.steps[0]!.slice(0, 6)).toEqual(["-ss", "1.000", "-t", "2.000", "-i", "in put.mp4"]);
    expect(j.steps[0]).not.toContain("-filter_complex");
    expect(j.steps[0]).toContain("0:v:0");
  });

  it("many close ranges: one pass with trim/atrim, relative to the first", () => {
    const ranges = [{ s: 10, e: 12 }, { s: 12.5, e: 15 }, { s: 15.2, e: 20 }];
    const j = buildJob({ ...base, mode: "exact", ranges, fade: 0.01 });
    const a = j.steps[0]!;
    expect(a.filter((x) => x === "-i")).toHaveLength(1);
    expect(a.slice(0, 4)).toEqual(["-ss", "10.000", "-t", "10.000"]);
    const g = a[a.indexOf("-filter_complex") + 1]!;
    expect(g).toContain("[0:v:0]trim=start=2.500:end=5.000,setpts=PTS-STARTPTS[v1]");
    expect(g).toContain("[0:a:0]atrim=start=2.500:end=5.000,asetpts=PTS-STARTPTS,afade=t=in:d=0.010,afade=t=out:st=2.490:d=0.010[a1]");
    expect(g).toContain("[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vc][ac]");
    expect(j.duration).toBeCloseTo(9.3);
  });

  it("reordered ranges: one input each", () => {
    const j = buildJob({ ...base, mode: "exact", ranges: [{ s: 30, e: 40 }, { s: 1, e: 2 }] });
    expect(j.steps[0]!.filter((x) => x === "-i")).toHaveLength(2);
  });

  it("appends processing after the join", () => {
    const ops = normalizeOps([{ id: "crop", on: true, p: { aspect: "9:16" } }, { id: "denoise", on: true, p: {} }]);
    const j = buildJob({ ...base, mode: "exact", ranges: [{ s: 0, e: 1 }, { s: 1.5, e: 3 }], ops, frame: { width: 1920, height: 1080 } });
    const a = j.steps[0]!;
    const g = a[a.indexOf("-filter_complex") + 1]!;
    expect(g).toContain("[vc]crop=608:1080:656:0[vout]");
    expect(g).toContain("[ac]afftdn=nr=12:nf=-40[aout]");
    expect(a.join(" ")).toContain("-map [vout] -map [aout]");
  });

  it("audio modes drop the video and pick the codec", () => {
    const j = buildJob({ ...base, output: "o.mp3", mode: "audio", audioCodec: "mp3", ranges: [{ s: 0, e: 1 }, { s: 2, e: 3 }] });
    const a = j.steps[0]!.join(" ");
    expect(a).not.toContain(":v:");
    expect(a).toContain("-c:a libmp3lame");
    expect(outputExt("audio", "x.mp4", true, "pcm")).toBe("wav");
    expect(outputExt("copy", "x.MOV", true)).toBe("mov");
  });

  it("copy mode: parts + concat list, as a script", () => {
    const j = buildJob({ ...base, mode: "copy", ranges: [{ s: 0, e: 1 }, { s: 2, e: 3 }], tmp: "/tmp_" });
    expect(j.steps).toHaveLength(3);
    expect(j.files[0]).toEqual({ path: "/tmp_concat.txt", text: "file 'tmp_part000.mp4'\nfile 'tmp_part001.mp4'\n" });
    const sh = jobToShell(buildJob({ ...base, mode: "copy", ranges: [{ s: 0, e: 1 }, { s: 2, e: 3 }] }));
    expect(sh).toContain("set -e\ncat > textcut_concat.txt <<'EOF'");
    expect(sh).toContain("rm -f textcut_part000.mp4 textcut_part001.mp4 textcut_concat.txt");
    expect(sh).toContain("'0:v:0?'");
  });

  it("quotes for the shell", () => {
    expect(shQuote("a.mp4")).toBe("a.mp4");
    expect(shQuote("it's here.mp4")).toBe(`'it'\\''s here.mp4'`);
    expect(shQuote("[vout]")).toBe("'[vout]'");
    expect(jobToShell(buildJob({ ...base, mode: "exact", ranges: [{ s: 1, e: 3 }] }))).toMatch(/^ffmpeg -hide_banner \\\n  -ss 1\.000 -t 2\.000 -i 'in put\.mp4'/);
  });

  it("rejects an empty cut", () => {
    expect(() => buildJob({ ...base, mode: "exact", ranges: [] })).toThrow(/Nothing/);
  });
});
