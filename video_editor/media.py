"""Shared ffmpeg / ffprobe / braw-decode / rclone helpers.

Extracted verbatim (logic-preserving) from the original ``process_video.py`` so the
step implementations share one source of truth for media plumbing.
"""

import json
import subprocess
import sys
from pathlib import Path

ANALYSIS_SR = 8000  # Hz — low sample rate is plenty for sync detection
BRAW_DECODE_BIN = Path(__file__).resolve().parent.parent / "lib" / "braw-decode" / "braw-decode"

SCALE_FILTER = (
    "scale=1920:1080:force_original_aspect_ratio=decrease,"
    "pad=1920:1080:(ow-iw)/2:(oh-ih)/2"
)


def run(cmd: list, **kwargs) -> subprocess.CompletedProcess:
    """Echo a command then run it, raising on non-zero exit."""
    print(f"  $ {' '.join(str(c) for c in cmd)}")
    return subprocess.run(cmd, check=True, **kwargs)


def is_braw(path: Path) -> bool:
    return Path(path).suffix.lower() == ".braw"


# ---------------------------------------------------------------------------
# Probing
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


# ---------------------------------------------------------------------------
# Encoding helpers
# ---------------------------------------------------------------------------

def video_codec_args(hw_accel: bool, crf: int, preset: str, video_bitrate: str) -> list[str]:
    if hw_accel:
        return ["-c:v", "h264_videotoolbox", "-b:v", video_bitrate, "-allow_sw", "1", "-color_range", "tv"]
    return ["-c:v", "libx264", "-preset", preset, "-crf", str(crf)]


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------

def public_url(remote: str, filename: str) -> str:
    _, rest = remote.split(":", 1)
    parts = rest.strip("/").split("/", 1)
    bucket = parts[0]
    prefix = parts[1].rstrip("/") + "/" if len(parts) > 1 and parts[1] else ""
    key = prefix + filename
    if remote.lower().startswith("s3"):
        return f"https://{bucket}.s3.amazonaws.com/{key}"
    return f"https://storage.googleapis.com/{bucket}/{key}"


def rclone_copy(output_path: Path, remote: str, public: bool = False, dry_run: bool = False) -> str | None:
    """rclone copy a file to a remote. Returns the public URL when ``public``."""
    cmd = ["rclone", "copy", str(output_path), remote, "--progress"]
    if public:
        remote_lower = remote.lower()
        if remote_lower.startswith("s3"):
            cmd += ["--s3-acl", "public-read"]
        elif remote_lower.startswith("gs"):
            cmd += ["--gcs-object-acl", "publicRead"]
        else:
            sys.exit(f"Error: public upload is not supported for remote '{remote}' (expected s3: or gs:)")
    if dry_run:
        print(f"  [dry-run] $ {' '.join(str(c) for c in cmd)}")
    else:
        run(cmd)
    url = public_url(remote, Path(output_path).name) if public else None
    if url:
        print(f"  Public URL: {url}")
    return url
