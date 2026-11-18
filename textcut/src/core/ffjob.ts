/**
 * One description of a cut → ffmpeg invocations. The same job runs in the browser
 * (ffmpeg.wasm) and is printed as a shell script for a native ffmpeg, so what you
 * copy is exactly what the browser would run.
 */

import type { TimeRange } from "./ranges";
import type { FontFile } from "./captions";
import { opFilters, type Frame, type OpState } from "./ops";

export type CutMode =
  | "exact"   // re-encode to H.264/AAC: frame-accurate, processing ops apply
  | "copy"    // stream copy: instant, but cut points snap to keyframes; no processing
  | "audio";  // audio only, re-encoded (aac / mp3 / pcm)

export type AudioCodec = "aac" | "mp3" | "pcm";

export interface CutSpec {
  input: string;
  output: string;
  ranges: readonly TimeRange[];
  mode: CutMode;
  /** the source has a video stream */
  hasVideo: boolean;
  /** source frame size, for exact crop/scale numbers (null: use expressions) */
  frame?: Frame | null;
  ops?: readonly OpState[];
  /** short audio fade (s) at every join, so word-level cuts don't click. 0 = off */
  fade?: number;
  audioCodec?: AudioCodec;
  crf?: number;
  preset?: string;
  /** prefix for intermediate files (copy mode's parts, the captions script) */
  tmp?: string;
  /** the transcript's words, source time — captions need them */
  words?: ReadonlyArray<{ s: number; e: number; w: string }>;
  /** transcript language (captions' upper-casing) */
  lang?: string;
  /** where the captions' fonts go (default "textcut_fonts") */
  fontsDir?: string;
}

export interface FfJob {
  /** ffmpeg argv lists (without the `ffmpeg` itself), run in order */
  steps: string[][];
  /** text files the steps need, written before the first step */
  files: Array<{ path: string; text: string }>;
  /** fonts to download into `fontsDir` before the first step */
  fonts?: FontFile[];
  fontsDir?: string;
  /** ffmpeg filters the job needs that not every build has (e.g. "ass": libass) */
  requires?: string[];
  /** intermediate files to delete afterwards */
  temps: string[];
  output: string;
  /** total output duration (s), for progress */
  duration: number;
  notes: string[];
}

const S = (t: number) => (Math.round(t * 1000) / 1000).toFixed(3);

