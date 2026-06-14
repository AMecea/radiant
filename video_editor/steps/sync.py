"""sync step — detect the time offset between camera audio and the speaker-mic.

Cross-correlates the first ``analysis_duration`` seconds of each track at a low
sample rate to find where the mic recording lines up with the camera audio.
"""

import subprocess
import sys
import tempfile
from pathlib import Path

from ..media import ANALYSIS_SR, is_braw
from .base import Output, Param, Step, StepContext


def _extract_audio_for_analysis(video_path: Path, out_path: Path, duration: int, start: float = 0.0) -> None:
    cmd = ["ffmpeg", "-y"]
    if start > 0:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-t", str(duration), "-i", str(video_path), "-ac", "1", "-ar", str(ANALYSIS_SR), "-vn", str(out_path)]
    print(f"  $ {' '.join(str(c) for c in cmd)}")
    subprocess.run(cmd, check=True, stderr=subprocess.DEVNULL)


def _extract_braw_audio_for_analysis(braw_path: Path, out_path: Path, duration: int, start: float = 0.0) -> bool:
    """Pull audio from a BRAW container via ffmpeg. Returns False if unreadable."""
    try:
        cmd = ["ffmpeg", "-y"]
        if start > 0:
            cmd += ["-ss", f"{start:.3f}"]
        cmd += ["-t", str(duration), "-i", str(braw_path), "-ac", "1", "-ar", str(ANALYSIS_SR), "-vn", str(out_path)]
        subprocess.run(cmd, check=True, stderr=subprocess.DEVNULL)
        return True
    except subprocess.CalledProcessError:
        return False


def _find_offset(video_audio_path: Path, ref_audio_path: Path, duration: int) -> float:
    """Return time offset (seconds) where ref_audio starts within video_audio."""
    import librosa
    import numpy as np
    from scipy.signal import correlate

    print(f"  Loading up to {duration}s of each audio track at {ANALYSIS_SR} Hz...")
    v, _ = librosa.load(str(video_audio_path), sr=ANALYSIS_SR, mono=True, duration=duration)
    r, _ = librosa.load(str(ref_audio_path), sr=ANALYSIS_SR, mono=True, duration=duration)

    v = v / (np.max(np.abs(v)) + 1e-10)
    r = r / (np.max(np.abs(r)) + 1e-10)

    corr = correlate(v, r, mode="full", method="fft")
    offset_samples = int(np.argmax(corr)) - (len(r) - 1)
    return offset_samples / ANALYSIS_SR


class SyncStep(Step):
    action = "sync"
    summary = "Detect the time offset between camera audio and the speaker-mic."
    params = (
        Param("video", "Camera video (or BRAW) whose audio is the reference track.",
              type="path", required=True),
        Param("audio", "Speaker-mic recording to align against the video.",
              type="path", required=True),
        Param("analysis_duration", "Seconds of each track to analyse (longer = more robust, slower).",
              type="int", default=600),
    )
    outputs = (
        Output("offset", "Seconds to seek the video forward so it lines up with the mic (>= 0)."),
        Output("audio_trim", "Seconds to trim off the START of the mic audio when it leads the video."),
    )

    def run(self, params: dict, ctx: StepContext) -> dict:
        video = Path(self.require(params, "video"))
        audio = Path(self.require(params, "audio"))
        analysis_duration = int(params.get("analysis_duration", 600))

        if ctx.dry_run:
            print("  [dry-run] would cross-correlate audio; assuming offset=0")
            return {"offset": 0.0, "audio_trim": 0.0}

        if not video.exists():
            sys.exit(f"Error: video file not found: {video}")
        if not audio.exists():
            sys.exit(f"Error: audio file not found: {audio}")

        print(f"  Extracting first {analysis_duration}s of video audio for sync analysis...")
        tmp_path = ctx.step_dir / "video_audio.wav"
        if is_braw(video):
            ok = _extract_braw_audio_for_analysis(video, tmp_path, analysis_duration)
            if not ok:
                sys.exit(
                    "Error: ffmpeg could not read audio from the BRAW file.\n"
                    "  Auto-sync is unavailable. Set 'offset' explicitly in the plan."
                )
        else:
            _extract_audio_for_analysis(video, tmp_path, analysis_duration)

        print("  Computing sync offset via cross-correlation...")
        offset = _find_offset(tmp_path, audio, analysis_duration)
        print(f"  Detected offset: {offset:.3f}s")

        # Resolve negative offset: audio leads video by abs(offset) seconds.
        # Trim that many seconds from the start of the audio instead of seeking the video.
        audio_trim = 0.0
        if offset < -30:
            sys.exit(
                f"Error: offset {offset:.3f}s is beyond -30s — detection is unreliable.\n"
                "  Set 'offset' / 'audio_trim' explicitly in the plan."
            )
        elif offset < 0:
            audio_trim = -offset
            print(f"  Audio leads video by {audio_trim:.3f}s — trimming audio start by {audio_trim:.3f}s.")
            offset = 0.0

        return {"offset": round(offset, 6), "audio_trim": round(audio_trim, 6)}
