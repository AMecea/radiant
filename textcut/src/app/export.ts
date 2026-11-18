/**
 * Rendering cuts in the browser.
 *
 *  - WAV: native. A PCM .wav source is cut straight from its bytes (File.slice /
 *    HTTP Range), so even hour-long masters export instantly without decoding.
 *    Anything else (mp3, m4a, mp4…) is decoded with WebAudio first.
 *  - Everything else (mp4, mp3, m4a…, crop & filters): ffmpeg.wasm, downloaded on
 *    first use (~32 MB, cached by the browser afterwards). Single-threaded build, so
 *    it works on any static host without cross-origin-isolation headers.
 *
 * ffmpeg never needs the whole recording in memory: a local File is read lazily
 * from disk (WORKERFS), and a URL that supports HTTP Range is read lazily over the
 * network (see ffmpeg-worker.ts) — only the index and the stretches being cut are
 * fetched. Hosts without Range support fall back to a full download.
 */

import type { TimeRange } from "../core/ranges";
import type { FontFile } from "../core/captions";
import { buildJob, type CutSpec } from "../core/ffjob";
import { encodeWav, parseWavHeader, pcmToFloat, wavByteRange } from "../core/wav";
import { fmtBytes } from "./dom";
import { FFmpegWorker, type NetStats } from "./ffmpeg-client";
import { byteReader, probeUrl, type MediaSource } from "./sources";

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

let coreUrls: Promise<{ coreURL: string; wasmURL: string }> | null = null;
let current: FFmpegWorker | null = null;

/** A loaded ffmpeg worker; a new one after a cancel (the core download is reused). */
async function getFFmpeg(progress: Progress): Promise<FFmpegWorker> {
  if (current && !current.dead) return current;
  const urls = coreUrls ??= (async () => {
    progress("Downloading ffmpeg.wasm (~32 MB, first time only)…", 0);
    const coreURL = await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript");
    const wasmURL = await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm",
      (f) => progress(`Downloading ffmpeg.wasm… ${Math.round(f * 100)}%`, f));
    return { coreURL, wasmURL };
  })();
  try {
    const { coreURL, wasmURL } = await urls;
    progress("Starting ffmpeg…");
    const ff = new FFmpegWorker();
    await ff.load(coreURL, wasmURL);
    current = ff;
    return ff;
  } catch (e) {
    coreUrls = null;
    throw e;
  }
}

/** Font bytes, fetched once per page. */
const fontCache = new Map<string, Promise<Uint8Array>>();

function fetchFont(f: FontFile): Promise<Uint8Array> {
  let p = fontCache.get(f.url);
  if (!p) {
    p = fetch(f.url).then(async (res) => {
      if (!res.ok) throw new Error(`Couldn't download the font ${f.file}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    });
    p.catch(() => fontCache.delete(f.url));
    fontCache.set(f.url, p);
  }
  return p;
}

const FONTS_DIR = "/fonts";

export interface RunCut {
  /** the cut, minus input/output names (those depend on where it runs) */
  spec: Omit<CutSpec, "input" | "output" | "tmp" | "fontsDir">;
  ext: string;
  progress: Progress;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

const MIME: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm",
  m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", flac: "audio/flac",
};

let runSeq = 0;

/** Run a cut with ffmpeg.wasm and return the result. */
export async function runCut(src: MediaSource, o: RunCut): Promise<{ blob: Blob; ext: string; net: NetStats | null }> {
  const { progress, signal } = o;
  if (signal?.aborted) throw new Error("Cancelled");
  const ff = await getFFmpeg(progress);
  const onAbort = () => ff.kill(new Error("Cancelled"));
  signal?.addEventListener("abort", onAbort);

  let net: NetStats | null = null;
  let status = "";
  const show = (frac?: number) => progress(
    status + (net ? ` · fetched ${fmtBytes(net.fetched)} of ${fmtBytes(net.size)}` : ""), frac);

  const dir = `/src${++runSeq}`;
  const cleanup: Array<() => Promise<unknown>> = [];
  try {
    let input: string;
    if (src.kind === "file") {
      await ff.mountFiles(dir, [src.file]);
      cleanup.push(() => ff.unmount(dir));
      input = `${dir}/${src.file.name}`;
    } else {
      progress("Checking the media URL…");
      const pr = await probeUrl(src.url).catch((e: Error) => {
        throw new Error(`Couldn't reach the media (${e.message}) — the host must allow CORS; or open it as a local file.`);
      });
      const name = src.name.replace(/[^\w.-]+/g, "_") || "input";
      if (pr.ranges && pr.size) {
        // Lazy: only the bytes ffmpeg reads are fetched.
        await ff.mountUrl(dir, name, src.url, pr.size);
        cleanup.push(() => ff.unmount(dir));
        input = `${dir}/${name}`;
        o.log?.(`[textcut] ${src.url}: Range requests supported — reading only what's needed of ${fmtBytes(pr.size)}`);
      } else {
        o.log?.(`[textcut] ${src.url}: no Range support — downloading the whole file`);
        const bytes = await downloadAll(src.url, pr.size, progress);
        input = `/${name}`;
        await ff.writeFile(input, bytes);
        cleanup.push(() => ff.deleteFile(input));
      }
    }

    const job = buildJob({ ...o.spec, input, output: `/out${runSeq}.${o.ext}`, tmp: `/tmp${runSeq}_`, fontsDir: FONTS_DIR });
    for (const n of job.notes) o.log?.(`[textcut] ${n}`);
    if (job.fonts?.length) {
      progress("Loading fonts…");
      await ff.mkdir(FONTS_DIR);
      for (const f of job.fonts) await ff.writeFile(`${FONTS_DIR}/${f.file}`, await fetchFont(f));
    }
    for (const f of job.files) await ff.writeFile(f.path, f.text);
    cleanup.push(async () => {
      for (const p of [...job.temps, ...job.files.map((f) => f.path)]) await ff.deleteFile(p).catch(() => {});
    });

    let step = 0;
    const nSteps = job.steps.length;
    ff.on = {
      log: o.log,
      net: (s) => { net = s; show(); },
      progress: ({ time }) => {
        // `time`: microseconds of output written by the current step.
        const f = nSteps > 1 ? (step + Math.min(1, time / 1e6 / (job.duration / nSteps))) / nSteps
                             : Math.min(1, Math.max(0, time / 1e6 / job.duration));
        status = `Rendering… ${Math.round(f * 100)}%`;
        show(f);
      },
    };
    for (; step < nSteps; step++) {
      status = nSteps > 1 ? `Step ${step + 1}/${nSteps}…` : "Rendering…";
      show(step / nSteps);
      const code = await ff.exec(job.steps[step]!);
      if (code !== 0) throw new Error(`ffmpeg exited with code ${code} — see the log`);
    }
    const data = await ff.readFile(job.output);
    await ff.deleteFile(job.output).catch(() => {});
    progress("Done", 1);
    return { blob: new Blob([data as BlobPart], { type: MIME[o.ext] ?? "application/octet-stream" }), ext: o.ext, net };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    ff.on = {};
    if (!ff.dead) for (const c of cleanup.reverse()) await c().catch(() => {});
  }
}

async function downloadAll(url: string, size: number | null, progress: Progress): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Media download failed: HTTP ${res.status}`);
  const total = size ?? (Number(res.headers.get("Content-Length")) || 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    progress(`Downloading media… ${fmtBytes(got)}${total ? ` of ${fmtBytes(total)}` : ""}`, total ? got / total : undefined);
  }
  return new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer());
}
