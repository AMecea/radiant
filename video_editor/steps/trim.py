"""trim step — keep or drop a list of time ranges in one ffmpeg pass.

Give it **either** a list of ranges to ``include`` (keep only those, dropping the
gaps) **or** a list to ``exclude`` (keep everything else, dropping those ranges).
The selected pieces are concatenated and the timestamps reset, so the result plays
gap-free. Both video and audio are cut on the same expression, so they stay in sync.

It uses ffmpeg's ``select``/``aselect`` filters in a single command — no temp
files, no per-segment muxing — which means it also works as a stage inside a
``pipe`` (source, filter, or sink), exactly like the ``ffmpeg`` step. Because
``select`` rewrites frames it always re-encodes: ``vcodec: copy`` / ``acodec:
copy`` are not allowed.

Cuts may be written as ``{start, end}`` mappings or ``[start, end]`` pairs. Times
are seconds (``90``, ``12.5``) or clock strings (``"00:01:30"``, ``"1:30"``).

Params (besides include/exclude, all optional; share names/defaults with `ffmpeg`):
  input    : source media path (omit when piped)
  output   : output filename (standalone only; the pipe passes the path)
  include  : list of ranges to KEEP        (mutually exclusive with exclude)
  exclude  : list of ranges to DROP        (mutually exclusive with include)
  vcodec   : -c:v   (default libx264; "copy" rejected — trim re-encodes)
  crf      : -crf   (quality, lower = better; emitted only when set)
  preset   : -preset
  video_bitrate : -b:v (takes precedence over crf)
  pix_fmt  : -pix_fmt
  acodec   : -c:a   (default aac; "copy" rejected unless no_audio)
  audio_bitrate : -b:a (default 192k)
  no_audio : -an, drop audio (also skips the audio select)
  fps      : -r, output frame rate
  scale    : -vf scale=…   (applied after the cut)
  vf       : extra -vf filtergraph appended after the cut (overrides scale)
  faststart: -movflags +faststart (default true; mp4/mov)
  format   : -f, force a muxer/container
  extra_args : list of raw ffmpeg args appended verbatim

Outputs:
  file : absolute path to the produced file

Examples
  # keep two highlights, drop everything else
  - id: highlights
    action: trim
    with:
      input: "${vars.source}"
      output: highlights.mp4
      include:
        - { start: "00:01:00", end: "00:01:30" }
        - [120, 138.5]
  # drop an intro and a dead patch in the middle (keep the rest)
  - id: tidy
    action: trim
    with:
      input: "${vars.source}"
      output: tidy.mp4
      exclude:
        - { start: 0, end: 12 }
        - { start: "05:00", end: "05:20" }
"""

import sys
from pathlib import Path

from .base import StepContext
from .ffmpeg import FfmpegStep


class TrimStep(FfmpegStep):
    action = "trim"
    produces = ("file",)
    artifacts = ("file",)

    def _mode_label(self, params: dict) -> str:
        """Human label for the cut; also enforces that exactly one of
        include/exclude is present (trim is meaningless without a cut)."""
        if params.get("include") is not None:
            return f"keep {len(params['include'])} range(s)"
        if params.get("exclude") is not None:
            return f"drop {len(params['exclude'])} range(s)"
        raise ValueError("trim needs exactly one of 'include' or 'exclude'")

    # The cut itself (parsing include/exclude → select/aselect, the copy-codec
    # guard, clock-string parsing) lives in FfmpegStep now, so `trim` and the
    # `ffmpeg` action share one implementation. trim only adds: a *required* cut
    # and its own log line.

    # -- standalone ----------------------------------------------------------

    def run(self, params: dict, ctx: StepContext) -> dict:
        input_path = Path(self.require(params, "input"))
        output_name = self.require(params, "output")
        out = ctx.out_path(output_name)
        audio = params.get("audio")
        label = self._mode_label(params)        # also requires a cut to be given

        if not ctx.dry_run:
            if not input_path.exists():
                sys.exit(f"Error: input file not found: {input_path}")
            if audio and not Path(audio).exists():
                sys.exit(f"Error: audio file not found: {audio}")

        # No -ss: the cut ranges are absolute source times, and a pre-input seek
        # would shift the timeline out from under the select expression.
        cmd: list = ["ffmpeg", "-y", "-i", str(input_path)]
        cmd += self._audio_input(params)
        cmd += self._output_args(params, ctx, has_audio=bool(audio))
        cmd += [str(out)]

        print(f"  trim ({label}) → {out}")
        ctx.run(cmd)
        return {"file": str(out.resolve())}

    def command(self, params: dict, ctx: StepContext, *, upstream: dict | None = None,
                out: Path | None = None, is_last: bool = False) -> tuple[list, dict]:
        # As a pipe stage, reuse FfmpegStep's wiring (stdin/file input + sink);
        # FfmpegStep._output_args injects the cut. We just enforce a cut is given.
        self._mode_label(params)
        return super().command(params, ctx, upstream=upstream, out=out, is_last=is_last)
