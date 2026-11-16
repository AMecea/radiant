# textcut

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
- **Clips**: collect selections (`A`), or split a selection at its pauses (`S`, "+ Clips
  w/o pauses"). Reorder, play them back to back, and copy them as a radiant `trim` step,
  radiant `clip` steps, an ffmpeg command, CSV, JSON or SRT.
- **Export** the edit, the clips or a selection, with optional **processing**: *crop* to
  9:16 / 1:1 / 4:5… (drag the frame on a preview), *resize*, *reduce noise*, *normalise
  loudness*. *Smooth joins* adds 10 ms audio fades at every cut, so word-level cuts
  don't click. The dialog always shows the **ffmpeg command** for the current choices
  (copy it, or download it as a `.sh`). It is the same job the browser runs, so a long
  render can go to a native ffmpeg instead. Formats:
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
| `tx`    | the transcript itself, compressed (deflate + base64url). The start page builds this |
| `title` | display title |
| `at`    | start position: `83.5` or `1:23.5` |
| `sel`   | selection to restore: `83.5-91.2` |
| `clips` | clip list: `10-20.5,30-41` |
| `dw`    | deleted words, by index: `3-5,10` |
| `dg`    | deleted pauses, by index of the word before them + 1 (`0` = leading silence): `0,14` |

```
https://<host>/textcut/#media=https://x.org/talk.mp4&words=https://x.org/talk.words.json&sel=1:23.5-1:31
```

The start page has a **link builder**. It turns GitHub/gist/Dropbox/Google Drive share
links into direct ones and checks that both URLs load. It can also **embed the
transcript** in the link, so the transcript needs no hosting: a 2-minute transcript is
about 3 KB of link, and an hour is roughly 50–100 KB. In the editor, **Share** and
**🔗 Link** (the current selection) build the same kind of link, including your clips.

### Hosting requirements

- **Media playback** works from any public, direct file URL. No CORS is needed.
- **Fetching the transcript** (`words=`) needs the host to send CORS headers. GitHub
  raw, gists, Dropbox (`dl.dropboxusercontent.com`) and S3/R2/GCS buckets with CORS
  enabled all work. If yours doesn't, embed the transcript instead (`tx=`).
- **Exporting from a URL** also reads the media bytes, so it needs CORS too. With HTTP
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

## Keyboard

`Space` play/pause · `Enter` play selection · `L` loop · `A` add clip · `S` add clips
without pauses · `C` copy times · `[` / `]` copy IN / OUT · `←/→` previous/next word ·
`Delete` cut / restore the selected words · `P` shorten pauses in the selection ·
`Alt+click` a pause to cut / restore it · `⌘Z` / `⇧⌘Z` undo / redo ·
`Shift+←/→` grow/shrink selection · `Alt+←/→` ±5 s · `/` search (`Enter`/`Shift+Enter`
next/previous) · `Esc` clear · `?` help

## Layout

```
src/core/      pure logic, unit-tested: transcript parsing, pauses/ranges, search,
               time formats, clip export formats, link encoding, WAV read/write,
               edits.ts (text edits → time ranges), ops.ts (crop/resize/audio
               filters), ffjob.ts (a cut → ffmpeg argv + shell script)
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
a label, its fields (selects or sliders), defaults, and a `build(params, frame)` that
returns one ffmpeg filter. Video ops receive the frame size left by the ops before
them, so they can emit exact pixel sizes. The export dialog renders the fields, and the
job builder chains the filters after the cuts are joined. Nothing else needs changing.
