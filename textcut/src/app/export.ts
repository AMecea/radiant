/**
 * Rendering cuts in the browser.
 *
 *  - WAV: native. A PCM .wav source is cut straight from its bytes (File.slice /
 *    HTTP Range), so even hour-long masters export instantly without decoding.
 *    Anything else (mp3, m4a, mp4…) is decoded with WebAudio first.
 *  - Everything else (mp4, mp3, m4a…): ffmpeg.wasm, downloaded on first use
 *    (~32 MB, cached by the browser afterwards). Single-threaded build, so it
 *    works on any static host without cross-origin-isolation headers.
 */

import type { FFmpeg } from "@ffmpeg/ffmpeg";
import type { TimeRange } from "../core/ranges";
import { encodeWav, parseWavHeader, pcmToFloat, wavByteRange } from "../core/wav";
import { byteReader, type MediaSource } from "./sources";

export type Progress = (msg: string, frac?: number) => void;

// ------------------------------------------------------------------ WAV

export async function exportWav(src: MediaSource, ranges: readonly TimeRange[], progress: Progress): Promise<Blob> {
  if (!ranges.length) throw new Error("Nothing to export");
  const reader = await byteReader(src);
  progress("Reading header…");
  const head = await reader.read(0, Math.min(reader.size ?? 1 << 20, 1 << 20));
  const hdr = parseWavHeader(head);

  if (hdr) {
    const pieces: Float32Array[][] = [];
    for (const [i, r] of ranges.entries()) {
      progress(`Cutting ${i + 1}/${ranges.length}…`, i / ranges.length);
      const [a, b] = wavByteRange(hdr, r.s, r.e);
      pieces.push(pcmToFloat(await reader.read(a, b), hdr));
    }
    progress("Encoding…", 1);
    const float = hdr.format === 3 || hdr.bitsPerSample > 16;
    return new Blob([encodeWav(pieces, hdr.sampleRate, { float }) as BlobPart], { type: "audio/wav" });
  }

  if (reader.size && reader.size > 1.5e9) {
    throw new Error("This file is too large to decode in the browser; use the ffmpeg export " +
                    "(or copy the ffmpeg command) instead.");
  }
  progress("Downloading / reading media…");
  const bytes = await reader.all();
  progress("Decoding audio…");
  const ctx = new AudioContext();
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
  } catch {
    throw new Error("The browser couldn't decode this file's audio track. Try the ffmpeg export.");
  } finally {
    void ctx.close();
  }
  const pieces = ranges.map((r) => {
    const a = Math.max(0, Math.floor(r.s * buf.sampleRate));
    const b = Math.min(buf.length, Math.ceil(r.e * buf.sampleRate));
    return Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice(a, b));
  });
  progress("Encoding…", 1);
  return new Blob([encodeWav(pieces, buf.sampleRate) as BlobPart], { type: "audio/wav" });
}

// ------------------------------------------------------------------ ffmpeg.wasm

const CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.9/dist/esm";

let ffmpegPromise: Promise<FFmpeg> | null = null;

/**
 * fetch → blob: URL, reporting progress. (Our own instead of @ffmpeg/util's
 * toBlobURL, which fails when the CDN compresses the response: Content-Length is
 * then the compressed size and never matches the decoded byte count.)
 */
async function toBlobURL(url: string, type: string, onProgress?: (frac: number) => void): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Couldn't download ${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("Content-Length")) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) onProgress?.(Math.min(1, got / total));
  }
  return URL.createObjectURL(new Blob(chunks as BlobPart[], { type }));
}

async function getFFmpeg(progress: Progress): Promise<FFmpeg> {
  ffmpegPromise ??= (async () => {
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const ff = new FFmpeg();
    progress("Downloading ffmpeg.wasm (~32 MB, first time only)…", 0);
    const coreURL = await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript");
    const wasmURL = await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm",
      (f) => progress(`Downloading ffmpeg.wasm… ${Math.round(f * 100)}%`, f));
    progress("Starting ffmpeg…");
    await ff.load({ coreURL, wasmURL });
    return ff;
  })();
  try {
    return await ffmpegPromise;
  } catch (e) {
    ffmpegPromise = null;
    throw e;
  }
}

export type FfmpegMode =
  | "video-copy"    // stream copy: instant, cuts snap to keyframes
  | "video-encode"  // H.264/AAC re-encode: frame-accurate, slow in wasm
  | "mp3"
  | "m4a";

export interface FfmpegExport {
  mode: FfmpegMode;
  hasVideo: boolean;
}

