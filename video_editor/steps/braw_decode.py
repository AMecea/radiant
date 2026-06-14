"""braw_decode step — decode Blackmagic RAW frames to a raw RGBA stream.

This is the decode half of the ``encode`` step, pulled out as a reusable,
composable *source* stage. It is **pipe-only**: it streams decoded frames on
stdout for a downstream ``ffmpeg`` stage and reports the matching ffmpeg input
args (rawvideo geometry + fps) as pipe metadata, so the consumer knows how to
read the stream. See ``steps/pipe.py``.

It does not run standalone (there is nothing to persist — raw frames are only
useful piped into an encoder), so ``run`` raises with guidance.

Params:
  video    : source .braw file                       (required)
  offset   : seconds to seek before decoding (→ start frame); default 0
  threads  : braw-decode --threads (default 2)
  scale    : braw-decode --scale  (default 1)

Pipe metadata produced:
  input_args : ffmpeg input args describing this stage's stdout (incl. -i pipe:0)
"""

import sys
from pathlib import Path

from ..media import BRAW_DECODE_BIN, braw_format_args, braw_fps, is_braw
from .base import Step, StepContext

# Illustrative geometry shown in --dry-run, where we don't probe the file.
_DRY_RUN_INPUT_ARGS = [
    "-f", "rawvideo", "-pixel_format", "rgba",
    "-s", "<WIDTHxHEIGHT>", "-r", "<fps>", "-i", "pipe:0",
]


class BrawDecodeStep(Step):
    action = "braw_decode"
    produces = ()        # source stage — nothing to persist on its own
    artifacts = ()

    def run(self, params: dict, ctx: StepContext) -> dict:
        raise ValueError(
            "braw_decode is a pipe-only source stage; use it as the first stage of a "
            "`pipe` step (e.g. braw_decode | ffmpeg), not as a standalone action."
        )

    def command(self, params: dict, ctx: StepContext, *,
                upstream: dict | None = None, out: Path | None = None) -> tuple[list, dict]:
        if upstream is not None:
            raise ValueError("braw_decode must be the first stage of a pipe — it is a source, it has no input stream")
        video = Path(self.require(params, "video"))
        threads = int(params.get("threads", 2))
        scale = int(params.get("scale", 1))
        offset = float(params.get("offset", 0.0) or 0.0)

        if ctx.dry_run:
            start_frame = 0
            input_args = list(_DRY_RUN_INPUT_ARGS)
        else:
            if not video.exists():
                sys.exit(f"Error: video file not found: {video}")
            if not is_braw(video):
                sys.exit(f"Error: braw_decode input is not a .braw file: {video}")
            if not BRAW_DECODE_BIN.exists():
                sys.exit(f"Error: braw-decode not found at {BRAW_DECODE_BIN}")
            input_args = braw_format_args(video)
            start_frame = int(offset * braw_fps(input_args))

        argv = [
            str(BRAW_DECODE_BIN), "--in", str(start_frame),
            "--threads", str(threads),
            "--scale", str(scale),
            str(video),
        ]
        return argv, {"input_args": input_args}
