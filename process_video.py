#!/usr/bin/env python3
"""Thin wrapper around the video_editor sync+encode+upload steps.

Kept for ad-hoc use and backwards compatibility with extract-video.sh. The
canonical interface is now the YAML plan runner: `video_editor run --plan ...`.
The real logic lives in video_editor/steps/{sync,encode,upload}.py.

Usage:
    uv run process_video.py <video> <audio> --output <path> [options]
"""

import argparse
import sys
from pathlib import Path

from video_editor.media import rclone_copy
from video_editor.steps.base import StepContext
from video_editor.steps.encode import EncodeStep
from video_editor.steps.sync import SyncStep


def main() -> None:
    p = argparse.ArgumentParser(description="Sync, trim, re-encode, and upload an event video.")
    p.add_argument("video", type=Path)
    p.add_argument("audio", type=Path)
    p.add_argument("--output", "-o", type=Path, required=True)
    p.add_argument("--offset", type=float, default=None, help="Manual sync offset (skips auto-detect)")
    p.add_argument("--crf", type=int, default=18)
    p.add_argument("--preset", default="slow")
    p.add_argument("--upload", type=str, default=None, metavar="REMOTE:PATH")
    p.add_argument("--skip-encode", action="store_true")
    p.add_argument("--upload-public", action="store_true")
    p.add_argument("--analysis-duration", type=int, default=600, metavar="SECONDS")
    p.add_argument("--test-duration", type=float, default=None, metavar="SECONDS")
    p.add_argument("--hw", action="store_true")
    p.add_argument("--video-bitrate", default="8M")
    p.add_argument("--braw-threads", type=int, default=2, metavar="N")
    p.add_argument("--braw-scale", type=int, default=1, choices=[1, 2, 4, 8], metavar="N")
    args = p.parse_args()

    if args.test_duration is not None:
        args.output = args.output.with_name("test_" + args.output.name)

    ctx = StepContext(step_id=args.output.stem, workdir=Path("."), out_dir=args.output.parent or Path("."))

    if not args.skip_encode:
        offset, audio_trim = args.offset or 0.0, 0.0
        if args.offset is None:
            synced = SyncStep().run(
                {"video": args.video, "audio": args.audio, "analysis_duration": args.analysis_duration},
                ctx,
            )
            offset, audio_trim = synced["offset"], synced["audio_trim"]

        EncodeStep().run({
            "video": args.video, "audio": args.audio, "output": args.output.name,
            "offset": offset, "audio_trim": audio_trim,
            "hw": args.hw, "crf": args.crf, "preset": args.preset,
            "video_bitrate": args.video_bitrate, "test_duration": args.test_duration,
            "braw_threads": args.braw_threads, "braw_scale": args.braw_scale,
        }, ctx)
        print(f"\nOutput written: {args.output}")

    if args.upload:
        if args.test_duration is not None:
            print("\nSkipping upload (--test-duration is set).")
        elif not args.output.exists():
            sys.exit(f"Error: output file not found: {args.output}")
        else:
            print(f"\nUploading to {args.upload} ...")
            rclone_copy(args.output, args.upload, public=args.upload_public)
            print("Upload complete.")

    print("\nDone.")


if __name__ == "__main__":
    main()
