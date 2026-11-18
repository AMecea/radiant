import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assColor, assInlineColor, assTime, captionScript, chunkWords, wordsOnCut, type CueWord } from "../src/core/captions";
import { buildJob, jobToShell } from "../src/core/ffjob";
import { normalizeOps } from "../src/core/ops";
import { radiantPlan } from "../src/core/radiant";
import { sliceOutput } from "../src/core/ranges";
import { parseTranscript } from "../src/core/transcript";

const W = (s: number, e: number, w: string) => ({ s, e, w });
const words = [W(1, 1.4, "Hello"), W(1.5, 1.9, "there,"), W(2, 2.4, "general"), W(2.5, 3, "Kenobi."), W(5, 5.5, "Next")];

describe("wordsOnCut", () => {
  it("retimes words onto the output timeline, in range order", () => {
    // second range first: [4.9, 6) then [0.9, 2.3)
    const out = wordsOnCut(words, [{ s: 4.9, e: 6 }, { s: 0.9, e: 2.3 }]);
    expect(out.map((w) => w.w)).toEqual(["Next", "Hello", "there,", "general"]);
    expect(out[0]!.s).toBeCloseTo(0.1);
    expect(out[1]!.s).toBeCloseTo(1.1 + 0.1); // 1.1 s of the first range, then 0.1 in
    // "general" ends past the range: clipped to it
    expect(out[3]!.e).toBeCloseTo(1.1 + 1.4);
  });

  it("drops words whose middle was cut out", () => {
    expect(wordsOnCut(words, [{ s: 0, e: 1.19 }]).map((w) => w.w)).toEqual([]);
    expect(wordsOnCut(words, [{ s: 0, e: 1.21 }]).map((w) => w.w)).toEqual(["Hello"]);
  });
});

describe("chunkWords", () => {
  const cue = (list: Array<[number, number, string]>): CueWord[] => list.map(([s, e, w]) => ({ s, e, w }));

  it("caps words per caption and breaks at sentence ends and pauses", () => {
    const c = chunkWords(cue([[0, 0.2, "a"], [0.3, 0.5, "b"], [0.6, 0.8, "c."], [0.9, 1, "d"], [2, 2.2, "e"]]), 2, 99);
    expect(c.map((x) => x.words.map((w) => w.w).join(" "))).toEqual(["a b", "c.", "d", "e"]);
  });

  it("holds a caption until the next one when the gap is short, briefly otherwise", () => {
    const c = chunkWords(cue([[0, 0.5, "a"], [0.8, 1, "b"], [3, 3.5, "c"]]), 1, 99);
    expect(c[0]!.e).toBe(0.8);       // next caption 0.3 s later: no blink
    expect(c[1]!.e).toBeCloseTo(1.3); // long pause: a 0.3 s hold
    expect(c[2]!.e).toBeCloseTo(3.8);
  });

  it("keeps very short words up long enough to read", () => {
    const c = chunkWords(cue([[0, 0.05, "a"], [2, 2.1, "b"]]), 1, 99);
    expect(c[0]!.e).toBeCloseTo(0.35);
  });

  it("respects the character limit", () => {
    const c = chunkWords(cue([[0, 0.1, "aaaa"], [0.1, 0.2, "bbbb"], [0.2, 0.3, "cc"]]), 9, 9);
    expect(c.map((x) => x.words.length)).toEqual([2, 1]);
  });
});

