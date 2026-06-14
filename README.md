# video-radiant

Processes large event/concert videos: automatically syncs a speaker-mic audio recording with the camera video, trims the video to match, replaces the camera audio with the better-quality speaker-mic audio, re-encodes to YouTube-ready H.264 1080p, and optionally uploads via rclone.

## `video_editor` — the pipeline tool

The whole flow (sync → encode → upload → transcribe → reel-clip → upload) is declared
once in a YAML **plan**. Steps run a slice at a time and each writes output artifacts
into a persistent workdir, so later steps consume earlier steps' outputs by reference
and runs are resumable.

```bash
uv run video_editor validate --plan examples/1petru.yaml      # check refs, DAG, actions
uv run video_editor run      --plan examples/1petru.yaml --step sync       # just step 1
uv run video_editor run      --plan examples/1petru.yaml --step master     # heavy encode
uv run video_editor run      --plan examples/1petru.yaml --step transcribe # find reel timestamps
uv run video_editor run      --plan examples/1petru.yaml --step reel-upload_reel
uv run video_editor list     --plan examples/1petru.yaml      # per-step status + outputs

uv run video_editor run      --plan examples/1petru.yaml --preview      # 5s preview of the whole chain
uv run video_editor run      --plan examples/1petru.yaml --preview 10    # 10s preview
```

- **Step selector** (`--step`): `N`, `N-M`, `N-`, `-M`, comma lists, step ids, and id ranges (`sync-reel`). Default = all.
- **Artifacts & state:** outputs land under `runs/<plan-name>/<step-id>/`; `state.json` records each step's outputs. Referenced as `${steps.<id>.<output>}` and `${vars.<key>}` in the plan.
- **Resumable / idempotent:** a finished step is skipped on re-run unless its artifact was deleted (then it rebuilds) or you pass `--force`.
- **Fail-fast:** running a step whose upstream artifact doesn't exist yet errors with guidance instead of doing the wrong thing.
- **`--preview [SECONDS]`** (default 5): caps the long steps (`encode`, `clip`, `transcribe`) to a few seconds so you can sanity-check sync/framing/timestamps fast. Outputs are written `preview_`-prefixed, uploads are skipped, and **state is not saved** — so the preview never blocks or gets mistaken for the real run. Re-run it as many times as you like; a later full run (without `--preview`) still does everything from scratch.
- **`--dry-run`** prints every command (and hook) without executing; **`--vars k=v`** overrides plan vars for one run.
- **Hooks:** optional `on_start` / `on_success` / `on_failure` / `on_pause` shell commands in the plan (`{name}`/`{step}`/`{code}`/`{url}`/`{message}` placeholders) — put `caffeinate` / `telegram` piping there.

Step actions: `sync` (offset detect), `encode` (trim + replace audio + re-encode; braw & standard), `clip` (segment + 9:16 crop / face-track), `trim` (keep/drop a list of time ranges), `transcribe` (Whisper timestamps), `upload` (rclone), `ffmpeg` (general-purpose transcode/convert from basic parameters), `pipe` (compose stages via OS pipes) + `braw_decode` (BRAW→raw source stage), `pause` (manual checkpoint). See `examples/1petru.yaml`, `examples/ffmpeg.yaml`, `examples/trim.yaml`, and `examples/pipe.yaml`.

### `ffmpeg` — general-purpose transcode / convert

The plain ffmpeg escape hatch (no sync/braw logic): one input, one output, and the common knobs — `vcodec`/`acodec` (or `copy` to stream-copy), `crf`, `preset`, `video_bitrate`/`audio_bitrate`, `scale`, `vf`, `fps`, `start`/`end`/`duration`, `no_audio`, `audio` (mux a separate audio track), `pix_fmt`, `faststart` (mp4/mov only), `format`, plus an `extra_args` list for raw flags. It also accepts `include`/`exclude` range lists (the same cut the `trim` action does — `select`/`aselect`, video + audio cut together and in sync; forces a re-encode). Handy for downscales, trims, audio extraction, gif previews, and remuxes; honours `--preview` (caps to N seconds). See `examples/ffmpeg.yaml` for transcode / trim / extract-audio / gif samples.

### `trim` — keep or drop a list of time ranges

Give `trim` **either** an `include` list (keep only those ranges) **or** an `exclude` list (keep everything else); each range is a `{start, end}` mapping or an `[start, end]` pair, in seconds (`90`, `12.5`) or clock strings (`"00:01:30"`, `"1:30"`). It cuts video and audio on the same expression in a single ffmpeg pass (`select`/`aselect` + `setpts`), so the kept pieces concatenate gap-free and stay in sync — no temp files or per-segment muxing. Because `select` rewrites frames it always re-encodes, so `vcodec: copy` / `acodec: copy` are rejected. It works standalone or as a `pipe` stage (source/filter/sink). See `examples/trim.yaml`.

