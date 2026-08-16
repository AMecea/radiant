"""ffmpeg argv construction — the part that decides what actually gets encoded.

Nothing here spawns ffmpeg; it asserts on the command that would be run.
"""

from pathlib import Path

import pytest

from radiant.steps.base import StepContext
from radiant.steps.ffmpeg import FfmpegStep


@pytest.fixture
def step():
    return FfmpegStep()


@pytest.fixture
def ctx(tmp_path):
    return StepContext(step_id="enc", workdir=tmp_path)


def args_after(argv, flag):
    """The value following `flag` in an argv list."""
    return argv[argv.index(flag) + 1]


class TestToSeconds:
    @pytest.mark.parametrize("value,expected", [
        (12, 12.0),
        (1.5, 1.5),
        ("90", 90.0),
        ("01:30", 90.0),
        ("00:18:51", 1131.0),
        ("00:18:51.20", 1131.2),
        ("1:00:00", 3600.0),
    ])
    def test_parses(self, step, value, expected):
        assert step._to_seconds(value) == expected


class TestCutBounds:
    def test_mapping_and_pair_forms_agree(self, step):
        assert step._cut_bounds({"start": 0, "end": 12}) == (0.0, 12.0)
        assert step._cut_bounds([0, 12]) == (0.0, 12.0)

    def test_clock_strings(self, step):
        assert step._cut_bounds({"start": "00:18:30", "end": "00:19:05"}) == (1110.0, 1145.0)

    def test_missing_bound(self, step):
        with pytest.raises(ValueError, match="needs both 'start' and 'end'"):
            step._cut_bounds({"start": 0})

    def test_wrong_shape(self, step):
        with pytest.raises(ValueError, match="mapping or an \\[start, end\\] pair"):
            step._cut_bounds("0-12")

    def test_end_before_start(self, step):
        with pytest.raises(ValueError, match="must be after start"):
            step._cut_bounds({"start": 12, "end": 5})


class TestSelectExpression:
    def test_absent_when_neither_is_set(self, step):
        assert step._select_expr({}) is None

    def test_include_keeps_any_matching_range(self, step):
        expr = step._select_expr({"include": [{"start": 0, "end": 12}, {"start": 30, "end": 40}]})
        assert expr == "between(t,0,12)+between(t,30,40)"

    def test_exclude_drops_every_matching_range(self, step):
        expr = step._select_expr({"exclude": [{"start": 0, "end": 12}]})
        assert expr == "not(between(t,0,12))"

    def test_both_at_once_is_rejected(self, step):
        with pytest.raises(ValueError, match="only one of 'include' or 'exclude'"):
            step._select_expr({"include": [[0, 1]], "exclude": [[2, 3]]})

    def test_empty_list_is_rejected(self, step):
        with pytest.raises(ValueError, match="non-empty list"):
            step._select_expr({"include": []})


class TestOutputArgs:
    def test_defaults(self, step, ctx):
        args = step._output_args({}, ctx, has_audio=False)
        assert args == ["-c:v", "libx264", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]

    def test_stream_copy(self, step, ctx):
        args = step._output_args({"vcodec": "copy", "acodec": "copy"}, ctx, has_audio=False)
        assert "-c:v" in args and args_after(args, "-c:v") == "copy"
        assert args_after(args, "-c:a") == "copy"
        assert "-b:a" not in args

    def test_bitrate_beats_crf(self, step, ctx):
        args = step._output_args({"crf": 18, "video_bitrate": "8M"}, ctx, has_audio=False)
        assert args_after(args, "-b:v") == "8M"
        assert "-crf" not in args

    def test_crf_and_preset(self, step, ctx):
        args = step._output_args({"crf": 18, "preset": "slow"}, ctx, has_audio=False)
        assert args_after(args, "-crf") == "18"
        assert args_after(args, "-preset") == "slow"

    def test_scale_becomes_a_filter_and_vf_overrides_it(self, step, ctx):
        assert args_after(step._output_args({"scale": "-2:720"}, ctx, has_audio=False), "-vf") == "scale=-2:720"
        args = step._output_args({"scale": "-2:720", "vf": "hflip"}, ctx, has_audio=False)
        assert args_after(args, "-vf") == "hflip"

    def test_no_audio(self, step, ctx):
        args = step._output_args({"no_audio": True}, ctx, has_audio=False)
        assert "-an" in args and "-c:a" not in args

    def test_audio_input_is_mapped_and_shortest_by_default(self, step, ctx):
        args = step._output_args({}, ctx, has_audio=True)
        assert args[:4] == ["-map", "0:v", "-map", "1:a"]
        assert "-shortest" in args

    def test_shortest_can_be_turned_off(self, step, ctx):
        assert "-shortest" not in step._output_args({"shortest": False}, ctx, has_audio=True)

    def test_faststart_can_be_turned_off(self, step, ctx):
        assert "-movflags" not in step._output_args({"faststart": False}, ctx, has_audio=False)

    def test_extra_args_are_appended_verbatim(self, step, ctx):
        args = step._output_args({"extra_args": ["-allow_sw", 1]}, ctx, has_audio=False)
        assert args[-2:] == ["-allow_sw", "1"]

    def test_duration_wins_over_end(self, step, ctx):
        args = step._output_args({"end": "00:10:00", "duration": 30}, ctx, has_audio=False)
        assert args_after(args, "-t") == "30"
        assert "-to" not in args

    def test_end_is_emitted_when_there_is_no_duration(self, step, ctx):
        args = step._output_args({"end": "00:10:00"}, ctx, has_audio=False)
        assert args_after(args, "-to") == "00:10:00"

    def test_preview_caps_the_encode(self, step, tmp_path):
        ctx = StepContext(step_id="enc", workdir=tmp_path, preview=5)
        args = step._output_args({"end": "00:10:00", "duration": 600}, ctx, has_audio=False)
        assert args_after(args, "-t") == "5"
        assert "-to" not in args

    def test_a_cut_prepends_select_and_appends_aselect(self, step, ctx):
        args = step._output_args({"exclude": [{"start": 0, "end": 12}], "vf": "hflip"},
                                 ctx, has_audio=False)
        assert args_after(args, "-vf") == "select='not(between(t,0,12))',setpts=N/FRAME_RATE/TB,hflip"
        assert args_after(args, "-af") == "aselect='not(between(t,0,12))',asetpts=N/SR/TB"

    def test_a_cut_without_audio_skips_the_aselect(self, step, ctx):
        args = step._output_args({"include": [[0, 10]], "no_audio": True}, ctx, has_audio=False)
        assert "-af" not in args

    def test_a_cut_cannot_stream_copy(self, step, ctx):
        with pytest.raises(ValueError, match="remove 'vcodec: copy'"):
            step._output_args({"include": [[0, 10]], "vcodec": "copy"}, ctx, has_audio=False)
        with pytest.raises(ValueError, match="remove 'acodec: copy'"):
            step._output_args({"include": [[0, 10]], "acodec": "copy"}, ctx, has_audio=False)

    def test_streaming_to_stdout_fragments_mp4_instead_of_faststart(self, step, ctx):
        args = step._output_args({}, ctx, has_audio=False, to_stdout=True)
        assert args_after(args, "-movflags") == "+frag_keyframe+empty_moov"
        assert args_after(args, "-f") == "mp4"
        assert "+faststart" not in args


