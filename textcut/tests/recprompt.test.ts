import { describe, expect, it } from "vitest";
import { parseTranscript } from "../src/core/transcript";
import { placeRecs } from "../src/core/recs";
import { buildRecPrompt, promptLines, readRecAnswer } from "../src/core/recprompt";

//   line 1: "Why hasn't he come?"      0.0 – 2.0   (sentence end)
//   line 2: "Think about it"           2.2 – 3.4   (then a 2 s pause)
//   line 3: "Because he is patient."   5.4 – 7.6
const raw: Array<[number, number, string]> = [
  [0.0, 0.4, "Why"], [0.5, 0.9, "hasn't"], [1.0, 1.3, "he"], [1.4, 2.0, "come?"],
  [2.2, 2.6, "Think"], [2.7, 3.0, "about"], [3.1, 3.4, "it"],
  [5.4, 5.9, "Because"], [6.0, 6.2, "he"], [6.3, 6.5, "is"], [6.6, 7.6, "patient."],
];
const words = parseTranscript({ segments: raw.map(([start, end, word]) => ({ words: [{ start, end, word }] })) }).words;
const lines = promptLines(words);
const opts = { count: 5, minSeconds: 15, maxSeconds: 60, language: "Romanian" };

describe("the prompt for somebody's own AI", () => {
  it("breaks the transcript where the speaker does", () => {
    expect(lines).toEqual([
      { s: 0, e: 2, text: "Why hasn't he come?" },
      { s: 2.2, e: 3.4, text: "Think about it" },
      { s: 5.4, e: 7.6, text: "Because he is patient." },
    ]);
    // a longer pause threshold no longer splits at the 2 s silence
    expect(promptLines(words, 3).map((l) => l.text)).toEqual(["Why hasn't he come?", "Think about it Because he is patient."]);
  });

  it("still breaks speech that has neither punctuation nor pauses", () => {
    const runOn = parseTranscript({
      segments: [{ words: Array.from({ length: 40 }, (_, i) => ({ start: i * 0.5, end: i * 0.5 + 0.4, word: `w${i}` })) }],
    }).words;
    expect(promptLines(runOn).map((l) => l.text.split(" ").length)).toEqual([16, 16, 8]);
  });

  it("numbers the lines and carries what was asked for", () => {
    const p = buildRecPrompt(lines, { ...opts, guidance: "  For the church's Instagram. " });
    expect(p).toContain("1 [0:00] Why hasn't he come?");
    expect(p).toContain("3 [0:05] Because he is patient.");
    expect(p).toContain("the 5 best clips, each between 15 and 60 seconds");
    expect(p).toContain("a short hook for the post, in Romanian");
    expect(p).toContain("What the editor asked for:\nFor the church's Instagram.\n");
    expect(buildRecPrompt(lines, opts)).not.toContain("What the editor asked for");
    expect(buildRecPrompt([{ s: 3725, e: 3726, text: "late." }], opts)).toContain("1 [1:02:05] late.");
  });
});

describe("the AI's answer", () => {
  it("turns line numbers into times, whatever is wrapped around the JSON", () => {
    const answer = `Here are the clips:\n\n\`\`\`json\n${JSON.stringify({ clips: [
      { title: "Weaker", score: 60, why: "w", tags: ["x"], parts: [{ from: 2, to: 2 }] },
      { title: "Question and answer", score: 91, why: "arc", tags: ["question"], parts: [{ from: "1", to: 1 }, { from: 3, to: 3 }] },
    ] }, null, 2)}\n\`\`\`\nLet me know if you want more.`;
    const recs = readRecAnswer(answer, lines);
    expect(recs.map((r) => r.title)).toEqual(["Question and answer", "Weaker"]);
    expect(recs[0]).toEqual({ title: "Question and answer", score: 91, why: "arc", tags: ["question"], ranges: [{ s: 0, e: 2 }, { s: 5.4, e: 7.6 }] });
    // and those times mean exactly the lines' words
    expect(placeRecs(recs, words)[0]!.parts).toEqual([{ a: 0, b: 3 }, { a: 7, b: 10 }]);
  });

  it("drops what points outside the transcript", () => {
    const recs = readRecAnswer(JSON.stringify([
      { title: "Half real", score: 80, parts: [{ from: 1, to: 2 }, { from: 3, to: 9 }] },
      { title: "Backwards", parts: [{ from: 3, to: 1 }] },
      { title: "Not numbers", parts: [{ from: 1.5, to: 2 }, { to: 2 }, null, "junk"] },
    ]), lines);
    expect(recs).toEqual([{ title: "Half real", score: 80, why: "", tags: [], ranges: [{ s: 0, e: 3.4 }] }]);
  });

  it("accepts an answer that gives seconds instead of line numbers", () => {
    const recs = readRecAnswer('{"clips": [{"title": "T", "ranges": [[5.4, 7.6]]}]}', lines);
    expect(recs[0]!.ranges).toEqual([{ s: 5.4, e: 7.6 }]);
  });

  it("says what is wrong with an answer it can't use", () => {
    expect(() => readRecAnswer("Sorry, I can't help with that.", lines)).toThrow(/doesn't look like the AI's answer/);
    expect(() => readRecAnswer('{"clips": [{"title": "cut off', lines)).toThrow(/doesn't look like|cut off/);
    expect(() => readRecAnswer('{"clips": [{"title": "x", }]}', lines)).toThrow(/cut off or isn't valid JSON/);
    expect(() => readRecAnswer('{"result": []}', lines)).toThrow(/no "clips" list/);
    expect(() => readRecAnswer('{"clips": [{"title": "T", "parts": [{"from": 50, "to": 60}]}]}', lines)).toThrow(/this recording's prompt/);
  });
});
