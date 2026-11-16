import "./style.css";
import { readLink, type LinkParams } from "./core/link";
import { h, toast } from "./app/dom";
import { Editor } from "./app/editor";
import { openView, type OpenResult } from "./app/open-view";
import {
  isMediaFile, isTranscriptFile, loadTranscriptFile, loadTranscriptInline, loadTranscriptUrl,
  mediaFromFile, mediaFromUrl,
} from "./app/sources";

const app = document.getElementById("app")!;
let editor: Editor | null = null;

function showOpen(error?: string, prefill?: LinkParams): void {
  editor?.destroy();
  editor = null;
  document.title = "textcut";
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
  document.title = `${r.link.title || r.loaded.name.replace(/\.words\.json$|\.json$|\.txt$/i, "")} · textcut`;
}

async function boot(): Promise<void> {
  const link = readLink(location);
  if (!link.words && !link.tx) {
    showOpen(link.media ? "The link has media but no transcript (words= or tx=)." : undefined, link);
    return;
  }
  app.replaceChildren(h("div", { class: "loading" }, "Loading transcript…"));
  try {
    const loaded = link.tx ? await loadTranscriptInline(link.tx, link.title) : await loadTranscriptUrl(link.words!);
    startEditor({ loaded, media: link.media ? mediaFromUrl(link.media) : null, link });
  } catch (e) {
    showOpen((e as Error).message, link);
  }
}

// Dropping files anywhere in the editor swaps the media / transcript.
document.addEventListener("dragover", (e) => { if (editor) e.preventDefault(); });
document.addEventListener("drop", async (e) => {
  if (!editor || !e.dataTransfer?.files.length) return;
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files);
  const media = files.find(isMediaFile);
  const tr = files.find((f) => !isMediaFile(f) && isTranscriptFile(f));
  try {
    if (tr) {
      const loaded = await loadTranscriptFile(tr);
      startEditor({ loaded, media: media ? mediaFromFile(media) : null, link: {} });
    } else if (media) {
      editor.setMedia(mediaFromFile(media));
      toast(`Media: ${media.name}`);
    }
  } catch (err) {
    toast((err as Error).message, "err", 5000);
  }
});

window.addEventListener("hashchange", () => void boot());
void boot();
