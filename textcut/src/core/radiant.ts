/**
 * A cut as a radiant plan: one `ffmpeg` step carrying the same filter graph the
 * browser runs (frame-accurate trims, joins, crop, audio filters). Inputs are
 * seek-only (`start`, `inputs[].start`) and segment lengths live in the graph,
 * which is what the step can express.
 *
 * Captions add a `shell` step first: it writes the .ass script and downloads the
 * font the graph's `ass` filter reads.
 */

import { encodePlan, fontLines, requireLines, shQuote, type CutSpec } from "./ffjob";

export interface RadiantOptions {
  /** use ${vars.input} / ${vars.output}, declared with the original values as defaults */
  vars?: boolean;
  /** plan name */
  name?: string;
  /** a comment line at the top */
  comment?: string;
}

const q = (s: string) => JSON.stringify(s); // a JSON string is a valid YAML double-quoted scalar
const S = (t: number) => (Math.round(t * 1000) / 1000).toFixed(3);

export function radiantPlan(spec: CutSpec, o: RadiantOptions = {}): string {
  const lines: string[] = [];
  if (o.comment) lines.push(`# ${o.comment}`);
  if (spec.mode === "copy") {
    lines.push("# radiant has no stream-copy cut: this step re-encodes (frame-accurate).");
  }
  const p = encodePlan(spec, true);
  const input = o.vars ? "${vars.input}" : spec.input;
  const output = o.vars ? "${vars.output}" : spec.output;
  lines.push("#", "#   radiant run --plan <this file>" + (o.vars ? "  [--vars input=… output=…]" : ""), "");
  lines.push(`name: ${q(o.name ?? "textcut")}`, "");
  if (o.vars) {
    lines.push("vars:", `  input: ${q(spec.input)}`, `  output: ${q(spec.output)}`, "");
  }
  if (p.requires.includes("ass")) {
    lines.push("# The captions need an ffmpeg with libass (macOS: brew install ffmpeg-full).", "");
  }
  lines.push("steps:");
  if (p.files.length || p.fonts.length) {
    const sh = [
      ...requireLines(p.requires),
      ...fontLines(p.fonts, p.fontsDir),
      ...p.files.map((f) => `cat > ${shQuote(f.path)} <<'EOF'\n${f.text.replace(/\n$/, "")}\nEOF`),
    ];
    lines.push(
      "  - id: captions",
      "    action: shell",
      "    with:",
      "      cmd: |",
      ...sh.join("\n").split("\n").map((l) => (l ? `        ${l}` : "")),
      "",
    );
  }
  lines.push(
    "  - id: cut",
    "    action: ffmpeg",
    "    with:",
    `      input: ${q(input)}`,
    `      output: ${q(output)}`,
    `      start: ${S(p.inputs[0]!.ss)}`,
  );
  if (p.inputs.length > 1) {
    lines.push("      inputs:");
    for (const i of p.inputs.slice(1)) lines.push(`        - { file: ${q(input)}, start: ${S(i.ss)} }`);
  }
  if (p.graph.length) {
    lines.push("      filter_complex: |-");
    for (const g of p.graph.join(";\n").split("\n")) lines.push(`        ${g}`);
  }
  lines.push(`      map: [${p.maps.map(q).join(", ")}]`);
  if (p.video) {
    lines.push(
      `      vcodec: ${p.video.codec}`,
      `      preset: ${p.video.preset}`,
      `      crf: ${p.video.crf}`,
      `      pix_fmt: ${p.video.pixFmt}`,
    );
  }
  lines.push(`      acodec: ${p.audio.codec}`);
  if (p.audio.bitrate) lines.push(`      audio_bitrate: ${p.audio.bitrate}`);
  if (!p.faststart) lines.push("      faststart: false");
  if (p.extra.length) lines.push(`      extra_args: [${p.extra.map(q).join(", ")}]`);
  return lines.join("\n") + "\n";
}
