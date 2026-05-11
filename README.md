# video-radiant

Processes large event/concert videos: automatically syncs a speaker-mic audio recording with the camera video, trims the video to match, replaces the camera audio with the better-quality speaker-mic audio, re-encodes to YouTube-ready H.264 1080p, and optionally uploads via rclone.

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

## Audio sync notes

- Auto-detect analyses the **first 10 minutes** of the video audio via FFT cross-correlation against the speaker-mic recording.
- If the detected offset is between **-30 s and 0**: the audio is trimmed from the start instead of seeking the video.
- If the offset is beyond -30 s, detection is considered unreliable — use `--offset` manually.
- The temp audio file extracted for analysis is printed in the logs and kept on disk (check `/tmp/tmp*.wav`) for debugging.
