import { describe, expect, it } from "vitest";
import { decodeFixes, encodeFixes, packEdits, spreadEdit, spreadText, unpackEdits } from "../src/core/edits";
import { buildLink, readLink } from "../src/core/link";
import { parseLineMode, parseTranscript, textOf, transcriptLines } from "../src/core/transcript";

describe("spelling fixes", () => {
  it("encode / decode, with the separators in the text", () => {
    const m = new Map([[10, "a|b~c 100%"], [3, "Kenobi"]]);
    const s = encodeFixes(m);
    expect(s).toBe("3~Kenobi|10~a%7Cb%7Ec 100%25");
    expect([...decodeFixes(s)]).toEqual([[3, "Kenobi"], [10, "a|b~c 100%"]]);
    expect([...decodeFixes("x~y|5|~z|7~")]).toEqual([[7, ""]]);
  });

  it("travel with the cuts (storage, undo) and in links", async () => {
    const ed = { words: new Set([1]), gaps: new Set<number>(), fixes: new Map([[2, "Bucureşti"]]) };
    const p = packEdits(ed);
    expect(p).toEqual({ dw: "1", fx: "2~Bucureşti" });
    expect([...unpackEdits(p, 5).fixes]).toEqual([[2, "Bucureşti"]]);
    expect(unpackEdits({ fx: "9~x" }, 5).fixes.size).toBe(0); // out of range
    const link = buildLink("https://x.org/tc/", { ...p, words: "https://x.org/t.words.json" });
    expect(readLink(new URL(link)).fx).toBe("2~Bucureşti");
  });

  it("spread new text over the old words", () => {
    expect(spreadText("Obi-Wan  Kenobi", 2)).toEqual(["Obi-Wan", "Kenobi"]);
    expect(spreadText("Kenobi", 2)).toEqual(["", "Kenobi"]);            // merged
    expect(spreadText("a b c", 2)).toEqual(["a", "b c"]);               // split
    expect(spreadText("one two three four", 3)).toEqual(["one", "two", "three four"]);
  });

  it("a fix in a long passage leaves the other words where they were", () => {
    const old = "one two three four five six seven eight".split(" ");
    // same number of words: one to one
    expect(spreadEdit(old, "one TWO three four five six seven eight")[1]).toBe("TWO");
    // a word added near the start: only its neighbour changes
    expect(spreadEdit(old, "one two and three four five six seven eight"))
      .toEqual(["one", "two and", "three", "four", "five", "six", "seven", "eight"]);
    // a word removed: it is emptied where it was
    expect(spreadEdit(old, "one two four five six seven eight"))
      .toEqual(["one", "two", "", "four", "five", "six", "seven", "eight"]);
    // one added and one removed, far apart: each stays local (not a shift of all between)
    expect(spreadEdit(old, "one new two three four five six eight"))
      .toEqual(["one new", "two", "three", "four", "five", "six", "", "eight"]);
    // two words merged, two words split
    expect(spreadEdit(old, "one twothree four five six se ven eight"))
      .toEqual(["one", "", "twothree", "four", "five", "six", "se ven", "eight"]);
    // typed before the first word
    expect(spreadEdit(old, "zero one two three four five six seven eight")[0]).toBe("zero one");
    // a stretch rewritten with other words
    expect(spreadEdit(old, "one two a b c d six seven eight"))
      .toEqual(["one", "two", "a", "b", "c d", "six", "seven", "eight"]);
    expect(spreadEdit(["Obi", "Wan", "Kenobi"], "Kenobi")).toEqual(["", "", "Kenobi"]);
  });

  it("clitics, punctuation and earlier fixes stay as they are when not touched", () => {
    // "m" "-am" reads "m-am"; "." is its own word; "b c" was typed over one word; "" was merged away
    const old = ["Eu", "m", "-am", "dus", ".", "a", "b c", "", "d"];
    expect(spreadEdit(old, "Eu m-am dus. a b c d")).toEqual(old);
    expect(spreadEdit(old, "Eu m-am dus. acasa a b c d")).toEqual(["Eu", "m", "-am", "dus", ". acasa", "a", "b c", "", "d"]);
    expect(spreadEdit(old, "Eu ne-am dus. a b c D")).toEqual(["Eu", "", "ne-am", "dus", ".", "a", "b", "c", "D"]);
    expect(spreadEdit(old, "Tu m-am dus. a b d")).toEqual(["Tu", "m", "-am", "dus", ".", "a", "", "b", "d"]);
  });

  it("an emptied word drops out of the text", () => {
    const t = parseTranscript([{ start: 0, end: 1, word: "a" }, { start: 1, end: 2, word: "b" }, { start: 2, end: 3, word: "c" }]);
    t.words[1]!.w = "";
    expect(textOf(t.words, 0, 2)).toBe("a c");
  });
});

describe("transcript lines", () => {
  const t = parseTranscript({
    segments: [
      { words: [[0, "One"], [1, "two."], [2, "Three"], [3, "four"]].map(([s, w]) => ({ start: +s!, end: +s! + 0.5, word: String(w) })) },
      { words: [[4, "five?"], [5, "Six"], [6, "seven"], [7, "eight"], [8, "nine"], [9, "ten"], [10, "eleven."]]
        .map(([s, w]) => ({ start: +s!, end: +s! + 0.5, word: String(w) })) },
    ],
  });
  const show = (mode: Parameters<typeof transcriptLines>[2]) =>
    transcriptLines(t, t.words, mode).map((l) => textOf(t.words, l.first, l.last));

  it("as transcribed: the segments", () => {
    expect(show("seg")).toEqual(["One two. Three four", "five? Six seven eight nine ten eleven."]);
  });

  it("sentences, whatever the segments say", () => {
    expect(show("sentence")).toEqual(["One two.", "Three four five?", "Six seven eight nine ten eleven."]);
  });

  it("at most N words, splitting long sentences evenly", () => {
    expect(show(4)).toEqual(["One two.", "Three four five?", "Six seven eight", "nine ten eleven."]);
    expect(show(1).length).toBe(t.words.length);
  });

  it("parses the setting", () => {
    expect(parseLineMode("sentence")).toBe("sentence");
    expect(parseLineMode("12")).toBe(12);
    expect(parseLineMode("seg")).toBe("seg");
    expect(parseLineMode(undefined)).toBe("seg");
  });
});
