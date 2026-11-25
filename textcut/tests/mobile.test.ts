import { describe, expect, it } from "vitest";
import { tapSelect } from "../src/core/ranges";
import { bothEnds } from "../src/core/formats";

describe("selecting words by tapping", () => {
  it("the first tap picks one word", () => {
    expect(tapSelect(null, 7)).toEqual({ a: 7, b: 7 });
  });

  it("first word, then last word, selects the passage — in either order", () => {
    expect(tapSelect({ a: 7, b: 7 }, 20)).toEqual({ a: 7, b: 20 });
    expect(tapSelect({ a: 20, b: 20 }, 7)).toEqual({ a: 7, b: 20 });
  });

  it("a tap outside the selection extends it to that word", () => {
    expect(tapSelect({ a: 7, b: 20 }, 3)).toEqual({ a: 3, b: 20 });
    expect(tapSelect({ a: 7, b: 20 }, 31)).toEqual({ a: 7, b: 31 });
  });

  it("a tap inside moves the nearer end in", () => {
    expect(tapSelect({ a: 7, b: 20 }, 9)).toEqual({ a: 9, b: 20 });
    expect(tapSelect({ a: 7, b: 20 }, 18)).toEqual({ a: 7, b: 18 });
    // halfway: the end moves, the start stays where it was first put
    expect(tapSelect({ a: 10, b: 20 }, 15)).toEqual({ a: 10, b: 15 });
  });

  it("tapping an end, or the only word, changes nothing", () => {
    expect(tapSelect({ a: 7, b: 20 }, 7)).toEqual({ a: 7, b: 20 });
    expect(tapSelect({ a: 7, b: 20 }, 20)).toEqual({ a: 7, b: 20 });
    expect(tapSelect({ a: 7, b: 7 }, 7)).toEqual({ a: 7, b: 7 });
  });
});

describe("bothEnds", () => {
  it("leaves a short text alone", () => {
    expect(bothEnds("  De ce  n-a venit?  ", 40)).toBe("De ce n-a venit?");
  });

  it("keeps the beginning and the end of a long one, cut between words", () => {
    const text = "Dar aș vrea să încep cu o întrebare pentru că au trecut aproape două mii de ani de atunci";
    const short = bothEnds(text, 44);
    expect(short).toBe("Dar aș vrea să încep … mii de ani de atunci");
    expect(short.length).toBeLessThanOrEqual(44);
  });

  it("still shortens a text with no spaces to cut at", () => {
    const short = bothEnds("a".repeat(100), 21);
    expect(short).toBe(`${"a".repeat(9)} … ${"a".repeat(9)}`);
  });
});
