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
- **Clips** (e.g. one per reel): a clip is a named list of segments, played and exported
  back to back. `A` (or "+ Add to clip") adds the selection to the current clip, and `S`
  adds it with its pauses cut out. **+ New clip** (`N`) starts another one. Click a
  clip to make it current, and click its name to rename it. Each clip has its own ▶
  play and **Export…** button, and its segments can be reordered, removed, sorted, split
  at pauses, or copied as a radiant plan, radiant `trim`/`clip` steps, an ffmpeg command,
  CSV, JSON or SRT.
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
| `tx`    | the transcript itself, compressed (deflate + base64url). The start page builds this |
| `title` | display title |
| `at`    | start position: `83.5` or `1:23.5` |
| `sel`   | selection to restore: `83.5-91.2` |
| `clips` | one clip's segments: `10-20.5,30-41` |
| `reels` | several named clips: `Intro~1-5,9-12\|Q&A~30-41` (name `~` segments, `\|` between clips) |
| `dw`    | deleted words, by index: `3-5,10` |
| `dg`    | deleted pauses, by index of the word before them + 1 (`0` = leading silence): `0,14` |
| `x`     | an export to open on arrival: ranges, format, processing, file name (compressed JSON) |

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
