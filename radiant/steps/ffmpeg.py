"""ffmpeg step — a general-purpose transcode/convert built from basic parameters.

Two ways to use it:

* **Standalone** (``run``): one file ``input`` → one ``output``, with the common
  knobs you reach for most (codec, quality, scale, fps, trim).
* **As a ``pipe`` stage** (``command``): when an upstream stage feeds it (see
  ``steps/pipe.py``) it reads that stage's stdout instead of a file. With a
  separate ``audio`` input it maps ``-map 0:v -map 1:a`` and replaces the audio
  track — which is how a ``braw_decode | ffmpeg`` pipe reproduces the ``encode``
  step's behaviour. ffmpeg is always a *sink* (it writes a file, never stdout).

For anything not exposed here, drop raw flags into ``extra_args``. Every parameter
is documented at its declaration below.
"""

import sys
from pathlib import Path

from .base import Output, Param, Step, StepContext


class FfmpegStep(Step):
    action = "ffmpeg"
    summary = "General-purpose transcode/convert (and a `pipe` sink stage)."
    params = (
        Param("input", "Source media path. Omit when fed by an upstream pipe stage.",
              type="path", required=True),
        Param("output", "Output filename (standalone only; a pipe passes the path).",
              required=True),
        Param("start", "-ss seek before -i (fast keyframe seek); file input only.",
              type="str"),
        Param("end", "-to end time (mutually exclusive with duration).", type="str"),
        Param("duration", "-t, encode only this many seconds (overridden by --preview).",
              type="str"),
        Param("include", "Time ranges to KEEP (drop the rest); each {start,end} or "
                         "[start,end], seconds or clock strings. Cuts video+audio together "
                         "(re-encode required). Use only one of include/exclude.",
              type="ranges"),
        Param("exclude", "Time ranges to DROP (keep the rest). Use only one of include/exclude.",
              type="ranges"),
        Param("vcodec", "-c:v ('copy' to stream-copy video).", default="libx264"),
        Param("crf", "-crf quality (lower = better); emitted only when set.", type="int"),
        Param("preset", "-preset encoder speed/efficiency; emitted only when set.", type="str"),
        Param("video_bitrate", "-b:v (e.g. '8M'); takes precedence over crf when set.", type="str"),
        Param("pix_fmt", "-pix_fmt (e.g. 'yuv420p').", type="str"),
        Param("acodec", "-c:a ('copy' to stream-copy audio).", default="aac"),
        Param("audio_bitrate", "-b:a.", default="192k"),
        Param("no_audio", "-an, drop the audio track.", type="bool", default=False),
        Param("audio", "A second input file to mux/replace as the audio track.", type="path"),
        Param("audio_trim", "-ss applied before the `audio` input (seconds).",
              type="float", default=0.0),
        Param("shortest", "Finish at the shorter input (default true when `audio` is set).",
              type="bool"),
        Param("fps", "-r, output frame rate.", type="str"),
        Param("scale", "-vf scale=..., e.g. '1280:720' or '-2:720'.", type="str"),
        Param("vf", "Raw -vf filtergraph (overrides scale).", type="str"),
        Param("faststart", "-movflags +faststart for web playback (mp4/mov only).",
              type="bool", default=True),
        Param("format", "-f, force a muxer/container.", type="str"),
        Param("input_format", "-f for a generic upstream stdin stream (pipe stage only).",
              type="str"),
        Param("extra_args", "List of raw ffmpeg args appended verbatim (escape hatch).",
              type="list"),
    )
    outputs = (
        Output("file", "Absolute path to the produced file.", artifact=True),
    )

    # -- shared command building --------------------------------------------

    def _audio_input(self, params: dict) -> list[str]:
        audio = params.get("audio")
        if not audio:
            return []
        trim = float(params.get("audio_trim", 0.0) or 0.0)
        return (["-ss", f"{trim:.3f}"] if trim > 0 else []) + ["-i", str(audio)]

    # -- include/exclude cut -------------------------------------------------

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

    def _select_expr(self, params: dict) -> str | None:
        """The (a)select expression for include/exclude, or None when neither is set."""
        include, exclude = params.get("include"), params.get("exclude")
        if include is None and exclude is None:
            return None
        if include is not None and exclude is not None:
            raise ValueError("use only one of 'include' or 'exclude'")
        cuts = include if include is not None else exclude
        if not isinstance(cuts, list) or not cuts:
            raise ValueError("'include'/'exclude' must be a non-empty list of cuts")
        bounds = [self._cut_bounds(c) for c in cuts]
        if include is not None:
            # Keep a frame if it falls inside ANY kept range.
            return "+".join(f"between(t,{s:g},{e:g})" for s, e in bounds)
        # Keep a frame only if it falls outside EVERY dropped range.
        return "*".join(f"not(between(t,{s:g},{e:g}))" for s, e in bounds)

    def _output_args(self, params: dict, ctx: StepContext, *, has_audio: bool,
                     to_stdout: bool = False) -> list[str]:
        """Everything after the inputs: maps, codecs, filters, container, trim.

        ``to_stdout`` builds a streamable output (for a non-final ``pipe`` stage
        writing to ``pipe:1``): faststart is impossible on a non-seekable pipe, so
        mp4/mov get fragmented (``+frag_keyframe+empty_moov``) and a format is forced.
        """
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

        # include/exclude: prepend a select cut to the video filter chain (the
        # matching audio aselect is appended as -af below). Re-encode is required.
        cut = self._select_expr(params)
        if cut:
            if str(vcodec).lower() == "copy":
                raise ValueError("include/exclude cut needs a re-encode (select); remove 'vcodec: copy'")
            if not no_audio and str(acodec).lower() == "copy":
                raise ValueError("include/exclude cut needs a re-encode (aselect); remove 'acodec: copy' or set 'no_audio: true'")
            select = f"select='{cut}',setpts=N/FRAME_RATE/TB"
            vf = f"{select},{vf}" if vf else select

        faststart = self.as_bool(params.get("faststart"), default=True)
        shortest = self.as_bool(params.get("shortest"), default=has_audio)
        fmt = params.get("format")
        extra_args = params.get("extra_args") or []
        if to_stdout:
            faststart = False           # can't move the moov atom on a non-seekable pipe
            fmt = fmt or "mp4"

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

        mp4_family = (fmt or "").lower() in ("mp4", "mov", "m4v", "m4a", "3gp")
        if to_stdout and mp4_family:
            args += ["-movflags", "+frag_keyframe+empty_moov"]
        elif faststart:
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
        if cut and not no_audio:
            args += ["-af", f"aselect='{cut}',asetpts=N/SR/TB"]
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
        if params.get("include") is not None:
            parts.append(f"keep {len(params['include'])} range(s)")
        elif params.get("exclude") is not None:
            parts.append(f"drop {len(params['exclude'])} range(s)")
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

    # -- pipe stage ----------------------------------------------------------

    def command(self, params: dict, ctx: StepContext, *, upstream: dict | None = None,
                out: Path | None = None, is_last: bool = False) -> tuple[list, dict]:
        audio = params.get("audio")
        if audio and not ctx.dry_run and not Path(audio).exists():
            sys.exit(f"Error: audio file not found: {audio}")

        cmd: list = ["ffmpeg", "-y"]
        if upstream is not None:
            # Fed by an upstream stage → read its stdout.
            if upstream.get("input_args"):
                cmd += [str(a) for a in upstream["input_args"]]   # e.g. -f rawvideo … -i pipe:0
            else:
                # Generic upstream (e.g. a shell source): read pipe:0; user names the format.
                informat = params.get("input_format")
                if informat:
                    cmd += ["-f", str(informat)]
                cmd += ["-i", "pipe:0"]
        else:
            # First stage → behave like a normal file input.
            input_path = Path(self.require(params, "input"))
            start = params.get("start")
            if start is not None:
                cmd += ["-ss", str(start)]
            cmd += ["-i", str(input_path)]
        cmd += self._audio_input(params)

        if is_last:
            if out is None:
                raise ValueError(
                    "ffmpeg as the final pipe stage needs an 'output' (set the pipe's 'output', "
                    "or use a streaming sink like upload_stream)"
                )
            cmd += self._output_args(params, ctx, has_audio=bool(audio))
            cmd += [str(out)]
            return cmd, {}

        # Non-final stage → stream a fragmented/streamable container to stdout.
        cmd += self._output_args(params, ctx, has_audio=bool(audio), to_stdout=True)
        cmd += ["pipe:1"]
        return cmd, {}
