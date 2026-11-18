/** Main-thread side of ./ffmpeg-worker.ts: a promise per request, plus events. */

export interface NetStats {
  fetched: number;
  requests: number;
  size: number;
}

export interface FFEvents {
  log?: (line: string) => void;
  progress?: (p: { progress: number; time: number }) => void;
  net?: (s: NetStats) => void;
}

export class FFmpegWorker {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, { ok: (v: unknown) => void; err: (e: Error) => void }>();
  on: FFEvents = {};
  dead = false;

  constructor() {
    this.worker = new Worker(new URL("./ffmpeg-worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data: m }) => {
      if (m.id == null) {
        if (m.type === "log") this.on.log?.(m.data);
        else if (m.type === "progress") this.on.progress?.(m.data);
        else if (m.type === "net") this.on.net?.(m.data);
        return;
      }
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.ok) p?.ok(m.data);
      else p?.err(new Error(m.error));
    };
    this.worker.onerror = (e) => this.kill(new Error(e.message || "ffmpeg worker crashed"));
  }

  private call<T>(type: string, data: unknown): Promise<T> {
    if (this.dead) return Promise.reject(new Error("ffmpeg was stopped"));
    const id = ++this.seq;
    return new Promise<T>((ok, err) => {
      this.pending.set(id, { ok: ok as (v: unknown) => void, err });
      this.worker.postMessage({ id, type, data });
    });
  }

  load(coreURL: string, wasmURL: string) { return this.call<boolean>("load", { coreURL, wasmURL }); }
  exec(args: string[]) { return this.call<number>("exec", { args }); }
  writeFile(path: string, data: Uint8Array | string) { return this.call<void>("writeFile", { path, data }); }
  readFile(path: string) { return this.call<Uint8Array>("readFile", { path }); }
  deleteFile(path: string) { return this.call<void>("deleteFile", { path }); }
  mkdir(path: string) { return this.call<void>("mkdir", { path }); }
  mountFiles(dir: string, files: File[]) { return this.call<void>("mountFiles", { dir, files }); }
  mountUrl(dir: string, name: string, url: string, size: number) { return this.call<void>("mountUrl", { dir, name, url, size }); }
  unmount(dir: string) { return this.call<void>("unmount", { dir }); }

  /** Stop immediately (cancels a running exec); the instance is unusable afterwards. */
  kill(reason = new Error("Cancelled")): void {
    if (this.dead) return;
    this.dead = true;
    this.worker.terminate();
    for (const p of this.pending.values()) p.err(reason);
    this.pending.clear();
  }
}
