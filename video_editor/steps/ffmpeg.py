"""ffmpeg step — a general-purpose transcode/convert built from basic parameters.

Two ways to use it:

* **Standalone** (``run``): one file ``input`` → one ``output``, with the common
  knobs you reach for most (codec, quality, scale, fps, trim).
* **As a ``pipe`` stage** (``command``): when an upstream stage feeds it (see
  ``steps/pipe.py``) it reads that stage's stdout instead of a file. With a
  separate ``audio`` input it maps ``-map 0:v -map 1:a`` and replaces the audio
  track — which is how a ``braw_decode | ffmpeg`` pipe reproduces the ``encode``
  step's behaviour. ffmpeg is always a *sink* (it writes a file, never stdout).

For anything not exposed here, drop raw flags into ``extra_args``.

Params (all optional except input/output; input may instead come from a pipe):
  input         : source media path (omit when piped)
  output        : output filename (standalone only; the pipe passes the path)
  start         : -ss seek, e.g. "00:01:30" or 90      (before -i, fast seek; file input only)
  end           : -to end time                          (mutually exclusive with duration)
  duration      : -t, encode only this many seconds
  vcodec        : -c:v   (default libx264; use "copy" to stream-copy video)
  crf           : -crf   (quality, lower = better; emitted only when set)
  preset        : -preset (encoder speed/efficiency; emitted only when set)
  video_bitrate : -b:v   (e.g. "8M"; takes precedence over crf when set)
  pix_fmt       : -pix_fmt (e.g. "yuv420p")
  acodec        : -c:a   (default aac; use "copy" to stream-copy audio)
  audio_bitrate : -b:a   (default 192k)
  no_audio      : -an, drop the audio track
  audio         : a second input file to mux/replace as the audio track
  audio_trim    : -ss applied before the `audio` input (seconds)
  shortest      : finish at the shorter input (default true when `audio` is set)
  fps           : -r, output frame rate
  scale         : -vf scale=..., e.g. "1280:720" or "-2:720"
  vf            : raw -vf filtergraph (overrides scale)
  faststart     : -movflags +faststart for web playback (default true; mp4/mov only)
  format        : -f, force a muxer/container
  extra_args    : list of raw ffmpeg args appended verbatim (escape hatch)

Outputs:
  file : absolute path to the produced file
"""

import sys
from pathlib import Path

from .base import Step, StepContext


class FfmpegStep(Step):
    action = "ffmpeg"
    produces = ("file",)
    artifacts = ("file",)

    # -- shared command building --------------------------------------------

    def _audio_input(self, params: dict) -> list[str]:
        audio = params.get("audio")
        if not audio:
            return []
        trim = float(params.get("audio_trim", 0.0) or 0.0)
        return (["-ss", f"{trim:.3f}"] if trim > 0 else []) + ["-i", str(audio)]

    def _output_args(self, params: dict, ctx: StepContext, *, has_audio: bool) -> list[str]:
        """Everything after the inputs: maps, codecs, filters, container, trim."""
        vcodec = params.get("vcodec", "libx264")
        crf = params.get("crf")
        preset = params.get("preset")
        video_bitrate = params.get("video_bitrate")
        pix_fmt = params.get("pix_fmt")
        acodec = params.get("acodec", "aac")
        audio_bitrate = params.get("audio_bitrate", "192k")
        no_audio = self.as_bool(params.get("no_audio"))
        fps = params.get("fps")
        scale = params.get("scale")
        vf = params.get("vf") or (f"scale={scale}" if scale else None)
        faststart = self.as_bool(params.get("faststart"), default=True)
        shortest = self.as_bool(params.get("shortest"), default=has_audio)
        fmt = params.get("format")
        extra_args = params.get("extra_args") or []

        end = params.get("end")
        duration = params.get("duration")
        if ctx.preview is not None:
            duration = ctx.preview          # preview overrides any plan duration/end
            end = None

        args: list = []
        if has_audio:
            args += ["-map", "0:v", "-map", "1:a"]

        # Video
        if vcodec == "copy":
            args += ["-c:v", "copy"]
        else:
            args += ["-c:v", str(vcodec)]
            if video_bitrate:
                args += ["-b:v", str(video_bitrate)]
            elif crf is not None:
                args += ["-crf", str(crf)]
            if preset:
                args += ["-preset", str(preset)]
            if vf:
                args += ["-vf", str(vf)]
            if pix_fmt:
                args += ["-pix_fmt", str(pix_fmt)]
        if fps is not None:
            args += ["-r", str(fps)]

        # Audio
        if no_audio:
            args += ["-an"]
        elif acodec == "copy":
            args += ["-c:a", "copy"]
        else:
            args += ["-c:a", str(acodec), "-b:a", str(audio_bitrate)]

        if faststart:
            args += ["-movflags", "+faststart"]
        if shortest:
            args += ["-shortest"]
        if fmt:
            args += ["-f", str(fmt)]
        # Output-side trim (placed after all inputs so it can't bind to an input).
        if duration is not None:
            args += ["-t", str(duration)]
        elif end is not None:
            args += ["-to", str(end)]
        args += [str(a) for a in extra_args]
        return args

    def _span_label(self, params: dict, ctx: StepContext) -> str:
        start = params.get("start")
        end = params.get("end")
        duration = ctx.preview if ctx.preview is not None else params.get("duration")
        parts = []
        if start is not None:
            parts.append(f"from {start}")
        if duration is not None:
            parts.append(f"+{duration}s")
        elif end is not None:
            parts.append(f"to {end}")
        return " ".join(parts) or "full"

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

        start = params.get("start")
        cmd: list = ["ffmpeg", "-y"]
        if start is not None:
            cmd += ["-ss", str(start)]          # before -i: fast (keyframe) seek
        cmd += ["-i", str(input_path)]
        cmd += self._audio_input(params)
        cmd += self._output_args(params, ctx, has_audio=bool(audio))
        cmd += [str(out)]

        print(f"  ffmpeg {self._span_label(params, ctx)} → {out}")
        ctx.run(cmd)
        return {"file": str(out.resolve())}

    # -- pipe stage (sink) ---------------------------------------------------

    def command(self, params: dict, ctx: StepContext, *,
                upstream: dict | None = None, out: Path | None = None) -> tuple[list, dict]:
        if out is None:
            raise ValueError("ffmpeg can only be the final (sink) stage of a pipe — it writes a file, not stdout")
        audio = params.get("audio")
        if audio and not ctx.dry_run and not Path(audio).exists():
            sys.exit(f"Error: audio file not found: {audio}")

        cmd: list = ["ffmpeg", "-y"]
        if upstream and upstream.get("input_args"):
            cmd += [str(a) for a in upstream["input_args"]]   # e.g. -f rawvideo … -i pipe:0
        else:
            # No upstream stream → behave like a normal file input.
            input_path = Path(self.require(params, "input"))
            start = params.get("start")
            if start is not None:
                cmd += ["-ss", str(start)]
            cmd += ["-i", str(input_path)]
        cmd += self._audio_input(params)
        cmd += self._output_args(params, ctx, has_audio=bool(audio))
        cmd += [str(out)]
        return cmd, {}
