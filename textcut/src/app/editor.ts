import { gluesToPrev, textOf, wordAt, compactTranscript, type Transcript, type Word } from "../core/transcript";
import { findPauses, mergeRanges, rangeOf, splitAtPauses, wordsIn, type Pause, type TimeRange, type WordRange } from "../core/ranges";
import { buildSearchIndex, search, type SearchIndex } from "../core/search";
import { fmtDur, fmtShort, fmtTime } from "../core/time";
import { CLIP_FORMATS, formatClips, oneLine, type Clip, type ClipFormat } from "../core/formats";
import {
  hasEdits, packEdits, rangeAt, removedRanges, subtractRanges, unpackEdits, type CutParams, type Edits, type PackedEdits,
} from "../core/edits";
import { buildLink, packJson, packPreset, unpackPreset, type ExportPreset, type LinkParams } from "../core/link";
import { copyText, h, isTyping, modal, toast } from "./dom";
import { loadJson, loadSettings, saveJson, saveSettings, type Settings } from "./settings";
import { mediaFromFile, mediaFromUrl, stemOf, type LoadedTranscript, type MediaSource } from "./sources";
import { openExportDialog } from "./export-dialog";
import { Timeline } from "./timeline";

/** A clip: segments of the recording, played and exported back to back. */
interface Reel {
  name: string;
  parts: Clip[];
}

export interface EditorInit {
  loaded: LoadedTranscript;
  media: MediaSource | null;
  link: LinkParams;
  onOpenOther: () => void;
}

type PlayMode =
  | { kind: "free" }
  | { kind: "until"; e: number }
  | { kind: "loop"; r: TimeRange }
  | { kind: "queue"; list: TimeRange[]; i: number };

export class Editor {
  readonly t: Transcript;
  readonly words: Word[];
  private settings: Settings = loadSettings();
  private media: MediaSource | null;
  private mediaUrl: string | null = null;
  private hasVideo = false;
  private duration: number;
  private pauses: Pause[] = [];
  private index: SearchIndex;

  private sel: WordRange | null = null;
  private selAnchor = -1;
  /** clips: each a named list of segments, exported as one cut */
  private reels: Reel[] = [];
  /** the clip that A / S add to */
  private active = 0;
  private hits: WordRange[] = [];
  private hitIdx = -1;
  private cur = -1;
  private mode: PlayMode = { kind: "free" };
  private raf = 0;
  private txPacked: Promise<string> | null = null;

  // text edits
  private delWords = new Set<number>();
  private delGaps = new Set<number>();
  /** time ranges the edits remove (sorted, merged) */
  private removed: TimeRange[] = [];
  private undoStack: PackedEdits[] = [];
  private redoStack: PackedEdits[] = [];
  /** the removed range playback started inside of (it plays; others are skipped) */
  private allowRemoval: TimeRange | null = null;

  // DOM
  readonly root: HTMLElement;
  private video!: HTMLVideoElement;
  private playerBox!: HTMLElement;
  private trEl!: HTMLElement;
  private wordEls: HTMLElement[] = [];
  private timeEl!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private selBar!: HTMLElement;
  private editsEl!: HTMLElement;
  private clipsEl!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private searchCount!: HTMLElement;
  private timeline!: Timeline;
  private loopBtn: HTMLButtonElement | null = null;

  constructor(private init: EditorInit) {
    this.t = init.loaded.transcript;
    this.words = this.t.words;
    this.media = init.media;
    this.duration = this.t.duration;
    this.index = buildSearchIndex(this.words);
    this.root = this.build();
    this.recomputePauses();
    this.renderTranscript();
    this.restoreClips();
    this.restoreEdits();
    this.setMedia(init.media);
    this.applyLinkState();
    this.bindKeys();
  }

  // ======================================================== layout

  private get title(): string {
    return this.init.link.title || stemOf(this.media?.name ?? this.init.loaded.name);
  }

  private build(): HTMLElement {
    const s = this.settings;
    this.searchInput = h("input", {
      type: "search", placeholder: "Search transcript  ( / )", "aria-label": "Search transcript",
      oninput: () => this.runSearch(),
      onkeydown: (e: Event) => {
        const k = e as KeyboardEvent;
        if (k.key === "Enter") { k.preventDefault(); this.stepHit(k.shiftKey ? -1 : 1); }
        if (k.key === "Escape") { this.searchInput.value = ""; this.runSearch(); this.searchInput.blur(); }
      },
    });
    this.searchCount = h("span", { class: "count" });

    const top = h("header", { class: "topbar" },
      h("button", { class: "brand", title: "Open other files / build a link", onclick: () => this.init.onOpenOther() }, "textcut"),
      h("div", { class: "doc-title" },
        h("strong", {}, this.title),
        h("span", { class: "muted" },
          [this.t.language && this.t.language.toUpperCase(), `${this.words.length} words`]
            .filter(Boolean).join(" · "))),
      h("div", { class: "search" }, this.searchInput, this.searchCount,
        h("button", { class: "icon", title: "Previous match (Shift+Enter)", onclick: () => this.stepHit(-1) }, "↑"),
        h("button", { class: "icon", title: "Next match (Enter)", onclick: () => this.stepHit(1) }, "↓")),
      h("div", { class: "top-actions" },
        h("button", { onclick: () => this.shareDialog(), title: "Shareable link" }, "Share"),
        h("button", { class: "icon", onclick: () => this.settingsDialog(), title: "Settings", "aria-label": "Settings" }, "⚙"),
        h("button", { class: "icon", onclick: () => this.helpDialog(), title: "Keyboard shortcuts (?)", "aria-label": "Help" }, "?")));

    this.video = h("video", { playsInline: true, preload: "auto" });
    this.video.playbackRate = s.rate;
    this.playerBox = h("div", { class: "player" }, this.video);
    this.playBtn = h("button", { class: "play", title: "Play / pause (Space)", onclick: () => this.togglePlay() }, "▶");
    this.timeEl = h("span", { class: "time mono" }, "0:00.0");
    const rate = h("select", {
      title: "Playback speed", "aria-label": "Playback speed",
      onchange: () => { s.rate = Number(rate.value); this.video.playbackRate = s.rate; saveSettings(s); },
    }, ...[0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => h("option", { value: String(r), selected: r === s.rate }, `${r}×`)));
    const transport = h("div", { class: "transport" }, this.playBtn, this.timeEl, h("span", { class: "spacer" }), rate,
      this.toggle("Follow", "Keep the current word in view", "follow"),
      this.toggle("Skip pauses", "Jump over pauses while playing (preview of a tightened cut)", "skipPauses"),
      this.toggle("Skip cuts", "Jump over deleted words and pauses while playing (preview the edit)", "previewEdits"));

    this.timeline = new Timeline({
      seek: (t) => this.seek(t),
      selectTime: (a, b) => {
        const r = wordsIn(this.words, a, b);
        if (r) this.setSel(r);
      },
    });

    this.selBar = h("div", { class: "selbar" });
    this.editsEl = h("section", { class: "edits" });
    this.clipsEl = h("section", { class: "clips" });
    this.trEl = h("article", { class: "transcript", tabindex: "0", "aria-label": "Transcript" });

    const approx = this.words.some((w) => w.approx)
      ? h("div", { class: "notice" }, "Word timings were interpolated from a segment-level transcript — " +
          "they're approximate. Re-run the transcribe step with word_timestamps: true for exact cuts.")
      : null;

    const left = h("section", { class: "left" }, this.playerBox, transport, this.timeline.el, this.selBar, this.editsEl, this.clipsEl);
    const right = h("section", { class: "right" }, approx, this.trEl);
    const root = h("div", { class: "app editor-view" }, top, h("main", { class: "editor" }, left, right));

    this.trEl.addEventListener("mouseup", (e) => this.onTranscriptMouseUp(e));
    for (const ev of ["wheel", "touchmove"]) this.trEl.addEventListener(ev, this.markUserScroll, { passive: true });
    this.trEl.addEventListener("click", (e) => this.onTranscriptClick(e));
    this.renderSelBar();
    return root;
  }

