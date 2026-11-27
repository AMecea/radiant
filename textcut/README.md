# textcut (rReelIT)

The app shows itself as **rReelIT** (page title, top bar, start page; set in
`src/core/app.ts`). The code, this folder, the storage keys and the files an export
writes keep the name textcut.

Navigate, search and cut audio/video **by its transcript**, in the browser. It is the
companion to radiant's `transcribe` step (`word_timestamps: true` → `<stem>.words.json`).

- **Click a word** to jump there. **Double-click** to jump and play.
- **Select words** (drag, or Shift+click) to select that stretch of audio. Play it, loop it,
  and copy its **IN/OUT times** (for reels / radiant `clip` steps).
- **Quick search** across the transcript. It ignores diacritics, case and punctuation
  (`sase` finds `șase`), and a match can span several words.
- **Pauses** are detected from the word timings and shown inline (`1.4s`). A click plays
  around the pause. *Skip pauses* jumps over them while playing.
- **Edit by text**: select words and press `Delete` to cut them (press it again to put
  them back). `P` shortens the pauses in the selection, and *Shorten all pauses* does
  the whole recording. A cut word takes the silence around it too, keeping the padding.
  A cut pause keeps ⚙ *Shortened pause* seconds (default 0.3 s). *Skip cuts* previews
  the edit while playing. Undo/redo with `⌘Z` / `⇧⌘Z`. Edits are saved per transcript
  and go into shared links. They also apply to clips and selections you export.
- **Fix misheard words**: select words (or click one) and press `E`, or use *✎ Fix
  text*. Type the correction, then press `Enter` (or `Esc` to cancel). An empty field
  goes back to the transcribed text. Select as much as you like, a whole passage if it
  needs several fixes. Each word keeps its timing: the words you leave alone stay where
  they are, and what you change is spread over the words it replaces, so typing "Kenobi"
  over "Ken obi" merges the two. Fixes are underlined, and hovering shows the original. They
  show up in search, copied text, SRT and burned-in captions. They're saved with your
  edits, can be undone, and travel in shared links (`fx`).
- **Lines**: the control above the transcript sets how the text is broken into lines.
  *As transcribed* uses the JSON's segments, *Sentences* breaks at sentence ends, and
  *Sentences, ≤ N words* also splits long sentences into even lines of at most N words.
  This only changes the display.
- **Clips** (e.g. one per reel): a clip is a named list of segments, played and exported
  back to back. `A` (or "+ Add to clip") adds the selection to the current clip, and `S`
  adds it with its pauses cut out. **+ New clip** (`N`) starts another one. Click a
  clip to make it current, and click its name to rename it. Each clip has its own ▶
  play and **Export…** button, and its segments can be reordered, removed, sorted, split
  at pauses, or copied as a radiant plan, radiant `trim`/`clip` steps, an ffmpeg command,
  CSV, JSON or SRT.
- **Extend or shorten a segment** with the `« ‹ › »` buttons on its *Start* and *End*:
  `‹ ›` move that edge by one word, `« »` by a phrase (to the next sentence end or
  pause). The segment stays on word boundaries and the transcript shows its new extent.
- **Frame** (under the player) shows the frame the export keeps, i.e. its *Crop*, on
  the video, with the rest dimmed. Drag the bar at its top to move it left/right (and
  up/down when the crop is smaller than the picture). It is the same setting as
  *Export → Processing → Crop*, where the aspect and size are chosen; one position for
  all clips.
- **CC** on a clip puts the transcript on screen for that clip, with your spelling fixes
  and without the words you deleted. The player shows the captions while the clip plays
  (inside the crop frame, when a crop is set), and the clip's **Export…** opens with
  *Captions* on. Style, font, size, colour and position are set there, under
  *Processing → Captions*; the player preview follows them. **▲ ▼** next to CC move the
  captions up or down 3% at a time (the same *Position from top* setting, shared by all
  clips); paused between captions, a sample shows the new position for a moment. The preview matches the
  export's words, grouping, size and position; outlines and animation are drawn by the
  browser, so they differ slightly from the final render.
