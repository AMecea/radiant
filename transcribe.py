#!/usr/bin/env python3
"""Thin wrapper around the video_editor transcribe step.

Kept for ad-hoc use. The canonical interface is now `video_editor run --plan ...`;
the real logic lives in video_editor/steps/transcribe.py. Writes a sibling
``<input>.txt`` with ``start<TAB>end<TAB>text`` lines.

Usage:
    uv run transcribe.py <audio.wav> [--language ro] [--model turbo]
"""

import argparse
import sys
from pathlib import Path

from video_editor.steps.base import StepContext
from video_editor.steps.transcribe import TranscribeStep


def main() -> None:
    p = argparse.ArgumentParser(description="Transcribe audio/video with Whisper.")
    p.add_argument("input")
    p.add_argument("--language", default="ro")
    p.add_argument("--model", default="turbo")
    args = p.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        sys.exit(f"Error: input file not found: {input_path}")

    ctx = StepContext(step_id=input_path.stem, workdir=Path("."), out_dir=input_path.parent or Path("."))
    out = TranscribeStep().run(
        {"input": input_path, "language": args.language, "model": args.model}, ctx
    )
    print(f"Transcript: {out['transcript']}")


if __name__ == "__main__":
    main()
