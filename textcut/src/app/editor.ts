import { gluesToPrev, textOf, wordAt, compactTranscript, type Transcript, type Word } from "../core/transcript";
import { findPauses, mergeRanges, rangeOf, splitAtPauses, wordsIn, type Pause, type TimeRange, type WordRange } from "../core/ranges";
import { buildSearchIndex, search, type SearchIndex } from "../core/search";
import { fmtDur, fmtShort, fmtTime } from "../core/time";
import { CLIP_FORMATS, formatClips, oneLine, type Clip, type ClipFormat } from "../core/formats";
import { buildLink, packJson, type LinkParams } from "../core/link";
import { copyText, download, h, isTyping, modal, toast } from "./dom";
import { loadJson, loadSettings, saveJson, saveSettings, type Settings } from "./settings";
import { mediaFromFile, mediaFromUrl, stemOf, type LoadedTranscript, type MediaSource } from "./sources";
import { exportWav, exportWithFFmpeg, type FfmpegMode } from "./export";
import { Timeline } from "./timeline";

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
  private clips: Clip[] = [];
  private hits: WordRange[] = [];
  private hitIdx = -1;
  private cur = -1;
  private mode: PlayMode = { kind: "free" };
  private raf = 0;
  private txPacked: Promise<string> | null = null;

  // DOM
  readonly root: HTMLElement;
  private video!: HTMLVideoElement;
  private playerBox!: HTMLElement;
  private trEl!: HTMLElement;
  private wordEls: HTMLElement[] = [];
  private timeEl!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private selBar!: HTMLElement;
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
      this.toggle("Skip pauses", "Jump over pauses while playing (preview of a tightened cut)", "skipPauses"));

    this.timeline = new Timeline({
      seek: (t) => this.seek(t),
      selectTime: (a, b) => {
        const r = wordsIn(this.words, a, b);
        if (r) this.setSel(r);
      },
    });

    this.selBar = h("div", { class: "selbar" });
    this.clipsEl = h("section", { class: "clips" });
    this.trEl = h("article", { class: "transcript", tabindex: "0", "aria-label": "Transcript" });

    const approx = this.words.some((w) => w.approx)
      ? h("div", { class: "notice" }, "Word timings were interpolated from a segment-level transcript — " +
          "they're approximate. Re-run the transcribe step with word_timestamps: true for exact cuts.")
      : null;

    const left = h("section", { class: "left" }, this.playerBox, transport, this.timeline.el, this.selBar, this.clipsEl);
    const right = h("section", { class: "right" }, approx, this.trEl);
    const root = h("div", { class: "app editor-view" }, top, h("main", { class: "editor" }, left, right));

    this.trEl.addEventListener("mouseup", (e) => this.onTranscriptMouseUp(e));
    for (const ev of ["wheel", "touchmove"]) this.trEl.addEventListener(ev, this.markUserScroll, { passive: true });
    this.trEl.addEventListener("click", (e) => this.onTranscriptClick(e));
    this.renderSelBar();
    return root;
  }

  private toggle(label: string, title: string, key: "follow" | "skipPauses"): HTMLElement {
    const input = h("input", {
      type: "checkbox", checked: this.settings[key],
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
    if (!this.media) {
      // No media: still move the "cursor" so the transcript follows.
      this.updateCurrent(wordAt(this.words, t + 1e-4), true);
      this.timeline.setTime(t);
      this.timeEl.textContent = fmtShort(t);
      return;
    }
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
          if (m.i < m.list.length) v.currentTime = m.list[m.i]!.s;
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
    if (this.trEl.childElementCount) this.renderTranscript();
    this.timeline.setData(this.words, this.pauses, this.duration);
    this.timeline.setClips(this.clips);
    this.timeline.setHits(this.hits.map((x) => this.words[x.a]!.s));
  }

  private renderTranscript(): void {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    const pauseAfter = new Map(this.pauses.map((p) => [p.after, p]));
    const html: string[] = [];
    const pauseHtml = (p: Pause) =>
      `<span class="pause${p.d >= 2 ? " long" : ""}" data-pause="${p.after}" contenteditable="false" ` +
      `title="${p.d.toFixed(2)}s pause · click to play around it">${p.d.toFixed(1)}s</span>`;
    const lead = pauseAfter.get(-1);
    for (const [si, sg] of this.t.segments.entries()) {
      html.push(`<p class="seg" data-seg="${si}"><button class="ts mono" data-t="${sg.s}" tabindex="-1" ` +
                `title="Jump to ${fmtTime(sg.s)}">${fmtShort(sg.s)}</button><span class="txt">`);
      if (si === 0 && lead) html.push(pauseHtml(lead), " ");
      for (let i = sg.first; i <= sg.last; i++) {
        const w = this.words[i]!;
        const low = w.p != null && w.p < 0.5 ? " low" : "";
        html.push(`<span class="w${low}" data-i="${i}">${esc(w.w)}</span>`);
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
      const p = this.pauses.find((x) => x.after === Number(pause.dataset.pause));
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
        h("button", { title: "Add as one clip (A)", onclick: () => this.addSelAsClip(false) }, "+ Clip"),
        nPauses ? h("button", { title: "Add as clips with the pauses cut out (S)", onclick: () => this.addSelAsClip(true) }, "+ Clips w/o pauses") : null,
        h("button", { title: "Export just this selection", onclick: () => this.exportDialog([{ ...r, text }]) }, "Export…")));
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

  private restoreClips(): void {
    const fromLink = this.init.link.clips;
    const saved: Clip[] = fromLink?.length ? fromLink : loadJson<Clip[]>(this.clipsKey) ?? [];
    this.clips = saved.map((c) => ({ s: c.s, e: c.e, text: c.text ?? this.textIn(c) }));
    this.clipsChanged(false);
  }

  private textIn(r: TimeRange): string {
    const wr = wordsIn(this.words, r.s, r.e);
    return wr ? textOf(this.words, wr.a, wr.b) : "";
  }

  private addSelAsClip(splitPauses: boolean): void {
    if (!this.sel) return;
    const { a, b } = this.sel;
    const parts = splitPauses ? splitAtPauses(this.words, a, b, this.settings.pauseMin) : [{ a, b }];
    for (const p of parts) {
      const r = rangeOf(this.words, p.a, p.b, this.settings.pad, this.duration);
      this.clips.push({ ...r, text: textOf(this.words, p.a, p.b) });
    }
    this.clipsChanged();
    toast(parts.length > 1 ? `Added ${parts.length} clips (pauses removed)` : "Clip added");
    this.clearSel();
  }

  private clipsChanged(save = true): void {
    if (save) saveJson(this.clipsKey, this.clips);
    this.paintClips();
    this.timeline.setClips(this.clips);
    this.renderClips();
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
    this.clipsEl.querySelectorAll("li").forEach((li, i) =>
      li.classList.toggle("now", m.kind === "queue" && i === m.i));
  }

  private renderClips(): void {
    const el = this.clipsEl;
    el.replaceChildren();
    const total = this.clips.reduce((n, c) => n + (c.e - c.s), 0);
    const fmtSel = h("select", {
      "aria-label": "Copy format",
      onchange: () => { this.settings.copyFormat = fmtSel.value as ClipFormat; saveSettings(this.settings); },
    }, ...CLIP_FORMATS.map((f) => h("option", { value: f.id, selected: f.id === this.settings.copyFormat }, f.label)));

    el.append(h("header", {},
      h("h3", {}, "Clips"),
      h("span", { class: "muted" }, this.clips.length ? `${this.clips.length} · ${fmtDur(total)}` : "none yet"),
      h("span", { class: "spacer" }),
      this.clips.length ? h("button", { title: "Play all clips back to back", onclick: () => this.playQueue(this.clips) }, "▶ Play all") : null));

    if (!this.clips.length) {
      el.append(h("p", { class: "hint" }, "Select text and press ", h("kbd", {}, "A"),
        " (or “+ Clip”) to collect ranges. Clips play back to back and export as one cut."));
      return;
    }
    const ol = h("ol", {});
    this.clips.forEach((c, i) => {
      const li = h("li", {},
        h("button", { class: "icon", title: "Play clip", onclick: () => this.playRange(c) }, "▶"),
        h("div", {
          class: "clip-body", title: "Select these words",
          onclick: () => { const r = wordsIn(this.words, c.s + 1e-3, c.e - 1e-3); if (r) { this.setSel(r); this.seek(c.s); this.wordEls[r.a]?.scrollIntoView({ block: "center" }); } },
        },
          h("div", { class: "mono" }, `${fmtShort(c.s)} → ${fmtShort(c.e)}`, h("span", { class: "muted" }, ` ${fmtDur(c.e - c.s)}`)),
          h("div", { class: "clip-text" }, oneLine(c.text ?? "", 90))),
        h("div", { class: "clip-actions" },
          h("button", { class: "icon", title: "Move up", disabled: i === 0, onclick: () => this.moveClip(i, -1) }, "↑"),
          h("button", { class: "icon", title: "Move down", disabled: i === this.clips.length - 1, onclick: () => this.moveClip(i, 1) }, "↓"),
          h("button", { class: "icon", title: "Remove", onclick: () => { this.clips.splice(i, 1); this.clipsChanged(); } }, "✕")));
      ol.append(li);
    });
    el.append(ol);
    el.append(h("div", { class: "row wrap" },
      fmtSel,
      h("button", { onclick: () => void copyText(this.formatClips(this.settings.copyFormat), "Clips") }, "Copy"),
      h("span", { class: "spacer" }),
      h("button", { title: "Sort by time and merge overlaps", onclick: () => this.tidyClips() }, "Sort"),
      h("button", { title: "Split every clip at its pauses", onclick: () => this.tightenClips() }, "Cut pauses"),
      h("button", { onclick: () => { if (confirm("Remove all clips?")) { this.clips = []; this.clipsChanged(); } } }, "Clear"),
      h("button", { class: "primary", onclick: () => this.exportDialog(this.clips) }, "Export…")));
    this.highlightPlayingClip();
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
    toast(this.clips.length === before ? "No pauses inside the clips" : `${before} → ${this.clips.length} clips`);
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
    if (this.clips.length) p.clips = this.clips;
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
      h("p", {}, "Opens this transcript", p.media ? " and media" : "", this.clips.length ? ` with ${this.clips.length} clips` : "",
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

  // ======================================================== export

  private exportDialog(clips: readonly Clip[]): void {
    if (!clips.length) return;
    const total = clips.reduce((n, c) => n + (c.e - c.s), 0);
    const hasMedia = !!this.media;
    const v = this.hasVideo;
    const srcExt = this.media?.name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? "";
    type Opt = { id: "wav" | FfmpegMode; label: string; note: string; ok: boolean };
    const opts: Opt[] = [
      { id: "wav", label: "WAV audio", note: srcExt === "wav" ? "instant, lossless — cut straight from the file" : "decoded in the browser", ok: hasMedia },
      { id: "video-copy", label: v ? `Video, fast (${srcExt === "mov" ? "MOV" : "MP4"}, no re-encode)` : `Original format (${srcExt.toUpperCase() || "copy"}, no re-encode)`,
        note: v ? "quick; cut points snap to the nearest keyframe (can be ~1–2 s early)" : "quick, lossless", ok: hasMedia },
      { id: "video-encode", label: "Video, exact (MP4 re-encode)", note: "frame-accurate; slow in the browser (≈ real time or slower)", ok: hasMedia && v },
      { id: "mp3", label: "MP3 audio", note: "re-encoded", ok: hasMedia },
      { id: "m4a", label: "M4A (AAC) audio", note: "re-encoded", ok: hasMedia },
    ];
    let choice: Opt["id"] = v ? "video-copy" : "wav";
    const list = h("div", { class: "choices" }, ...opts.filter((o) => o.ok).map((o) => {
      const input = h("input", { type: "radio", name: "fmt", value: o.id, checked: o.id === choice, onchange: () => { choice = o.id; } });
      return h("label", { class: "choice" }, input, h("span", {}, h("strong", {}, o.label), h("small", {}, o.note)));
    }));
    const stem = stemOf(this.media?.name ?? this.title);
    const name = h("input", { type: "text", value: `${stem}_cut`, "aria-label": "File name" });
    const bar = h("progress", { max: 1, value: 0, hidden: true });
    const status = h("p", { class: "muted" });
    const logEl = h("pre", { class: "log" });
    const cmd = h("details", {},
      h("summary", {}, "Or run it yourself (ffmpeg / radiant)"),
      ...(["ffmpeg", "trim-yaml", "clip-yaml"] as ClipFormat[]).map((k) =>
        h("div", { class: "snippet" },
          h("div", { class: "row" }, h("strong", {}, CLIP_FORMATS.find((f) => f.id === k)!.label), h("span", { class: "spacer" }),
            h("button", { onclick: () => void copyText(this.formatClips(k, clips), "Copied") }, "Copy")),
          h("pre", { class: "mono" }, this.formatClips(k, clips)))));
    const body = h("div", {},
      h("p", {}, `${clips.length} range${clips.length > 1 ? "s" : ""}, ${fmtDur(total)} total.`),
      hasMedia ? list : h("p", { class: "notice" }, "Load the media to export in the browser — or copy a command below."),
      hasMedia ? h("label", { class: "field" }, "File name", name) : null,
      bar, status, h("details", { class: "logbox" }, h("summary", {}, "ffmpeg log"), logEl), cmd);
    const go = h("button", { class: "primary", disabled: !hasMedia }, "Export");
    const dlg = modal("Export cut", body, [go]);
    go.onclick = async () => {
      if (!this.media) return;
      go.disabled = true;
      bar.hidden = false;
      const progress = (msg: string, frac?: number) => {
        status.textContent = msg;
        if (frac == null) bar.removeAttribute("value"); else bar.value = frac;
      };
      try {
        const ranges = clips.map((c) => ({ s: c.s, e: c.e }));
        let blob: Blob, ext: string;
        if (choice === "wav") { blob = await exportWav(this.media, ranges, progress); ext = "wav"; }
        else {
          ({ blob, ext } = await exportWithFFmpeg(this.media, ranges, { mode: choice, hasVideo: this.hasVideo }, progress,
            (line) => { logEl.textContent += line + "\n"; }));
        }
        download(blob, `${name.value || stem + "_cut"}.${ext}`);
        status.textContent = `Saved ${name.value}.${ext} (${(blob.size / 1e6).toFixed(1)} MB)`;
        if (!dlg.el.open) toast("Export finished");
      } catch (e) {
        status.textContent = (e as Error).message;
        status.className = "error";
      } finally {
        go.disabled = false;
      }
    };
  }

  // ======================================================== dialogs

  private settingsDialog(): void {
    const s = this.settings;
    const num = (label: string, key: "pauseMin" | "pad", min: number, max: number, step: number, help: string) => {
      const input = h("input", { type: "number", min, max, step, value: String(s[key]) });
      input.onchange = () => {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return;
        s[key] = Math.max(min, Math.min(max, v));
        saveSettings(s);
        if (key === "pauseMin") this.recomputePauses();
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
      h("label", { class: "field" }, "Copied time format", style)));
  }

  private helpDialog(): void {
    const rows: Array<[string, string]> = [
      ["Space", "Play / pause"], ["Click word", "Jump there"], ["Double-click", "Jump & play"],
      ["Drag / Shift+click", "Select words"], ["Shift + ← →", "Grow / shrink selection by a word"],
      ["← →", "Previous / next word"], ["Alt + ← →", "Back / forward 5 s"],
      ["Enter", "Play selection"], ["L", "Loop selection"], ["A", "Add selection as clip"],
      ["S", "Add selection as clips without pauses"], ["C", "Copy selection times"],
      ["[  ]", "Copy start / end time"], ["/", "Search"], ["Enter / Shift+Enter (in search)", "Next / previous match"],
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
        case "s": case "S": this.addSelAsClip(true); break;
        case "c": case "C": this.copySelRange(); break;
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