describe("ASS", () => {
  it("formats times and colours", () => {
    expect(assTime(3725.456)).toBe("1:02:05.46");
    expect(assColor("#FFE11A")).toBe("&H001AE1FF");
    expect(assColor("#000000", 0x80)).toBe("&H80000000");
    expect(assInlineColor("#FFE11A")).toBe("&H1AE1FF&");
  });

  const frame = { width: 1080, height: 1920 };
  const events = (ass: string) => ass.split("\n").filter((l) => l.startsWith("Dialogue:"));

  const own = { font: "", size: 0 }; // the style's font and size

  it("defaults: Inter Black, letters 10% of the width, Radiant yellow", () => {
    const { ass, font } = captionScript(words, [{ s: 0, e: 6 }], frame);
    // em = 108 px; libass sizes by line height (1.21 em for Inter) → 131
    expect(ass).toMatch(/^Style: Cap,Inter Black,131,/m);
    expect(ass).toContain("{\\1c&H13B0FF&}HELLO");
    expect(font).toEqual({ file: "Inter-Black.otf", url: "https://cdn.jsdelivr.net/gh/rsms/inter@v3.19/docs/font-files/Inter-Black.otf" });
  });

  it("sizes letters the same whatever the font's line height", () => {
    const size = (f: string) => Number(captionScript(words, [{ s: 0, e: 6 }], frame, { font: f, size: 10 })
      .ass.match(/^Style: Cap,[^,]+,(\d+),/m)![1]);
    expect(size("Inter Black")).toBe(131);   // 108 × 1.21
    expect(size("Poppins Black")).toBe(190); // 108 × 1.76
  });

  it("fits captions on the style's lines at big sizes", () => {
    // bold pop is one line: at 20% of the width only a word or two fit
    const n = (size: number) => captionScript(words, [{ s: 0, e: 6 }], frame, { size }).count;
    expect(n(20)).toBeGreaterThan(n(8));
  });

  it("lays the script out in the frame's pixels, with the style's font", () => {
    const { ass, font, count } = captionScript(words, [{ s: 0, e: 6 }], frame, { style: "pop", y: 0.7, ...own });
    expect(ass).toContain("PlayResX: 1080\nPlayResY: 1920");
    expect(ass).toMatch(/^Style: Cap,Poppins Black,152,/m); // em 8% of 1080 × 1.76
    expect(ass).toContain("\\an5\\pos(540,1344)");
    expect(font.file).toBe("Poppins-Black.ttf");
    expect(font.url).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/gh\/google\/fonts@[0-9a-f]{40}\/ofl\/poppins\/Poppins-Black\.ttf$/);
    expect(count).toBe(3); // HELLO THERE | GENERAL KENOBI | NEXT
  });

  it("highlights the spoken word, one event per word, back to back", () => {
    const { ass } = captionScript(words, [{ s: 0, e: 6 }], frame, { style: "pop", accent: "#3DFF6E", ...own });
    const ev = events(ass);
    expect(ev).toHaveLength(5);
    expect(ev[0]).toContain("{\\1c&H6EFF3D&}HELLO{\\1c&HFFFFFF&} THERE");
    expect(ev[1]).toContain("HELLO {\\1c&H6EFF3D&}THERE{\\1c&HFFFFFF&}");
    expect(ev[0]).toContain("\\t(0,90,"); // pops in…
    expect(ev[1]).not.toContain("\\t(");  // …once per caption
    // punctuation dropped in this style, upper-cased
    expect(ev[1]!.slice(ev[1]!.lastIndexOf("}") + 1)).toBe("");
    expect(ev[1]).toMatch(/}THERE\{/);
    // each word event ends where the next starts
    const span = (l: string) => l.split(",").slice(1, 3);
    expect(span(ev[0]!)[1]).toBe(span(ev[1]!)[0]);
  });

  it("karaoke: one event per caption, \\kf per word with the gaps as \\k", () => {
    const { ass } = captionScript(words, [{ s: 0, e: 6 }], frame, { style: "karaoke", accent: "#FFE11A", ...own });
    const ev = events(ass);
    expect(ev[0]).toContain("{\\kf40}Hello {\\k10}{\\kf40}there,");
    // the sung colour is the accent; the unsung (secondary) white
    expect(ass).toMatch(/^Style: Cap,Poppins ExtraBold,\d+,&H001AE1FF,&H00FFFFFF,/m);
  });

  it("box style: an opaque box (BorderStyle 3), sentence case kept", () => {
    const { ass } = captionScript(words, [{ s: 0, e: 6 }], { width: 1920, height: 1080 }, { style: "box", ...own });
    expect(ass).toMatch(/^Style: Cap,Poppins SemiBold,65,(&H[0-9A-F]{8},){4}0,0,0,0,100,100,0,0,3,/m);
    expect(events(ass)[0]).toContain("Hello there, general Kenobi.");
  });

  it("options: words per caption, case, size", () => {
    const { ass } = captionScript(words, [{ s: 0, e: 6 }], frame, { style: "box", words: 1, case: "upper", font: "", size: 8 });
    expect(events(ass)).toHaveLength(5);
    expect(events(ass)[0]).toMatch(/}HELLO$/);
    expect(ass).toMatch(/^Style: Cap,Poppins SemiBold,152,/m);
  });

  it("upper-cases with the transcript's language and escapes override braces", () => {
    const { ass } = captionScript([W(0, 1, "istanbul"), W(1, 2, "{x}")], [{ s: 0, e: 3 }], frame,
      { style: "word", lang: "tr" });
    expect(ass).toContain("}İSTANBUL");
    expect(ass).toContain("}(X)");
  });

  it("captions the Romanian fixture", () => {
    const t = parseTranscript(readFileSync(new URL("./fixtures/sample.words.json", import.meta.url), "utf8"));
    const { ass, count } = captionScript(t.words, [{ s: 0, e: t.duration }], frame, { style: "pop", lang: t.language });
    expect(count).toBeGreaterThan(15);
    expect(ass).toContain("BUNĂ");
    // events never overlap
    const times = events(ass).map((l) => l.split(",").slice(1, 3));
    for (let i = 1; i < times.length; i++) expect(times[i]![0]! >= times[i - 1]![1]!).toBe(true);
  });
});