`trim` is just the `ffmpeg` action with a *required* `include`/`exclude` cut — both actions share one implementation, so you can also add `include`/`exclude` directly to any `ffmpeg` step (e.g. to cut while you encode/scale in a single pass, as the master pipe in `my_pipline_1petru.yaml` does).

### `pipe` — compose stages via OS pipes

`pipe` chains several actions into a single streaming command (`stage1 | stage2 | …`), the same shape `encode` uses internally (`braw-decode | ffmpeg`) but assembled declaratively from reusable stages. The first stage is a **source** (writes stdout), the last is the **sink** (writes the `output` file); geometry/format metadata flows from one stage to the next (e.g. `braw_decode` tells `ffmpeg` the rawvideo size + fps). A stage opts in by implementing `Step.command`; today `braw_decode` (source), `ffmpeg`/`trim` (filter or sink), `shell` (any role), and `upload_stream` (streaming sink) do.

A pipe runs as **one unit** — no intermediate file lands on disk, so there's nothing to resume mid-pipe; if the output is deleted the whole pipe re-runs. Use a pipe when you want streaming with no large throwaway intermediate; use separate plan steps when you want per-stage resume. `examples/pipe.yaml` reproduces the `master` encode as `braw_decode | ffmpeg` (the built-in `encode` action is unchanged).

### `pause` — manual checkpoints

Drop a `pause` step where you need to do something by hand (e.g. read the transcript and choose reel start/end). When the run reaches it, it **exits 0**, prints a notice (and fires the `on_pause` hook if set, so you get a telegram ping), and does **not** run the remaining steps:

```yaml
- id: pick_timestamps
  action: pause
  needs: [transcribe]
  with:
    message: "Read the transcript and set reel start/end, then resume with --step reel-"
```

The notice tells you exactly how to resume (`run … --step <next>-`). `pause` is not recorded in state, so it always halts a normal run — you step over it by selecting the steps after it. In `--dry-run` and `--preview` it does **not** halt (those modes are meant to walk/produce the whole chain) — it just prints a note.

The standalone scripts below (`process_video.py`, `clip.py`, `transcribe.py`) remain as thin
wrappers over the same step logic for ad-hoc use; the plan runner is the canonical interface.

---

## What it does

1. **Extracts** the first 10 minutes of the camera's audio track
2. **Cross-correlates** it against the speaker-mic recording to find the time offset automatically
3. **Seeks** the video to that offset (or trims the audio if the mic started slightly before the camera)
4. **Replaces** the camera audio with the speaker-mic recording
5. **Re-encodes** to H.264 1080p MP4 (YouTube-optimised: yuv420p, AAC 192k, faststart)
6. **Uploads** to any rclone remote (Google Drive, S3, etc.)

Supported input formats: any container ffmpeg can read (MP4, MOV, MXF, …) plus Blackmagic RAW (`.braw`) via `braw-decode`.

## Requirements

**System tools** (must be installed separately):

| Tool | Install |
|---|---|
| `uv` | `brew install uv` |
| `ffmpeg` (with libx264 + VideoToolbox) | `brew install ffmpeg` |
| `rclone` | `brew install rclone` |
| `braw-decode` | Place binary at `lib/braw-decode/braw-decode` |

**Python dependencies** are declared inline (PEP 723) and installed automatically by `uv` on first run — no manual `pip install` needed.

## Usage

```
uv run process_video.py <video> <audio> --output <path> [options]
```

### Basic example

```bash
uv run process_video.py /Volumes/Drive/event.braw speaker_mic.wav --output event_final.mp4
```

### Test encode (2 minutes only)

```bash
uv run process_video.py /Volumes/Drive/event.braw speaker_mic.wav \
  --output test.mp4 --test-duration 2
```

### Full run with upload

```bash
uv run process_video.py /Volumes/Drive/event.braw speaker_mic.wav \
  --output event_final.mp4 --upload "gdrive:Videos/2026/"
```

### Skip encode, upload existing file

```bash
uv run process_video.py /Volumes/Drive/event.braw speaker_mic.wav \
  --output event_final.mp4 --skip-encode --upload "gdrive:Videos/2026/"
```

### Manual sync offset (skips auto-detect)

```bash
uv run process_video.py /Volumes/Drive/event.braw speaker_mic.wav \
  --output event_final.mp4 --offset 42.5
```

## All options