  private toggle(label: string, title: string, key: "follow" | "skipPauses" | "previewEdits"): HTMLElement {
    const input = h("input", {
      type: "checkbox", checked: this.settings[key], "data-key": key,
      onchange: () => { this.settings[key] = input.checked; saveSettings(this.settings); },
    });
    return h("label", { class: "chk", title }, input, label);
  }

  // ======================================================== media

  setMedia(src: MediaSource | null): void {
    this.media = src;
    this.txPacked = null;
    if (this.mediaUrl?.startsWith("blob:")) URL.revokeObjectURL(this.mediaUrl);
    this.playerBox.querySelector(".media-missing")?.remove();
    this.playerBox.querySelector(".media-error")?.remove();
    if (!src) {
      this.mediaUrl = null;
      this.video.removeAttribute("src");
      this.playerBox.classList.add("no-media");
      this.playerBox.append(this.missingMediaPrompt());
      this.timeline.setData(this.words, this.pauses, this.duration);
      return;
    }
    this.playerBox.classList.remove("no-media");
    this.mediaUrl = src.kind === "file" ? URL.createObjectURL(src.file) : src.url;
    const v = this.video;
    v.src = this.mediaUrl;
    v.onloadedmetadata = () => {
      this.hasVideo = v.videoWidth > 0;
      this.playerBox.classList.toggle("audio-only", !this.hasVideo);
      v.controls = this.hasVideo;
      if (Number.isFinite(v.duration) && v.duration > this.duration) this.duration = v.duration;
      this.recomputePauses();
      if (this.pendingAt != null) { v.currentTime = this.pendingAt; this.pendingAt = null; }
      this.onTime();
    };
    v.onerror = () => {
      const err = v.error;
      this.playerBox.append(h("div", { class: "media-error" },
        h("strong", {}, "Can't play this media. "),
        err?.code === 4
          ? "The browser doesn't support this file's format or codec (e.g. HEVC/ProRes/BRAW, some MKVs). " +
            "Transcode it to MP4 (H.264/AAC) or M4A/MP3 — e.g. with radiant's ffmpeg step."
          : `It failed to load (${err?.message || "network or CORS error"}). Check the URL is public and direct.`,
        " ", h("button", { onclick: () => this.pickMediaFile() }, "Choose a local file…")));
    };
    v.onplay = () => { this.playBtn.textContent = "❚❚"; this.loop(); };
    v.onpause = () => { this.playBtn.textContent = "▶"; cancelAnimationFrame(this.raf); this.onTime(); };
    v.onseeked = () => this.onTime();
    v.ontimeupdate = () => { if (v.paused) this.onTime(); };
  }

  private pendingAt: number | null = null;

  private missingMediaPrompt(): HTMLElement {
    const url = h("input", { type: "url", placeholder: "https://…/recording.mp4" });
    return h("div", { class: "media-missing" },
      h("p", {}, h("strong", {}, "No media loaded. "), "You can search and copy times without it; to listen or export, add the audio/video:"),
      h("div", { class: "row" },
        h("button", { class: "primary", onclick: () => this.pickMediaFile() }, "Choose file…"),
        h("span", { class: "muted" }, "or drop it here, or"),
        url,
        h("button", {
          onclick: () => { if (url.value.trim()) this.setMedia(mediaFromUrl(url.value)); },
        }, "Load URL")));
  }

