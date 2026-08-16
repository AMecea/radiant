"""concat step — assemble several sources into one timeline, with transitions.

This is the pipeline's linear-editing primitive: an ordered list of `clips`, each
with its own in/out points, joined by either a hard **cut** or a **transition**
(any of ffmpeg's ``xfade`` wipes/dissolves, with a matching ``acrossfade`` on the
audio so the two never drift apart).

Everything is one ffmpeg invocation built from a ``-filter_complex`` graph:

1. **Normalise** every clip to a common canvas — scale (fit/fill/stretch), pad,
   frame rate, SAR and pixel format — because ``xfade`` refuses to mix geometries.
   Sources with no audio get generated silence so the audio graph stays parallel
   to the video graph.
2. **Join** clip *i* onto the accumulated timeline with ``concat`` (a cut) or
   ``xfade`` + ``acrossfade`` (a transition). A transition *overlaps* the two
   clips, so the timeline gets shorter by its duration — the running offset that
   ``xfade`` needs is tracked accordingly.
3. **Encode** once, with the usual codec knobs.

In/out points are applied as input-level seeks (``-ss``/``-t``), so trimming an
hour-long source to a 20-second beat costs a keyframe seek, not a full decode.

Example — three sources, a cut then a dissolve, fading up from black at the top:

    - id: assemble
      action: concat
      with:
        output: film.mp4
        transition: fade            # default for every join
        transition_duration: 1.0
        clips:
          - { file: "${vars.intro}", end: 8, fade_in: 1 }
          - { file: "${vars.talk}", start: 120, duration: 45, transition: cut }
          - { file: "${vars.outro}", transition: dissolve, fade_out: 1.5 }
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .. import media
from .base import Output, Param, Step, StepContext

# Every transition ffmpeg's `xfade` filter accepts, plus our own `cut` (no
# transition at all — the clips are simply concatenated).
XFADE_TRANSITIONS = (
    "fade", "fadeblack", "fadewhite", "fadegrays", "fadefast", "fadeslow",
    "dissolve", "distance", "pixelize", "radial", "hblur",
    "wipeleft", "wiperight", "wipeup", "wipedown",
    "wipetl", "wipetr", "wipebl", "wipebr",
    "slideleft", "slideright", "slideup", "slidedown",
    "smoothleft", "smoothright", "smoothup", "smoothdown",
    "circlecrop", "rectcrop", "circleopen", "circleclose",
    "vertopen", "vertclose", "horzopen", "horzclose",
    "diagtl", "diagtr", "diagbl", "diagbr",
    "hlslice", "hrslice", "vuslice", "vdslice",
    "squeezeh", "squeezev", "zoomin",
    "hlwind", "hrwind", "vuwind", "vdwind",
    "coverleft", "coverright", "coverup", "coverdown",
    "revealleft", "revealright", "revealup", "revealdown",
)
CUT = "cut"
TRANSITIONS = (CUT,) + XFADE_TRANSITIONS

# Fallbacks used only when a source can't be probed (dry-run over a file that
# isn't there yet, or a plan being validated on another machine).
_NOMINAL = {"width": 1920, "height": 1080, "fps": 30.0, "duration": 10.0, "has_audio": True}

_AUDIO_RATE = 48000
_AUDIO_LAYOUT = "stereo"


@dataclass
class _Clip:
    """One entry of ``clips:`` after parsing, probing and defaulting."""

    index: int              # position in the clips list (= ffmpeg input index)
    file: Path
    start: float            # in-point in the source (seconds)
    duration: float         # length on the timeline (seconds, after trimming)
    transition: str         # transition INTO this clip (from the previous one)
    transition_duration: float
    fade_in: float
    fade_out: float
    volume: float | None
    has_audio: bool
    info: dict              # what ffprobe reported (or the nominal fallback)


class ConcatStep(Step):
    action = "concat"
    summary = "Assemble clips into one timeline with cuts, transitions and fades."
    params = (
        Param("clips", "Ordered list of clips to join. Each item is a path string, or a "
                       "mapping: file (required), start/end or duration (in/out points, "
                       "seconds or clock strings), transition + transition_duration (how it "
                       "joins the PREVIOUS clip), fade_in/fade_out (seconds, video+audio), "
                       "volume (audio gain multiplier).",
              type="list", required=True),
        Param("output", "Output filename (standalone only; a pipe passes the path).",
              required=True),
        Param("transition", "Default transition between clips: 'cut', or any ffmpeg xfade "
                            "name (fade, fadeblack, dissolve, wipeleft, slideup, circleopen, "
                            "pixelize, zoomin, …). Per-clip 'transition' overrides it.",
              default=CUT),
        Param("transition_duration", "Default transition length in seconds (clips overlap by "
                                     "this much). Per-clip 'transition_duration' overrides it.",
              type="float", default=1.0),
        Param("fade_color", "Colour used by fade_in/fade_out (e.g. black, white).",
              default="black"),
        Param("audio_fade", "Fade the audio alongside fade_in/fade_out.",
              type="bool", default=True),
        Param("width", "Canvas width; defaults to the first clip's.", type="int"),
        Param("height", "Canvas height; defaults to the first clip's.", type="int"),
        Param("fps", "Timeline frame rate; defaults to the first clip's.", type="str"),
        Param("fit", "How a clip that doesn't match the canvas is fitted: 'contain' "
                     "(letterbox/pillarbox), 'cover' (fill and crop), 'stretch' (distort).",
              type="enum", choices=("contain", "cover", "stretch"), default="contain"),
        Param("vcodec", "-c:v (no 'copy' — assembling always re-encodes).", default="libx264"),
        Param("crf", "-crf quality (lower = better); emitted only when set.", type="int"),
        Param("preset", "-preset encoder speed/efficiency.", type="str"),
        Param("video_bitrate", "-b:v; takes precedence over crf.", type="str"),
        Param("pix_fmt", "-pix_fmt for the timeline (must be shared by all clips).",
              default="yuv420p"),
        Param("acodec", "-c:a (no 'copy' — the audio graph re-encodes).", default="aac"),
        Param("audio_bitrate", "-b:a.", default="192k"),
        Param("no_audio", "-an, build a silent timeline (skips the audio graph).",
              type="bool", default=False),
        Param("faststart", "-movflags +faststart (mp4/mov).", type="bool", default=True),
        Param("format", "-f, force a muxer/container.", type="str"),
        Param("extra_args", "List of raw ffmpeg args appended verbatim.", type="list"),
    )
    outputs = (
        Output("file", "Absolute path to the assembled file.", artifact=True),
        Output("duration", "Timeline duration in seconds (transitions overlap, so this is "
                           "less than the sum of the clips)."),
    )

    # -- parsing -------------------------------------------------------------

    def _probe(self, path: Path, ctx: StepContext) -> dict:
        """Probe a source; fall back to nominal values when it can't be read.

        A missing file is fatal in a real run and tolerated in a dry-run (where the
        point is to *print* the command a later run would execute)."""
        try:
            return media.probe(path)
        except (OSError, subprocess.CalledProcessError, ValueError, KeyError):
            if not ctx.dry_run:
                sys.exit(f"Error: cannot read clip: {path}")
            print(f"  [dry-run] {path} not probeable — assuming "
                  f"{_NOMINAL['width']}x{_NOMINAL['height']} @{_NOMINAL['fps']}, "
                  f"{_NOMINAL['duration']}s")
            return dict(_NOMINAL)

    def _clip_duration(self, entry: dict, info: dict, start: float, label: str) -> float:
        """Timeline length of one clip from its in/out points and the source length."""
        end, duration = entry.get("end"), entry.get("duration")
        if end is not None and duration is not None:
            raise ValueError(f"{label}: use only one of 'end' or 'duration'")
        if duration is not None:
            length = self.to_seconds(duration)
        elif end is not None:
            length = self.to_seconds(end) - start
        else:
            length = float(info.get("duration") or 0.0) - start
        if length <= 0:
            raise ValueError(
                f"{label}: empty clip (start={start:g}s, "
                f"source is {info.get('duration', 0):g}s) — check start/end/duration"
            )
        source = float(info.get("duration") or 0.0)
        if source and start + length > source + 0.001:
            length = source - start          # asked past the end: clamp to what exists
        return length

    def _parse_clips(self, params: dict, ctx: StepContext) -> list[_Clip]:
        raw = self.require(params, "clips")
        if not isinstance(raw, list) or not raw:
            raise ValueError("'clips' must be a non-empty list")
        default_transition = str(params.get("transition", CUT))
        default_tdur = float(params.get("transition_duration", 1.0) or 0.0)

        clips: list[_Clip] = []
        for i, item in enumerate(raw):
            label = f"clip #{i + 1}"
            entry = {"file": item} if isinstance(item, (str, Path)) else item
            if not isinstance(entry, dict):
                raise ValueError(f"{label}: must be a path string or a mapping with 'file'")
            if not entry.get("file"):
                raise ValueError(f"{label}: missing 'file'")

            path = Path(entry["file"])
            info = self._probe(path, ctx)
            start = self.to_seconds(entry.get("start", 0))
            duration = self._clip_duration(entry, info, start, label)
            if ctx.preview is not None:
                duration = min(duration, float(ctx.preview))

            transition = str(entry.get("transition", default_transition)).lower()
            if transition not in TRANSITIONS:
                raise ValueError(
                    f"{label}: unknown transition '{transition}' "
                    f"(use 'cut' or an xfade name: {', '.join(XFADE_TRANSITIONS)})"
                )
            if i == 0 and transition != CUT:
                print(f"  note: {label} is first, so its transition "
                      f"('{transition}') has nothing to join — ignored")
                transition = CUT

            tdur = float(entry.get("transition_duration", default_tdur) or 0.0)
            if transition != CUT and tdur <= 0:
                raise ValueError(f"{label}: transition '{transition}' needs a "
                                 "transition_duration greater than 0")

            clips.append(_Clip(
                index=i,
                file=path,
                start=start,
                duration=duration,
                transition=transition,
                transition_duration=tdur,
                fade_in=self.to_seconds(entry.get("fade_in", 0)),
                fade_out=self.to_seconds(entry.get("fade_out", 0)),
                volume=(float(entry["volume"]) if entry.get("volume") is not None else None),
                has_audio=bool(info.get("has_audio")),
                info=info,
            ))
        return clips

    # -- filter graph --------------------------------------------------------

    def _canvas(self, params: dict, clips: list[_Clip]) -> tuple[int, int, str]:
        """Target geometry: explicit params win, else the first clip's own."""
        first = clips[0].info
        width = int(params.get("width") or first.get("width") or _NOMINAL["width"])
        height = int(params.get("height") or first.get("height") or _NOMINAL["height"])
        fps = params.get("fps") or f"{first.get('fps') or _NOMINAL['fps']:.6g}"
        return width, height, str(fps)

    def _fit_filters(self, fit: str, width: int, height: int) -> list[str]:
        if fit == "stretch":
            return [f"scale={width}:{height}"]
        if fit == "cover":
            return [f"scale={width}:{height}:force_original_aspect_ratio=increase",
                    f"crop={width}:{height}"]
        return [f"scale={width}:{height}:force_original_aspect_ratio=decrease",
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"]

    def _video_chain(self, clip: _Clip, params: dict, width: int, height: int,
                     fps: str) -> str:
        """Normalise one clip's video onto the canvas (+ its own fades)."""
        chain = ["setpts=PTS-STARTPTS"]
        chain += self._fit_filters(str(params.get("fit", "contain")), width, height)
        # settb: xfade refuses inputs whose timebases differ, and `concat` hands on a
        # microsecond timebase while a raw clip carries 1/fps — pin both to AVTB.
        chain += [f"fps={fps}", "setsar=1", "settb=AVTB",
                  f"format={params.get('pix_fmt') or 'yuv420p'}"]
        color = params.get("fade_color", "black")
        if clip.fade_in > 0:
            chain.append(f"fade=t=in:st=0:d={clip.fade_in:g}:color={color}")
        if clip.fade_out > 0:
            start = max(0.0, clip.duration - clip.fade_out)
            chain.append(f"fade=t=out:st={start:g}:d={clip.fade_out:g}:color={color}")
        return f"[{clip.index}:v]" + ",".join(chain) + f"[v{clip.index}]"

    def _audio_chain(self, clip: _Clip, params: dict) -> str:
        """Normalise one clip's audio — or synthesise silence when it has none."""
        aformat = f"aformat=sample_rates={_AUDIO_RATE}:channel_layouts={_AUDIO_LAYOUT}"
        if clip.has_audio:
            head = f"[{clip.index}:a]"
            chain = ["asetpts=PTS-STARTPTS", aformat]
        else:
            # A filter-source chain: no input label, silence generated in place.
            head = ""
            chain = [f"anullsrc=channel_layout={_AUDIO_LAYOUT}:sample_rate={_AUDIO_RATE}",
                     f"atrim=duration={clip.duration:g}", "asetpts=PTS-STARTPTS"]
        if clip.volume is not None:
            chain.append(f"volume={clip.volume:g}")
        if self.as_bool(params.get("audio_fade"), default=True):
            if clip.fade_in > 0:
                chain.append(f"afade=t=in:st=0:d={clip.fade_in:g}")
            if clip.fade_out > 0:
                start = max(0.0, clip.duration - clip.fade_out)
                chain.append(f"afade=t=out:st={start:g}:d={clip.fade_out:g}")
        return head + ",".join(chain) + f"[a{clip.index}]"

    def _joins(self, clips: list[_Clip], with_audio: bool,
               ctx: StepContext) -> tuple[list[str], str, str, float]:
        """Chain the normalised clips together, returning (filters, vlabel, alabel, duration).

        ``xfade`` needs the *offset into the accumulated timeline* at which the
        overlap starts, so the running length is tracked as we go: a cut adds the
        whole clip, a transition adds it minus the overlap.
        """
        filters: list[str] = []
        vlabel, alabel = f"v{clips[0].index}", f"a{clips[0].index}"
        running = clips[0].duration

        for clip in clips[1:]:
            i = clip.index
            if clip.transition == CUT:
                filters.append(f"[{vlabel}][v{i}]concat=n=2:v=1:a=0[vc{i}]")
                if with_audio:
                    filters.append(f"[{alabel}][a{i}]concat=n=2:v=0:a=1[ac{i}]")
                vlabel, alabel = f"vc{i}", f"ac{i}"
                running += clip.duration
                continue

            tdur = self._transition_duration(clip, running, ctx)
            offset = running - tdur
            filters.append(
                f"[{vlabel}][v{i}]xfade=transition={clip.transition}:"
                f"duration={tdur:g}:offset={offset:g}[vx{i}]"
            )
            if with_audio:
                filters.append(f"[{alabel}][a{i}]acrossfade=d={tdur:g}:c1=tri:c2=tri[ax{i}]")
            vlabel, alabel = f"vx{i}", f"ax{i}"
            running += clip.duration - tdur

        return filters, vlabel, alabel, running

    def _transition_duration(self, clip: _Clip, running: float, ctx: StepContext) -> float:
        """A transition overlaps two clips, so it can't outlast either of them.

        In a real run that's a plan error worth reporting. Under ``--preview`` the
        clips are artificially short, so the transition is clamped instead — the
        point of a preview is to see every join, not to fail on one."""
        headroom = min(running, clip.duration)
        if clip.transition_duration < headroom:
            return clip.transition_duration
        if ctx.preview is not None:
            clamped = max(0.1, headroom / 2)
            print(f"  preview: clip #{clip.index + 1} transition "
                  f"{clip.transition_duration:g}s → {clamped:g}s (clips capped to {ctx.preview}s)")
            return clamped
        raise ValueError(
            f"clip #{clip.index + 1}: transition_duration {clip.transition_duration:g}s does not "
            f"fit — it must be shorter than both this clip ({clip.duration:g}s) and the timeline "
            f"before it ({running:g}s)"
        )

    # -- command building ----------------------------------------------------

    def _encode_args(self, params: dict, ctx: StepContext, vlabel: str, alabel: str | None,
                     *, to_stdout: bool) -> list[str]:
        args: list = ["-map", f"[{vlabel}]"]
        if alabel:
            args += ["-map", f"[{alabel}]"]

        for key, flag in (("vcodec", "-c:v"), ("acodec", "-c:a")):
            if str(params.get(key, "")).lower() == "copy":
                raise ValueError(f"concat re-encodes (filter graph); remove '{key}: copy'")

        args += ["-c:v", str(params.get("vcodec", "libx264"))]
        if params.get("video_bitrate"):
            args += ["-b:v", str(params["video_bitrate"])]
        elif params.get("crf") is not None:
            args += ["-crf", str(params["crf"])]
        if params.get("preset"):
            args += ["-preset", str(params["preset"])]

        if alabel:
            args += ["-c:a", str(params.get("acodec", "aac")),
                     "-b:a", str(params.get("audio_bitrate", "192k"))]
        else:
            args += ["-an"]

        fmt = params.get("format")
        if to_stdout:
            fmt = fmt or "mp4"
        if to_stdout and (fmt or "").lower() in ("mp4", "mov", "m4v", "3gp"):
            args += ["-movflags", "+frag_keyframe+empty_moov"]   # no seeking on a pipe
        elif self.as_bool(params.get("faststart"), default=True):
            args += ["-movflags", "+faststart"]
        if fmt:
            args += ["-f", str(fmt)]
        args += [str(a) for a in (params.get("extra_args") or [])]
        return args

    def _build(self, params: dict, ctx: StepContext, *, to_stdout: bool = False
               ) -> tuple[list, float, int]:
        """The whole ffmpeg argv minus its destination, plus (duration, clip count)."""
        clips = self._parse_clips(params, ctx)
        width, height, fps = self._canvas(params, clips)

        with_audio = not self.as_bool(params.get("no_audio"))
        if with_audio and not any(c.has_audio for c in clips):
            print("  no clip has an audio track — assembling video only")
            with_audio = False

        filters = [self._video_chain(c, params, width, height, fps) for c in clips]
        if with_audio:
            filters += [self._audio_chain(c, params) for c in clips]
        joins, vlabel, alabel, duration = self._joins(clips, with_audio, ctx)
        filters += joins

        cmd: list = ["ffmpeg", "-y"]
        for clip in clips:
            if clip.start > 0:
                cmd += ["-ss", f"{clip.start:g}"]
            cmd += ["-t", f"{clip.duration:g}", "-i", str(clip.file)]
        cmd += ["-filter_complex", ";".join(filters)]
        cmd += self._encode_args(params, ctx, vlabel, alabel if with_audio else None,
                                 to_stdout=to_stdout)

        print(f"  timeline: {len(clips)} clip(s) → {duration:g}s at {width}x{height}@{fps}")
        for clip in clips:
            join = "start" if clip.index == 0 else (
                "cut" if clip.transition == CUT
                else f"{clip.transition} {clip.transition_duration:g}s")
            print(f"    [{clip.index + 1}] {clip.file.name} "
                  f"{clip.start:g}s +{clip.duration:g}s  ({join})")
        return cmd, duration, len(clips)

    # -- standalone ----------------------------------------------------------

    def run(self, params: dict, ctx: StepContext) -> dict:
        output_name = self.require(params, "output")
        out = ctx.out_path(output_name)
        cmd, duration, _ = self._build(params, ctx)
        cmd += [str(out)]
        ctx.run(cmd)
        return {"file": str(out.resolve()), "duration": round(duration, 3)}

    # -- pipe stage ----------------------------------------------------------

    def command(self, params: dict, ctx: StepContext, *, upstream: dict | None = None,
                out: Path | None = None, is_last: bool = False) -> tuple[list, dict]:
        """`concat` reads its own inputs, so it can only be a pipe *source*."""
        if upstream is not None:
            raise ValueError(
                "action 'concat' reads its clips from files, so it can only be the FIRST "
                "stage of a pipe (it has no stdin to consume)"
            )
        cmd, _duration, _ = self._build(params, ctx, to_stdout=not is_last)
        if is_last:
            if out is None:
                raise ValueError("concat as the final pipe stage needs the pipe's 'output'")
            cmd += [str(out)]
            return cmd, {}                      # the pipe records `out` as its file
        cmd += ["pipe:1"]
        # Tell the next stage how to read our stdout (see `braw_decode`'s meta).
        fmt = str(params.get("format") or "mp4")
        return cmd, {"input_args": ["-f", fmt, "-i", "pipe:0"]}
