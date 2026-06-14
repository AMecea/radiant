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

    # -- cut parsing ---------------------------------------------------------

    @staticmethod
    def _to_seconds(value) -> float:
        """Accept seconds (int/float/str) or a clock string HH:MM:SS(.ms)/MM:SS."""
        if isinstance(value, (int, float)):
            return float(value)
        s = str(value).strip()
        if ":" in s:
            secs = 0.0
            for part in s.split(":"):
                secs = secs * 60 + float(part)
            return secs
        return float(s)

    def _cut_bounds(self, cut) -> tuple[float, float]:
        if isinstance(cut, dict):
            start, end = cut.get("start"), cut.get("end")
            if start is None or end is None:
                raise ValueError("each cut needs both 'start' and 'end'")
        elif isinstance(cut, (list, tuple)) and len(cut) == 2:
            start, end = cut
        else:
            raise ValueError("each cut must be a {start, end} mapping or an [start, end] pair")
        s, e = self._to_seconds(start), self._to_seconds(end)
        if e <= s:
            raise ValueError(f"cut end ({end}) must be after start ({start})")
        return s, e

    def _select_expr(self, params: dict) -> str:
        """Build the (a)select expression that decides which frames survive."""
        include, exclude = params.get("include"), params.get("exclude")
        if (include is None) == (exclude is None):
            raise ValueError("trim needs exactly one of 'include' or 'exclude'")
        cuts = include if include is not None else exclude
        if not isinstance(cuts, list) or not cuts:
            raise ValueError("'include'/'exclude' must be a non-empty list of cuts")
        bounds = [self._cut_bounds(c) for c in cuts]
        if include is not None:
            # Keep a frame if it falls inside ANY kept range.
            return "+".join(f"between(t,{s:g},{e:g})" for s, e in bounds)
        # Keep a frame only if it falls outside EVERY dropped range.
        return "*".join(f"not(between(t,{s:g},{e:g}))" for s, e in bounds)

    def _guard_codecs(self, params: dict) -> None:
        if str(params.get("vcodec", "libx264")).lower() == "copy":
            raise ValueError("trim must re-encode video (the select filter rewrites frames); remove 'vcodec: copy'")
        if not self.as_bool(params.get("no_audio")) and str(params.get("acodec", "aac")).lower() == "copy":
            raise ValueError("trim must re-encode audio (aselect); remove 'acodec: copy' or set 'no_audio: true'")

    def _mode_label(self, params: dict) -> str:
        if params.get("include") is not None:
            return f"keep {len(params['include'])} range(s)"
        return f"drop {len(params['exclude'])} range(s)"

    # -- command building (shared by standalone + pipe via FfmpegStep) -------

    def _output_args(self, params: dict, ctx: StepContext, *, has_audio: bool,
                     to_stdout: bool = False) -> list[str]:
        """Fold the cut into the ffmpeg step's output args.

        The video cut goes in front of any user scale/vf via ``-vf``; the matching
        audio cut is appended as ``-af`` (unless audio is dropped). Everything else
        — codecs, faststart, preview cap, extra_args — comes from ``FfmpegStep``.
        """
        self._guard_codecs(params)
        expr = self._select_expr(params)

        user_vf = params.get("vf") or (f"scale={params['scale']}" if params.get("scale") else None)
        vchain = f"select='{expr}',setpts=N/FRAME_RATE/TB"
        if user_vf:
            vchain = f"{vchain},{user_vf}"

        p = dict(params)
        p["vf"] = vchain          # FfmpegStep emits this verbatim as -vf
        p.pop("scale", None)      # already folded into the chain above

        args = super()._output_args(p, ctx, has_audio=has_audio, to_stdout=to_stdout)
        if not self.as_bool(params.get("no_audio")):
            args += ["-af", f"aselect='{expr}',asetpts=N/SR/TB"]
        return args

    # -- standalone ----------------------------------------------------------

    def run(self, params: dict, ctx: StepContext) -> dict:
        input_path = Path(self.require(params, "input"))
        output_name = self.require(params, "output")
        out = ctx.out_path(output_name)
        audio = params.get("audio")

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

        print(f"  trim ({self._mode_label(params)}) → {out}")
        ctx.run(cmd)
        return {"file": str(out.resolve())}

    # As a pipe stage, trim inherits FfmpegStep.command (stdin/file wiring + sink);
    # the cut is injected through the overridden _output_args above. We never set
    # 'start', so no pre-input -ss is emitted to shift the select timeline.
