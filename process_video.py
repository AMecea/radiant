#!/usr/bin/env python3
"""
Process and upload event video: sync audio, trim, re-encode to YouTube HD, upload via rclone.

Supports standard video files (MP4, MOV, MXF, …) and Blackmagic RAW (.braw) via braw-decode.

Usage:
    uv run process_video.py <video> <audio> --output <path> [options]
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import librosa
import numpy as np
from scipy.signal import correlate


ANALYSIS_SR = 8000  # Hz — low sample rate is plenty for sync detection
BRAW_DECODE_BIN = Path(__file__).parent / "lib" / "braw-decode" / "braw-decode"

SCALE_FILTER = (
    "scale=1920:1080:force_original_aspect_ratio=decrease,"
    "pad=1920:1080:(ow-iw)/2:(oh-ih)/2"
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def run(cmd: list, **kwargs) -> subprocess.CompletedProcess:
    print(f"  $ {' '.join(str(c) for c in cmd)}")
    return subprocess.run(cmd, check=True, **kwargs)


def is_braw(path: Path) -> bool:
    return path.suffix.lower() == ".braw"


# ---------------------------------------------------------------------------
# BRAW helpers
# ---------------------------------------------------------------------------

def get_duration(path: Path) -> float:
    """Return media duration in seconds via ffprobe."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_entries", "format=duration", str(path),
        ],
        capture_output=True, text=True, check=True,
    )
    return float(json.loads(result.stdout)["format"]["duration"])


