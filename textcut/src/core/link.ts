import { parseTime } from "./time";
import type { TimeRange } from "./ranges";

/**
 * Everything the app can be opened with. Read from the URL fragment (preferred —
 * it never reaches the server) and the query string; the fragment wins.
 *
 *   words  URL of a <stem>.words.json (or segment .txt)
 *   media  URL of the audio/video file
 *   tx     the transcript itself, deflate-raw + base64url compressed (compact form)
 *   title  display title
 *   clips  "s-e,s-e,…" one clip's segments (seconds or clock times)
 *   reels  several named clips: "Intro~1-5,9-12|Q&A~30-41" (name~segments, "|" between)
 *   sel    "s-e" selection to restore
 *   at     start position, seconds or clock time
 *   dw     deleted words, by index: "3-5,10"
 *   dg     deleted pauses, by (index of the word before them) + 1: "0,14"
 *   x      an export to open on arrival (ranges, format, processing), packed:
 *          see {@link ExportPreset}
 */
export interface LinkParams {
  words?: string;
  media?: string;
  tx?: string;
  title?: string;
  clips?: TimeRange[];
  /** several named clips (wins over `clips`) */
  reels?: NamedRanges[];
  sel?: TimeRange;
  at?: number;
  dw?: string;
  dg?: string;
  x?: string;
}

/** A ready-to-run export, shared in a link (`x=`, deflate + base64url JSON). */
export interface ExportPreset {
  v: 1;
  /** the ranges to export, in order, [start, end] seconds */
  r: Array<[number, number]>;
  /** dialog heading */
  h?: string;
  /** format id (exact / copy / wav / m4a / mp3) */
  m?: string;
  /** enabled processing ops */
  o?: Array<{ id: string; p: Record<string, string | number> }>;
  /** smooth joins on/off */
  f?: 0 | 1;
  /** output file name, without extension */
  n?: string;
  /** commands use variables */
  vars?: 0 | 1;
}

export interface NamedRanges {
  name: string;
  ranges: TimeRange[];
}

export function readLink(loc: { search: string; hash: string }): LinkParams {
  const q = new URLSearchParams(loc.search);
  const h = new URLSearchParams(loc.hash.replace(/^#/, ""));
  const get = (k: string) => h.get(k) ?? q.get(k) ?? undefined;
  const out: LinkParams = {};
  const words = get("words"), media = get("media"), tx = get("tx"), title = get("title");
  if (words) out.words = words;
  if (media) out.media = media;
  if (tx) out.tx = tx;
  if (title) out.title = title;
  const dw = get("dw"), dg = get("dg");
  if (dw) out.dw = dw;
  if (dg) out.dg = dg;
  const x = get("x");
  if (x) out.x = x;
  const clips = get("clips");
  if (clips) out.clips = decodeRanges(clips);
  const reels = get("reels");
  if (reels) out.reels = decodeReels(reels);
  const sel = get("sel");
  if (sel) {
    const r = decodeRanges(sel)[0];
    if (r) out.sel = r;
  }
  const at = get("at");
  if (at && Number.isFinite(parseTime(at))) out.at = parseTime(at);
  return out;
}

/** Build a link to `base` (page URL without hash) carrying `p` in the fragment. */
export function buildLink(base: string, p: LinkParams): string {
  const h = new URLSearchParams();
  if (p.title) h.set("title", p.title);
  if (p.media) h.set("media", p.media);
  if (p.words) h.set("words", p.words);
  if (p.reels?.length) h.set("reels", encodeReels(p.reels));
  else if (p.clips?.length) h.set("clips", encodeRanges(p.clips));
  if (p.sel) h.set("sel", encodeRanges([p.sel]));
  if (p.at != null) h.set("at", String(+p.at.toFixed(3)));
  if (p.dw) h.set("dw", p.dw);
  if (p.dg) h.set("dg", p.dg);
  if (p.x) h.set("x", p.x);
  if (p.tx) h.set("tx", p.tx); // last: it's the long one
  const frag = h.toString().replace(/%2F/gi, "/").replace(/%3A/gi, ":").replace(/%2C/gi, ",");
  return `${base.replace(/#.*$/, "")}#${frag}`;
}

export function encodeRanges(rs: readonly TimeRange[]): string {
  return rs.map((r) => `${+r.s.toFixed(3)}-${+r.e.toFixed(3)}`).join(",");
}

/** Names lose the separators ("~", "|") — everything else survives URL encoding. */
export function encodeReels(reels: readonly NamedRanges[]): string {
  return reels.map((r) => `${r.name.replace(/[~|]+/g, " ").trim()}~${encodeRanges(r.ranges)}`).join("|");
}

export function decodeReels(str: string): NamedRanges[] {
  return str.split("|").flatMap((part, i) => {
    const k = part.lastIndexOf("~");
    const name = (k >= 0 ? part.slice(0, k) : "").trim() || `Clip ${i + 1}`;
    const ranges = decodeRanges(k >= 0 ? part.slice(k + 1) : part);
    return ranges.length || k >= 0 ? [{ name, ranges }] : [];
  });
}

export function decodeRanges(str: string): TimeRange[] {
  return str.split(",").flatMap((p) => {
    const m = p.match(/^\s*([\d.:]+)\s*-\s*([\d.:]+)\s*$/);
    if (!m) return [];
    const s = parseTime(m[1]!), e = parseTime(m[2]!);
    return e > s ? [{ s, e }] : [];
  });
}

/** Turn common "share" links into direct-download ones. */
export function normalizeUrl(u: string): string {
  u = u.trim();
  if (!u) return u;
  let m: RegExpMatchArray | null;
  if ((m = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/))) {
    return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  }
  if ((m = u.match(/^https?:\/\/gist\.github\.com\/([^/]+)\/([0-9a-f]+)\/?$/))) {
    return `https://gist.githubusercontent.com/${m[1]}/${m[2]}/raw`;
  }
  if ((m = u.match(/^https?:\/\/(?:www\.)?dropbox\.com\/(.+)$/))) {
    const url = new URL(`https://dl.dropboxusercontent.com/${m[1]}`);
    url.searchParams.delete("dl");
    url.searchParams.delete("raw");
    return url.toString();
  }
  if ((m = u.match(/^https?:\/\/drive\.google\.com\/file\/d\/([^/?#]+)/)) ||
      (m = u.match(/^https?:\/\/drive\.google\.com\/open\?id=([^&#]+)/))) {
    return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  }
  return u;
}

// ------------------------------------------------------------ packing

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipeBytes(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** JSON → deflate-raw → base64url, for embedding a transcript in a link. */
export async function packJson(obj: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return b64urlEncode(await pipeBytes(bytes, new CompressionStream("deflate-raw")));
}

export async function unpackJson<T = unknown>(s: string): Promise<T> {
  const bytes = await pipeBytes(b64urlDecode(s), new DecompressionStream("deflate-raw"));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export async function packPreset(p: ExportPreset): Promise<string> {
  return packJson(p);
}

export async function unpackPreset(s: string): Promise<ExportPreset | null> {
  try {
    const p = await unpackJson<ExportPreset>(s);
    if (p?.v !== 1 || !Array.isArray(p.r)) return null;
    p.r = p.r.filter((x) => Array.isArray(x) && Number(x[1]) > Number(x[0])).map(([a, b]) => [Number(a), Number(b)]);
    return p.r.length ? p : null;
  } catch {
    return null;
  }
}
