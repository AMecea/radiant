import { fmtTime, type TimeStyle } from "./time";
import type { TimeRange } from "./ranges";
import { buildJob, jobToShell } from "./ffjob";

export interface Clip extends TimeRange {
  text?: string;
}

export type ClipFormat = "ranges" | "trim-yaml" | "clip-yaml" | "ffmpeg" | "csv" | "json" | "srt";

export const CLIP_FORMATS: Array<{ id: ClipFormat; label: string }> = [
  { id: "ranges", label: "Start ⇥ end lines" },
  { id: "trim-yaml", label: "radiant trim step (one cut)" },
  { id: "clip-yaml", label: "radiant clip steps (one reel each)" },
  { id: "ffmpeg", label: "ffmpeg command" },
  { id: "csv", label: "CSV" },
  { id: "json", label: "JSON" },
  { id: "srt", label: "SRT subtitles of the cut" },
];

export interface FormatOptions {
  style?: TimeStyle;
  input?: string;
  output?: string;
  /** false for audio-only sources (affects the ffmpeg command) */
  hasVideo?: boolean;
  /** audio fade at each join (s), ffmpeg command only */
  fade?: number;
}

/** Text renderings of a clip list, for the clipboard. */
export function formatClips(clips: readonly Clip[], kind: ClipFormat, opts: FormatOptions = {}): string {
  const { style = "clock", input = "INPUT.mp4", output = "cut.mp4", hasVideo = true } = opts;
  const T = (t: number) => fmtTime(t, style);
  const Y = (t: number) => (style === "seconds" ? fmtTime(t, "seconds") : `"${fmtTime(t)}"`);
  const S = (t: number) => fmtTime(t, "seconds");
  const many = clips.length > 1;

  switch (kind) {
    case "ranges":
      return clips.map((c) => `${T(c.s)}\t${T(c.e)}`).join("\n");

    case "trim-yaml":
      return [
        "  - id: textcut",
        "    action: trim",
        "    with:",
        `      input: "${input}"`,
        `      output: "${output}"`,
        "      include:",
        ...clips.map((c) => `        - { start: ${Y(c.s)}, end: ${Y(c.e)} }` +
          (c.text ? `   # ${oneLine(c.text, 60)}` : "")),
      ].join("\n");

    case "clip-yaml":
      return clips.map((c, i) => {
        const n = many ? String(i + 1) : "";
        return [
          `  - id: reel${n}`,
          "    action: clip",
          "    with:",
          `      input: "${input}"`,
          `      start: ${Y(c.s)}`,
          `      end: ${Y(c.e)}`,
          `      output: "reel${n}.mp4"`,
          ...(c.text ? [`      # ${oneLine(c.text, 70)}`] : []),
        ].join("\n");
      }).join("\n\n");

    case "ffmpeg":
      return jobToShell(buildJob({
        input, output, ranges: clips, mode: hasVideo ? "exact" : "audio", hasVideo, fade: opts.fade ?? 0.01,
      }));

    case "csv":
      return "start,end,duration,text\n" + clips.map((c) =>
        [S(c.s), S(c.e), S(c.e - c.s), `"${(c.text ?? "").replace(/"/g, '""')}"`].join(",")).join("\n");

    case "json":
      return JSON.stringify(clips.map((c) => ({
        start: +c.s.toFixed(3), end: +c.e.toFixed(3), text: c.text ?? "",
      })), null, 2);

    case "srt": {
      // Timed against the *cut* (clips back to back), so it subtitles the export.
      let t = 0;
      const srt = (x: number) => fmtTime(x).replace(".", ",");
      return clips.map((c, i) => {
        const a = t;
        t += c.e - c.s;
        return `${i + 1}\n${srt(a)} --> ${srt(t)}\n${c.text ?? ""}\n`;
      }).join("\n");
    }
  }
}

export function oneLine(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