| Flag | Default | Description |
|---|---|---|
| `video` | *(required)* | Source video file path |
| `audio` | *(required)* | Speaker-mic audio file path |
| `--output` / `-o` | *(required)* | Output file path |
| `--offset` | auto-detect | Manual sync offset in seconds; skips cross-correlation |
| `--upload` | — | rclone remote path, e.g. `gdrive:Videos/` |
| `--skip-encode` | off | Skip encode step, only upload |
| `--test-duration` | — | Encode only N minutes (quick sanity check) |
| `--analysis-duration` | 600 | Seconds of audio used for sync detection |
| `--hw` | off | Use VideoToolbox hardware encoder (see Speed below) |
| `--video-bitrate` | `8M` | Bitrate for hardware encoding (YouTube 1080p = 8 Mbps) |
| `--crf` | 18 | libx264 quality (lower = better; ignored with `--hw`) |
| `--preset` | `slow` | libx264 preset (ignored with `--hw`) |

## Speed options

Encoding a 2-hour 4K BRAW video is the bottleneck. Three ways to go faster:

### 1. Hardware encoder — biggest win (10–20× faster)

```bash
uv run process_video.py video.braw audio.wav --output out.mp4 --hw
```

Uses macOS VideoToolbox to encode H.264 on the GPU/media engine instead of the CPU. Quality is bitrate-controlled (`--video-bitrate`, default `8M`) rather than CRF. 8 Mbps is YouTube's recommended upload bitrate for 1080p SDR — quality is indistinguishable after YouTube re-encodes.

```bash
# Higher bitrate for more headroom before YouTube re-encodes:
uv run process_video.py video.braw audio.wav --output out.mp4 --hw --video-bitrate 16M
```

### 2. Faster software preset — moderate win (3–5× faster than default)

```bash
uv run process_video.py video.braw audio.wav --output out.mp4 --preset fast
```

libx264 `slow` preset is the default for maximum compression efficiency, but YouTube re-encodes the upload anyway so the difference in final quality is negligible. `fast` or `medium` is a good trade-off.

### 3. Both together (not applicable — `--hw` replaces libx264 entirely)

`--hw` and `--preset`/`--crf` are mutually exclusive: hardware encoding ignores preset and CRF.

### Comparison

| Mode | Relative speed | Quality control |
|---|---|---|
| `--preset slow` (default) | 1× baseline | CRF 18 (lossless-looking) |
| `--preset fast` | ~4× | CRF 18 |
| `--hw` | ~15× | 8 Mbps bitrate |
| `--hw --video-bitrate 16M` | ~15× | 16 Mbps bitrate |

## Clipping (`clip.py`)

Cut a segment from any video, with optional TikTok-format cropping.

```
uv run clip.py <input> -s HH:MM:SS -e HH:MM:SS [--crop-format default|tiktok] [--track-face]
```

### Crop formats

| `--crop-format` | Description |
|---|---|
| `default` | Keeps original resolution and aspect ratio |
| `tiktok` | Static center crop → 1080×1920 (9:16) |

### Face tracking (`--track-face`)

Detects the face every N frames with OpenCV's DNN detector (Caffe SSD res10, ~10 MB,
downloaded automatically on first use to `~/.cache/video-radiant/`), interpolates
positions between samples, smooths the trajectory with a Gaussian filter, then
re-encodes with a per-frame 9:16 crop centered on the face.

`--track-face` is independent of `--crop-format` — it always produces a 9:16 output
centered on the detected face.

```bash
# face-tracked 9:16 clip
uv run clip.py talk.mp4 -s 0:05:00 -e 0:05:30 --track-face

# detect every 5th frame, faster response to movement
uv run clip.py talk.mp4 -s 0:05:00 -e 0:05:30 --track-face --track-sample 5 --track-sigma 10

# very smooth pan (good for slow walkers)
uv run clip.py talk.mp4 -s 0:05:00 -e 0:05:30 --track-face --track-sigma 60
```

#### Tuning flags

| Flag | Default | Effect |
|---|---|---|
| `--track-sample N` | `10` | Detect face every N frames; lower = more accurate, slower |
| `--track-sigma S` | `30` | Gaussian smoothing in frames (~1.2 s at 25 fps); lower = follows movement faster, higher = smoother/less jitter |

**Rule of thumb:** lower `--track-sigma` when the subject moves quickly and you want the
frame to keep up; raise it when movement is slow and jitter is the bigger problem.

## Audio sync notes

- Auto-detect analyses the **first 10 minutes** of the video audio via FFT cross-correlation against the speaker-mic recording.
- If the detected offset is between **-30 s and 0**: the audio is trimmed from the start instead of seeking the video.
- If the offset is beyond -30 s, detection is considered unreliable — use `--offset` manually.
- The temp audio file extracted for analysis is printed in the logs and kept on disk (check `/tmp/tmp*.wav`) for debugging.