export async function exportWithFFmpeg(
  src: MediaSource, ranges: readonly TimeRange[], opts: FfmpegExport, progress: Progress,
  log?: (line: string) => void,
): Promise<{ blob: Blob; ext: string }> {
  if (!ranges.length) throw new Error("Nothing to export");
  const ff = await getFFmpeg(progress);
  const logger = ({ message }: { message: string }) => log?.(message);
  ff.on("log", logger);

  const srcExt = (src.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "mp4").toLowerCase();
  let input: string;
  const cleanup: Array<() => Promise<unknown>> = [];
  if (src.kind === "file") {
    // WORKERFS reads the File lazily — no copy of a multi-GB master into memory.
    await ff.createDir("/in").catch(() => {});
    await ff.mount("WORKERFS" as never, { files: [src.file] }, "/in");
    cleanup.push(() => ff.unmount("/in"));
    input = `/in/${src.file.name}`;
  } else {
    progress("Downloading media…");
    input = `/input.${srcExt}`;
    const res = await fetch(src.url).catch((e: Error) => {
      throw new Error(`Couldn't download the media (${e.message}) — the host must allow CORS; or open it as a local file.`);
    });
    if (!res.ok) throw new Error(`Media download failed: HTTP ${res.status}`);
    await ff.writeFile(input, new Uint8Array(await res.arrayBuffer()));
    cleanup.push(() => ff.deleteFile(input));
  }

  const total = ranges.reduce((n, r) => n + (r.e - r.s), 0);
  let done = 0;
  const onProgress = ({ time }: { time: number }) => {
    // `time` is microseconds of output written by the current exec.
    const t = Math.max(0, time / 1e6);
    progress(`Rendering… ${Math.round(((done + t) / total) * 100)}%`, Math.min(1, (done + t) / total));
  };
  ff.on("progress", onProgress);

  const S = (t: number) => t.toFixed(3);
  const run = async (args: string[]) => {
    const code = await ff.exec(args);
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code} — see the log`);
  };

  try {
    let out: string, ext: string, mime: string;
    if (opts.mode === "video-copy") {
      ext = opts.hasVideo ? (["mp4", "mov", "m4v", "mkv", "webm"].includes(srcExt) ? srcExt : "mp4") : srcExt;
      const parts: string[] = [];
      for (const [i, r] of ranges.entries()) {
        const part = `/part${i}.${ext}`;
        await run(["-ss", S(r.s), "-t", S(r.e - r.s), "-i", input, "-map", "0", "-c", "copy",
                   "-avoid_negative_ts", "make_zero", part]);
        parts.push(part);
        done += r.e - r.s;
      }
      out = `/out.${ext}`;
      if (parts.length === 1) {
        await ff.rename(parts[0]!, out);
      } else {
        await ff.writeFile("/list.txt", parts.map((p) => `file '${p}'`).join("\n"));
        await run(["-f", "concat", "-safe", "0", "-i", "/list.txt", "-c", "copy", out]);
        for (const p of parts) await ff.deleteFile(p);
      }
      mime = opts.hasVideo ? `video/${ext === "mov" ? "quicktime" : ext}` : `audio/${ext}`;
    } else {
      const video = opts.mode === "video-encode" && opts.hasVideo;
      ext = opts.mode === "mp3" ? "mp3" : opts.mode === "m4a" ? "m4a" : "mp4";
      mime = opts.mode === "mp3" ? "audio/mpeg" : opts.mode === "m4a" ? "audio/mp4" : "video/mp4";
      const inputs = ranges.flatMap((r) => ["-ss", S(r.s), "-t", S(r.e - r.s), "-i", input]);
      const pads = ranges.map((_, i) => (video ? `[${i}:v:0][${i}:a:0]` : `[${i}:a:0]`)).join("");
      const graph = `${pads}concat=n=${ranges.length}:v=${video ? 1 : 0}:a=1${video ? "[v][a]" : "[a]"}`;
      const codecs = opts.mode === "mp3" ? ["-c:a", "libmp3lame", "-q:a", "2"]
        : video ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
                   "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
        : ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
      out = `/out.${ext}`;
      await run([...inputs, "-filter_complex", graph,
                 ...(video ? ["-map", "[v]", "-map", "[a]"] : ["-map", "[a]"]), ...codecs, out]);
    }
    const data = await ff.readFile(out);
    await ff.deleteFile(out);
    progress("Done", 1);
    return { blob: new Blob([data as BlobPart], { type: mime }), ext };
  } finally {
    ff.off("progress", onProgress);
    ff.off("log", logger);
    for (const c of cleanup) await c().catch(() => {});
  }
}
