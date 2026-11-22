import { buildLink, normalizeUrl, packJson, type LinkParams } from "../core/link";
import { compactTranscript } from "../core/transcript";
import { fmtShort } from "../core/time";
import { APP_NAME } from "../core/app";
import { copyText, fmtBytes, h } from "./dom";
import {
  isMediaFile, isTranscriptFile, loadTranscriptFile, loadTranscriptUrl, mediaFromFile, probeUrl,
  type LoadedTranscript, type MediaSource,
} from "./sources";

export interface OpenResult {
  loaded: LoadedTranscript;
  /** media played in the editor (may be a light preview) */
  media: MediaSource | null;
  /** full-quality original for exports; null: exports use `media` */
  full?: MediaSource | null;
  link: LinkParams;
}

/**
 * Landing page: open local files, or build a shareable link from public URLs
 * (optionally embedding the transcript in the link itself).
 */
export function openView(onOpen: (r: OpenResult) => void, error?: string, prefill: LinkParams = {}): HTMLElement {
  // ---------------------------------------------------------- local files
  let localTranscript: File | null = null;
  let localMedia: File | null = null;
  const picked = h("ul", { class: "picked" });
  const openLocalBtn = h("button", { class: "primary", disabled: true }, "Open");
  const localErr = h("p", { class: "error", hidden: true });

  const refreshPicked = () => {
    picked.replaceChildren(
      h("li", { class: localTranscript ? "ok" : "" }, "Transcript: ",
        localTranscript ? h("strong", {}, localTranscript.name) : h("span", { class: "muted" }, "— (.words.json or .txt)")),
      h("li", { class: localMedia ? "ok" : "" }, "Media: ",
        localMedia ? h("strong", {}, `${localMedia.name} (${fmtBytes(localMedia.size)})`) : h("span", { class: "muted" }, "— optional (audio or video)")));
    openLocalBtn.disabled = !localTranscript;
  };
  const takeFiles = (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (isMediaFile(f)) localMedia = f;
      else if (isTranscriptFile(f)) localTranscript = f;
    }
    refreshPicked();
    // Both picked: no reason to make them click again.
    if (localTranscript && localMedia) void openLocal();
  };
  const openLocal = async () => {
    if (!localTranscript) return;
    localErr.hidden = true;
    try {
      const loaded = await loadTranscriptFile(localTranscript);
      onOpen({ loaded, media: localMedia ? mediaFromFile(localMedia) : null, link: {} });
    } catch (e) {
      localErr.textContent = (e as Error).message;
      localErr.hidden = false;
    }
  };
  openLocalBtn.onclick = () => void openLocal();
  const fileInput = h("input", {
    type: "file", multiple: true, hidden: true,
    accept: ".json,.txt,audio/*,video/*,.mkv,.mov,.flac,.opus",
    onchange: () => fileInput.files && takeFiles(fileInput.files),
  });
  const drop = h("div", { class: "dropzone", tabindex: "0", role: "button", onclick: () => fileInput.click(),
    onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === "Enter") fileInput.click(); } },
    h("strong", {}, "Drop the transcript and the media here"),
    h("span", { class: "muted" }, "or click to choose — e.g. talk.words.json + talk.mp4 (both at once)"), fileInput);
  for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
  for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer?.files) takeFiles(e.dataTransfer.files); });
  refreshPicked();

  // ---------------------------------------------------------- link builder
  const wordsUrl = h("input", { type: "url", placeholder: "https://…/talk.words.json", value: prefill.words ?? "" });
  const mediaUrl = h("input", { type: "url", placeholder: "https://…/talk.mp4  (or .mp3, .wav, .m4a…)", value: prefill.media ?? "" });
  const fullUrl = h("input", { type: "url", placeholder: "optional — https://…/talk_master.mov", value: prefill.full ?? "" });
  const title = h("input", { type: "text", placeholder: "optional", value: prefill.title ?? "" });
  const embed = h("input", { type: "checkbox" });
  const embedFile = h("input", { type: "file", accept: ".json,.txt", hidden: true });
  let embedLocal: File | null = null;
  const embedName = h("span", { class: "muted" });
  const wordsHint = h("small", { class: "hint-line" });
  const mediaHint = h("small", { class: "hint-line" });
  const fullHint = h("small", { class: "hint-line" });
  const out = h("textarea", { class: "mono", rows: 3, readOnly: true, placeholder: "Your link appears here" });
  const outInfo = h("p", { class: "muted" });
  const buildErr = h("p", { class: "error", hidden: true });
  let lastLink = "";

  embedFile.onchange = () => {
    embedLocal = embedFile.files?.[0] ?? null;
    embedName.textContent = embedLocal ? embedLocal.name : "";
    if (embedLocal) embed.checked = true;
    void rebuild();
  };

  const showNormalized = (input: HTMLInputElement, hint: HTMLElement) => {
    const v = input.value.trim();
    const n = normalizeUrl(v);
    hint.textContent = v && n !== v ? `→ using direct link ${n}` : "";
  };

  let seq = 0;
  const rebuild = async () => {
    const my = ++seq;
    showNormalized(wordsUrl, wordsHint);
    showNormalized(mediaUrl, mediaHint);
    showNormalized(fullUrl, fullHint);
    buildErr.hidden = true;
    const p: LinkParams = {};
    if (title.value.trim()) p.title = title.value.trim();
    if (mediaUrl.value.trim()) p.media = normalizeUrl(mediaUrl.value);
    if (fullUrl.value.trim() && normalizeUrl(fullUrl.value) !== p.media) p.full = normalizeUrl(fullUrl.value);
    try {
      if (embed.checked) {
        const loaded = embedLocal ? await loadTranscriptFile(embedLocal)
          : wordsUrl.value.trim() ? await loadTranscriptUrl(wordsUrl.value) : null;
        if (my !== seq) return;
        if (!loaded) throw new Error("Pick a transcript file (or give its URL) to embed.");
        p.tx = await packJson(compactTranscript(loaded.transcript));
        outInfo.textContent = `${loaded.transcript.words.length} words embedded · `;
      } else if (wordsUrl.value.trim()) {
        p.words = normalizeUrl(wordsUrl.value);
        outInfo.textContent = "";
      } else {
        out.value = "";
        outInfo.textContent = "";
        lastLink = "";
        return;
      }
    } catch (e) {
      if (my !== seq) return;
      buildErr.textContent = (e as Error).message;
      buildErr.hidden = false;
      return;
    }
    if (my !== seq) return;
    lastLink = buildLink(location.href.replace(/[?#].*$/, ""), p);
    out.value = lastLink;
    outInfo.textContent += `${lastLink.length.toLocaleString()} characters`;
  };
  for (const el of [wordsUrl, mediaUrl, fullUrl, title]) el.addEventListener("input", () => void rebuild());
  embed.addEventListener("change", () => void rebuild());

  const check = h("p", { class: "muted" });
  const checkBtn = h("button", {
    onclick: async () => {
      check.textContent = "Checking…";
      const msgs: string[] = [];
      if (wordsUrl.value.trim()) {
        try {
          const l = await loadTranscriptUrl(wordsUrl.value);
          msgs.push(`✓ transcript: ${l.transcript.words.length} words, ${fmtShort(l.transcript.duration)}`);
        } catch (e) { msgs.push(`✗ transcript: ${(e as Error).message}`); }
      }
      if (mediaUrl.value.trim()) msgs.push(await probeMedia(normalizeUrl(mediaUrl.value), "media"));
      if (fullUrl.value.trim()) msgs.push(await probeFull(normalizeUrl(fullUrl.value)));
      check.textContent = msgs.join("  ·  ") || "Nothing to check.";
    },
  }, "Check URLs");

  const openBuilt = async () => {
    await rebuild();
    if (lastLink) location.href = lastLink;
  };

  return h("div", { class: "app open-view" },
    h("header", { class: "hero" },
      h("h1", {}, APP_NAME),
      h("p", {}, "Navigate, search and cut audio & video by its transcript. Click a word to jump there, " +
        "select words to select the audio, copy in/out times for reels, cut out the pauses, export the cut. " +
        "Runs entirely in your browser — nothing is uploaded.")),
    error ? h("p", { class: "error banner" }, error) : null,
    h("div", { class: "cards" },
      h("section", { class: "card" },
        h("h2", {}, "Open local files"),
        drop, picked, localErr,
        h("div", { class: "row" }, openLocalBtn,
          h("span", { class: "muted" }, "Tip: radiant writes ", h("code", {}, "<stem>.words.json"),
            " when the transcribe step has ", h("code", {}, "word_timestamps: true"), "."))),
      h("section", { class: "card" },
        h("h2", {}, "Build a link from public URLs"),
        h("p", { class: "muted" }, "Both files must be publicly reachable. GitHub, gist, Dropbox and Google Drive " +
          "share links are converted to direct ones. The transcript host must allow CORS — or embed it in the link."),
        h("label", { class: "field" }, "Transcript URL", wordsUrl, wordsHint),
        h("label", { class: "chk" }, embed, "Embed the transcript in the link (no hosting needed) ",
          h("button", { class: "linkish", onclick: (e: Event) => { e.preventDefault(); embedFile.click(); } }, "use a local file…"),
          embedFile, " ", embedName),
        h("label", { class: "field" }, "Media URL", mediaUrl, mediaHint),
        h("label", { class: "field" }, h("span", {}, "Full-quality URL ",
          h("small", { class: "muted" }, "— optional: exports read this; the editor plays the media above (a light preview)")),
          fullUrl, fullHint),
        h("label", { class: "field" }, "Title", title),
        h("div", { class: "row" }, checkBtn, check),
        out, outInfo, buildErr,
        h("div", { class: "row" },
          h("button", { onclick: async () => { await rebuild(); if (lastLink) void copyText(lastLink, "Link"); } }, "Copy link"),
          h("button", { class: "primary", onclick: () => void openBuilt() }, "Open"))),
      h("section", { class: "card wide" },
        h("h2", {}, "Link parameters"),
        h("p", { class: "muted" }, "You can also write links by hand — parameters go after ", h("code", {}, "#"),
          " (or ", h("code", {}, "?"), "):"),
        h("table", { class: "params" },
          ...([
            ["words", "URL of the .words.json (or segment .txt)"],
            ["media", "URL of the audio/video — anything your browser plays: mp4, webm, mov (H.264), mp3, m4a, wav, ogg, opus, flac"],
            ["full", "optional full-quality original: exports, commands and plans read it, while the editor plays media (a light preview)"],
            ["tx", "the transcript itself, compressed (the builder makes this)"],
            ["title", "display title"],
            ["at", "start position — 83.5 or 1:23.5"],
            ["sel", "selection to restore — 83.5-91.2"],
            ["clips", "clip list — 10-20.5,30-41"],
            ["recs", "URL of a .clips.json with recommended clips (default: the one next to the .words.json)"],
          ] as const).map(([k, d]) => h("tr", {}, h("td", {}, h("code", {}, k)), h("td", {}, d)))),
        h("p", { class: "muted mono" }, "https://<this page>/#media=https://x.org/talk.mp4&words=https://x.org/talk.words.json&at=1:23"))),
  );
}

async function probeMedia(url: string, label: string): Promise<string> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    const done = (msg: string) => { v.removeAttribute("src"); v.load(); resolve(msg); };
    const timer = setTimeout(() => done(`? ${label}: no response after 15 s`), 15_000);
    v.onloadedmetadata = () => {
      clearTimeout(timer);
      done(`✓ ${label}: ${v.videoWidth ? `video ${v.videoWidth}×${v.videoHeight}` : "audio"}, ${fmtShort(v.duration)}`);
    };
    v.onerror = () => {
      clearTimeout(timer);
      done(v.error?.code === 4 ? `✗ ${label}: format/codec not playable in this browser (or not a direct file link)`
                               : `✗ ${label}: failed to load`);
    };
    v.src = url;
  });
}

/**
 * The full-quality file is read by ffmpeg, not played: it needs CORS (and ideally
 * Range requests), and a codec the browser can't play (ProRes…) is fine.
 */
async function probeFull(url: string): Promise<string> {
  let net: string;
  try {
    const { ranges, size } = await probeUrl(url);
    net = `${size ? fmtBytes(size) + ", " : ""}${ranges ? "Range requests ✓" : "no Range requests (exports download it whole)"}`;
  } catch (e) {
    return `✗ full: can't read it (${(e as Error).message}) — the host must allow CORS for exports`;
  }
  const play = await probeMedia(url, "full");
  return play.startsWith("✓") ? `${play}, ${net}` : `✓ full: ${net} (the browser can't play it — fine, ffmpeg reads it)`;
}

