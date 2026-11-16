import type { Word } from "../core/transcript";
import type { Pause, TimeRange } from "../core/ranges";
import { fmtShort } from "../core/time";
import { h } from "./dom";

interface Callbacks {
  seek(t: number): void;
  selectTime(a: number, b: number): void;
}

/**
 * Overview strip of the whole recording: speech vs. pauses (from the word timings),
 * clips, search hits, the selection and the playhead. Click to seek, drag to
 * select the words in a time span.
 */
export class Timeline {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private base: HTMLCanvasElement = document.createElement("canvas");
  private tip: HTMLElement;
  private words: readonly Word[] = [];
  private pauses: readonly Pause[] = [];
  private clips: readonly TimeRange[] = [];
  private removed: readonly TimeRange[] = [];
  private hits: number[] = [];
  private sel: TimeRange | null = null;
  private time = 0;
  private duration = 1;
  private ro: ResizeObserver;
  private dirty = true;
  private drag: { x0: number; t0: number; moved: boolean } | null = null;
  private dragSel: TimeRange | null = null;

  constructor(private cb: Callbacks) {
    this.canvas = h("canvas", { "aria-label": "Timeline: click to seek, drag to select" });
    this.tip = h("div", { class: "tl-tip mono", hidden: true });
    this.el = h("div", { class: "timeline" }, this.canvas, this.tip);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
    this.canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.onMove(e));
    this.canvas.addEventListener("pointerup", (e) => this.onUp(e));
    this.canvas.addEventListener("pointerleave", () => { this.tip.hidden = true; });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.invalidate());
  }

  setData(words: readonly Word[], pauses: readonly Pause[], duration: number): void {
    this.words = words;
    this.pauses = pauses;
    this.duration = Math.max(duration, 0.001);
    this.invalidate();
  }
  setClips(c: readonly TimeRange[]): void { this.clips = c; this.invalidate(); }
  setRemoved(r: readonly TimeRange[]): void { this.removed = r; this.invalidate(); }
  setHits(times: number[]): void { this.hits = times; this.invalidate(); }
  setSel(r: TimeRange | null): void { this.sel = r; this.draw(); }
  setTime(t: number): void { this.time = t; this.draw(); }

  resize(): void {
    const w = this.el.clientWidth, hgt = this.el.clientHeight;
    if (!w || !hgt) return;
    const dpr = devicePixelRatio || 1;
    for (const c of [this.canvas, this.base]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
    }
    this.invalidate();
  }

  destroy(): void { this.ro.disconnect(); }

  private invalidate(): void {
    this.dirty = true;
    this.draw();
  }

  private css(name: string): string {
    return getComputedStyle(this.el).getPropertyValue(name).trim() || "#888";
  }

  private x(t: number): number { return (t / this.duration) * this.canvas.width; }

  private paintBase(): void {
    const c = this.base, g = c.getContext("2d")!;
    const W = c.width, H = c.height, dpr = devicePixelRatio || 1;
    g.clearRect(0, 0, W, H);
    g.fillStyle = this.css("--tl-bg");
    g.fillRect(0, 0, W, H);
    // Speech: the stretches between pauses.
    const top = Math.round(H * 0.3), sh = Math.round(H * 0.45);
    g.fillStyle = this.css("--tl-speech");
    if (this.words.length) {
      let s = this.words[0]!.s;
      for (const p of this.pauses) {
        if (p.after < 0) { s = p.e; continue; }
        g.fillRect(this.x(s), top, Math.max(1, this.x(p.s) - this.x(s)), sh);
        s = p.e;
      }
      const lastEnd = this.words[this.words.length - 1]!.e;
      if (s < lastEnd) g.fillRect(this.x(s), top, Math.max(1, this.x(lastEnd) - this.x(s)), sh);
    }
    // Removed by text edits: struck through, speech dimmed.
    if (this.removed.length) {
      g.fillStyle = this.css("--cut-bg");
      for (const r of this.removed) g.fillRect(this.x(r.s), 0, Math.max(1, this.x(r.e) - this.x(r.s)), H);
      g.fillStyle = this.css("--cut");
      const mid = Math.round(top + sh / 2) - dpr;
      for (const r of this.removed) g.fillRect(this.x(r.s), mid, Math.max(1, this.x(r.e) - this.x(r.s)), 2 * dpr);
    }
    // Clips: band along the bottom.
    g.fillStyle = this.css("--clip");
    for (const r of this.clips) g.fillRect(this.x(r.s), H - 5 * dpr, Math.max(2, this.x(r.e) - this.x(r.s)), 5 * dpr);
    // Search hits: ticks along the top.
    g.fillStyle = this.css("--hit-strong");
    for (const t of this.hits) g.fillRect(this.x(t) - dpr, 0, 2 * dpr, top - dpr);
    this.dirty = false;
  }

  private draw(): void {
    if (!this.canvas.width) return;
    if (this.dirty) this.paintBase();
    const g = this.canvas.getContext("2d")!;
    const W = this.canvas.width, H = this.canvas.height, dpr = devicePixelRatio || 1;
    g.clearRect(0, 0, W, H);
    g.drawImage(this.base, 0, 0);
    const sel = this.dragSel ?? this.sel;
    if (sel) {
      g.fillStyle = this.css("--sel-bg");
      g.globalAlpha = 0.55;
      g.fillRect(this.x(sel.s), 0, Math.max(2, this.x(sel.e) - this.x(sel.s)), H);
      g.globalAlpha = 1;
    }
    g.fillStyle = this.css("--accent");
    g.fillRect(Math.round(this.x(this.time)) - dpr, 0, 2 * dpr, H);
  }

  private tAt(e: PointerEvent): number {
    const r = this.canvas.getBoundingClientRect();
    return Math.max(0, Math.min(this.duration, ((e.clientX - r.left) / r.width) * this.duration));
  }

  private onDown(e: PointerEvent): void {
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { x0: e.clientX, t0: this.tAt(e), moved: false };
  }

  private onMove(e: PointerEvent): void {
    const t = this.tAt(e);
    const r = this.canvas.getBoundingClientRect();
    this.tip.hidden = false;
    this.tip.textContent = fmtShort(t);
    this.tip.style.left = `${Math.min(r.width - 40, Math.max(0, e.clientX - r.left - 20))}px`;
    if (!this.drag) return;
    if (Math.abs(e.clientX - this.drag.x0) > 4) this.drag.moved = true;
    if (this.drag.moved) {
      this.dragSel = { s: Math.min(this.drag.t0, t), e: Math.max(this.drag.t0, t) };
      this.draw();
    }
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    this.dragSel = null;
    if (!d) return;
    const t = this.tAt(e);
    if (d.moved) this.cb.selectTime(Math.min(d.t0, t), Math.max(d.t0, t));
    else this.cb.seek(t);
    this.draw();
  }
}
