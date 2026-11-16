/** Where the transcript and media come from: a URL, a local File, or (for the
 *  transcript) data packed into the link itself. */

import { parseTranscript, type Transcript } from "../core/transcript";
import { normalizeUrl, unpackJson } from "../core/link";

export type MediaSource =
  | { kind: "url"; url: string; name: string }
  | { kind: "file"; file: File; name: string };

export type TranscriptOrigin =
  | { kind: "url"; url: string }
  | { kind: "file"; name: string }
  | { kind: "inline" };

export interface LoadedTranscript {
  transcript: Transcript;
  origin: TranscriptOrigin;
  name: string;
}

export const MEDIA_EXT = /\.(wav|wave|mp3|m4a|aac|ogg|oga|opus|flac|weba|webm|mp4|m4v|mov|mkv|ogv|3gp)$/i;
export const TRANSCRIPT_EXT = /\.(json|txt)$/i;

export function isMediaFile(f: File): boolean {
  return /^(audio|video)\//.test(f.type) || MEDIA_EXT.test(f.name);
}
export function isTranscriptFile(f: File): boolean {
  return TRANSCRIPT_EXT.test(f.name) || f.type === "application/json" || f.type === "text/plain";
}

export function baseName(pathOrUrl: string): string {
  try {
    const u = new URL(pathOrUrl);
    pathOrUrl = decodeURIComponent(u.pathname);
  } catch { /* plain name */ }
  return pathOrUrl.split("/").filter(Boolean).pop() ?? pathOrUrl;
}

/** Strip the media/transcript suffixes to get the recording's stem. */
export function stemOf(name: string): string {
  return name.replace(/\.words\.json$/i, "").replace(/\.[a-z0-9]+$/i, "");
}

export async function loadTranscriptUrl(url: string): Promise<LoadedTranscript> {
  const direct = normalizeUrl(url);
  let res: Response;
  try {
    res = await fetch(direct);
  } catch (e) {
    throw new Error(`Couldn't fetch the transcript (${(e as Error).message}). The host must allow ` +
      "cross-origin requests (CORS) — GitHub raw, gists, Dropbox and most object stores do; " +
      "or embed the transcript in the link instead.");
  }
  if (!res.ok) throw new Error(`Transcript fetch failed: HTTP ${res.status} ${res.statusText}`);
  return { transcript: parseTranscript(await res.text()), origin: { kind: "url", url }, name: baseName(direct) };
}

export async function loadTranscriptFile(file: File): Promise<LoadedTranscript> {
  return { transcript: parseTranscript(await file.text()), origin: { kind: "file", name: file.name }, name: file.name };
}

export async function loadTranscriptInline(tx: string, title?: string): Promise<LoadedTranscript> {
  return { transcript: parseTranscript(await unpackJson(tx)), origin: { kind: "inline" }, name: title ?? "transcript" };
}

export function mediaFromUrl(url: string): MediaSource {
  const direct = normalizeUrl(url);
  return { kind: "url", url: direct, name: baseName(direct) };
}

export function mediaFromFile(file: File): MediaSource {
  return { kind: "file", file, name: file.name };
}

/** Byte-range reader over a File or a (CORS-enabled) URL. */
export interface ByteReader {
  size: number | null;
  read(start: number, end: number): Promise<Uint8Array>;
  all(): Promise<Uint8Array>;
}

export async function byteReader(src: MediaSource): Promise<ByteReader> {
  if (src.kind === "file") {
    const f = src.file;
    return {
      size: f.size,
      read: async (a, b) => new Uint8Array(await f.slice(a, b).arrayBuffer()),
      all: async () => new Uint8Array(await f.arrayBuffer()),
    };
  }
  const url = src.url;
  let size: number | null, ranges: boolean;
  try {
    ({ size, ranges } = await probeUrl(url));
  } catch (e) {
    throw new Error(`Can't read the media bytes (${(e as Error).message}). Exporting from a URL ` +
      "needs the host to allow CORS; open the media as a local file instead.");
  }
  let whole: Promise<Uint8Array> | null = null;
  const all = () => (whole ??= fetch(url).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }));
  return {
    size,
    all,
    read: async (a, b) => {
      if (!ranges) return (await all()).subarray(a, b);
      const r = await fetch(url, { headers: { Range: `bytes=${a}-${b - 1}` } });
      if (r.status !== 206) throw new Error(`Range request failed: HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}

/**
 * Does the host serve byte ranges, and how big is the file? A 1-byte range request
 * answers both (206 + Content-Range). Cross-origin, Content-Range is only readable
 * when the host exposes it, so fall back to a HEAD request's Content-Length.
 */
export async function probeUrl(url: string): Promise<{ ranges: boolean; size: number | null }> {
  let size: number | null = null;
  let ranges = false;
  const r = await fetch(url, { headers: { Range: "bytes=0-0" } });
  if (r.status === 206) {
    ranges = true;
    const m = r.headers.get("Content-Range")?.match(/\/(\d+)$/);
    if (m) size = Number(m[1]);
  } else if (r.ok) {
    const cl = r.headers.get("Content-Length");
    if (cl) size = Number(cl);
  } else {
    throw new Error(`HTTP ${r.status}`);
  }
  await r.body?.cancel().catch(() => {});
  if (ranges && size == null) {
    const hd = await fetch(url, { method: "HEAD" }).catch(() => null);
    const cl = hd?.ok ? Number(hd.headers.get("Content-Length")) : 0;
    if (cl > 0 && !hd!.headers.get("Content-Encoding")) size = cl;
  }
  return { ranges, size };
}