/** Output file extension for a mode. */
export function outputExt(mode: CutMode, srcName: string, hasVideo: boolean, codec: AudioCodec = "aac"): string {
  const src = (srcName.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  if (mode === "exact") return hasVideo ? "mp4" : "m4a";
  if (mode === "audio") return codec === "mp3" ? "mp3" : codec === "pcm" ? "wav" : "m4a";
  if (hasVideo) return ["mp4", "mov", "m4v", "mkv", "webm"].includes(src) ? src : "mp4";
  return src || "m4a";
}

function isChronological(rs: readonly TimeRange[]): boolean {
  for (let i = 1; i < rs.length; i++) if (rs[i]!.s < rs[i - 1]!.e - 1e-6) return false;
  return true;
}

export function buildJob(spec: CutSpec): FfJob {
  const ranges = spec.ranges.filter((r) => r.e - r.s > 0.001);
  if (!ranges.length) throw new Error("Nothing to export");
  const duration = ranges.reduce((n, r) => n + (r.e - r.s), 0);
  return spec.mode === "copy" ? copyJob(spec, ranges, duration) : encodeJob(spec);
}

function copyJob(spec: CutSpec, ranges: readonly TimeRange[], duration: number): FfJob {
  const notes: string[] = [];
  if (spec.ops?.some((o) => o.on)) notes.push("Fast copy can't crop or filter — processing is ignored. Use the exact (re-encode) mode.");
  const ext = spec.output.match(/\.([a-z0-9]+)$/i)?.[1] ?? "mp4";
  const maps = ["-map", "0:v:0?", "-map", "0:a:0?"];
  const cut = (r: TimeRange, out: string) =>
    ["-ss", S(r.s), "-t", S(r.e - r.s), "-i", spec.input, ...maps, "-c", "copy", "-avoid_negative_ts", "make_zero", out];
  if (ranges.length === 1) {
    return { steps: [cut(ranges[0]!, spec.output)], files: [], temps: [], output: spec.output, duration, notes };
  }
  const tmp = spec.tmp ?? "textcut_";
  const parts = ranges.map((_, i) => `${tmp}part${String(i).padStart(3, "0")}.${ext}`);
  const list = `${tmp}concat.txt`;
  // concat-demuxer paths are relative to the list file: use bare names next to it.
  const base = (p: string) => p.split("/").pop()!;
  return {
    steps: [
      ...ranges.map((r, i) => cut(r, parts[i]!)),
      ["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", spec.output],
    ],
    files: [{ path: list, text: parts.map((p) => `file '${base(p)}'`).join("\n") + "\n" }],
    temps: [...parts, list],
    output: spec.output,
    duration,
    notes,
  };
}

/**
 * A re-encoding cut, before it's spelled as argv: inputs (all of `spec.input`,
 * each seeked), the filter graph, what to map, and the encoder settings. Both the
 * argv (browser + shell) and the radiant `ffmpeg` step are rendered from this.
 */
export interface EncodePlan {
  /** one entry per `-i spec.input`: input seek, and input duration when known */
  inputs: Array<{ ss: number; t?: number }>;
  graph: string[];
  /** -map targets: "[label]" for graph outputs, "0:a:0" for raw streams */
  maps: string[];
  video: { codec: string; preset: string; crf: number; pixFmt: string } | null;
  audio: { codec: string; bitrate?: string };
  /** extra output options contributed by ops (e.g. -ar 48000) */
  extra: string[];
  /** text files and fonts the graph reads (captions) */
  files: Array<{ path: string; text: string }>;
  fonts: FontFile[];
  fontsDir: string;
  requires: string[];
  faststart: boolean;
  duration: number;
  notes: string[];
}

/**
 * Plan a re-encoding cut. With `seekOnly`, inputs carry just a seek (no input-side
 * `-t`), and every segment's length comes from trim filters instead — the shape
 * radiant's `ffmpeg` step can express (`start` + `inputs[].start`).
 */
export function encodePlan(spec: CutSpec, seekOnly = false): EncodePlan {
  const ranges = spec.ranges.filter((r) => r.e - r.s > 0.001);
  if (!ranges.length) throw new Error("Nothing to export");
  const duration = ranges.reduce((n, r) => n + (r.e - r.s), 0);
  const notes: string[] = [];
  const mode = spec.mode === "copy" ? (spec.hasVideo ? "exact" : "audio") : spec.mode;
  const video = mode === "exact" && spec.hasVideo;
  const n = ranges.length;
  const fade = n > 1 ? Math.max(0, spec.fade ?? 0) : 0;
  const inputs: EncodePlan["inputs"] = [];
  const graph: string[] = [];
  const vSeg: string[] = [], aSeg: string[] = [];

  const afade = (d: number) => {
    const f = Math.min(fade, d / 3);
    return f > 0.0005 ? `,afade=t=in:d=${S(f)},afade=t=out:st=${S(d - f)}:d=${S(f)}` : "";
  };

  // One decode pass over a single input (cheap when the ranges are close together,
  // e.g. a talk with words and pauses removed), or one fast-seeked input per range
  // (when they're far apart, or reordered — a single pass would have to buffer).
  const t0 = ranges[0]!.s, t1 = ranges[n - 1]!.e;
  const onePass = n > 1 && isChronological(ranges) && (n > 12 || duration >= 0.5 * (t1 - t0));
  if (onePass) {
    inputs.push(seekOnly ? { ss: t0 } : { ss: t0, t: t1 - t0 });
    ranges.forEach((r, i) => {
      const a = S(r.s - t0), b = S(r.e - t0);
      if (video) {
        graph.push(`[0:v:0]trim=start=${a}:end=${b},setpts=PTS-STARTPTS[v${i}]`);
        vSeg.push(`[v${i}]`);
      }
      graph.push(`[0:a:0]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS${afade(r.e - r.s)}[a${i}]`);
      aSeg.push(`[a${i}]`);
    });
  } else {
    if (n > 12) notes.push(`${n} separate inputs: fine for a native ffmpeg, heavy for the browser.`);
    ranges.forEach((r, i) => {
      const d = r.e - r.s;
      inputs.push(seekOnly ? { ss: r.s } : { ss: r.s, t: d });
      if (seekOnly) {
        if (video) {
          graph.push(`[${i}:v:0]trim=duration=${S(d)},setpts=PTS-STARTPTS[v${i}]`);
          vSeg.push(`[v${i}]`);
        }
        graph.push(`[${i}:a:0]atrim=duration=${S(d)},asetpts=PTS-STARTPTS${afade(d)}[a${i}]`);
        aSeg.push(`[a${i}]`);
        return;
      }
      if (video) vSeg.push(`[${i}:v:0]`);
      const f = afade(d);
      if (f) {
        graph.push(`[${i}:a:0]${f.slice(1)}[a${i}]`);
        aSeg.push(`[a${i}]`);
      } else aSeg.push(`[${i}:a:0]`);
    });
  }

  let vOut = vSeg[0] ?? "", aOut = aSeg[0]!;
  if (n > 1) {
    const pads = ranges.map((_, i) => (video ? vSeg[i]! : "") + aSeg[i]!).join("");
    graph.push(`${pads}concat=n=${n}:v=${video ? 1 : 0}:a=1${video ? "[vc]" : ""}[ac]`);
    vOut = video ? "[vc]" : "";
    aOut = "[ac]";
  }

  const fontsDir = spec.fontsDir ?? "textcut_fonts";
  const ops = opFilters(spec.ops ?? [], spec.frame ?? null, video, {
    words: spec.words, lang: spec.lang, ranges, tmp: spec.tmp ?? "textcut_", fontsDir,
  });
  notes.push(...ops.notes);
  if (video && ops.video.length) {
    graph.push(`${vOut}${ops.video.join(",")}[vout]`);
    vOut = "[vout]";
  }
  if (ops.audio.length) {
    graph.push(`${aOut}${ops.audio.join(",")}[aout]`);
    aOut = "[aout]";
  }

  // Raw input pads are mapped as "0:v:0", filter outputs as "[label]".
  const mapOf = (l: string) => (/^\[\d+:/.test(l) ? l.slice(1, -1) : l);
  const codec = mode === "audio" ? spec.audioCodec ?? "aac" : "aac";
  return {
    inputs, graph,
    maps: [...(video ? [mapOf(vOut)] : []), mapOf(aOut)],
    video: video ? { codec: "libx264", preset: spec.preset ?? "veryfast", crf: spec.crf ?? 21, pixFmt: "yuv420p" } : null,
    audio: codec === "mp3" ? { codec: "libmp3lame", bitrate: "192k" }
         : codec === "pcm" ? { codec: "pcm_s16le" } : { codec: "aac", bitrate: "192k" },
    extra: ops.out,
    files: ops.files, fonts: ops.fonts, fontsDir,
    requires: ops.video.some((f) => f.startsWith("ass=")) ? ["ass"] : [],
    faststart: /\.(mp4|m4a|mov|m4v)$/i.test(spec.output),
    duration, notes,
  };
}

function encodeJob(spec: CutSpec): FfJob {
  const p = encodePlan(spec);
  const args: string[] = [];
  for (const i of p.inputs) args.push("-ss", S(i.ss), ...(i.t != null ? ["-t", S(i.t)] : []), "-i", spec.input);
  if (p.graph.length) args.push("-filter_complex", p.graph.join(";\n"));
  for (const m of p.maps) args.push("-map", m);
  if (p.video) args.push("-c:v", p.video.codec, "-preset", p.video.preset, "-crf", String(p.video.crf), "-pix_fmt", p.video.pixFmt);
  args.push("-c:a", p.audio.codec, ...(p.audio.bitrate ? ["-b:a", p.audio.bitrate] : []), ...p.extra);
  if (p.faststart) args.push("-movflags", "+faststart");
  args.push(spec.output);
  return {
    steps: [args], files: p.files, temps: p.files.map((f) => f.path), output: spec.output, duration: p.duration, notes: p.notes,
    ...(p.fonts.length ? { fonts: p.fonts, fontsDir: p.fontsDir } : {}),
    ...(p.requires.length ? { requires: p.requires } : {}),
  };
}

// ------------------------------------------------------------ shell rendering

/** POSIX-shell quoting (bash/zsh): bare when safe, else single-quoted. */
export function shQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Break an argv over lines at the natural places: inputs, graph, maps, codecs, output. */
function fmtCommand(args: readonly string[], sub: (a: string) => string | null = () => null): string {
  const lines: string[][] = [["ffmpeg", "-hide_banner"]];
  let map = false, codec = false;
  args.forEach((a, i) => {
    const isCodec = /^-c(:[av])?$/.test(a);
    const brk = a === "-ss" || (a === "-f" && i === 0) || a === "-filter_complex" ||
      (a === "-map" && !map) || (isCodec && !codec) || i === args.length - 1;
    map ||= a === "-map";
    codec ||= isCodec;
    if (brk) lines.push([]);
    lines[lines.length - 1]!.push(sub(a) ?? shQuote(a));
  });
  return lines.map((l) => l.join(" ")).join(" \\\n  ");
}

export interface ShellVars {
  /** the literal input / output in the job, replaced by "$INPUT" / "$OUTPUT" */
  input: string;
  output: string;
}

/**
 * The job as a shell script a native ffmpeg can run. With `vars`, the input and
 * output become $INPUT / $OUTPUT, defaulting to the original values:
 * `INPUT=other.mp4 sh cut.sh`.
 */
export function jobToShell(job: FfJob, vars?: ShellVars): string {
  const out: string[] = [];
  const multi = job.steps.length > 1 || job.files.length > 0 || !!job.fonts?.length;
  if (multi) out.push("set -e");
  if (vars) {
    out.push(`INPUT=\${INPUT:-${shQuote(vars.input)}}`, `OUTPUT=\${OUTPUT:-${shQuote(vars.output)}}`);
  }
  const sub = (a: string) => (vars && a === vars.input ? '"$INPUT"' : vars && a === vars.output ? '"$OUTPUT"' : null);
  out.push(...requireLines(job.requires));
  out.push(...fontLines(job.fonts, job.fontsDir));
  for (const f of job.files) out.push(`cat > ${shQuote(f.path)} <<'EOF'\n${f.text.replace(/\n$/, "")}\nEOF`);
  for (const s of job.steps) out.push(fmtCommand(s, sub));
  if (job.temps.length) out.push(`rm -f ${job.temps.map(shQuote).join(" ")}`);
  return out.join("\n");
}

/** Shell lines that stop early when this ffmpeg lacks a filter the job uses. */
export function requireLines(filters: readonly string[] = []): string[] {
  return filters.map((f) =>
    `ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' ${f} ' || ` +
    `{ echo "This needs an ffmpeg with the '${f}' filter${f === "ass" ? " (libass; macOS: brew install ffmpeg-full)" : ""}" >&2; exit 1; }`);
}

/** Shell lines that download the fonts once (kept for the next run). */
export function fontLines(fonts: readonly FontFile[] = [], dir = "textcut_fonts"): string[] {
  if (!fonts.length) return [];
  return [
    `mkdir -p ${shQuote(dir)}`,
    ...fonts.map((f) => `[ -s ${shQuote(`${dir}/${f.file}`)} ] || curl -fsSL -o ${shQuote(`${dir}/${f.file}`)} ${shQuote(f.url)}`),
  ];
}
