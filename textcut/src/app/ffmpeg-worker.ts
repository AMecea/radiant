/**
 * Our own ffmpeg.wasm worker (instead of @ffmpeg/ffmpeg's), for one extra trick:
 * mounting a *URL* as a lazily-read file. ffmpeg then fetches only the bytes it
 * actually reads — the container index plus the stretches being cut — with HTTP
 * Range requests, instead of the whole recording being downloaded into memory first.
 *
 * It works through Emscripten's WORKERFS, which reads a mounted "blob" via
 * `blob.slice(a, b)` + FileReaderSync. We hand it a Blob look-alike whose slice()
 * does a synchronous ranged XHR (allowed in workers), with a small LRU chunk cache.
 *
 * Protocol: {id, type, data} → {id, ok, data | error}; plus unsolicited
 * {type: "log" | "progress" | "net", data} events.
 */

interface CoreFS {
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string): Uint8Array;
  unlink(path: string): void;
  mkdir(path: string): void;
  rmdir(path: string): void;
  mount(fs: unknown, opts: unknown, dir: string): void;
  unmount(dir: string): void;
  filesystems: Record<string, unknown>;
  ErrnoError: new (errno: number) => Error;
}

interface Core {
  FS: CoreFS;
  ret: number;
  exec(...args: string[]): number;
  reset(): void;
  setTimeout(ms: number): void;
  setLogger(fn: (l: { type: string; message: string }) => void): void;
  setProgress(fn: (p: { progress: number; time: number }) => void): void;
}

let core: Core | null = null;

const post = (msg: unknown, transfer: Transferable[] = []) => self.postMessage(msg, { transfer });

const CHUNK = 1 << 20;          // 1 MiB
const CACHE_CHUNKS = 96;        // ≤ ~96 MiB cached
const MAX_AHEAD = 8;            // sequential reads grow to 8 MiB per request

/** A read-only, Blob-shaped view of a URL, read with synchronous Range requests. */
class RangeFile {
  private cache = new Map<number, Uint8Array>();
  private whole: Uint8Array | null = null;
  private lastChunk = -2;
  private ahead = 1;
  fetched = 0;
  requests = 0;
  error: string | null = null;

  constructor(readonly url: string, readonly size: number) {}

  /** WORKERFS calls this, then reads the returned (real) Blob with FileReaderSync. */
  slice(a: number, b: number): Blob {
    b = Math.min(b, this.size);
    if (b <= a) return new Blob([]);
    try {
      return new Blob([this.read(a, b) as BlobPart]);
    } catch (e) {
      this.error = (e as Error).message;
      throw new core!.FS.ErrnoError(29); // EIO: ffmpeg reports an I/O error instead of the worker aborting
    }
  }

  private read(a: number, b: number): Uint8Array {
    if (this.whole) return this.whole.subarray(a, b);
    const first = Math.floor(a / CHUNK), last = Math.floor((b - 1) / CHUNK);
    for (let k = first; k <= last; k++) {
      if (this.cache.has(k)) continue;
      // Sequential reading (decoding a long stretch): fetch further ahead each time.
      this.ahead = k === this.lastChunk + 1 ? Math.min(MAX_AHEAD, this.ahead * 2) : 1;
      let end = Math.max(k, last);
      end = Math.min(end + this.ahead - 1, Math.ceil(this.size / CHUNK) - 1);
      let m = k;
      while (m < end && !this.cache.has(m + 1)) m++;
      this.fetchChunks(k, m);
      if (this.whole) return (this.whole as Uint8Array).subarray(a, b);
      this.lastChunk = m;
      k = m;
    }
    const out = new Uint8Array(b - a);
    for (let k = first; k <= last; k++) {
      const c = this.cache.get(k)!;
      this.cache.delete(k); // LRU: re-insert as most recent
      this.cache.set(k, c);
      const cs = k * CHUNK;
      const from = Math.max(a, cs), to = Math.min(b, cs + c.length);
      out.set(c.subarray(from - cs, to - cs), from - a);
    }
    return out;
  }

