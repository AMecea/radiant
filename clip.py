#!/usr/bin/env python3
"""Thin wrapper around the video_editor clip step.

Kept for ad-hoc use and backwards compatibility with reel-video.sh. The canonical
interface is now `video_editor run --plan ...`; the real logic lives in
video_editor/steps/clip.py.

Usage:
    uv run clip.py <input> -s HH:MM:SS -e HH:MM:SS [--crop-format default|tiktok] [--track-face] [--output <path>]
"""

import argparse
import sys
from pathlib import Path

from video_editor.steps.base import StepContext
from video_editor.steps.clip import ClipStep


def main() -> None:
    p = argparse.ArgumentParser(description="Clip a video segment.")
    p.add_argument("input")
    p.add_argument("-s", "--start", required=True)
    p.add_argument("-e", "--end", required=True)
    p.add_argument("--crop-format", choices=["default", "tiktok"], default="default", dest="crop_fmt")
    p.add_argument("--output")
    p.add_argument("--track-face", action="store_true")
    p.add_argument("--track-sample", type=int, default=10, metavar="N")
    p.add_argument("--track-sigma", type=float, default=30.0, metavar="S")
    args = p.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        sys.exit(f"Error: input file not found: {input_path}")

    if args.output:
        output_path = Path(args.output)
    else:
        suffix = "_tiktok_track" if args.track_face else "_tiktok" if args.crop_fmt == "tiktok" else "_clip"
        output_path = input_path.with_name(input_path.stem + suffix + input_path.suffix)

    ctx = StepContext(step_id=output_path.stem, workdir=Path("."), out_dir=output_path.parent or Path("."))
    ClipStep().run({
        "input": input_path, "start": args.start, "end": args.end, "output": output_path.name,
        "crop_format": args.crop_fmt, "track_face": args.track_face,
        "track_sample": args.track_sample, "track_sigma": args.track_sigma,
    }, ctx)
    print(f"Output: {output_path}")


if __name__ == "__main__":
    main()
