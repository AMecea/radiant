import "./style.css";
import { APP_NAME } from "./core/app";
import { readLink, unpackJson, type LinkParams } from "./core/link";
import { parseRecs, siblingRecsUrl } from "./core/recs";
import { h, toast } from "./app/dom";
import { Editor } from "./app/editor";
import { openView, type OpenResult } from "./app/open-view";
import { restoreUserFont } from "./app/userfont";
import {
  isMediaFile, isRecsFile, isTranscriptFile, loadRecsUrl, loadTranscriptFile, loadTranscriptInline, loadTranscriptUrl,
  mediaFromFile, mediaFromUrl,
} from "./app/sources";

const app = document.getElementById("app")!;
let editor: Editor | null = null;

function showOpen(error?: string, prefill?: LinkParams): void {
  editor?.destroy();
  editor = null;
  document.title = APP_NAME;
  app.replaceChildren(openView(startEditor, error, prefill));
}

function startEditor(r: OpenResult): void {
  editor?.destroy();
  editor = new Editor({
    ...r,
    onOpenOther: () => {
      history.pushState(null, "", location.pathname);
      showOpen();
    },
  });
  app.replaceChildren(editor.root);
  editor.mounted();
  document.title = `${r.link.title || r.loaded.name.replace(/\.words\.json$|\.json$|\.txt$/i, "")} · ${APP_NAME}`;
}

async function boot(): Promise<void> {
  await restoreUserFont(); // before anything lays out captions in it
  const link = readLink(location);
  if (!link.words && !link.tx) {
    showOpen(link.media || link.full ? "The link has media but no transcript (words= or tx=)." : undefined, link);
    return;
  }
  app.replaceChildren(h("div", { class: "loading" }, "Loading transcript…"));
  try {
    const loaded = link.tx ? await loadTranscriptInline(link.tx, link.title) : await loadTranscriptUrl(link.words!);
    // `media` plays in the editor; `full` (if any) is what exports read. With only
    // `full`, it does both.
    const preview = link.media ?? link.full;
    const full = link.full && link.full !== link.media ? mediaFromUrl(link.full) : null;
    startEditor({ loaded, media: preview ? mediaFromUrl(preview) : null, full: link.media ? full : null, link });
  } catch (e) {
    showOpen((e as Error).message, link);
    return;
  }
  void loadRecs(link, editor!);
}

/**
 * Recommended clips for the recording: packed in the link, at the URL the link
 * names, or — by convention — in the `.clips.json` next to the `.words.json`.
 * Only a source the link names is worth an error; the conventional file usually
 * isn't there.
 */
async function loadRecs(link: LinkParams, target: Editor): Promise<void> {
  if (link.ai) {
    // An AI wrote them onto the link: they are this person's list now, like a pasted answer.
    try {
      const n = target.useAiLink(link.ai);
      toast(n ? `${n} recommended clip${n > 1 ? "s" : ""} from the AI's link — play them, then “+ Clip” the ones you want`
              : "None of the clips in the link fall inside this transcript", n ? "ok" : "info", 4500);
    } catch (e) {
      toast(`The clips in the link: ${(e as Error).message}`, "err", 7000);
    }
    return;
  }
  const guess = link.rx || link.recs || !link.words ? null : siblingRecsUrl(link.words);
  try {
    const recs = link.rx ? parseRecs(await unpackJson(link.rx))
      : link.recs ? await loadRecsUrl(link.recs)
      : guess ? await loadRecsUrl(guess) : null;
    if (recs && editor === target) target.setRecs(recs, link.rx ? { rx: link.rx } : link.recs ? { recs: link.recs } : {});
  } catch (e) {
    if (!guess && editor === target) toast(`Couldn't load the recommended clips: ${(e as Error).message}`, "err", 5000);
  }
}

// Dropping files anywhere in the editor swaps the media / transcript.
document.addEventListener("dragover", (e) => { if (editor) e.preventDefault(); });
document.addEventListener("drop", async (e) => {
  if (!editor || !e.dataTransfer?.files.length) return;
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files);
  const recs = files.find(isRecsFile);
  if (recs) {
    try {
      const n = editor.setRecs(parseRecs(await recs.text()));
      toast(n ? `${n} recommended clip${n > 1 ? "s" : ""} from ${recs.name}` : `${recs.name} has no clips for this recording`, n ? "ok" : "info");
    } catch (err) {
      toast(`${recs.name}: ${(err as Error).message}`, "err", 5000);
    }
  }
  const media = files.find(isMediaFile);
  const tr = files.find((f) => !isMediaFile(f) && isTranscriptFile(f));
  try {
    if (tr) {
      const loaded = await loadTranscriptFile(tr);
      startEditor({ loaded, media: media ? mediaFromFile(media) : null, link: {} });
    } else if (media) {
      editor.loadMedia(mediaFromFile(media));
      toast(`Media: ${media.name}`);
    }
  } catch (err) {
    toast((err as Error).message, "err", 5000);
  }
});

window.addEventListener("hashchange", () => void boot());
void boot();
