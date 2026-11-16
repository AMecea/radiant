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
 *   clips  "s-e,s-e,…" clip list (seconds or clock times)
 *   sel    "s-e" selection to restore
 *   at     start position, seconds or clock time
 */
export interface LinkParams {
  words?: string;
  media?: string;
  tx?: string;
  title?: string;
  clips?: TimeRange[];
  sel?: TimeRange;
  at?: number;
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
  const clips = get("clips");
  if (clips) out.clips = decodeRanges(clips);
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
  if (p.clips?.length) h.set("clips", encodeRanges(p.clips));
  if (p.sel) h.set("sel", encodeRanges([p.sel]));
  if (p.at != null) h.set("at", String(+p.at.toFixed(3)));
  if (p.tx) h.set("tx", p.tx); // last: it's the long one
  const frag = h.toString().replace(/%2F/gi, "/").replace(/%3A/gi, ":").replace(/%2C/gi, ",");
  return `${base.replace(/#.*$/, "")}#${frag}`;
}

export function encodeRanges(rs: readonly TimeRange[]): string {
  return rs.map((r) => `${+r.s.toFixed(3)}-${+r.e.toFixed(3)}`).join(",");
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
