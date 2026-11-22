import { describe, expect, it } from "vitest";
import { parseFontFile } from "../src/core/fontfile";
import { captionLayout, captionScript, fontFile, registerFont, unregisterFont } from "../src/core/captions";
import { fontLines } from "../src/core/ffjob";

/** A minimal TrueType file: A–Z are 600 units wide, a–z 500, on a 1000-unit em. */
function tinyFont(family: string): Uint8Array {
  const u16 = (...v: number[]) => v.flatMap((x) => [(x >> 8) & 255, x & 255]);
  const u32 = (x: number) => [...u16(x >>> 16), ...u16(x & 0xffff)];
  const pad = (b: number[], n: number) => [...b, ...new Array(n - b.length).fill(0)];
  const head = pad([...new Array(18).fill(0), ...u16(1000)], 54);
  const hhea = pad([...new Array(34).fill(0), ...u16(53)], 36);
  const os2 = pad([...new Array(74).fill(0), ...u16(900, 300)], 78);
  const hmtx = [0, ...new Array(26).fill(600), ...new Array(26).fill(500)].flatMap((a) => u16(a, 0));
  const cmap = [
    ...u16(0, 1), ...u16(3, 1), ...u32(12),                         // one table: Windows, Unicode BMP
    ...u16(4, 0, 0, 6, 0, 0, 0), ...u16(90, 122, 0xffff), ...u16(0),  // format 4, three segments: end codes
    ...u16(65, 97, 0xffff), ...u16(0x10000 - 64, 0x10000 - 70, 1), ...u16(0, 0, 0),
  ];
  const text = [...family].flatMap((c) => u16(c.charCodeAt(0)));
  const name = [...u16(0, 1, 18), ...u16(3, 1, 0x409, 1, text.length, 0), ...text];
  const tables: Array<[string, number[]]> = [["OS/2", os2], ["cmap", cmap], ["head", head], ["hhea", hhea], ["hmtx", hmtx], ["name", name]];
  let off = 12 + 16 * tables.length;
  const dir: number[] = [], data: number[] = [];
  for (const [tag, b] of tables) {
    dir.push(...[...tag].map((c) => c.charCodeAt(0)), ...u32(0), ...u32(off), ...u32(b.length));
    data.push(...b);
    off += b.length;
  }
  return new Uint8Array([...u32(0x00010000), ...u16(tables.length, 0, 0, 0), ...dir, ...data]);
}

describe("a font of the user's own", () => {
  it("is read for its family name and metrics", () => {
    const info = parseFontFile(tinyFont("Casa Mea"));
    expect(info.family).toBe("Casa Mea");
    expect(info.lh).toBeCloseTo(1.2);
    expect(info.upper).toBeCloseTo(0.6);
    expect(info.lower).toBeCloseTo(0.5);
  });

  it("says why a file can't be used", () => {
    const woff = new Uint8Array([0x77, 0x4f, 0x46, 0x32, ...new Array(20).fill(0)]);
    expect(() => parseFontFile(woff)).toThrow(/\.ttf or \.otf/);
    expect(() => parseFontFile(new TextEncoder().encode("this is not a font at all"))).toThrow(/not a \.ttf or \.otf/);
    expect(() => parseFontFile(tinyFont("Cut").slice(0, 150))).toThrow(/missing|damaged/);
  });

  it("captions with it once registered, and commands expect the file to be there", () => {
    const info = parseFontFile(tinyFont("Casa Mea"));
    const name = registerFont(info.family, { url: "blob:x", lh: info.lh, upper: info.upper, lower: info.lower, file: "CasaMea.ttf", local: true });
    try {
      const words = [{ s: 0, e: 0.4, w: "Bună" }, { s: 0.5, e: 0.9, w: "ziua" }];
      const frame = { width: 1080, height: 1920 };
      expect(captionLayout(words, [{ s: 0, e: 1 }], frame, { font: name }).fontName).toBe("Casa Mea");
      const cap = captionScript(words, [{ s: 0, e: 1 }], frame, { font: name, size: 10 });
      expect(cap.ass).toContain("Style: Cap,Casa Mea,130,");                // 108 px letters × its line height 1.2
      expect(cap.font).toEqual({ file: "CasaMea.ttf", url: "blob:x", local: true });
      const sh = fontLines([cap.font, fontFile("Anton")]).join("\n");
      expect(sh).toContain("Put your font CasaMea.ttf into textcut_fonts/ first");
      expect(sh).not.toContain("blob:");
      expect(sh).toContain("curl -fsSL -o textcut_fonts/Anton-Regular.ttf");
    } finally {
      unregisterFont(name);
    }
    // gone again: the style's own font is used
    expect(captionLayout([], [], { width: 1080, height: 1920 }, { font: "Casa Mea" }).fontName).not.toBe("Casa Mea");
    // a built-in name is never replaced
    registerFont("Anton", { url: "blob:y", lh: 9, upper: 9, lower: 9 });
    expect(fontFile("Anton").url).toMatch(/^https:/);
  });
});