  private fetchChunks(k0: number, k1: number): void {
    const from = k0 * CHUNK, to = Math.min(this.size, (k1 + 1) * CHUNK) - 1;
    const xhr = new XMLHttpRequest();
    xhr.open("GET", this.url, false);
    xhr.responseType = "arraybuffer";
    xhr.setRequestHeader("Range", `bytes=${from}-${to}`);
    xhr.send();
    this.requests++;
    if (xhr.status === 200) {
      // The server ignored the Range header and sent everything: use that.
      this.whole = new Uint8Array(xhr.response as ArrayBuffer);
      this.fetched += this.whole.length;
      this.cache.clear();
    } else if (xhr.status === 206) {
      const buf = new Uint8Array(xhr.response as ArrayBuffer);
      this.fetched += buf.length;
      for (let k = k0; k <= k1; k++) {
        this.cache.set(k, buf.subarray((k - k0) * CHUNK, (k - k0 + 1) * CHUNK));
      }
      while (this.cache.size > CACHE_CHUNKS) this.cache.delete(this.cache.keys().next().value!);
    } else {
      throw new Error(`Range request failed: HTTP ${xhr.status}`);
    }
    post({ type: "net", data: { fetched: this.fetched, requests: this.requests, size: this.size } });
  }
}

const remote = new Map<string, RangeFile>();

type Handler = (d: any) => unknown;

const handlers: Record<string, Handler> = {
  async load({ coreURL, wasmURL }: { coreURL: string; wasmURL: string }) {
    if (core) return true;
    const mod = await import(/* @vite-ignore */ coreURL);
    // ffmpeg-core reads the wasm location from the hash of mainScriptUrlOrBlob.
    core = (await mod.default({ mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL }))}` })) as Core;
    core.setLogger(({ message }) => post({ type: "log", data: message }));
    core.setProgress((p) => post({ type: "progress", data: p }));
    return true;
  },
  exec({ args }: { args: string[] }) {
    const c = core!;
    c.setTimeout(-1);
    c.exec(...args);
    const ret = c.ret;
    c.reset();
    const err = [...remote.values()].map((r) => r.error).find(Boolean);
    if (err) throw new Error(`Reading the media failed: ${err}`);
    return ret;
  },
  writeFile: ({ path, data }: { path: string; data: Uint8Array | string }) => core!.FS.writeFile(path, data),
  readFile: ({ path }: { path: string }) => core!.FS.readFile(path),
  deleteFile: ({ path }: { path: string }) => core!.FS.unlink(path),
  /** Create a directory; fine if it exists. */
  mkdir({ path }: { path: string }) {
    try { core!.FS.mkdir(path); } catch { /* EEXIST */ }
  },
  /** Mount local File objects (read lazily from disk) at `dir`. */
  mountFiles({ dir, files }: { dir: string; files: File[] }) {
    core!.FS.mkdir(dir);
    core!.FS.mount(core!.FS.filesystems.WORKERFS, { files }, dir);
  },
  /** Mount a URL (read lazily over HTTP Range) as `dir/name`. */
  mountUrl({ dir, name, url, size }: { dir: string; name: string; url: string; size: number }) {
    const f = new RangeFile(url, size);
    remote.set(dir, f);
    core!.FS.mkdir(dir);
    core!.FS.mount(core!.FS.filesystems.WORKERFS, { blobs: [{ name, data: f }] }, dir);
  },
  unmount({ dir }: { dir: string }) {
    remote.delete(dir);
    core!.FS.unmount(dir);
    core!.FS.rmdir(dir);
  },
};

self.onmessage = async (ev: MessageEvent<{ id: number; type: string; data: unknown }>) => {
  const { id, type, data } = ev.data;
  try {
    const h = handlers[type];
    if (!h) throw new Error(`unknown message ${type}`);
    if (type !== "load" && !core) throw new Error("ffmpeg isn't loaded");
    const res = await h(data);
    post({ id, ok: true, data: res }, res instanceof Uint8Array ? [res.buffer] : []);
  } catch (e) {
    post({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