describe("captions in the ffmpeg job", () => {
  const ops = normalizeOps([
    { id: "crop", on: true, p: { aspect: "9:16" } },
    { id: "captions", on: true, p: { style: "pop" } },
  ]);
  const spec = {
    input: "talk.mp4", output: "reel.mp4", ranges: [{ s: 0.9, e: 3.1 }, { s: 4.9, e: 5.6 }], mode: "exact" as const,
    hasVideo: true, frame: { width: 1920, height: 1080 }, ops, words,
  };

  it("draws the captions last, on the cropped frame, from a script file and a fonts dir", () => {
    const job = buildJob(spec);
    const graph = job.steps[0]![job.steps[0]!.indexOf("-filter_complex") + 1]!;
    expect(graph).toMatch(/\[vc\]crop=608:1080:656:0,ass=filename=textcut_captions\.ass:fontsdir=textcut_fonts\[vout\]/);
    expect(job.files).toHaveLength(1);
    expect(job.files[0]!.path).toBe("textcut_captions.ass");
    expect(job.files[0]!.text).toContain("PlayResX: 608\nPlayResY: 1080");
    expect(job.fonts?.map((f) => f.file)).toEqual(["Inter-Black.otf"]);
    expect(job.temps).toContain("textcut_captions.ass");
    expect(job.requires).toEqual(["ass"]);
  });

  it("the shell script checks for libass, downloads the font once, writes the script", () => {
    const sh = jobToShell(buildJob(spec));
    expect(sh).toMatch(/^set -e\n/);
    expect(sh).toContain("grep -q ' ass ' || { echo");
    expect(sh).toContain("mkdir -p textcut_fonts\n[ -s textcut_fonts/Inter-Black.otf ] || curl -fsSL -o textcut_fonts/Inter-Black.otf https://");
    expect(sh).toContain("cat > textcut_captions.ass <<'EOF'\n[Script Info]");
    expect(sh).toMatch(/rm -f textcut_captions\.ass$/);
  });

  it("is skipped without words, or when nothing is said in the cut", () => {
    expect(buildJob({ ...spec, words: undefined }).files).toEqual([]);
    expect(buildJob({ ...spec, ranges: [{ s: 3.2, e: 4.8 }] }).fonts).toBeUndefined();
  });

  it("uses the browser's paths when given", () => {
    const job = buildJob({ ...spec, tmp: "/tmp3_", fontsDir: "/fonts" });
    expect(job.steps[0]!.join(" ")).toContain("ass=filename=/tmp3_captions.ass:fontsdir=/fonts");
  });

  it("radiant: a shell step writes the script and fetches the font before the cut", () => {
    const plan = radiantPlan(spec);
    expect(plan).toContain("  - id: captions\n    action: shell\n    with:\n      cmd: |\n        ffmpeg -hide_banner -filters");
    expect(plan).toContain("        cat > textcut_captions.ass <<'EOF'\n        [Script Info]");
    expect(plan.indexOf("id: captions")).toBeLessThan(plan.indexOf("id: cut"));
    expect(plan).toContain("ass=filename=textcut_captions.ass");
  });
});

describe("sliceOutput", () => {
  it("maps an output window back onto source ranges", () => {
    const rs = [{ s: 10, e: 12 }, { s: 20, e: 25 }, { s: 30, e: 31 }];
    expect(sliceOutput(rs, 1, 3)).toEqual([{ s: 11, e: 12 }, { s: 20, e: 22 }]);
    expect(sliceOutput(rs, 0, 100)).toEqual(rs);
    expect(sliceOutput(rs, 7.5, 5)).toEqual([{ s: 30.5, e: 31 }]);
  });
});