  pickMediaFile(): void {
    const input = h("input", { type: "file", accept: "audio/*,video/*,.mkv,.mov,.flac,.opus" });
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) this.setMedia(mediaFromFile(f));
    };
    input.click();
  }

  private togglePlay(): void {
    if (!this.media) return this.pickMediaFile();
    if (this.video.paused) {
      if (this.mode.kind === "until" && this.video.currentTime >= this.mode.e - 0.02) this.mode = { kind: "free" };
      void this.video.play();
    } else this.video.pause();
  }

  seek(t: number, keepMode = false): void {
    if (!keepMode) this.setMode({ kind: "free" });
    t = Math.max(0, Math.min(this.duration || t, t));
    this.allowRemoval = rangeAt(this.removed, t);
    if (!this.media) {
      // No media: still move the "cursor" so the transcript follows.
      this.updateCurrent(wordAt(this.words, t + 1e-4), true);
      this.timeline.setTime(t);
      this.timeEl.textContent = fmtShort(t);
      return;
    }
    // Move the word cursor now: keys pressed before the seek lands (Shift+→) use it.
    this.updateCurrent(wordAt(this.words, t + 1e-3), false);
    if (this.video.readyState === 0) this.pendingAt = t;
    else this.video.currentTime = t;
  }

  private playRange(r: TimeRange, loop = false): void {
    this.seek(r.s);
    this.setMode(loop ? { kind: "loop", r } : { kind: "until", e: r.e });
    void this.video.play();
  }

  private playQueue(list: TimeRange[]): void {
    if (!list.length) return;
    this.seek(list[0]!.s);
    this.setMode({ kind: "queue", list, i: 0 });
    void this.video.play();
  }

  private setMode(m: PlayMode): void {
    this.mode = m;
    this.loopBtn?.classList.toggle("on", m.kind === "loop");
    this.clipsEl.classList.toggle("playing-all", m.kind === "queue");
    this.highlightPlayingClip();
  }

  private loop = (): void => {
    cancelAnimationFrame(this.raf);
    const step = () => {
      this.onTime();
      if (!this.video.paused) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  };

  private onTime(): void {
    const v = this.video;
    const t = v.currentTime;
    const m = this.mode;
    if (!v.paused && this.settings.previewEdits && this.removed.length) {
      // Preview the edit: jump over removed stretches — except one we were put into
      // on purpose (clicked a deleted word to hear it).
      const r = rangeAt(this.removed, t);
      if (!r) this.allowRemoval = null;
      else if (r !== this.allowRemoval) v.currentTime = r.e;
    }
    if (!v.paused) {
      if (m.kind === "until" && t >= m.e) {
        v.pause();
        v.currentTime = m.e;
        this.setMode({ kind: "free" });
      } else if (m.kind === "loop" && (t >= m.r.e || t < m.r.s - 0.5)) {
        v.currentTime = m.r.s;
      } else if (m.kind === "queue") {
        const cur = m.list[m.i]!;
        if (t >= cur.e) {
          m.i++;
          if (m.i < m.list.length) { v.currentTime = m.list[m.i]!.s; this.allowRemoval = rangeAt(this.removed, v.currentTime); }
          else { v.pause(); this.setMode({ kind: "free" }); }
          this.highlightPlayingClip();
        }
      } else if (this.settings.skipPauses && m.kind === "free") {
        const p = this.pauseAt(t);
        if (p) v.currentTime = Math.max(t, p.e - this.settings.pad);
      }
    }
    this.timeEl.textContent = `${fmtShort(t)} / ${fmtShort(this.duration)}`;
    this.timeline.setTime(t);
    this.updateCurrent(wordAt(this.words, t + 1e-3), !v.paused);
  }

  /** The pause (≥ pauseMin) whose padded interior contains t. */
  private pauseAt(t: number): Pause | null {
    const pad = this.settings.pad;
    let lo = 0, hi = this.pauses.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, p = this.pauses[mid]!;
      if (t < p.s + pad) hi = mid - 1;
      else if (t >= p.e - pad) lo = mid + 1;
      else return p;
    }
    return null;
  }

  private updateCurrent(i: number, follow: boolean): void {
    if (i === this.cur) return;
    this.wordEls[this.cur]?.classList.remove("cur");
    this.cur = i;
    const el = this.wordEls[i];
    if (!el) return;
    el.classList.add("cur");
    if (follow && this.settings.follow && !this.userScrolling) {
      const r = el.getBoundingClientRect(), box = this.trEl.getBoundingClientRect();
      if (r.top < box.top + 60 || r.bottom > box.bottom - 60) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }

  private userScrolling = false;
  private scrollTimer = 0;

  // ======================================================== transcript

  private recomputePauses(): void {
    this.pauses = findPauses(this.words, this.settings.pauseMin, this.duration);
    this.removed = removedRanges(this.words, this.edits, this.cutParams);
    this.timeline.setRemoved(this.removed);
    if (this.trEl.childElementCount) this.renderTranscript();
    this.timeline.setData(this.words, this.pauses, this.duration);
    this.timeline.setClips(this.clips);
    this.timeline.setHits(this.hits.map((x) => this.words[x.a]!.s));
  }

  private renderTranscript(): void {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    const pauseAfter = new Map(this.pauses.map((p) => [p.after, p]));
    // Deleted gaps stay visible even when they're shorter than the pause threshold.
    for (const g of this.delGaps) if (!pauseAfter.has(g)) { const p = this.gapAt(g); if (p) pauseAfter.set(g, p); }
    const html: string[] = [];
    const pauseHtml = (p: Pause) =>
      `<span class="pause${p.d >= 2 ? " long" : ""}${this.delGaps.has(p.after) ? " del" : ""}" data-pause="${p.after}" contenteditable="false" ` +
      `title="${p.d.toFixed(2)}s pause · click: play around it · Alt+click: delete / restore">${p.d.toFixed(1)}s</span>`;
    const lead = pauseAfter.get(-1);
    for (const [si, sg] of this.t.segments.entries()) {
      html.push(`<p class="seg" data-seg="${si}"><button class="ts mono" data-t="${sg.s}" tabindex="-1" ` +
                `title="Jump to ${fmtTime(sg.s)}">${fmtShort(sg.s)}</button><span class="txt">`);
      if (si === 0 && lead) html.push(pauseHtml(lead), " ");
      for (let i = sg.first; i <= sg.last; i++) {
        const w = this.words[i]!;
        const low = w.p != null && w.p < 0.5 ? " low" : "";
        const del = this.delWords.has(i) ? " del" : "";
        html.push(`<span class="w${low}${del}" data-i="${i}">${esc(w.w)}</span>`);
        const p = pauseAfter.get(i);
        const next = i < sg.last ? this.words[i + 1]!.w : "";
        html.push(p ? ` ${pauseHtml(p)} ` : next && gluesToPrev(next) ? "" : " ");
      }
      html.push("</span></p>");
    }
    this.trEl.innerHTML = html.join("");
    this.wordEls = Array.from(this.trEl.querySelectorAll<HTMLElement>(".w"));
    this.cur = -1;
    this.paintSel();
    this.paintClips();
    this.paintHits();
  }

  /** Don't yank the view back to the playing word while the user reads elsewhere. */
  private markUserScroll = (): void => {
    this.userScrolling = true;
    clearTimeout(this.scrollTimer);
    this.scrollTimer = window.setTimeout(() => { this.userScrolling = false; }, 3000);
  };

  private wordIndexOf(el: EventTarget | null): number {
    const w = (el as HTMLElement | null)?.closest?.(".w") as HTMLElement | null;
    return w ? Number(w.dataset.i) : -1;
  }

  private onTranscriptClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const ts = target.closest<HTMLElement>(".ts");
    if (ts) { this.seek(Number(ts.dataset.t)); return; }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // a drag-select, handled on mouseup
    const pause = target.closest<HTMLElement>(".pause");
    if (pause) {
      const g = Number(pause.dataset.pause);
      if (e.altKey) { this.toggleGaps([g]); return; }
      const p = this.gapAt(g);
      if (p) this.playRange({ s: Math.max(0, p.s - 1.5), e: p.e + 1.5 });
      return;
    }
    const i = this.wordIndexOf(target);
    if (i < 0) return;
    if (e.shiftKey && (this.sel || this.cur >= 0)) {
      const anchor = this.sel ? this.selAnchor : this.cur;
      this.setSel({ a: Math.min(anchor, i), b: Math.max(anchor, i) }, anchor);
      return;
    }
    if (this.sel && (e.altKey || e.metaKey)) return;
    this.clearSel();
    this.seek(this.words[i]!.s);
    if (this.media && this.video.paused && e.detail === 2) void this.video.play(); // double-click plays
  }

  private onTranscriptMouseUp(_e: MouseEvent): void {
    const ds = window.getSelection();
    if (!ds || ds.isCollapsed || !ds.rangeCount) return;
    const r = ds.getRangeAt(0);
    if (!this.trEl.contains(r.commonAncestorContainer)) return;
    const a = this.boundaryWord(r.startContainer, r.startOffset, true);
    const b = this.boundaryWord(r.endContainer, r.endOffset, false);
    ds.removeAllRanges();
    if (a < 0 || b < 0 || a > b) return;
    this.setSel({ a, b }, a);
  }

  /** The first word at/after (forward) or last word at/before a DOM boundary. */
  private boundaryWord(node: Node, offset: number, forward: boolean): number {
    const inWord = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element))?.closest?.(".w") as HTMLElement | null;
    if (inWord) {
      const len = node.textContent?.length ?? 0;
      const i = Number(inWord.dataset.i);
      if (forward && node.nodeType === Node.TEXT_NODE && offset >= len) return i + 1 < this.words.length ? i + 1 : -1;
      if (!forward && node.nodeType === Node.TEXT_NODE && offset === 0) return i - 1;
      return i;
    }
    const walker = document.createTreeWalker(this.trEl, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => ((n as Element).classList.contains("w") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    let start: Node = node;
    if (node.nodeType === Node.ELEMENT_NODE && node.childNodes.length) {
      const child = node.childNodes[forward ? offset : offset - 1];
      if (child) start = child;
      else if (!forward) start = node;
    }
    walker.currentNode = start;
    if (start.nodeType === Node.ELEMENT_NODE && (start as Element).classList.contains("w") && start !== node) {
      return Number((start as HTMLElement).dataset.i);
    }
    const n = (forward ? walker.nextNode() : walker.previousNode()) as HTMLElement | null;
    return n ? Number(n.dataset.i) : -1;
  }

  // ======================================================== selection

  private setSel(r: WordRange | null, anchor = r?.a ?? -1): void {
    this.sel = r;
    this.selAnchor = anchor;
    if (this.mode.kind === "loop") this.setMode({ kind: "free" });
    this.paintSel();
    this.renderSelBar();
    this.timeline.setSel(r ? this.selRange() : null);
  }

  private clearSel(): void {
    if (this.sel) this.setSel(null);
  }

  private selRange(): TimeRange {
    const r = this.sel!;
    return rangeOf(this.words, r.a, r.b, this.settings.pad, this.duration);
  }

  private paintSel(): void {
    for (const el of this.trEl.querySelectorAll(".w.sel")) el.classList.remove("sel");
    if (!this.sel) return;
    for (let i = this.sel.a; i <= this.sel.b; i++) this.wordEls[i]?.classList.add("sel");
  }

  private renderSelBar(): void {
    const bar = this.selBar;
    bar.replaceChildren();
    this.loopBtn = null;
    if (!this.sel) {
      bar.classList.remove("active");
      bar.append(h("p", { class: "hint" },
        "Select words to cut — drag across the text (or the timeline). Click a word to jump, ",
        h("kbd", {}, "Shift"), "+click to extend, double-click to play."));
      return;
    }
    bar.classList.add("active");
    const r = this.selRange();
    const st = this.settings.timeStyle;
    const text = textOf(this.words, this.sel.a, this.sel.b);
    const nPauses = this.pauses.filter((p) => p.after >= this.sel!.a && p.after < this.sel!.b).length;
    const allDel = this.selAllDeleted();
    const selGaps = this.selPauses();
    this.loopBtn = h("button", { title: "Loop selection (L)", onclick: () => this.toggleLoop() }, "⟲ Loop");
    bar.append(
      h("div", { class: "sel-times" },
        h("button", { class: "time-chip mono", title: "Copy start time ( [ )", onclick: () => void copyText(fmtTime(r.s, st), "Start") },
          h("small", {}, "IN"), fmtTime(r.s, st)),
        h("span", { class: "arrow" }, "→"),
        h("button", { class: "time-chip mono", title: "Copy end time ( ] )", onclick: () => void copyText(fmtTime(r.e, st), "End") },
          h("small", {}, "OUT"), fmtTime(r.e, st)),
        h("span", { class: "dur" }, fmtDur(r.e - r.s), " · ", `${this.sel.b - this.sel.a + 1} words`,
          nPauses ? ` · ${nPauses} pause${nPauses > 1 ? "s" : ""}` : "")),
      h("p", { class: "sel-text" }, `“${oneLine(text, 160)}”`),
      h("div", { class: "row" },
        h("button", { class: "primary", title: "Play selection (Enter)", onclick: () => this.playRange(this.selRange()) }, "▶ Play"),
        this.loopBtn,
        h("button", { title: "Copy “start ⇥ end” (C)", onclick: () => this.copySelRange() }, "Copy times"),
        h("button", { title: "Copy the selected text", onclick: () => void copyText(text, "Text") }, "Copy text"),
        h("button", { title: "Link that opens on this selection", onclick: () => void this.copyLink(true) }, "🔗 Link"),
        h("span", { class: "spacer" }),
        h("button", { title: `Add to ${this.reels[this.active]?.name ?? "a new clip"} (A)`, onclick: () => this.addSelAsClip(false) }, "+ Add to clip"),
        nPauses ? h("button", { title: "Add as segments with the pauses cut out (S)", onclick: () => this.addSelAsClip(true) }, "+ Add w/o pauses") : null,
        h("button", { title: "Export just this selection", onclick: () => this.exportRanges("Export selection", [{ ...r, text }]) }, "Export…")),
      h("div", { class: "row edit-row" },
        h("button", {
          class: allDel ? "" : "danger", title: allDel ? "Put these words back (Delete)" : "Cut these words out of the edit (Delete)",
          onclick: () => this.deleteSel(),
        }, allDel ? "↺ Restore words" : "✂ Delete words"),
        selGaps.length ? h("button", {
          title: "Shorten the pauses inside the selection (P)", onclick: () => this.toggleGaps(selGaps),
        }, selGaps.every((g) => this.delGaps.has(g)) ? `↺ Restore ${selGaps.length} pause${selGaps.length > 1 ? "s" : ""}`
                                                     : `✂ Cut ${selGaps.length} pause${selGaps.length > 1 ? "s" : ""}`) : null));
  }

  private toggleLoop(): void {
    if (!this.sel) return;
    if (this.mode.kind === "loop") { this.setMode({ kind: "free" }); this.video.pause(); }
    else this.playRange(this.selRange(), true);
  }

  private copySelRange(): void {
    if (!this.sel) return;
    const r = this.selRange(), st = this.settings.timeStyle;
    void copyText(`${fmtTime(r.s, st)}\t${fmtTime(r.e, st)}`, "Times");
  }

  private extendSel(dir: -1 | 1): void {
    const n = this.words.length;
    if (!this.sel) {
      const i = Math.max(0, this.cur);
      this.setSel({ a: i, b: i }, i);
      return;
    }
    const { a, b } = this.sel;
    const anchor = this.selAnchor;
    // Move the end opposite the anchor.
    if (anchor === a && !(dir < 0 && a === b)) this.setSel({ a, b: Math.max(a, Math.min(n - 1, b + dir)) }, anchor);
    else this.setSel({ a: Math.max(0, Math.min(b, a + dir)), b }, b);
    this.wordEls[dir > 0 ? this.sel!.b : this.sel!.a]?.scrollIntoView({ block: "nearest" });
  }

  // ======================================================== clips

  private get clipsKey(): string {
    const w = this.words;
    const sig = `${w.length}|${w.slice(0, 30).map((x) => x.w).join(" ")}|${w[w.length - 1]?.e ?? 0}`;
    let hsh = 0;
    for (let i = 0; i < sig.length; i++) hsh = (Math.imul(31, hsh) + sig.charCodeAt(i)) | 0;
    return `textcut.clips.${(hsh >>> 0).toString(36)}`;
  }

  private get reelsKey(): string {
    return this.clipsKey.replace(".clips.", ".reels.");
  }

  /** The current clip's segments (empty when there is no clip yet). */
  private get clips(): Clip[] {
    return this.reels[this.active]?.parts ?? [];
  }

  private set clips(parts: Clip[]) {
    this.currentReel().parts = parts;
  }

  /** The current clip, creating the first one when there is none. */
  private currentReel(): Reel {
    if (!this.reels.length) { this.reels.push({ name: "Clip 1", parts: [] }); this.active = 0; }
    this.active = Math.min(this.active, this.reels.length - 1);
    return this.reels[this.active]!;
  }

  private restoreClips(): void {
    const { reels, clips } = this.init.link;
    const withText = (rs: readonly TimeRange[]) => rs.map((c) => ({ s: c.s, e: c.e, text: (c as Clip).text ?? this.textIn(c) }));
    if (reels?.length) {
      this.reels = reels.map((r) => ({ name: r.name, parts: withText(r.ranges) }));
      this.active = 0;
    } else if (clips?.length) {
      this.reels = [{ name: "Clip 1", parts: withText(clips) }];
      this.active = 0;
    } else {
      const saved = loadJson<{ reels: Reel[]; active: number }>(this.reelsKey);
      // Before multiple clips, one list of segments was stored under the clips key.
      const legacy = saved ? null : loadJson<Clip[]>(this.clipsKey);
      this.reels = saved?.reels?.map((r) => ({ name: String(r.name || "Clip"), parts: withText(r.parts ?? []) }))
        ?? (legacy?.length ? [{ name: "Clip 1", parts: withText(legacy) }] : []);
      this.active = Math.max(0, Math.min(saved?.active ?? 0, this.reels.length - 1));
    }
    this.clipsChanged(false);
  }

  private textIn(r: TimeRange): string {
    const wr = wordsIn(this.words, r.s, r.e);
    return wr ? textOf(this.words, wr.a, wr.b) : "";
  }

  private addSelAsClip(splitPauses: boolean): void {
    if (!this.sel) return;
    const { a, b } = this.sel;
    const reel = this.currentReel();
    const parts = splitPauses ? splitAtPauses(this.words, a, b, this.settings.pauseMin) : [{ a, b }];
    for (const p of parts) {
      const r = rangeOf(this.words, p.a, p.b, this.settings.pad, this.duration);
      reel.parts.push({ ...r, text: textOf(this.words, p.a, p.b) });
    }
    this.clipsChanged();
    toast(parts.length > 1 ? `Added ${parts.length} segments to ${reel.name} (pauses removed)` : `Added to ${reel.name}`);
    this.clearSel();
  }

  /** Start a new, empty clip; A / S add to it from now on. */
  private newReel(): void {
    const n = this.reels.reduce((m, r) => Math.max(m, Number(r.name.match(/^Clip (\d+)$/)?.[1] ?? 0)), 0) + 1;
    this.reels.push({ name: `Clip ${Math.max(n, this.reels.length + 1)}`, parts: [] });
    this.active = this.reels.length - 1;
    this.clipsChanged();
    toast(`${this.reels[this.active]!.name} started — select text and press A to add to it`, "info");
  }

  private selectReel(i: number): void {
    if (i === this.active) return;
    this.active = i;
    this.clipsChanged();
  }

  private removeReel(i: number): void {
    const r = this.reels[i]!;
    if (r.parts.length && !confirm(`Remove “${r.name}” and its ${r.parts.length} segment${r.parts.length > 1 ? "s" : ""}?`)) return;
    this.reels.splice(i, 1);
    if (this.active >= i) this.active = Math.max(0, this.active - 1);
    this.clipsChanged();
  }

  private clipsChanged(save = true): void {
    if (save) saveJson(this.reelsKey, { reels: this.reels, active: this.active });
    this.txPacked = null;
    this.paintClips();
    this.timeline.setClips(this.clips);
    this.renderClips();
    this.renderSelBar();
  }

  private paintClips(): void {
    for (const el of this.trEl.querySelectorAll(".w.in-clip")) el.classList.remove("in-clip");
    for (const c of this.clips) {
      const r = wordsIn(this.words, c.s + 1e-3, c.e - 1e-3);
      if (r) for (let i = r.a; i <= r.b; i++) this.wordEls[i]?.classList.add("in-clip");
    }
  }

  private highlightPlayingClip(): void {
    const m = this.mode;
    this.clipsEl.querySelectorAll(".reel.active li").forEach((li, i) =>
      li.classList.toggle("now", m.kind === "queue" && i === m.i));
  }

  private renderClips(): void {
    const el = this.clipsEl;
    el.replaceChildren();
    const dur = (ps: readonly Clip[]) => ps.reduce((n, c) => n + (c.e - c.s), 0);
    el.append(h("header", {},
      h("h3", {}, "Clips"),
      h("span", { class: "muted" }, this.reels.length ? String(this.reels.length) : "none yet"),
      h("span", { class: "spacer" }),
      h("button", { title: "Start a new clip; A / S add the selection to it (N)", onclick: () => this.newReel() }, "+ New clip")));

    if (!this.reels.length) {
      el.append(h("p", { class: "hint" }, "Select text and press ", h("kbd", {}, "A"),
        " to start a clip. A clip is a list of segments, played and exported back to back. ",
        "Make as many clips as you like with “+ New clip”."));
      return;
    }

    this.reels.forEach((reel, ri) => {
      const on = ri === this.active;
      const n = reel.parts.length;
      const head = h("div", { class: "reel-head" },
        on ? h("input", {
          type: "text", class: "reel-name", value: reel.name, "aria-label": "Clip name",
          onchange: (e: Event) => { reel.name = (e.target as HTMLInputElement).value.trim() || reel.name; this.clipsChanged(); },
        }) : h("strong", { class: "reel-name" }, reel.name),
        h("span", { class: "muted" }, n ? `${n} segment${n > 1 ? "s" : ""} · ${fmtDur(dur(reel.parts))}` : "empty"),
        h("span", { class: "spacer" }),
        h("button", {
          class: "icon", title: `Play ${reel.name}`, disabled: !n,
          onclick: (e: Event) => { e.stopPropagation(); this.selectReel(ri); this.playQueue(reel.parts); },
        }, "▶"),
        h("button", {
          class: on ? "primary" : "", title: `Export ${reel.name} — in the browser, as an ffmpeg command or a link`, disabled: !n,
          onclick: (e: Event) => { e.stopPropagation(); this.exportReel(ri); },
        }, "Export…"),
        h("button", {
          class: "icon", title: `Remove ${reel.name}`,
          onclick: (e: Event) => { e.stopPropagation(); this.removeReel(ri); },
        }, "✕"));
      const box = h("section", { class: `reel${on ? " active" : ""}` }, head);
      if (!on) {
        box.title = "Make this the current clip";
        box.onclick = () => this.selectReel(ri);
        if (n) box.append(h("div", { class: "clip-text" }, oneLine(reel.parts.map((c) => c.text ?? "").join(" … "), 90)));
        el.append(box);
        return;
      }
      if (!n) {
        box.append(h("p", { class: "hint" }, "Select text and press ", h("kbd", {}, "A"), " (or “+ Add to clip”) to add segments."));
        el.append(box);
        return;
      }
      const ol = h("ol", {});
      reel.parts.forEach((c, i) => {
        ol.append(h("li", {},
          h("button", { class: "icon", title: "Play segment", onclick: () => this.playRange(c) }, "▶"),
          h("div", {
            class: "clip-body", title: "Select these words",
            onclick: () => { const r = wordsIn(this.words, c.s + 1e-3, c.e - 1e-3); if (r) { this.setSel(r); this.seek(c.s); this.wordEls[r.a]?.scrollIntoView({ block: "center" }); } },
          },
            h("div", { class: "mono" }, `${fmtShort(c.s)} → ${fmtShort(c.e)}`, h("span", { class: "muted" }, ` ${fmtDur(c.e - c.s)}`)),
            h("div", { class: "clip-text" }, oneLine(c.text ?? "", 90))),
          h("div", { class: "clip-actions" },
            h("button", { class: "icon", title: "Move up", disabled: i === 0, onclick: () => this.moveClip(i, -1) }, "↑"),
            h("button", { class: "icon", title: "Move down", disabled: i === n - 1, onclick: () => this.moveClip(i, 1) }, "↓"),
            h("button", { class: "icon", title: "Remove segment", onclick: () => { reel.parts.splice(i, 1); this.clipsChanged(); } }, "✕"))));
      });
      const fmtSel = h("select", {
        "aria-label": "Copy format",
        onchange: () => { this.settings.copyFormat = fmtSel.value as ClipFormat; saveSettings(this.settings); },
      }, ...CLIP_FORMATS.map((f) => h("option", { value: f.id, selected: f.id === this.settings.copyFormat }, f.label)));
      box.append(ol, h("div", { class: "row wrap" },
        fmtSel,
        h("button", {
          title: "Copy this clip's segments in this format (deleted words inside them are left out)",
          onclick: () => void copyText(this.formatClips(this.settings.copyFormat, this.applyEdits(reel.parts)), reel.name),
        }, "Copy"),
        h("span", { class: "spacer" }),
        h("button", { title: "Sort by time and merge overlaps", onclick: () => this.tidyClips() }, "Sort"),
        h("button", { title: "Split every segment at its pauses", onclick: () => this.tightenClips() }, "Cut pauses"),
        h("button", { onclick: () => { if (confirm(`Remove every segment of ${reel.name}?`)) { reel.parts = []; this.clipsChanged(); } } }, "Clear")));
      el.append(box);
    });
    this.highlightPlayingClip();
  }

  private exportReel(i: number): void {
    const reel = this.reels[i]!;
    const slug = reel.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
    this.exportRanges(`Export ${reel.name}`, reel.parts, undefined, true, null,
      `${stemOf(this.media?.name ?? this.title)}_${slug || "clip"}`);
  }

  private moveClip(i: number, d: -1 | 1): void {
    const [c] = this.clips.splice(i, 1);
    this.clips.splice(i + d, 0, c!);
    this.clipsChanged();
  }

  private tidyClips(): void {
    this.clips = mergeRanges(this.clips).map((r) => ({ ...r, text: this.textIn(r) }));
    this.clipsChanged();
  }

  private tightenClips(): void {
    const before = this.clips.length;
    this.clips = this.clips.flatMap((c) => {
      const r = wordsIn(this.words, c.s + 1e-3, c.e - 1e-3);
      if (!r) return [c];
      return splitAtPauses(this.words, r.a, r.b, this.settings.pauseMin).map((p) => ({
        ...rangeOf(this.words, p.a, p.b, this.settings.pad, this.duration), text: textOf(this.words, p.a, p.b),
      }));
    });
    this.clipsChanged();
    toast(this.clips.length === before ? "No pauses inside the segments" : `${before} → ${this.clips.length} segments`);
  }

  private formatClips(kind: ClipFormat, clips: readonly Clip[] = this.clips): string {
    const name = this.media?.name ?? `${this.title}.mp4`;
    return formatClips(clips, kind, {
      style: this.settings.timeStyle,
      input: this.media?.kind === "url" ? this.media.url : name,
      output: `${stemOf(name)}_cut.${this.hasVideo || !this.media ? "mp4" : "m4a"}`,
      hasVideo: this.hasVideo || !this.media,
    });
  }

  // ======================================================== search

  private runSearch(): void {
    const q = this.searchInput.value;
    this.hits = q.trim() ? search(this.index, q) : [];
    this.hitIdx = -1;
    this.paintHits();
    this.timeline.setHits(this.hits.map((x) => this.words[x.a]!.s));
    if (this.hits.length) {
      // Jump to the first hit after the cursor.
      const t = this.video.currentTime || 0;
      const next = this.hits.findIndex((x) => this.words[x.a]!.s >= t - 0.01);
      this.gotoHit(next < 0 ? 0 : next, false);
    }
    this.searchCount.textContent = q.trim() ? (this.hits.length ? `${this.hitIdx + 1}/${this.hits.length}` : "0") : "";
  }

  private paintHits(): void {
    for (const el of this.trEl.querySelectorAll(".w.hit")) el.classList.remove("hit", "hit-cur");
    for (const [n, x] of this.hits.entries()) {
      for (let i = x.a; i <= x.b; i++) {
        const el = this.wordEls[i];
        el?.classList.add("hit");
        el?.classList.toggle("hit-cur", n === this.hitIdx);
      }
    }
  }

  private stepHit(d: 1 | -1): void {
    if (!this.hits.length) return;
    this.gotoHit((this.hitIdx + d + this.hits.length) % this.hits.length, true);
  }

  private gotoHit(n: number, select: boolean): void {
    this.hitIdx = n;
    const x = this.hits[n]!;
    this.paintHits();
    this.searchCount.textContent = `${n + 1}/${this.hits.length}`;
    this.wordEls[x.a]?.scrollIntoView({ block: "center", behavior: "smooth" });
    if (select) this.setSel({ a: x.a, b: x.b });
    this.seek(this.words[x.a]!.s);
  }

  // ======================================================== link-provided state

  private applyLinkState(): void {
    const { sel, at } = this.init.link;
    if (sel) {
      const r = wordsIn(this.words, sel.s + 1e-3, sel.e - 1e-3);
      if (r) {
        this.setSel(r);
        requestAnimationFrame(() => this.wordEls[r.a]?.scrollIntoView({ block: "center" }));
      }
    }
    const t = at ?? sel?.s;
    if (t != null) this.seek(t);
    if (this.init.link.x) void this.openSharedExport(this.init.link.x);
  }

  // ======================================================== sharing

  private async linkParams(withSel: boolean): Promise<{ p: LinkParams; warnings: string[] }> {
    const warnings: string[] = [];
    const p: LinkParams = { title: this.title };
    if (this.media?.kind === "url") p.media = this.media.url;
    else if (this.media) warnings.push(`The media is a local file (${this.media.name}) — whoever opens the link will be asked to pick it.`);
    const o = this.init.loaded.origin;
    if (o.kind === "url") p.words = o.url;
    else p.tx = await (this.txPacked ??= packJson(compactTranscript(this.t)));
    const reels = this.reels.filter((r) => r.parts.length);
    if (reels.length) p.reels = reels.map((r) => ({ name: r.name, ranges: r.parts }));
    Object.assign(p, packEdits(this.edits));
    if (withSel && this.sel) { p.sel = this.selRange(); p.at = p.sel.s; }
    return { p, warnings };
  }

  private pageBase(): string {
    return location.href.replace(/[?#].*$/, "");
  }

  private async copyLink(withSel: boolean): Promise<void> {
    const { p, warnings } = await this.linkParams(withSel);
    await copyText(buildLink(this.pageBase(), p), "Link");
    if (warnings.length) toast(warnings[0]!, "info", 5000);
  }

  private async shareDialog(): Promise<void> {
    const { p, warnings } = await this.linkParams(false);
    const link = buildLink(this.pageBase(), p);
    const ta = h("textarea", { class: "mono", rows: 4, readOnly: true });
    ta.value = link;
    const body = h("div", {},
      h("p", {}, "Opens this transcript", p.media ? " and media" : "", p.reels ? ` with ${p.reels.length} clip${p.reels.length > 1 ? "s" : ""}` : "",
        hasEdits(this.edits) ? `${p.reels ? " and" : " with"} your text edits` : "",
        ". Everything is in the link — nothing is uploaded."),
      ta,
      h("p", { class: "muted" }, `${link.length.toLocaleString()} characters`,
        p.tx ? " (transcript embedded; long links may not survive some chat apps — host the .words.json for shorter links)" : ""),
      ...warnings.map((w) => h("p", { class: "notice" }, w)));
    modal("Share link", body, [
      h("button", { onclick: () => window.open(link, "_blank") }, "Open"),
      h("button", { class: "primary", onclick: () => void copyText(link, "Link") }, "Copy link"),
    ]);
  }

  // ======================================================== text edits

  private get edits(): Edits {
    return { words: this.delWords, gaps: this.delGaps };
  }

  private get cutParams(): CutParams {
    return { pad: this.settings.pad, pauseKeep: this.settings.pauseKeep, duration: this.duration };
  }

  private get editsKey(): string {
    return this.clipsKey.replace(".clips.", ".edits.");
  }

  private restoreEdits(): void {
    const { dw, dg } = this.init.link;
    const packed = dw || dg ? { dw, dg } : loadJson<PackedEdits>(this.editsKey);
    const ed = unpackEdits(packed, this.words.length);
    this.delWords = new Set(ed.words);
    this.delGaps = new Set(ed.gaps);
    this.editsChanged(false);
  }

  /** The silence after word g (-1: before the first word), whatever its length. */
  private gapAt(g: number): Pause | null {
    const w = this.words, n = w.length;
    if (!n || g < -1 || g >= n) return null;
    const s = g < 0 ? 0 : w[g]!.e;
    const e = g < 0 ? w[0]!.s : g === n - 1 ? Math.max(this.duration, w[n - 1]!.e) : w[g + 1]!.s;
    return { after: g, s, e, d: e - s };
  }

  /** Pauses (>= threshold) inside the selection, incl. the head/tail silence at its edges. */
  private selPauses(): number[] {
    if (!this.sel) return [];
    const { a, b } = this.sel, n = this.words.length;
    return this.pauses.filter((p) => (p.after >= a && p.after < b) || (p.after === -1 && a === 0) ||
                                      (p.after === n - 1 && b === n - 1)).map((p) => p.after);
  }

  private selAllDeleted(): boolean {
    if (!this.sel) return false;
    for (let i = this.sel.a; i <= this.sel.b; i++) if (!this.delWords.has(i)) return false;
    return true;
  }

  private snapshot(): void {
    this.undoStack.push(packEdits(this.edits));
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Delete the selected words — or restore them, if they're all deleted already. */
  private deleteSel(): void {
    if (!this.sel) return;
    const { a, b } = this.sel;
    const restore = this.selAllDeleted();
    this.snapshot();
    for (let i = a; i <= b; i++) {
      if (restore) this.delWords.delete(i); else this.delWords.add(i);
    }
    // Deleting words also clears pause marks inside them (the word cut covers them).
    if (restore) for (let g = a - 1; g <= b; g++) this.delGaps.delete(g);
    this.editsChanged();
    toast(restore ? `Restored ${b - a + 1} word${b > a ? "s" : ""}` : `Cut ${b - a + 1} word${b > a ? "s" : ""}`, "info");
    if (!restore) {
      // Move on, like deleting text: the cursor lands after the cut.
      this.clearSel();
      if (b + 1 < this.words.length) this.seek(this.words[b + 1]!.s);
    } else this.renderSelBar();
  }

  /** Cut the given gaps — or restore them, if they're all cut already. */
  private toggleGaps(gaps: readonly number[]): void {
    if (!gaps.length) return;
    const restore = gaps.every((g) => this.delGaps.has(g));
    this.snapshot();
    for (const g of gaps) { if (restore) this.delGaps.delete(g); else this.delGaps.add(g); }
    this.editsChanged();
    toast(`${restore ? "Restored" : "Shortened"} ${gaps.length} pause${gaps.length > 1 ? "s" : ""}` +
          (restore ? "" : ` to ${this.settings.pauseKeep}s`), "info");
  }

  private undo(redo = false): void {
    const from = redo ? this.redoStack : this.undoStack;
    const to = redo ? this.undoStack : this.redoStack;
    const st = from.pop();
    if (!st) { toast(redo ? "Nothing to redo" : "Nothing to undo", "info"); return; }
    to.push(packEdits(this.edits));
    const ed = unpackEdits(st, this.words.length);
    this.delWords = new Set(ed.words);
    this.delGaps = new Set(ed.gaps);
    this.editsChanged();
    toast(redo ? "Redone" : "Undone", "info");
  }

  private resetEdits(): void {
    if (!hasEdits(this.edits)) return;
    this.snapshot();
    this.delWords.clear();
    this.delGaps.clear();
    this.editsChanged();
  }

  private editsChanged(save = true): void {
    if (save) saveJson(this.editsKey, packEdits(this.edits));
    this.txPacked = null;
    this.removed = removedRanges(this.words, this.edits, this.cutParams);
    this.timeline.setRemoved(this.removed);
    if (this.trEl.childElementCount) this.paintEdits();
    this.renderEdits();
    this.renderSelBar();
  }

  /** Update word/pause marks in place (full re-render only when a hidden gap must appear). */
  private paintEdits(): void {
    for (const [i, el] of this.wordEls.entries()) el.classList.toggle("del", this.delWords.has(i));
    const shown = new Set<number>();
    for (const el of this.trEl.querySelectorAll<HTMLElement>(".pause")) {
      const g = Number(el.dataset.pause);
      shown.add(g);
      el.classList.toggle("del", this.delGaps.has(g));
    }
    const pauseSet = new Set(this.pauses.map((p) => p.after));
    const stale = [...this.delGaps].some((g) => !shown.has(g)) || [...shown].some((g) => !pauseSet.has(g) && !this.delGaps.has(g));
    if (stale) {
      const top = this.trEl.scrollTop;
      this.renderTranscript();
      this.trEl.scrollTop = top;
    }
  }

  private renderEdits(): void {
    const el = this.editsEl;
    el.replaceChildren();
    const ed = this.edits;
    if (!hasEdits(ed)) {
      el.classList.remove("active");
      el.append(h("p", { class: "hint" }, "Edit by text: select words and press ", h("kbd", {}, "Delete"),
        " to cut them, ", h("kbd", {}, "P"), " to shorten the pauses in the selection. ",
        this.pauses.length ? h("button", { class: "linkish", onclick: () => this.toggleGaps(this.pauses.map((p) => p.after)) },
          `Shorten all ${this.pauses.length} pauses`) : null,
        this.pauses.length ? " · " : null,
        h("button", { class: "linkish", title: "Export the whole recording (crop, resize, audio filters…)", onclick: () => this.exportEdit() },
          "Export the whole recording…")));
      return;
    }
    el.classList.add("active");
    const cut = this.removed.reduce((n, r) => n + (r.e - r.s), 0);
    const total = Math.max(this.duration, this.words.at(-1)?.e ?? 0);
    const undeleted = this.pauses.filter((p) => !this.delGaps.has(p.after)).map((p) => p.after);
    el.append(
      h("header", {},
        h("h3", {}, "Edit"),
        h("span", { class: "muted" },
          [ed.words.size && `${ed.words.size} word${ed.words.size > 1 ? "s" : ""}`,
           ed.gaps.size && `${ed.gaps.size} pause${ed.gaps.size > 1 ? "s" : ""}`].filter(Boolean).join(", ") +
          ` cut · ${fmtDur(total)} → ${fmtDur(total - cut)}`),
        h("span", { class: "spacer" }),
        h("button", { class: "icon", title: "Undo (⌘Z / Ctrl+Z)", disabled: !this.undoStack.length, onclick: () => this.undo() }, "↶"),
        h("button", { class: "icon", title: "Redo (⇧⌘Z / Ctrl+Y)", disabled: !this.redoStack.length, onclick: () => this.undo(true) }, "↷")),
      h("div", { class: "row wrap" },
        h("button", { title: "Play the edited cut from the start", onclick: () => this.playEdit() }, "▶ Play edit"),
        undeleted.length ? h("button", { title: "Shorten every remaining pause", onclick: () => this.toggleGaps(undeleted) },
          `Shorten ${undeleted.length} more pause${undeleted.length > 1 ? "s" : ""}`) : null,
        h("button", { onclick: () => { if (confirm("Restore every deleted word and pause?")) this.resetEdits(); } }, "Reset"),
        h("span", { class: "spacer" }),
        h("button", { class: "primary", title: "Render the edited cut, or get its ffmpeg command", onclick: () => this.exportEdit() }, "Export edit…")));
  }

  private playEdit(): void {
    const keep = subtractRanges([{ s: 0, e: this.duration }], this.removed);
    if (!keep.length) return;
    if (!this.settings.previewEdits) {
      this.settings.previewEdits = true;
      saveSettings(this.settings);
      const chk = this.root.querySelector<HTMLInputElement>('.transport input[data-key="previewEdits"]');
      if (chk) chk.checked = true;
    }
    this.seek(keep[0]!.s);
    void this.video.play();
  }

  /** `ranges` minus what the text edits removed, with their text recomputed. */
  private applyEdits(ranges: readonly Clip[]): Clip[] {
    if (!this.removed.length) return ranges.map((c) => ({ ...c }));
    return subtractRanges(ranges, this.removed).map((r) => ({ ...r, text: this.textIn(r) }));
  }

  // ======================================================== export

  private exportEdit(): void {
    const keep = subtractRanges([{ s: 0, e: Math.max(this.duration, this.words.at(-1)?.e ?? 0) }], this.removed);
    const cut = this.removed.reduce((n, r) => n + (r.e - r.s), 0);
    this.exportRanges("Export edit", keep.map((r) => ({ ...r, text: this.textIn(r) })),
      hasEdits(this.edits) ? `${fmtDur(cut)} cut out in ${this.removed.length} place${this.removed.length > 1 ? "s" : ""}.` : undefined,
      false);
  }

  /** Export ranges (clips / a selection): the text edits inside them are applied. */
  private exportRanges(heading: string, ranges: readonly Clip[], summary?: string, applyEdits = true,
                       preset: ExportPreset | null = null, fileName?: string): void {
    const list = applyEdits ? this.applyEdits(ranges) : [...ranges];
    if (!list.length) { toast("Nothing left to export — it's all been cut", "err"); return; }
    const dur = (rs: readonly TimeRange[]) => rs.reduce((n, r) => n + (r.e - r.s), 0);
    if (applyEdits && dur(list) < dur(ranges) - 0.001) {
      summary ??= "Deleted words and pauses inside them are left out.";
    }
    const v = this.video;
    openExportDialog({
      heading, summary, ranges: list,
      media: this.media, hasVideo: this.hasVideo,
      frame: this.hasVideo && v.videoWidth ? { width: v.videoWidth, height: v.videoHeight } : null,
      video: v,
      stem: stemOf(this.media?.name ?? this.title),
      fileName,
      settings: this.settings,
      preset,
      shareLink: async (x) => {
        const { p, warnings } = await this.linkParams(false);
        p.x = await packPreset(x);
        p.at = x.r[0]?.[0];
        return { link: buildLink(this.pageBase(), p), warnings };
      },
    });
  }

  /** A link with `x=`: open the export it describes, once the media's size is known. */
  private async openSharedExport(x: string): Promise<void> {
    const preset = await unpackPreset(x);
    if (!preset) { toast("The export in this link couldn't be read", "err"); return; }
    if (this.media) await this.metadataReady(10_000);
    const ranges = preset.r.map(([s, e]) => ({ s, e, text: this.textIn({ s, e }) }));
    this.exportRanges(preset.h ?? "Shared export", ranges, "Shared with a link.", false, preset);
  }

  private metadataReady(ms: number): Promise<void> {
    const v = this.video;
    return new Promise((resolve) => {
      if (v.readyState >= 1 || v.error) return resolve();
      const done = () => {
        clearTimeout(timer);
        v.removeEventListener("loadedmetadata", done);
        v.removeEventListener("error", done);
        setTimeout(resolve, 0); // after setMedia's own handler has read the size
      };
      const timer = setTimeout(done, ms);
      v.addEventListener("loadedmetadata", done);
      v.addEventListener("error", done);
    });
  }

  // ======================================================== dialogs

  private settingsDialog(): void {
    const s = this.settings;
    const num = (label: string, key: "pauseMin" | "pad" | "pauseKeep", min: number, max: number, step: number, help: string) => {
      const input = h("input", { type: "number", min, max, step, value: String(s[key]) });
      input.onchange = () => {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return;
        s[key] = Math.max(min, Math.min(max, v));
        saveSettings(s);
        if (key === "pauseMin") this.recomputePauses();
        else this.editsChanged(false);
        this.renderSelBar();
        this.timeline.setSel(this.sel ? this.selRange() : null);
      };
      return h("label", { class: "field" }, label, input, h("small", {}, help));
    };
    const style = h("select", {
      onchange: () => { s.timeStyle = style.value as Settings["timeStyle"]; saveSettings(s); this.renderSelBar(); },
    }, h("option", { value: "clock", selected: s.timeStyle === "clock" }, "00:01:23.450"),
       h("option", { value: "seconds", selected: s.timeStyle === "seconds" }, "83.450 (seconds)"));
    modal("Settings", h("div", { class: "form" },
      num("Pause threshold (s)", "pauseMin", 0.1, 10, 0.1, "Gaps between words at least this long are marked as pauses, cut by “w/o pauses”, and skipped by “Skip pauses”."),
      num("Padding (s)", "pad", 0, 1, 0.01, "Added before/after every selection and clip so cuts don't clip syllables. Never extends past the middle of the gap to the next word."),
      num("Shortened pause (s)", "pauseKeep", 0, 3, 0.05, "A cut pause keeps this much silence (at least twice the padding), so speech doesn't run together."),
      h("label", { class: "field" }, "Copied time format", style)));
  }

  private helpDialog(): void {
    const rows: Array<[string, string]> = [
      ["Space", "Play / pause"], ["Click word", "Jump there"], ["Double-click", "Jump & play"],
      ["Drag / Shift+click", "Select words"], ["Shift + ← →", "Grow / shrink selection by a word"],
      ["← →", "Previous / next word"], ["Alt + ← →", "Back / forward 5 s"],
      ["Enter", "Play selection"], ["L", "Loop selection"], ["A", "Add selection to the current clip"], ["N", "Start a new clip"],
      ["S", "Add selection to the clip, without its pauses"], ["C", "Copy selection times"],
      ["[  ]", "Copy start / end time"], ["/", "Search"], ["Enter / Shift+Enter (in search)", "Next / previous match"],
      ["Delete / Backspace", "Cut the selected words (again: restore)"],
      ["P", "Shorten the pauses in the selection"], ["Alt+click pause", "Cut / restore that pause"],
      ["⌘Z / Ctrl+Z", "Undo an edit"], ["⇧⌘Z / Ctrl+Y", "Redo"],
      ["Esc", "Clear selection / stop looping"],
    ];
    modal("Keyboard shortcuts", h("table", { class: "keys" },
      ...rows.map(([k, d]) => h("tr", {}, h("td", {}, h("kbd", {}, k)), h("td", {}, d)))));
  }

  // ======================================================== keys

  private bindKeys(): void {
    this.keyHandler = (e: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if ((e.key === "f" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !isTyping(e))) {
        e.preventDefault();
        this.searchInput.focus();
        this.searchInput.select();
        return;
      }
      if (!isTyping(e) && (e.metaKey || e.ctrlKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === "z" || k === "y") {
          e.preventDefault();
          this.undo(k === "y" || e.shiftKey);
          return;
        }
      }
      if (isTyping(e) || e.metaKey || e.ctrlKey) return;
      const st = this.settings.timeStyle;
      switch (e.key) {
        case " ": e.preventDefault(); this.togglePlay(); break;
        case "Enter": if (this.sel) { e.preventDefault(); this.playRange(this.selRange()); } break;
        case "Escape": this.setMode({ kind: "free" }); this.clearSel(); break;
        case "ArrowLeft": case "ArrowRight": {
          e.preventDefault();
          const d = e.key === "ArrowLeft" ? -1 : 1;
          if (e.shiftKey) this.extendSel(d);
          else if (e.altKey) this.seek((this.video.currentTime || 0) + d * 5);
          else {
            const i = Math.max(0, Math.min(this.words.length - 1, this.cur + d));
            this.seek(this.words[i]!.s);
            this.wordEls[i]?.scrollIntoView({ block: "nearest" });
          }
          break;
        }
        case "l": case "L": this.toggleLoop(); break;
        case "a": case "A": this.addSelAsClip(false); break;
        case "n": case "N": this.newReel(); break;
        case "s": case "S": this.addSelAsClip(true); break;
        case "c": case "C": this.copySelRange(); break;
        case "Delete": case "Backspace": if (this.sel) { e.preventDefault(); this.deleteSel(); } break;
        case "p": case "P": if (this.sel) this.toggleGaps(this.selPauses()); break;
        case "[": if (this.sel) void copyText(fmtTime(this.selRange().s, st), "Start"); break;
        case "]": if (this.sel) void copyText(fmtTime(this.selRange().e, st), "End"); break;
        case "?": this.helpDialog(); break;
      }
    };
    document.addEventListener("keydown", this.keyHandler);
  }

  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  destroy(): void {
    if (this.keyHandler) document.removeEventListener("keydown", this.keyHandler);
    cancelAnimationFrame(this.raf);
    this.video.pause();
    this.video.removeAttribute("src");
    if (this.mediaUrl?.startsWith("blob:")) URL.revokeObjectURL(this.mediaUrl);
    this.timeline.destroy();
    this.root.remove();
  }

  /** Called after the root is in the document (sizes are known). */
  mounted(): void {
    this.timeline.resize();
  }
}
