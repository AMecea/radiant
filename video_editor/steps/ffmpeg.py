"""ffmpeg step — a general-purpose transcode/convert built from basic parameters.

Unlike ``encode`` (which is specialised: sync-offset seek + audio replacement + braw
pipe), this is the plain ffmpeg escape hatch: one input, one output, and the common
knobs you reach for most (codec, quality, scale, fps, trim). For anything it doesn't
expose, drop raw flags into ``extra_args``.

Params (all optional except input/output):
  input         : source media path                          (required)
  output        : output filename (lands in the step dir)     (required)
  start         : -ss seek, e.g. "00:01:30" or 90             (placed before -i for fast seek)
  end           : -to end time                                (mutually exclusive with duration)
  duration      : -t, encode only this many seconds
  vcodec        : -c:v   (default libx264; use "copy" to stream-copy video)
  crf           : -crf   (quality, lower = better; emitted only when set)
  preset        : -preset (encoder speed/efficiency; emitted only when set)
  video_bitrate : -b:v   (e.g. "8M"; takes precedence over crf when set)
  acodec        : -c:a   (default aac; use "copy" to stream-copy audio)
  audio_bitrate : -b:a   (default 192k)
  no_audio      : -an, drop the audio track
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

    def run(self, params: dict, ctx: StepContext) -> dict:
        input_path = Path(self.require(params, "input"))
        output_name = self.require(params, "output")
        out = ctx.out_path(output_name)

        start = params.get("start")
        end = params.get("end")
        duration = params.get("duration")
        vcodec = params.get("vcodec", "libx264")
        crf = params.get("crf")
        preset = params.get("preset")
        video_bitrate = params.get("video_bitrate")
        acodec = params.get("acodec", "aac")
        audio_bitrate = params.get("audio_bitrate", "192k")
        no_audio = self.as_bool(params.get("no_audio"))
        fps = params.get("fps")
        scale = params.get("scale")
        vf = params.get("vf") or (f"scale={scale}" if scale else None)
        faststart = self.as_bool(params.get("faststart"), default=True)
        fmt = params.get("format")
        extra_args = params.get("extra_args") or []

        # Preview caps the output length and disables any plan-specified duration/end.
        if ctx.preview is not None:
            duration = ctx.preview
            end = None

        if not ctx.dry_run and not input_path.exists():
            sys.exit(f"Error: input file not found: {input_path}")

        cmd: list = ["ffmpeg", "-y"]
        if start is not None:
            cmd += ["-ss", str(start)]          # before -i: fast (keyframe) seek
        cmd += ["-i", str(input_path)]
        if end is not None:
            cmd += ["-to", str(end)]
        if duration is not None:
            cmd += ["-t", str(duration)]

        # Video
        if vcodec == "copy":
            cmd += ["-c:v", "copy"]
        else:
            cmd += ["-c:v", str(vcodec)]
            if video_bitrate:
                cmd += ["-b:v", str(video_bitrate)]
            elif crf is not None:
                cmd += ["-crf", str(crf)]
            if preset:
                cmd += ["-preset", str(preset)]
        if vf and vcodec != "copy":
            cmd += ["-vf", str(vf)]
        if fps is not None:
            cmd += ["-r", str(fps)]

        # Audio
        if no_audio:
            cmd += ["-an"]
        elif acodec == "copy":
            cmd += ["-c:a", "copy"]
        else:
            cmd += ["-c:a", str(acodec), "-b:a", str(audio_bitrate)]

        if faststart:
            cmd += ["-movflags", "+faststart"]
        if fmt:
            cmd += ["-f", str(fmt)]
        cmd += [str(a) for a in extra_args]
        cmd += [str(out)]

        span = []
        if start is not None:
            span.append(f"from {start}")
        if duration is not None:
            span.append(f"+{duration}s")
        elif end is not None:
            span.append(f"to {end}")
        print(f"  ffmpeg {' '.join(span) or 'full'} → {out}")

        ctx.run(cmd)
        return {"file": str(out.resolve())}
