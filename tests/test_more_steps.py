"""The remaining steps' own logic: trim's required cut, braw_decode's start-frame
maths and pipe-only guards, upload's preview/dry-run behaviour, and the sync
offset itself.

Anything needing a real binary is either stubbed at the media-helper boundary or
skipped when the binary is absent.
"""

import shutil
import struct
import wave

import pytest

from radiant.steps.base import StepContext
from radiant.steps.braw_decode import BrawDecodeStep
from radiant.steps.trim import TrimStep
from radiant.steps.upload import UploadStep

ANALYSIS_SR = 8000


@pytest.fixture
def ctx(tmp_path):
    return StepContext(step_id="s", workdir=tmp_path)


@pytest.fixture
def dry_ctx(tmp_path):
    return StepContext(step_id="s", workdir=tmp_path, dry_run=True)


class TestTrim:
    def test_a_cut_is_mandatory(self, dry_ctx, tmp_path):
        src = tmp_path / "in.mp4"
        src.write_bytes(b"")
        with pytest.raises(ValueError, match="exactly one of 'include' or 'exclude'"):
            TrimStep().run({"input": str(src), "output": "out.mp4"}, dry_ctx)

    def test_it_never_seeks_before_the_input(self, dry_ctx, tmp_path, capsys):
        # -ss would shift the timeline the select expression is written against.
        src = tmp_path / "in.mp4"
        src.write_bytes(b"")
        TrimStep().run({"input": str(src), "output": "out.mp4",
                        "exclude": [{"start": 0, "end": 12}]}, dry_ctx)

        printed = capsys.readouterr().out
        assert "-ss" not in printed
        assert "select='not(between(t,0,12))'" in printed
        assert "aselect='not(between(t,0,12))'" in printed

    def test_it_reports_what_it_kept(self, dry_ctx, tmp_path, capsys):
        src = tmp_path / "in.mp4"
        src.write_bytes(b"")
        TrimStep().run({"input": str(src), "output": "out.mp4",
                        "include": [[0, 10], [20, 30]]}, dry_ctx)
        assert "trim (keep 2 range(s))" in capsys.readouterr().out

    def test_as_a_pipe_stage_the_cut_is_still_required(self, ctx):
        with pytest.raises(ValueError, match="exactly one of 'include' or 'exclude'"):
            TrimStep().command({"input": "x.mp4"}, ctx, is_last=False)


class TestBrawDecode:
    def test_it_cannot_run_standalone(self, ctx):
        with pytest.raises(ValueError, match="pipe-only source stage"):
            BrawDecodeStep().run({"video": "a.braw"}, ctx)

    def test_it_must_be_the_first_stage(self, ctx):
        with pytest.raises(ValueError, match="must be the first stage"):
            BrawDecodeStep().command({"video": "a.braw"}, ctx, upstream={"input_args": []})

    def test_dry_run_shows_placeholder_geometry_without_probing(self, dry_ctx):
        argv, meta = BrawDecodeStep().command(
            {"video": "/clips/a.braw", "threads": 10, "scale": 2}, dry_ctx)

        assert argv[1:] == ["--in", "0", "--threads", "10", "--scale", "2", "/clips/a.braw"]
        assert meta["input_args"][-2:] == ["-i", "pipe:0"]

    def test_the_offset_becomes_a_start_frame(self, ctx, tmp_path, monkeypatch):
        braw = tmp_path / "a.braw"
        braw.write_bytes(b"")
        monkeypatch.setattr("radiant.steps.braw_decode.BRAW_DECODE_BIN", tmp_path / "braw-decode")
        (tmp_path / "braw-decode").write_text("#!/bin/sh\n")
        monkeypatch.setattr(
            "radiant.steps.braw_decode.braw_format_args",
            lambda p: ["-f", "rawvideo", "-s", "4608x2592", "-r", "24.000000", "-i", "pipe:0"],
        )

        argv, meta = BrawDecodeStep().command({"video": str(braw), "offset": 722.5}, ctx)

        assert argv[1:3] == ["--in", str(int(722.5 * 24))]
        assert meta["input_args"][1] == "rawvideo"

    def test_a_non_braw_input_is_rejected(self, ctx, tmp_path):
        mp4 = tmp_path / "a.mp4"
        mp4.write_bytes(b"")
        with pytest.raises(SystemExit, match="not a .braw file"):
            BrawDecodeStep().command({"video": str(mp4)}, ctx)

    def test_a_missing_input_is_rejected(self, ctx, tmp_path):
        with pytest.raises(SystemExit, match="video file not found"):
            BrawDecodeStep().command({"video": str(tmp_path / "gone.braw")}, ctx)