- **Your own caption font**: in *Processing → Captions*, **Use your own font…** takes a
  `.ttf` or `.otf` (not `.woff`). It is kept in this browser only, shows up in the *Font*
  list, and is used by the player preview and the in-browser export. A copied ffmpeg
  command or radiant plan can't download it, so it checks that the file is in
  `textcut_fonts/` and stops with a message if it isn't. One font of your own at a time.
- **Recommended clips**: proposals for reels and shorts, listed under *Clips* when the
  recording has a `<stem>.clips.json`, or after *Ask an AI…* — a prompt for the AI you
  already use, which answers with a link to click or with JSON you paste back (see
  [Recommended clips](#recommended-clips)). Each
  one has a title, a 0–100 score and the reason it should work. ▶ plays it, a click
  shows its words in the transcript, and **+ Clip** turns it into a normal clip that you
  trim, extend and export like any other. They also show as a thin band on the timeline.
- **Export** the edit, the clips or a selection, with optional **processing**: *crop* to
  9:16 / 1:1 / 4:5… (drag the frame on a preview), *resize*, *captions*, *reduce noise*,
  *normalise loudness*. *Smooth joins* adds 10 ms audio fades at every cut, so word-level cuts
  don't click. The dialog always shows the **ffmpeg command** for the current choices
  (copy it, or download it as a `.sh`) and the **radiant plan**: one `ffmpeg` step with
  the same filter graph (copy it, or download it as a `.yaml`). Both describe the same
  job the browser runs, so a long render can go to a native ffmpeg or to radiant instead.
  - The input is the media URL, written into the command and the plan by default. Tick
    **Variables** to get `$INPUT` / `$OUTPUT` (`INPUT=other.mp4 sh cut.sh`) and radiant
    `${vars.input}` / `${vars.output}` (`--vars input=…`) instead. The URL and file name
    stay as their defaults.
  - **🔗 Copy link** puts the whole export in a link: the ranges (clips/reels, or the
    edit), the format, the processing and the file name. Whoever opens it lands in the
    same export dialog. They can run it in their browser or copy the command or plan,
    and their own saved settings stay untouched. Hosted media goes in the link. A local
    file can't, so the recipient is asked for it.

  **Captions** burn the transcript into the video, timed word by word on the cut. It
  uses an ASS script rendered by libass (ffmpeg's `ass` filter). There are four styles:
  *Bold pop* (2–3 upper-case words, the spoken word in the accent colour, a scale-in pop),
  *One word at a time*, *Karaoke fill* (words fill with colour as they're spoken), and
  *Clean subtitles on a box*. You can also set the font, size, accent colour, position,
  words per caption and case. The defaults are Inter Black, size 10 and Radiant yellow
  (`#FFB013`). Size is the letter size as a % of the frame's shorter side,
  so 10 means letters 10% of a 9:16 reel's width, whatever the font. The fonts are
  open-licensed (Inter, Poppins, Anton) and come from pinned jsDelivr URLs. **▶ Preview** renders 5 seconds of the export, captions and all,
  through the same job, and plays it in the dialog.
  - In the browser, ffmpeg.wasm already has libass.
  - A native ffmpeg needs libass too: on macOS `brew install ffmpeg-full`, because
    Homebrew's plain `ffmpeg` has no `ass`, `subtitles` or `drawtext` filters. The shell
    script checks for it, downloads the font into `textcut_fonts/` once, and writes
    `textcut_captions.ass` next to the output. The radiant plan does the same in a
    `shell` step before the `ffmpeg` step.

  Formats:
  - **WAV**: instant. A PCM `.wav` source is cut straight from its bytes, so a 1-hour
    master is not decoded. Other formats are decoded with WebAudio first.
  - **Video / MP3 / M4A** via [ffmpeg.wasm](https://ffmpegwasm.netlify.app/), downloaded on
    first use (~32 MB, cached after that). *Fast* stream-copy is instant, but cut points
    snap to keyframes. *Exact* re-encodes to H.264, is frame-accurate, and is slow
    (roughly real time). Crop and filters need this mode.
- **No backend.** Inputs come from local files or from public URLs in the link. Clips are
  remembered per transcript in `localStorage`.

## Run

```bash
cd textcut
npm install
npm run dev        # http://localhost:5173
npm test           # core logic (vitest)
npm run build      # static site in dist/; host it anywhere
```

The build uses relative paths, so `dist/` works from any sub-path. The
`.github/workflows/textcut-pages.yml` workflow publishes it to GitHub Pages on every push
to `main` that touches `textcut/`. To enable it once, go to *Settings → Pages → Source:
GitHub Actions*.

## Opening things

**Local files:** drop `talk.words.json` and `talk.mp4` onto the start page. You can also
drop a new media/transcript onto the editor at any time.

**Links:** every parameter goes in the URL fragment (`#…`), so it never reaches the
host's server. `?…` works too.

| param   | meaning |
|---------|---------|
| `words` | URL of the `.words.json` (or a segment-level `.txt`; its word times are interpolated) |
| `media` | URL of the audio/video. Anything the browser plays: mp4/webm/mov (H.264), mp3, m4a, wav, ogg, opus, flac |
| `full`  | optional URL of the full-quality original. Exports, the captions preview, ffmpeg commands and radiant plans read it, while the editor plays `media` (see *Preview and full-quality media*) |
| `tx`    | the transcript itself, compressed (deflate + base64url). The start page builds this |
| `title` | display title |
| `at`    | start position: `83.5` or `1:23.5` |
| `sel`   | selection to restore: `83.5-91.2` |
| `clips` | one clip's segments: `10-20.5,30-41` |
| `reels` | several named clips: `Intro~1-5,9-12\|Q&A~30-41` (name `~` segments, `\|` between clips) |
| `dw`    | deleted words, by index: `3-5,10` |
| `dg`    | deleted pauses, by index of the word before them + 1 (`0` = leading silence): `0,14` |
| `fx`    | spelling fixes, `index~text` joined by `\|`: `3~Kenobi\|10~two words` |
| `x`     | an export to open on arrival: ranges, format, processing, file name (compressed JSON) |
| `recs`  | URL of a `.clips.json` with recommended clips. Without it, the file next to `words` is tried (`x.words.json` → `x.clips.json`) |
| `rx`    | the recommended clips themselves, compressed like `tx` |
| `ai`    | recommended clips an AI wrote onto the link, by line number: `412;12-19~92~A_title~Why_it_works;40-44~81~Another` (see [Recommended clips](#recommended-clips)) |

```
https://<host>/textcut/#media=https://x.org/talk.mp4&words=https://x.org/talk.words.json&sel=1:23.5-1:31
```

The start page has a **link builder**. It turns GitHub/gist/Dropbox/Google Drive share
links into direct ones and checks that both URLs load. It can also **embed the
transcript** in the link, so the transcript needs no hosting: a 2-minute transcript is
about 3 KB of link, and an hour is roughly 50–100 KB. In the editor, **Share** and
**🔗 Link** (the current selection) build the same kind of link, including your clips.

### Preview and full-quality media

A link can carry two versions of the recording: `media`, a light preview (e.g. 480p
H.264) that the editor plays while you navigate, search and listen, and `full`, the
original (4K, ProRes, a big `.mov`…) that the final media is made from:

```
#media=https://x.org/talk_480p.mp4&full=https://x.org/talk.mov&words=https://x.org/talk.words.json
```

- **Plays the preview:** clicking words, playback, the clip ▶ buttons, and the crop
  frame you drag in the export dialog.
- **Reads the original:** *Export*, the captions **▶ Preview** render, the ffmpeg
  command, the radiant plan, the clip copy formats (radiant steps, ffmpeg) and the
  output file names. The export dialog names the source it reads.
- The original's frame size comes from its metadata, so crop and resize numbers are
  in its pixels. If the browser can't open it (ProRes, BRAW…), crop and resize are
  written as ffmpeg expressions relative to the real size instead, and the dialog
  says so.
- Both versions must have the same timing (same start, same length) and the same
  aspect ratio.
- `full` alone works too: it is then played as well. Picking or dropping another
  media file in the editor replaces both versions.
- The start page's link builder has a *Full-quality URL* field. *Check URLs* tests that
  the original can be read for exports (CORS, Range requests). It doesn't need to be
  playable. Shared links and export links (`x=`) keep both URLs.

### Recommended clips

textcut doesn't pick the clips itself. It shows what a `<stem>.clips.json` says, so the
picking can be done by whoever reads the transcript best: a person, a script, an LLM.
radiant's `recommend` step writes one from the `.words.json` (see the
[main README](../README.md#recommend--reel--short-proposals)); upload it next to the
transcript and the proposals appear by themselves.

```json
{ "v": 1, "clips": [
  { "title": "Why hasn't he come yet?", "score": 92, "tags": ["question"],
    "why": "Opens on a question and answers it within the clip.",
    "ranges": [[21.36, 34.48], [1817.62, 1853.72]] }
] }
```

- `ranges` are seconds (or clock times) in the recording, played back to back. One range
  is the usual case; two or more make a clip that skips what's between them. They don't
  need to be exact: each range is snapped to the words it covers, then padded like a
  selection.
- `score` (0–100), `why` and `tags` are optional. The list is shown best first.
- Put the file next to the transcript (`talk.words.json` → `talk.clips.json`) and the
  same link picks it up. Or name it with `recs=`, pack it into the link with `rx=`, or
  drop it onto the editor. The host needs CORS, as for `words=`.

**From your own AI.** With no file at all, *Ask an AI…* in the Recommended section
writes the prompt for you: the instructions plus the transcript as numbered lines that
end where the speaker does (with your spelling fixes). Copy it — or download it as a
`.txt` to attach — into ChatGPT, Claude, Gemini, DeepSeek or whatever you use, then
paste the answer back and the list appears. Nothing is sent from the app, and no key
is needed. The AI answers with line numbers rather than times, so its clips always
start and end on a phrase boundary. You can set how many clips, how long, and add
notes for the AI (who the audience is, what to avoid).

**The AI can answer with a link.** When the recording was opened from a link with
`words=`, the dialog offers *The AI answers with: a link to click*. The prompt then
gives the AI this recording's link and has it write the clips onto the end of it
(`ai=`). Clicking the link in the chat opens the recording with the clips in place,
and the link can be sent on as it is. If the chat doesn't make it clickable, paste the
answer into the dialog: a link is read the same as JSON. *JSON to paste back* stays
available; it also carries tags and is the safer choice for a long list, since the AI
has less to get wrong.

The `ai=` value is `<lines>;` followed by the clips, `;` between them. `<lines>` is how
many lines the transcript had in the prompt; a link whose count doesn't match the
recording is refused rather than shown with the wrong passages. Each clip is
`lines~score~title~why`: `12-19` or, in two parts, `12-19,40-44`; `_` stands for a
space. Lines are numbered from the words as transcribed, so the numbers mean the same
passages for everybody, whatever they have corrected. Clips that arrive this way
replace the list kept in the browser, like a pasted answer.

The transcript must be at a URL for this: a link that embeds the transcript (`tx=`) or
a local file can't be handed to an AI to copy. With the media on your computer the
link still works, but opens the transcript without it.

A list you brought yourself (an AI's answer, a dropped file) is kept in the browser
for that recording and shown instead of the link's until you clear it with ✕. Sharing
the link carries it along (`rx=`).

### Hosting requirements

- **Media playback** works from any public, direct file URL. No CORS is needed.
- **Fetching the transcript** (`words=`) needs the host to send CORS headers. GitHub
  raw, gists, Dropbox (`dl.dropboxusercontent.com`) and S3/R2/GCS buckets with CORS
  enabled all work. If yours doesn't, embed the transcript instead (`tx=`).
- **Exporting from a URL** also reads the media bytes (of `full` when it's given), so it needs CORS too. With HTTP
  Range support, ffmpeg reads only what it needs (see below). Without it, the whole
  file is downloaded first, and a native WAV cut is not possible. Local files have no
  such limits.

### Does ffmpeg.wasm need the whole file?

No. ffmpeg runs in a worker of our own (`src/app/ffmpeg-worker.ts`) and reads its input
through Emscripten's WORKERFS, one `blob.slice()` at a time:

- **Local file**: the `File` is read lazily from disk. Nothing is copied into memory.
- **URL with Range support**: we mount a Blob look-alike whose `slice()` makes a
  synchronous ranged request (1 MiB chunks, read-ahead for sequential reads, 96 MiB LRU
  cache). ffmpeg seeks by itself, so it fetches only the container index (the MP4
  `moov`, or the WebM cues, even at the end of the file) and the stretches being cut.
  Exporting a 3-second selection from a 37 MB test video fetched 4.2 MB in 4 requests.
  The export status shows how much was fetched.
- **URL without Range support**: one full download, as before.

When the cut covers most of the recording (a talk with words and pauses removed),
ffmpeg decodes it all anyway, so expect to fetch most of the file. The output is built
in memory, and ffmpeg.wasm has a few GB at most, so very long exact renders are better
run natively with the copied command.
- Browser codec support decides what plays. HEVC, ProRes, BRAW and some MKVs won't play.
  Transcode them with radiant's `ffmpeg` step first (H.264/AAC MP4 or M4A).

## On a phone

On a narrow screen (up to 860 px wide) the page is one column: the player, which stays
in view, then the clips and the recommendations. The transcript is not on the page; it
opens over it, full screen, when you need it.

- **See transcript** opens it to read, search, or tap a word to jump there. **Select
  text** lets you pick words.
- **Picking words is by tapping**: tap the first word, then the last. Another tap moves
  the nearer end of the selection, so either end can be adjusted outwards or inwards.
- **+ New clip** opens the transcript to pick the clip's text; **+ Make clip** creates
  it. **+ Add text** on a clip adds another segment the same way.
- **✎ Edit text** on a segment opens the transcript on its words. **✓ Update** makes
  the segment the words now selected; **✎ Fix** corrects their spelling and **✂ Cut**
  removes them from exports. **Done** closes the transcript.

A mouse on a narrow window can still drag across the text to select it.

## Keyboard

`Space` play/pause · `Enter` play selection · `L` loop · `A` add to the current clip ·
`S` add without pauses · `N` new clip · `C` copy times · `[` / `]` copy IN / OUT · `←/→` previous/next word ·
`Delete` cut / restore the selected words · `P` shorten pauses in the selection ·
`Alt+click` a pause to cut / restore it · `⌘Z` / `⇧⌘Z` undo / redo ·
`Shift+←/→` grow/shrink selection · `Alt+←/→` ±5 s · `/` search (`Enter`/`Shift+Enter`
next/previous) · `Esc` clear · `?` help

## Layout

```
src/core/      pure logic, unit-tested: transcript parsing, pauses/ranges, search,
               time formats, clip export formats, link encoding, WAV read/write,
               edits.ts (text edits → time ranges), ops.ts (crop/resize/captions/
               audio filters), captions.ts (words → ASS captions), ffjob.ts (a cut →
               ffmpeg argv + shell script), radiant.ts (a cut → radiant plan)
src/app/       UI: editor (player, transcript, selection, edits, clips), timeline
               canvas, start page / link builder, export dialog, export (WAV +
               ffmpeg.wasm), ffmpeg worker (lazy File/URL reads), sources
tests/         vitest suite (synthetic fixture)
```

Pause detection uses only Whisper's word timings. Whisper sometimes stretches a word
over a short silence, so short pauses can be under-reported. Raise or lower the
threshold in ⚙ Settings, which also holds the padding added around every cut (default
80 ms, never past the midpoint of the gap to the next word).

### Adding processing

Each processing step is one entry in `OPS` in `src/core/ops.ts`. An entry has an id,
a label, its fields (selects or sliders), defaults, and a `build(params, frame, env)` that
returns one ffmpeg filter. It can also return text files and fonts the filter reads, the
way captions do: `env` has the words, the ranges and where to put the files. Video ops receive the frame size left by the ops before
them, so they can emit exact pixel sizes. The export dialog renders the fields, and the
job builder chains the filters after the cuts are joined. Nothing else needs changing.
