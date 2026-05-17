#!/usr/bin/env python3
"""
Clip a segment from a video file, optionally cropping to TikTok (9:16) format.

Usage:
    uv run clip.py <input> --start HH:MM:SS --end HH:MM:SS [--format default|tiktok] [--output <path>]
"""

import argparse
import subprocess
import sys
from pathlib import Path


def build_filter(fmt: str) -> str | None:
    if fmt == "tiktok":
        # Crop center 9:16 region from a 16:9 source, then scale to 1080x1920
        return "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920"
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Clip a video segment.")
    parser.add_argument("input", help="Input MP4 file")
    parser.add_argument("-s", "--start", required=True, help="Start time (HH:MM:SS or SS)")
    parser.add_argument("-e", "--end", required=True, help="End time (HH:MM:SS or SS)")
    parser.add_argument(
        "--format",
        choices=["default", "tiktok"],
        default="default",
        dest="fmt",
        help="Output format (default: keep original; tiktok: crop to 9:16)",
    )
    parser.add_argument("--output", help="Output file path (default: <input>_clip.<ext>)")
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        sys.exit(f"Error: input file not found: {input_path}")

    if args.output:
        output_path = Path(args.output)
    else:
        suffix = "_tiktok" if args.fmt == "tiktok" else "_clip"
        output_path = input_path.with_name(input_path.stem + suffix + input_path.suffix)

    vf = build_filter(args.fmt)

    cmd = [
        "ffmpeg", "-y",
        "-ss", args.start,
        "-to", args.end,
        "-i", str(input_path),
    ]
    if vf:
        cmd += ["-vf", vf]
    cmd += [
        "-c:v", "libx264",
        "-crf", "18",
        "-preset", "fast",
        "-c:a", "aac",
        str(output_path),
    ]

    print("Running:", " ".join(cmd))
    result = subprocess.run(cmd)
    if result.returncode != 0:
        sys.exit(f"ffmpeg failed with exit code {result.returncode}")

    print(f"Output: {output_path}")


if __name__ == "__main__":
    main()
