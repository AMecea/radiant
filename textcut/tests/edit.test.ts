import { describe, expect, it } from "vitest";
import { parseTranscript, type Transcript } from "../src/core/transcript";
import {
  decodeIdx, encodeIdx, keptRanges, packEdits, rangeAt, removedRanges, subtractRanges, unpackEdits, type Edits,
} from "../src/core/edits";
import { buildJob, jobToShell, outputExt, shQuote } from "../src/core/ffjob";
import { cropRect, cropZoom, dragCropCorner, MAX_ZOOM, normalizeOps, opFilters, zoomSize } from "../src/core/ops";
import { buildLink, packPreset, readLink, unpackPreset } from "../src/core/link";
import { radiantPlan } from "../src/core/radiant";

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
  it("zooms in by making the crop smaller, between 1× and 5×", () => {
    expect(zoomSize(1)).toBe(100);
    expect(zoomSize(2)).toBe(50);
    expect(zoomSize(1.3)).toBe(76.92);
    expect(zoomSize(0.5)).toBe(100);
    expect(zoomSize(40)).toBe(20);
    expect(zoomSize(NaN)).toBe(100);
    expect(MAX_ZOOM).toBe(5);
    expect(cropZoom(50)).toBe(2);
    expect(cropZoom(undefined)).toBe(1);
    expect(cropZoom(5)).toBe(5);
    for (const z of [1, 1.1, 1.5, 2.3, 3.7, 5]) expect(cropZoom(zoomSize(z)).toFixed(1)).toBe(z.toFixed(1));
    // 2× on a 9:16 frame: half as wide and half as high, still centred
    expect(cropRect({ aspect: "9:16", size: zoomSize(2), cx: 0.5, cy: 0.5 }, f)).toEqual({ w: 304, h: 540, x: 808, y: 270 });
  });
  it("dragging a corner of the frame resizes it around the opposite corner", () => {
    // 9:16 on 1920×1080 at 1×: x 656..1264, y 0..1080
    const p = { aspect: "9:16", size: 100, cx: 0.5, cy: 0.5 };
    // bottom-right corner pulled in to half the size: the top-left corner stays
    const a = dragCropCorner(p, f, "se", 960, 540);
    expect(a.size).toBe(50);
    expect(cropRect({ ...p, ...a }, f)).toEqual({ w: 304, h: 540, x: 656, y: 0 });
    // top-left corner pulled in: the bottom-right corner stays
    const b = dragCropCorner(p, f, "nw", 960, 540);
    expect(cropRect({ ...p, ...b }, f)).toEqual({ w: 304, h: 540, x: 960, y: 540 });
    // never smaller than the 5× zoom, never outside the picture
    expect(dragCropCorner(p, f, "se", 660, 4).size).toBe(20);
    expect(dragCropCorner(p, f, "se", 5000, 5000).size).toBe(100);
    // growing again from a small frame in a corner stops at the picture's edge
    const small = { aspect: "9:16", size: 50, cx: 0, cy: 0 };            // x 0..304, y 0..540
    const c = dragCropCorner(small, f, "nw", -500, -500);                // no room up or left
    expect(cropRect({ ...small, ...c }, f)).toEqual({ w: 304, h: 540, x: 0, y: 0 });
    const d = dragCropCorner(small, f, "se", 456, 810);                  // 1.5× as large
    // off the diagonal, the corner takes the nearest point on it
    expect(dragCropCorner(p, f, "se", 1264, 540).size).toBeCloseTo(62.03, 1);
    expect(cropRect({ ...small, ...d }, f)).toEqual({ w: 456, h: 810, x: 0, y: 0 });
  });
  it("crops by expressions when the frame size is unknown (an unprobed full-quality original)", () => {
    const crop = (p: Record<string, string | number>) =>
      opFilters(normalizeOps([{ id: "crop", on: true, p }]), null, true).video;
    expect(crop({ aspect: "9:16" })).toEqual(["crop=w=trunc(min(iw\\,ih*9/16)/2)*2:h=trunc(min(ih\\,iw/(9/16))/2)*2"]);
    expect(crop({ aspect: "1:1", size: 50, cx: 0.25, cy: 1 })).toEqual([
      "crop=w=trunc(min(iw\\,ih*1/1)*0.5/2)*2:h=trunc(min(ih\\,iw/(1/1))*0.5/2)*2" +
      ":x=trunc(clip(0.25*iw-ow/2\\,0\\,iw-ow)/2)*2:y=trunc(clip(1*ih-oh/2\\,0\\,ih-oh)/2)*2" +
      // zoomed in: back up to the size it has at 1×
      ",scale=w=trunc(iw/0.5/2)*2:h=trunc(ih/0.5/2)*2:flags=lanczos",
    ]);
  });
  it("scales a zoomed crop back up, so the export keeps its size", () => {
    const run = (p: Record<string, string | number>, more: Array<{ id: string; on: boolean; p: Record<string, string | number> }> = []) =>
      opFilters(normalizeOps([{ id: "crop", on: true, p }, ...more]), f, true);
    // 2× on 9:16: a 304×540 piece of the picture, exported at the 608×1080 of the unzoomed frame
    const z = run({ aspect: "9:16", size: 50 });
    expect(z.video).toEqual(["crop=304:540:808:270,scale=608:1080:flags=lanczos"]);
    expect(z.frame).toEqual({ width: 608, height: 1080 });
    // not zoomed: just the crop
    expect(run({ aspect: "9:16", size: 100 }).video).toEqual(["crop=608:1080:656:0"]);
    // zooming without reshaping (the source's own shape)
    expect(run({ aspect: "16:9", size: 50 }).video).toEqual(["crop=960:540:480:270,scale=1920:1080:flags=lanczos"]);
    expect(run({ aspect: "16:9", size: 100 }).video).toEqual([]);
    // Resize still sees the exported size
    expect(run({ aspect: "9:16", size: 50 }, [{ id: "scale", on: true, p: { short: "540" } }]).video)
      .toEqual(["crop=304:540:808:270,scale=608:1080:flags=lanczos", "scale=540:960:flags=lanczos"]);
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

describe("variables, radiant plans, shared exports", () => {
  const url = "https://x.org/my talk.mp4";
  const spec = { input: url, output: "talk_cut.mp4", hasVideo: true, mode: "exact" as const,
                 ranges: [{ s: 30, e: 40 }, { s: 1, e: 2 }], fade: 0, frame: { width: 1920, height: 1080 },
                 ops: normalizeOps([{ id: "crop", on: true, p: { aspect: "9:16" } }, { id: "loudnorm", on: true, p: {} }]) };

  it("shell: literal URL by default, $INPUT/$OUTPUT with the URL as default when asked", () => {
    const job = buildJob(spec);
    expect(jobToShell(job)).toContain("-i 'https://x.org/my talk.mp4'");
    const sh = jobToShell(job, { input: url, output: "talk_cut.mp4" });
    expect(sh).toMatch(/^INPUT=\$\{INPUT:-'https:\/\/x\.org\/my talk\.mp4'\}\nOUTPUT=\$\{OUTPUT:-talk_cut\.mp4\}\n/);
    expect(sh).toContain('-i "$INPUT"');
    expect(sh).toMatch(/"\$OUTPUT"$/);
    expect(sh).not.toContain("x.org/my talk.mp4' \\");
  });

  it("radiant: one ffmpeg step, seek-only inputs, lengths in the graph", () => {
    const y = radiantPlan(spec);
    expect(y).toContain("action: ffmpeg");
    expect(y).toContain('input: "https://x.org/my talk.mp4"');
    expect(y).toContain("start: 30.000");
    expect(y).toContain('- { file: "https://x.org/my talk.mp4", start: 1.000 }');
    expect(y).toContain("[0:v:0]trim=duration=10.000,setpts=PTS-STARTPTS[v0];");
    expect(y).toContain("[1:a:0]atrim=duration=1.000,asetpts=PTS-STARTPTS[a1];");
    expect(y).toContain("[vc]crop=608:1080:656:0[vout];");
    expect(y).toContain('map: ["[vout]", "[aout]"]');
    expect(y).toContain('extra_args: ["-ar", "48000"]');
    expect(y).not.toContain("vars:");
  });

  it("radiant: variables declared with the URL as default", () => {
    const y = radiantPlan(spec, { vars: true, name: "t" });
    expect(y).toContain('vars:\n  input: "https://x.org/my talk.mp4"\n  output: "talk_cut.mp4"');
    expect(y).toContain('input: "${vars.input}"');
    expect(y).toContain('output: "${vars.output}"');
    expect(y).toContain('{ file: "${vars.input}", start: 1.000 }');
  });

  it("radiant: a one-pass cut keeps relative trims; audio-only drops faststart", () => {
    const y = radiantPlan({ ...spec, ops: [], output: "a.mp3", mode: "audio", audioCodec: "mp3",
                            ranges: [{ s: 10, e: 12 }, { s: 12.5, e: 15 }] });
    expect(y).toContain("start: 10.000");
    expect(y).not.toContain("inputs:");
    expect(y).toContain("[0:a:0]atrim=start=2.500:end=5.000");
    expect(y).toContain("acodec: libmp3lame");
    expect(y).toContain("faststart: false");
    expect(y).not.toContain("vcodec");
  });

  it("packs an export preset into the link", async () => {
    const x = await packPreset({ v: 1, r: [[1, 2], [5, 9.5]], m: "exact", o: [{ id: "crop", p: { aspect: "1:1" } }], f: 1, n: "reel" });
    const link = buildLink("https://h/textcut/", { media: url, x });
    const back = await unpackPreset(readLink({ search: "", hash: link.slice(link.indexOf("#")) }).x!);
    expect(back).toMatchObject({ r: [[1, 2], [5, 9.5]], m: "exact", n: "reel" });
    expect(await unpackPreset("garbage")).toBeNull();
  });
});

describe("several named clips in a link", () => {
  it("round-trips names and segments", async () => {
    const { encodeReels, decodeReels } = await import("../src/core/link");
    const reels = [
      { name: "Intro – Q&A", ranges: [{ s: 1, e: 5 }, { s: 9.5, e: 12 }] },
      { name: "a|b~c", ranges: [{ s: 30, e: 41 }] },
      { name: "Empty", ranges: [] },
    ];
    const link = buildLink("https://h/t/", { words: "w.json", reels, clips: [{ s: 0, e: 1 }] });
    const back = readLink({ search: "", hash: link.slice(link.indexOf("#")) });
    expect(back.clips).toBeUndefined();
    expect(back.reels).toEqual([
      { name: "Intro – Q&A", ranges: [{ s: 1, e: 5 }, { s: 9.5, e: 12 }] },
      { name: "a b c", ranges: [{ s: 30, e: 41 }] },
      { name: "Empty", ranges: [] },
    ]);
    expect(decodeReels("10-20")).toEqual([{ name: "Clip 1", ranges: [{ s: 10, e: 20 }] }]);
    expect(encodeReels([{ name: "x", ranges: [{ s: 1, e: 2 }] }])).toBe("x~1-2");
  });
});