class TestStandaloneRun:
    def test_builds_the_whole_command_and_reports_the_artifact(self, step, tmp_path, monkeypatch):
        src = tmp_path / "in.mp4"
        src.write_bytes(b"")
        ctx = StepContext(step_id="enc", workdir=tmp_path, dry_run=True)

        outputs = step.run({"input": str(src), "output": "out.mp4", "start": "00:00:05",
                            "scale": "-2:720"}, ctx)

        assert outputs == {"file": str((tmp_path / "enc" / "out.mp4").resolve())}

    def test_seek_goes_before_the_input(self, step, tmp_path, capsys):
        src = tmp_path / "in.mp4"
        src.write_bytes(b"")
        ctx = StepContext(step_id="enc", workdir=tmp_path, dry_run=True)

        step.run({"input": str(src), "output": "out.mp4", "start": "00:00:05"}, ctx)

        printed = capsys.readouterr().out
        assert f"-ss 00:00:05 -i {src}" in printed

    def test_a_missing_input_is_reported(self, step, tmp_path):
        ctx = StepContext(step_id="enc", workdir=tmp_path)
        with pytest.raises(SystemExit, match="input file not found"):
            step.run({"input": str(tmp_path / "nope.mp4"), "output": "out.mp4"}, ctx)

    def test_preview_prefixes_the_output_file(self, step, tmp_path):
        src = tmp_path / "in.mp4"
        src.write_bytes(b"")
        ctx = StepContext(step_id="enc", workdir=tmp_path, dry_run=True, preview=5)

        outputs = step.run({"input": str(src), "output": "out.mp4"}, ctx)
        assert Path(outputs["file"]).name == "preview_out.mp4"


class TestPipeStage:
    def test_reads_an_upstream_stages_stdout(self, step, ctx):
        argv, meta = step.command(
            {"output": "m.mp4"}, ctx,
            upstream={"input_args": ["-f", "rawvideo", "-s", "1920x1080", "-i", "pipe:0"]},
            out=Path("/tmp/m.mp4"), is_last=True,
        )
        assert argv[:8] == ["ffmpeg", "-y", "-f", "rawvideo", "-s", "1920x1080", "-i", "pipe:0"]
        assert argv[-1] == "/tmp/m.mp4"

    def test_a_generic_upstream_names_its_own_format(self, step, ctx):
        argv, _ = step.command({"input_format": "matroska"}, ctx, upstream={},
                               out=Path("/tmp/m.mp4"), is_last=True)
        assert argv[2:6] == ["-f", "matroska", "-i", "pipe:0"]

    def test_the_audio_track_is_muxed_with_its_trim(self, step, ctx, tmp_path):
        audio = tmp_path / "mic.wav"
        audio.write_bytes(b"")
        argv, _ = step.command({"audio": str(audio), "audio_trim": 2.5}, ctx,
                               upstream={"input_args": ["-i", "pipe:0"]},
                               out=Path("/tmp/m.mp4"), is_last=True)

        seek = argv.index("-ss")
        assert argv[seek:seek + 4] == ["-ss", "2.500", "-i", str(audio)]
        assert argv[argv.index("-map") + 1] == "0:v"

    def test_a_non_final_stage_writes_to_stdout(self, step, ctx, tmp_path):
        src = tmp_path / "in.mp4"
        src.write_bytes(b"")
        argv, _ = step.command({"input": str(src)}, ctx, upstream=None, out=None, is_last=False)

        assert argv[-1] == "pipe:1"
        assert argv[argv.index("-movflags") + 1] == "+frag_keyframe+empty_moov"

    def test_a_final_stage_needs_somewhere_to_write(self, step, ctx):
        with pytest.raises(ValueError, match="needs an 'output'"):
            step.command({}, ctx, upstream={"input_args": ["-i", "pipe:0"]}, out=None, is_last=True)
