import { describe, expect, it } from "vitest";
import { parseTranscript } from "../src/core/transcript";
import { placeRecs } from "../src/core/recs";
import { buildRecPrompt, findRecLink, promptLines, readRecAnswer, readRecLink, recLinkStub } from "../src/core/recprompt";
import { buildLink, readLink } from "../src/core/link";

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

describe("the AI answers with a link", () => {
  const base = buildLink("https://x.test/app/", {
    title: "2 Petru 3", media: "https://f.test/a.mp4", words: "https://f.test/a.words.json", ai: recLinkStub(lines.length),
  });
  /** what the app is opened with when the AI's link is clicked */
  const opened = (clips: string) => readLink(new URL(base + clips)).ai!;

  it("asks for the clips on the end of the recording's own link", () => {
    expect(base.endsWith("&ai=3;")).toBe(true);
    const p = buildRecPrompt(lines, { ...opts, link: base });
    expect(p).toContain(`\n${base}\n`);
    expect(p).toContain("…ai=3;12-19~92~");                 // the example continues the real ending
    expect(p).toContain("[Open the clips](the whole link)");
    expect(p).not.toContain('{"clips"');                     // one answer shape, not two
    expect(p).toContain("<transcript>\n1 [0:00] Why hasn't he come?");
    // without a link the JSON answer is asked for, as before
    expect(buildRecPrompt(lines, opts)).toContain('{"clips": [{"title"');
  });

  it("reads the clips back, by line number", () => {
    const recs = readRecLink(opened("1-3~92~Why_hasn't_he_come?~Opens_on_a_question,_then_answers_it;3-3~70~Patient"), lines);
    expect(recs).toEqual([
      { title: "Why hasn't he come?", score: 92, why: "Opens on a question, then answers it", tags: [], ranges: [{ s: 0, e: 7.6 }] },
      { title: "Patient", score: 70, why: "", tags: [], ranges: [{ s: 5.4, e: 7.6 }] },
    ]);
    expect(placeRecs(recs, words)).toHaveLength(2);
  });

  it("takes a clip in two parts, and spaces however the chat encoded them", () => {
    const recs = readRecLink(opened("1-1,3-3~88~Question%20and+answer~Skips_the_aside"), lines);
    expect(recs[0]).toMatchObject({ title: "Question and answer", why: "Skips the aside", ranges: [{ s: 0, e: 2 }, { s: 5.4, e: 7.6 }] });
  });

  it("keeps diacritics", () => {
    expect(readRecLink(opened("1-2~90~De_ce_n-a_venit_încă?~Începe_cu_o_întrebare"), lines)[0])
      .toMatchObject({ title: "De ce n-a venit încă?", why: "Începe cu o întrebare" });
  });

  it("tells the fields apart by what they are, whatever their order", () => {
    const recs = readRecLink("3;A_title~80~2-3;1-1~Just_a_title", lines);
    expect(recs).toEqual([
      { title: "A title", score: 80, why: "", tags: [], ranges: [{ s: 2.2, e: 7.6 }] },
      { title: "Just a title", score: null, why: "", tags: [], ranges: [{ s: 0, e: 2 }] },
    ]);
  });

  it("takes a single line written without its end", () => {
    const recs = readRecLink("3;2~42~One_line;1-1,3~70~Two_parts", lines);
    expect(recs).toMatchObject([
      { title: "Two parts", score: 70, ranges: [{ s: 0, e: 2 }, { s: 5.4, e: 7.6 }] },
      { title: "One line", score: 42, ranges: [{ s: 2.2, e: 3.4 }] },
    ]);
  });

  it("skips what makes no sense, keeps the rest", () => {
    const recs = readRecLink("3;9-12~90~Out_of_range;~~;nothing_here;2-2~60~Fine;", lines);
    expect(recs.map((r) => r.title)).toEqual(["Fine"]);
  });

  it("refuses clips counted in another transcript's lines", () => {
    expect(() => readRecLink("412;1-2~90~T", lines)).toThrow(/another recording/);
    expect(() => readRecLink("3;", lines)).toThrow(/no clips/);
    expect(() => readRecLink("3;50-60~90~T", lines)).toThrow(/no clips/);
    // written by hand, without the count: taken on trust
    expect(readRecLink("1-2~90~T", lines)).toHaveLength(1);
  });

  it("is also read when pasted instead of clicked", () => {
    const answer = `Here you go: [Open the clips](${base}1-3~92~Why_hasn't_he_come?~It_answers_itself)`;
    expect(findRecLink(answer)).toBe("3;1-3~92~Why_hasn't_he_come?~It_answers_itself");
    expect(readRecAnswer(answer, lines)[0]).toMatchObject({ title: "Why hasn't he come?", score: 92, ranges: [{ s: 0, e: 7.6 }] });
    expect(findRecLink('{"clips": []}')).toBeNull();
    // JSON that merely mentions a link is still JSON
    const json = '{"clips": [{"title": "see https://x.test/#ai=3;1-1~1~x", "parts": [{"from": 2, "to": 2}]}]}';
    expect(readRecAnswer(json, lines)[0]!.ranges).toEqual([{ s: 2.2, e: 3.4 }]);
  });

  it("numbers lines by the words as transcribed, whatever was corrected since", () => {
    // somebody fixed "it" to "it." — for them the text changes, the line numbers don't
    const fixed = words.map((w, i) => (i === 6 ? { ...w, w: "it." } : i === 3 ? { ...w, w: "come" } : w));
    const asTranscribed = words.map((w) => w.w);
    const theirs = promptLines(fixed, undefined, undefined, asTranscribed);
    expect(theirs.map((l) => [l.s, l.e])).toEqual(lines.map((l) => [l.s, l.e]));
    expect(theirs[0]!.text).toBe("Why hasn't he come");
    // without it, the missing "?" would have merged the first two lines
    expect(promptLines(fixed)).toHaveLength(2);
  });
});
