"""encode step — seek to the sync offset, replace audio with the mic, re-encode.

Handles both standard containers (ffmpeg directly) and Blackmagic RAW
(``braw-decode | ffmpeg`` pipe, kept internal to this step).

Outputs:
  file : absolute path to the encoded mp4
"""

import subprocess
import sys
from pathlib import Path

from ..media import (
    BRAW_DECODE_BIN,
    SCALE_FILTER,
    braw_format_args,
    braw_fps,
    is_braw,
    video_codec_args,
)
from .base import Step, StepContext


def _audio_input(audio_path: Path, audio_trim: float) -> list[str]:
    return (["-ss", f"{audio_trim:.3f}"] if audio_trim > 0 else []) + ["-i", str(audio_path)]


def _common_output_args(hw: bool, crf: int, preset: str, bitrate: str, test_duration) -> list[str]:
    args = [
        "-map", "0:v",
        "-map", "1:a",
        *video_codec_args(hw, crf, preset, bitrate),
        "-pix_fmt", "yuv420p",
        "-vf", SCALE_FILTER,
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        "-shortest",
    ]
    if test_duration is not None:
        args += ["-t", str(int(test_duration))]
    return args


def _encode_standard(video, audio, out, offset, audio_trim, hw, crf, preset, bitrate, test_duration, ctx):
    cmd = [
        "ffmpeg", "-y",
        "-ss", f"{offset:.3f}",
        "-i", str(video),
        *_audio_input(audio, audio_trim),
        *_common_output_args(hw, crf, preset, bitrate, test_duration),
        str(out),
    ]
    ctx.run(cmd)


def _encode_braw(video, audio, out, offset, audio_trim, hw, crf, preset, bitrate, test_duration, braw_threads, braw_scale, ctx):
    fmt_args = braw_format_args(video)
    fps = braw_fps(fmt_args)
    start_frame = int(offset * fps)

    decode_cmd = [
        str(BRAW_DECODE_BIN), "--in", str(start_frame),
        "--threads", str(braw_threads),
        "--scale", str(braw_scale),
        str(video),
    ]
    ffmpeg_cmd = [
        "ffmpeg", "-y",
        *fmt_args,
        *_audio_input(audio, audio_trim),
        *_common_output_args(hw, crf, preset, bitrate, test_duration),
        str(out),
    ]
    print(f"  $ {' '.join(str(c) for c in decode_cmd)} | {' '.join(str(c) for c in ffmpeg_cmd)}")
    if ctx.dry_run:
        return

    decode_proc = subprocess.Popen(decode_cmd, stdout=subprocess.PIPE)
    ffmpeg_proc = subprocess.Popen(ffmpeg_cmd, stdin=decode_proc.stdout)
    decode_proc.stdout.close()  # let decode_proc receive SIGPIPE when ffmpeg exits
    ffmpeg_proc.wait()
    decode_proc.wait()

    # SIGPIPE (-13) from braw-decode is normal when -t / -shortest stops ffmpeg early
    if ffmpeg_proc.returncode != 0:
        sys.exit(f"ffmpeg failed with exit code {ffmpeg_proc.returncode}")
    if decode_proc.returncode not in (0, -13):
        sys.exit(f"braw-decode failed with exit code {decode_proc.returncode}")


class EncodeStep(Step):
    action = "encode"
    produces = ("file",)
    artifacts = ("file",)

    def run(self, params: dict, ctx: StepContext) -> dict:
        video = Path(self.require(params, "video"))
        audio = Path(self.require(params, "audio"))
        output_name = self.require(params, "output")
        out = ctx.out_path(output_name)

        offset = float(params.get("offset", 0.0) or 0.0)
        audio_trim = float(params.get("audio_trim", 0.0) or 0.0)
        hw = self.as_bool(params.get("hw"))
        crf = int(params.get("crf", 18))
        preset = params.get("preset", "slow")
        bitrate = params.get("video_bitrate", "8M")
        test_duration = params.get("test_duration")
        if ctx.preview is not None:
            test_duration = ctx.preview  # preview overrides any plan test_duration
        braw_threads = int(params.get("braw_threads", 2))
        braw_scale = int(params.get("braw_scale", 1))

        if not ctx.dry_run:
            if not video.exists():
                sys.exit(f"Error: video file not found: {video}")
            if not audio.exists():
                sys.exit(f"Error: audio file not found: {audio}")
            if is_braw(video) and not BRAW_DECODE_BIN.exists():
                sys.exit(f"Error: braw-decode not found at {BRAW_DECODE_BIN}")

        if test_duration is not None:
            print(f"  Test mode: encoding only {int(test_duration)}s")
        if hw:
            print(f"  Hardware encoder: VideoToolbox H.264 @ {bitrate}")
        else:
            print(f"  Software encoder: libx264 preset={preset} crf={crf}")
        print(f"  offset={offset:.3f}s  audio_trim={audio_trim:.3f}s  ->  {out}")

        if ctx.dry_run:
            print(f"  [dry-run] would {'pipe braw-decode → ffmpeg' if is_braw(video) else 'run ffmpeg'} → {out}")
            return {"file": str(out.resolve())}

        if is_braw(video):
            _encode_braw(video, audio, out, offset, audio_trim, hw, crf, preset, bitrate,
                         test_duration, braw_threads, braw_scale, ctx)
        else:
            _encode_standard(video, audio, out, offset, audio_trim, hw, crf, preset, bitrate,
                             test_duration, ctx)

        return {"file": str(out.resolve())}