def _braw_format_args_from_ffprobe(braw_path: Path) -> list[str]:
    """Build braw-decode pipe format args using ffprobe for resolution/fps."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_streams", "-select_streams", "v:0", str(braw_path),
        ],
        capture_output=True, text=True, check=True,
    )
    stream = json.loads(result.stdout)["streams"][0]
    w, h = stream["width"], stream["height"]
    num, den = stream["r_frame_rate"].split("/")
    fps = float(num) / float(den)
    return ["-f", "rawvideo", "-pixel_format", "rgba",
            "-s", f"{w}x{h}", "-r", f"{fps:.6f}", "-i", "pipe:0"]


def braw_format_args(braw_path: Path) -> list[str]:
    """Return ffmpeg input args for a braw-decode pipe (includes -i pipe:0).
    Tries braw-decode -f first; falls back to ffprobe if it crashes."""
    try:
        result = subprocess.run(
            [str(BRAW_DECODE_BIN), "-f", str(braw_path)],
            capture_output=True, text=True, check=True,
        )
        return result.stdout.strip().split()
    except subprocess.CalledProcessError:
        print("  braw-decode -f failed (crash); falling back to ffprobe for metadata.")
        return _braw_format_args_from_ffprobe(braw_path)


def braw_fps(fmt_args: list[str]) -> float:
    return float(fmt_args[fmt_args.index("-r") + 1])


def extract_braw_audio_for_analysis(
    braw_path: Path, out_path: Path, duration: int, start: float = 0.0
) -> bool:
    """
    Try to pull audio from a BRAW file via ffmpeg (works if the container has a
    readable PCM/AAC track). Returns True on success, False if ffmpeg can't read it.
    """
    try:
        cmd = ["ffmpeg", "-y"]
        if start > 0:
            cmd += ["-ss", f"{start:.3f}"]
        cmd += [
            "-t", str(duration),
            "-i", str(braw_path),
            "-ac", "1", "-ar", str(ANALYSIS_SR),
            "-vn", str(out_path),
        ]
        subprocess.run(cmd, check=True, stderr=subprocess.DEVNULL)
        return True
    except subprocess.CalledProcessError:
        return False


def _video_codec_args(hw_accel: bool, crf: int, preset: str, video_bitrate: str) -> list[str]:
    if hw_accel:
        return ["-c:v", "h264_videotoolbox", "-b:v", video_bitrate, "-allow_sw", "1", "-color_range", "tv"]
    return ["-c:v", "libx264", "-preset", preset, "-crf", str(crf)]


def encode_braw(
    braw_path: Path,
    audio_path: Path,
    output_path: Path,
    offset: float,
    audio_trim: float,
    crf: int,
    preset: str,
    test_duration: float | None,
    hw_accel: bool = False,
    video_bitrate: str = "8M",
    braw_threads: int = 2,
    braw_scale: int = 1,
) -> None:
    """Pipe braw-decode → ffmpeg, seeking via --in frame index."""
    fmt_args = braw_format_args(braw_path)
    fps = braw_fps(fmt_args)
    start_frame = int(offset * fps)
    threads = braw_threads

    decode_cmd = [
        str(BRAW_DECODE_BIN), "--in", str(start_frame),
        "--threads", str(threads),
        "--scale", str(braw_scale),
        str(braw_path),
    ]

    # fmt_args already ends with "-i pipe:0"; ffmpeg reads that from its stdin.
    audio_input = (["-ss", f"{audio_trim:.3f}"] if audio_trim > 0 else []) + ["-i", str(audio_path)]
    ffmpeg_cmd = [
        "ffmpeg", "-y",
        *fmt_args,
        *audio_input,
        "-map", "0:v",
        "-map", "1:a",
        *_video_codec_args(hw_accel, crf, preset, video_bitrate),
        "-pix_fmt", "yuv420p",
        "-vf", SCALE_FILTER,
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        "-shortest",
    ]
    if test_duration is not None:
        ffmpeg_cmd += ["-t", str(int(test_duration))]
    ffmpeg_cmd.append(str(output_path))

    print(f"  $ {' '.join(str(c) for c in decode_cmd)} | {' '.join(str(c) for c in ffmpeg_cmd)}")

    decode_proc = subprocess.Popen(decode_cmd, stdout=subprocess.PIPE)
    ffmpeg_proc = subprocess.Popen(ffmpeg_cmd, stdin=decode_proc.stdout)
    decode_proc.stdout.close()  # let decode_proc receive SIGPIPE when ffmpeg exits
    ffmpeg_proc.wait()
    decode_proc.wait()

    # SIGPIPE (-13) from braw-decode is normal when -t / -shortest causes ffmpeg to stop early
    if ffmpeg_proc.returncode != 0:
        sys.exit(f"ffmpeg failed with exit code {ffmpeg_proc.returncode}")
    if decode_proc.returncode not in (0, -13):
        sys.exit(f"braw-decode failed with exit code {decode_proc.returncode}")


# ---------------------------------------------------------------------------
# Standard video helpers
# ---------------------------------------------------------------------------

def extract_audio_for_analysis(
    video_path: Path, out_path: Path, duration: int, start: float = 0.0
) -> None:
    cmd = ["ffmpeg", "-y"]
    if start > 0:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += [
        "-t", str(duration),
        "-i", str(video_path),
        "-ac", "1", "-ar", str(ANALYSIS_SR),
        "-vn", str(out_path),
    ]
    run(cmd, stderr=subprocess.DEVNULL)


def encode_video(
    video_path: Path,
    audio_path: Path,
    output_path: Path,
    offset: float,
    audio_trim: float,
    crf: int,
    preset: str,
    test_duration: float | None,
    hw_accel: bool = False,
    video_bitrate: str = "8M",
) -> None:
    audio_input = (["-ss", f"{audio_trim:.3f}"] if audio_trim > 0 else []) + ["-i", str(audio_path)]
    cmd = [
        "ffmpeg", "-y",
        "-ss", f"{offset:.3f}",
        "-i", str(video_path),
        *audio_input,
        "-map", "0:v",
        "-map", "1:a",
        *_video_codec_args(hw_accel, crf, preset, video_bitrate),
        "-pix_fmt", "yuv420p",
        "-vf", SCALE_FILTER,
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        "-shortest",
    ]
    if test_duration is not None:
        cmd += ["-t", str(int(test_duration))]
    cmd.append(str(output_path))
    run(cmd)


# ---------------------------------------------------------------------------
# Shared
# ---------------------------------------------------------------------------

def find_offset(video_audio_path: Path, ref_audio_path: Path, duration: int) -> float:
    """Return time offset (seconds) where ref_audio starts within video_audio."""
    print(f"  Loading up to {duration}s of each audio track at {ANALYSIS_SR} Hz...")
    v, _ = librosa.load(str(video_audio_path), sr=ANALYSIS_SR, mono=True, duration=duration)
    r, _ = librosa.load(str(ref_audio_path), sr=ANALYSIS_SR, mono=True, duration=duration)

    v = v / (np.max(np.abs(v)) + 1e-10)
    r = r / (np.max(np.abs(r)) + 1e-10)

    corr = correlate(v, r, mode="full", method="fft")
    offset_samples = int(np.argmax(corr)) - (len(r) - 1)
    return offset_samples / ANALYSIS_SR


def _public_url(remote: str, filename: str) -> str:
    _, rest = remote.split(":", 1)
    parts = rest.strip("/").split("/", 1)
    bucket = parts[0]
    prefix = parts[1].rstrip("/") + "/" if len(parts) > 1 and parts[1] else ""
    key = prefix + filename
    if remote.lower().startswith("s3"):
        return f"https://{bucket}.s3.amazonaws.com/{key}"
    return f"https://storage.googleapis.com/{bucket}/{key}"


def upload(output_path: Path, remote: str, public: bool = False) -> None:
    cmd = ["rclone", "copy", str(output_path), remote, "--progress"]
    if public:
        remote_lower = remote.lower()
        if remote_lower.startswith("s3"):
            cmd += ["--s3-acl", "public-read"]
        elif remote_lower.startswith("gs"):
            cmd += ["--gcs-object-acl", "publicRead"]
        else:
            sys.exit(f"Error: --upload-public is not supported for remote '{remote}' (expected s3: or gs:)")
    run(cmd)
    if public:
        print(f"Public URL: {_public_url(remote, output_path.name)}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Sync, trim, re-encode, and upload an event video."
    )
    parser.add_argument("video", type=Path, help="Source video file (camera, large; .braw supported)")
    parser.add_argument("audio", type=Path, help="Reference audio file (speaker mic)")
    parser.add_argument("--output", "-o", type=Path, required=True, help="Output file path")
    parser.add_argument(
        "--offset", type=float, default=None,
        help="Manual sync offset in seconds (skips auto-detect)",
    )
    parser.add_argument("--crf", type=int, default=18, help="H.264 CRF (default: 18)")
    parser.add_argument(
        "--preset", default="slow",
        choices=["ultrafast", "superfast", "veryfast", "faster", "fast",
                 "medium", "slow", "slower", "veryslow"],
        help="libx264 preset (default: slow)",
    )
    parser.add_argument(
        "--upload", type=str, default=None, metavar="REMOTE:PATH",
        help="rclone remote destination, e.g. 'gdrive:Videos/'",
    )
    parser.add_argument("--skip-encode", action="store_true", help="Skip encode, only upload")
    parser.add_argument("--upload-public", action="store_true", help="Set ACL to public-read on upload (s3: and gs: remotes)")
    parser.add_argument(
        "--analysis-duration", type=int, default=600, metavar="SECONDS",
        help="Audio seconds to use for sync detection (default: 600)",
    )
    parser.add_argument(
        "--test-duration", type=float, default=None, metavar="SECONDS",
        help="Encode only N seconds (for quick sanity checks); prefixes output with test_ and skips upload",
    )
    parser.add_argument(
        "--hw", action="store_true",
        help="Use VideoToolbox hardware H.264 encoder (macOS, much faster; uses --video-bitrate instead of CRF)",
    )
    parser.add_argument(
        "--video-bitrate", default="8M",
        help="Target bitrate for hardware encoding (default: 8M — YouTube recommended for 1080p)",
    )
    parser.add_argument(
        "--braw-threads", type=int, default=2, metavar="N",
        help="CPU threads for braw-decode (default: 2; reduce if sharing the machine)",
    )
    parser.add_argument(
        "--braw-scale", type=int, default=1, choices=[1, 2, 4, 8], metavar="N",
        help="Downsample BRAW by this factor before piping to ffmpeg (1/2/4/8). "
             "Use 2 when source is 4K and output is 1080p — cuts decode CPU and pipe bandwidth by 4x.",
    )
    args = parser.parse_args()

    if args.test_duration is not None:
        args.output = args.output.with_name("test_" + args.output.name)

    braw = is_braw(args.video)

    if not args.skip_encode:
        if not args.video.exists():
            sys.exit(f"Error: video file not found: {args.video}")
        if not args.audio.exists():
            sys.exit(f"Error: audio file not found: {args.audio}")
        if braw and not BRAW_DECODE_BIN.exists():
            sys.exit(f"Error: braw-decode not found at {BRAW_DECODE_BIN}")

        if args.offset is None:
            print(f"\n[1/3] Extracting first {args.analysis_duration}s of video audio for sync analysis...")

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp_path = Path(tmp.name)
            print(f"  Temp audio: {tmp_path}")
            try:
                if braw:
                    ok = extract_braw_audio_for_analysis(args.video, tmp_path, args.analysis_duration)
                    if not ok:
                        print(
                            "  Warning: ffmpeg could not read audio from the BRAW file.\n"
                            "  Auto-sync is unavailable. Re-run with --offset <seconds>."
                        )
                        sys.exit(1)
                else:
                    extract_audio_for_analysis(args.video, tmp_path, args.analysis_duration)

                print("\n[2/3] Computing sync offset via cross-correlation...")
                offset = find_offset(tmp_path, args.audio, args.analysis_duration)
            finally:
                #tmp_path.unlink(missing_ok=True)
                pass

            print(f"  Detected offset: {offset:.3f}s")
        else:
            offset = args.offset
            print(f"\n[1/3] Using manual offset: {offset:.3f}s")
            print("[2/3] Skipping auto-detect.")

        # Resolve negative offset: audio leads video by abs(offset) seconds.
        # Trim that many seconds from the start of the audio instead of seeking the video.
        audio_trim = 0.0
        if offset < -30:
            sys.exit(
                f"Error: offset {offset:.3f}s is beyond -30s — detection is unreliable.\n"
                "  Use --offset to provide a correct value manually."
            )
        elif offset < 0:
            audio_trim = -offset
            print(f"  Audio leads video by {audio_trim:.3f}s — trimming audio start by {audio_trim:.3f}s.")
            offset = 0.0

        print(f"\n[3/3] Encoding → {args.output}")
        if args.test_duration:
            print(f"  Test mode: encoding only {args.test_duration}s → {args.output}")
        if args.hw:
            print(f"  Hardware encoder: VideoToolbox H.264 @ {args.video_bitrate}")
        else:
            print(f"  Software encoder: libx264 preset={args.preset} crf={args.crf}")

        if braw:
            encode_braw(args.video, args.audio, args.output, offset, audio_trim,
                        args.crf, args.preset, args.test_duration, args.hw, args.video_bitrate,
                        args.braw_threads, args.braw_scale)
        else:
            encode_video(args.video, args.audio, args.output, offset, audio_trim,
                         args.crf, args.preset, args.test_duration, args.hw, args.video_bitrate)

        print(f"\nOutput written: {args.output}")

    if args.upload:
        if args.test_duration is not None:
            print("\nSkipping upload (--test-duration is set).")
        else:
            if not args.output.exists():
                sys.exit(f"Error: output file not found: {args.output}")
            print(f"\nUploading to {args.upload} ...")
            upload(args.output, args.upload, public=args.upload_public)
            print("Upload complete.")

    print("\nDone.")


if __name__ == "__main__":
    main()
