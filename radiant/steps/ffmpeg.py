"""ffmpeg step — a general-purpose transcode/convert built from basic parameters.

Two ways to use it:

* **Standalone** (``run``): one file ``input`` → one ``output``, with the common
  knobs you reach for most (codec, quality, scale, fps, trim).
* **As a ``pipe`` stage** (``command``): when an upstream stage feeds it (see
  ``steps/pipe.py``) it reads that stage's stdout instead of a file. With a
  separate ``audio`` input it maps ``-map 0:v -map 1:a`` and replaces the audio
  track — which is how a ``braw_decode | ffmpeg`` pipe reproduces the ``encode``
  step's behaviour. ffmpeg is always a *sink* (it writes a file, never stdout).

For cuts that need a real filter graph (frame-accurate trims joined with
``concat``, crops, audio filters — what textcut exports), give ``filter_complex``
and ``map``; ``inputs`` adds more seeked inputs of the same or other sources.
``input`` (and ``inputs``) may also be ``http(s)://`` URLs: ffmpeg reads them
directly, seeking with Range requests.

For anything not exposed here, drop raw flags into ``extra_args``. Every parameter
is documented at its declaration below.

Example — two ranges of a remote talk, joined, cropped to 9:16:

    - id: reel
      action: ffmpeg
      with:
        input: "${vars.input}"          # a path or an https:// URL
        output: reel.mp4
        start: 120                      # input 0: -ss 120 -i …
        inputs:
          - { file: "${vars.input}", start: 300 }   # input 1: -ss 300 -i …
        filter_complex: |
          [0:v:0]trim=duration=12,setpts=PTS-STARTPTS[v0];
          [0:a:0]atrim=duration=12,asetpts=PTS-STARTPTS[a0];
          [1:v:0]trim=duration=8,setpts=PTS-STARTPTS[v1];
          [1:a:0]atrim=duration=8,asetpts=PTS-STARTPTS[a1];
          [v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][a];
          [vc]crop=608:1080:656:0[v]
        map: ["[v]", "[a]"]
"""

import sys
from pathlib import Path

from .base import Output, Param, Step, StepContext


def is_url(value) -> bool:
    """An http(s) URL — ffmpeg reads those itself; they're not local paths."""
    return isinstance(value, str) and value.lower().startswith(("http://", "https://"))


def source_arg(value) -> str:
    """A path or URL as an ffmpeg input argument (``Path`` would mangle ``https://``)."""
    return str(value) if is_url(value) else str(Path(value))


class FfmpegStep(Step):
    action = "ffmpeg"
    summary = "General-purpose transcode/convert (and a `pipe` sink stage)."
    params = (
        Param("input", "Source media path or http(s) URL. Omit when fed by an upstream pipe stage.",
              type="path", required=True),
        Param("output", "Output filename (standalone only; a pipe passes the path).",
              required=True),
        Param("start", "-ss seek before -i (fast keyframe seek); file input only.",
              type="str"),
        Param("inputs", "More inputs after `input` (and `audio`), each {file, start?, duration?} "
                        "→ `[-ss start] [-t duration] -i file`; reference them in "
                        "`filter_complex` as [1:v], [2:a]…", type="list"),
        Param("filter_complex", "Raw -filter_complex graph (whitespace/newlines allowed). Pair "
                                "with `map`; not combinable with vf/scale/include/exclude.",
              type="str"),
        Param("map", "List of -map targets, e.g. ['[v]', '[a]'] or ['0:a:0']. When set, the "
                     "automatic audio-input mapping is skipped.", type="list"),
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

    def _extra_inputs(self, params: dict, ctx: StepContext) -> list[str]:
        inputs = params.get("inputs") or []
        if not isinstance(inputs, list):
            raise ValueError("'inputs' must be a list of {file, start?, duration?}")
        args: list = []
        for i, item in enumerate(inputs):
            if isinstance(item, str):
                item = {"file": item}
            if not isinstance(item, dict) or not item.get("file"):
                raise ValueError(f"inputs[{i}] needs a 'file'")
            f = item["file"]
            if not ctx.dry_run and not is_url(f) and not Path(f).exists():
                sys.exit(f"Error: input file not found: {f}")
            if item.get("start") is not None:
                args += ["-ss", str(item["start"])]
            if item.get("duration") is not None:
                args += ["-t", str(item["duration"])]
            args += ["-i", source_arg(f)]
        return args

    # -- include/exclude cut -------------------------------------------------

    # Time parsing lives on ``Step`` (shared with `concat`); kept here as the name
    # the cut helpers below read.
    _to_seconds = staticmethod(Step.to_seconds)

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
        graph = params.get("filter_complex")
        maps = params.get("map")
        if maps is not None and not isinstance(maps, list):
            raise ValueError("'map' must be a list, e.g. ['[v]', '[a]']")
        cut = self._select_expr(params)
        if graph and (vf or cut):
            raise ValueError("'filter_complex' can't be combined with vf/scale/include/exclude — "
                             "put those filters in the graph")
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
        if graph:
            args += ["-filter_complex", str(graph).strip()]
        if maps:
            for m in maps:
                args += ["-map", str(m)]
        elif has_audio:
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
        input_path = self.require(params, "input")
        output_name = self.require(params, "output")
        out = ctx.out_path(output_name)
        audio = params.get("audio")

        if not ctx.dry_run:
            if not is_url(input_path) and not Path(input_path).exists():
                sys.exit(f"Error: input file not found: {input_path}")
            if audio and not Path(audio).exists():
                sys.exit(f"Error: audio file not found: {audio}")

        start = params.get("start")
        cmd: list = ["ffmpeg", "-y"]
        if start is not None:
            cmd += ["-ss", str(start)]          # before -i: fast (keyframe) seek
        cmd += ["-i", source_arg(input_path)]
        cmd += self._audio_input(params)
        cmd += self._extra_inputs(params, ctx)
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
            input_path = self.require(params, "input")
            start = params.get("start")
            if start is not None:
                cmd += ["-ss", str(start)]
            cmd += ["-i", source_arg(input_path)]
        cmd += self._audio_input(params)
        cmd += self._extra_inputs(params, ctx)

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