class TestUpload:
    def test_preview_never_uploads(self, tmp_path, capsys):
        ctx = StepContext(step_id="up", workdir=tmp_path, preview=5)
        assert UploadStep().run({"file": "/nope.mp4", "remote": "gs:b/"}, ctx) == {"url": ""}
        assert "skipping upload" in capsys.readouterr().out

    def test_dry_run_reports_the_public_url_without_copying(self, dry_ctx, capsys):
        outputs = UploadStep().run(
            {"file": "/local/a.mp4", "remote": "gs:bucket/video/", "public": True}, dry_ctx)

        assert outputs == {"url": "https://storage.googleapis.com/bucket/video/a.mp4"}
        assert "[dry-run] $ rclone copy" in capsys.readouterr().out

    def test_a_private_upload_reports_the_remote(self, dry_ctx):
        outputs = UploadStep().run({"file": "/local/a.mp4", "remote": "gs:bucket/video/"}, dry_ctx)
        assert outputs == {"url": "gs:bucket/video/"}

    def test_a_missing_file_is_caught_before_rclone(self, ctx, tmp_path):
        with pytest.raises(SystemExit, match="file to upload not found"):
            UploadStep().run({"file": str(tmp_path / "gone.mp4"), "remote": "gs:b/"}, ctx)


def write_tone(path, seconds, sr=ANALYSIS_SR, lead_silence=0.0):
    """A short deterministic waveform: silence, then a distinctive chirp."""
    import math

    frames = []
    for i in range(int(sr * (seconds + lead_silence))):
        t = i / sr - lead_silence
        value = 0.0 if t < 0 else math.sin(2 * math.pi * (200 + 600 * t) * t)
        frames.append(struct.pack("<h", int(value * 20000)))
    with wave.open(str(path), "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(sr)
        fh.writeframes(b"".join(frames))


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="sync analysis shells out to ffmpeg")
class TestSyncOffset:
    """The offset is the value the whole pipeline hangs off, so check the maths
    against a known shift rather than trusting the cross-correlation blindly."""

    def _tracks(self, tmp_path, lead_silence):
        camera, mic = tmp_path / "cam.wav", tmp_path / "mic.wav"
        write_tone(camera, seconds=4, lead_silence=lead_silence)
        write_tone(mic, seconds=4)
        return camera, mic

    def test_it_finds_where_the_mic_starts_inside_the_camera_audio(self, tmp_path):
        from radiant.steps.sync import _find_offset

        camera, mic = self._tracks(tmp_path, lead_silence=1.5)
        assert _find_offset(camera, mic, duration=6) == pytest.approx(1.5, abs=0.01)

    def test_a_mic_that_leads_the_video_is_resolved_as_an_audio_trim(self, tmp_path):
        from radiant.steps.sync import SyncStep

        # Camera starts 1.5s *after* the mic → negative offset → trim the mic instead.
        camera, mic = self._tracks(tmp_path, lead_silence=0.0)
        write_tone(mic, seconds=4, lead_silence=1.5)
        ctx = StepContext(step_id="sync", workdir=tmp_path)

        outputs = SyncStep().run(
            {"video": str(camera), "audio": str(mic), "analysis_duration": 6}, ctx)

        assert outputs["offset"] == 0.0
        assert outputs["audio_trim"] == pytest.approx(1.5, abs=0.01)

    def test_dry_run_assumes_no_offset_rather_than_analysing(self, tmp_path):
        from radiant.steps.sync import SyncStep

        ctx = StepContext(step_id="sync", workdir=tmp_path, dry_run=True)
        assert SyncStep().run({"video": "/nope.braw", "audio": "/nope.wav"}, ctx) == {
            "offset": 0.0, "audio_trim": 0.0,
        }

    def test_missing_inputs_are_reported(self, tmp_path):
        from radiant.steps.sync import SyncStep

        ctx = StepContext(step_id="sync", workdir=tmp_path)
        with pytest.raises(SystemExit, match="video file not found"):
            SyncStep().run({"video": str(tmp_path / "no.mp4"), "audio": str(tmp_path / "no.wav")}, ctx)
