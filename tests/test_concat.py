"""concat — the timeline assembler: filter graph construction and join arithmetic.

Nothing here spawns ffmpeg or ffprobe: `probed` fakes the one thing concat needs
from the sources (geometry, duration, audio presence), and the tests assert on the
`-filter_complex` graph that would be run.
"""

from pathlib import Path

import pytest

from radiant.steps.base import StepContext
from radiant.steps.concat import ConcatStep


@pytest.fixture
def step():
    return ConcatStep()


@pytest.fixture
def ctx(tmp_path):
    return StepContext(step_id="film", workdir=tmp_path)


@pytest.fixture
def probed(monkeypatch):
    """Stub ffprobe: every clip is 1920x1080 @30 with audio, and `seconds` long.

    Call with per-file overrides, e.g. ``probed(10.0, {"silent.mp4": {"has_audio": False}})``.
    """

    def _install(seconds: float = 10.0, overrides: dict | None = None):
        def fake_probe(path):
            info = {"width": 1920, "height": 1080, "fps": 30.0,
                    "duration": seconds, "has_audio": True}
            info.update((overrides or {}).get(Path(path).name, {}))
            return info

        monkeypatch.setattr("radiant.media.probe", fake_probe)

    return _install


def graph(step, params, ctx):
    """The -filter_complex value of the command concat would run."""
    cmd, _duration, _n = step._build(params, ctx)
    return cmd[cmd.index("-filter_complex") + 1]


def duration_of(step, params, ctx):
    return step._build(params, ctx)[1]


def clips(*names, **common):
    return [{"file": f"/src/{n}", **common} for n in names]


class TestClipParsing:
    def test_a_bare_path_is_a_whole_clip(self, step, ctx, probed):
        probed(7.5)
        parsed = step._parse_clips({"clips": ["/src/a.mp4"]}, ctx)
        assert (parsed[0].file, parsed[0].start, parsed[0].duration) == (Path("/src/a.mp4"), 0.0, 7.5)

    def test_in_and_out_points_accept_clock_strings(self, step, ctx, probed):
        probed(600.0)
        parsed = step._parse_clips({"clips": [{"file": "/src/a.mp4", "start": "01:00", "end": "01:30"}]}, ctx)
        assert (parsed[0].start, parsed[0].duration) == (60.0, 30.0)

    def test_duration_is_an_alternative_to_end(self, step, ctx, probed):
        probed(600.0)
        parsed = step._parse_clips({"clips": [{"file": "/src/a.mp4", "start": 10, "duration": 25}]}, ctx)
        assert parsed[0].duration == 25.0

    def test_end_and_duration_together_are_rejected(self, step, ctx, probed):
        probed()
        with pytest.raises(ValueError, match="only one of 'end' or 'duration'"):
            step._parse_clips({"clips": [{"file": "/src/a.mp4", "end": 5, "duration": 5}]}, ctx)

    def test_an_out_point_past_the_source_is_clamped(self, step, ctx, probed):
        probed(10.0)
        parsed = step._parse_clips({"clips": [{"file": "/src/a.mp4", "start": 6, "duration": 30}]}, ctx)
        assert parsed[0].duration == 4.0

    def test_an_in_point_past_the_source_is_rejected(self, step, ctx, probed):
        probed(10.0)
        with pytest.raises(ValueError, match="empty clip"):
            step._parse_clips({"clips": [{"file": "/src/a.mp4", "start": 12}]}, ctx)

    def test_an_empty_clip_list_is_rejected(self, step, ctx, probed):
        probed()
        with pytest.raises(ValueError, match="non-empty list"):
            step._parse_clips({"clips": []}, ctx)

    def test_a_clip_without_a_file_is_rejected(self, step, ctx, probed):
        probed()
        with pytest.raises(ValueError, match="missing 'file'"):
            step._parse_clips({"clips": [{"start": 0}]}, ctx)

    def test_an_unknown_transition_lists_the_real_ones(self, step, ctx, probed):
        probed()
        with pytest.raises(ValueError, match="unknown transition 'swoosh'"):
            step._parse_clips({"clips": clips("a.mp4", "b.mp4"), "transition": "swoosh"}, ctx)

    def test_the_first_clips_transition_is_dropped(self, step, ctx, probed):
        probed()
        parsed = step._parse_clips({"clips": clips("a.mp4", "b.mp4"), "transition": "fade"}, ctx)
        assert parsed[0].transition == "cut"
        assert parsed[1].transition == "fade"

    def test_a_transition_needs_a_duration(self, step, ctx, probed):
        probed()
        with pytest.raises(ValueError, match="needs a transition_duration"):
            step._parse_clips({"clips": clips("a.mp4", "b.mp4"),
                               "transition": "fade", "transition_duration": 0}, ctx)


class TestJoins:
    def test_a_cut_concatenates_video_and_audio(self, step, ctx, probed):
        probed(5.0)
        g = graph(step, {"clips": clips("a.mp4", "b.mp4")}, ctx)
        assert "[v0][v1]concat=n=2:v=1:a=0[vc1]" in g
        assert "[a0][a1]concat=n=2:v=0:a=1[ac1]" in g
        assert "xfade" not in g

    def test_a_transition_crossfades_both_tracks(self, step, ctx, probed):
        probed(5.0)
        g = graph(step, {"clips": clips("a.mp4", "b.mp4"),
                         "transition": "wipeleft", "transition_duration": 1}, ctx)
        assert "[v0][v1]xfade=transition=wipeleft:duration=1:offset=4[vx1]" in g
        assert "[a0][a1]acrossfade=d=1:c1=tri:c2=tri[ax1]" in g

    def test_the_xfade_offset_follows_the_shortened_timeline(self, step, ctx, probed):
        # 5s clips, 1s transitions: the timeline is 5, then 9, then 13 — so the
        # second transition starts at 9-1=8, not at 10.
        probed(5.0)
        g = graph(step, {"clips": clips("a.mp4", "b.mp4", "c.mp4"),
                         "transition": "fade", "transition_duration": 1}, ctx)
        assert "offset=4[vx1]" in g
        assert "[vx1][v2]xfade=transition=fade:duration=1:offset=8[vx2]" in g

    def test_transitions_shorten_the_timeline_but_cuts_do_not(self, step, ctx, probed):
        probed(5.0)
        three = clips("a.mp4", "b.mp4", "c.mp4")
        assert duration_of(step, {"clips": three}, ctx) == 15.0
        assert duration_of(step, {"clips": three, "transition": "fade",
                                  "transition_duration": 1}, ctx) == 13.0

    def test_per_clip_transitions_override_the_default(self, step, ctx, probed):
        probed(5.0)
        g = graph(step, {"clips": [{"file": "/src/a.mp4"},
                                   {"file": "/src/b.mp4", "transition": "cut"},
                                   {"file": "/src/c.mp4", "transition": "dissolve"}],
                         "transition": "fade", "transition_duration": 1}, ctx)
        assert "[v0][v1]concat=n=2:v=1:a=0[vc1]" in g
        assert "[vc1][v2]xfade=transition=dissolve:duration=1:offset=9[vx2]" in g

    def test_a_transition_longer_than_its_clips_is_rejected(self, step, ctx, probed):
        probed(5.0)
        with pytest.raises(ValueError, match="does not fit"):
            graph(step, {"clips": clips("a.mp4", "b.mp4"),
                         "transition": "fade", "transition_duration": 6}, ctx)

    def test_a_single_clip_needs_no_joins(self, step, ctx, probed):
        probed(5.0)
        cmd, duration, _ = step._build({"clips": ["/src/a.mp4"]}, ctx)
        assert duration == 5.0
        assert cmd[cmd.index("-map") + 1] == "[v0]"


class TestNormalisation:
    def test_clips_are_fitted_to_the_canvas_and_a_common_timebase(self, step, ctx, probed):
        probed(5.0)
        g = graph(step, {"clips": clips("a.mp4", "b.mp4"), "width": 1280, "height": 720,
                         "fps": 25}, ctx)
        assert ("[0:v]setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,"
                "pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=25,setsar=1,settb=AVTB,format=yuv420p[v0]") in g

    def test_the_canvas_defaults_to_the_first_clip(self, step, ctx, probed):
        probed(5.0, {"a.mp4": {"width": 1280, "height": 720, "fps": 25.0}})
        g = graph(step, {"clips": clips("a.mp4", "b.mp4")}, ctx)
        assert "scale=1280:720" in g and "fps=25" in g

    def test_cover_crops_instead_of_padding(self, step, ctx, probed):
        probed(5.0)
        g = graph(step, {"clips": clips("a.mp4"), "fit": "cover",
                         "width": 1080, "height": 1920}, ctx)
        assert "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" in g
        assert "pad=" not in g

    def test_stretch_just_scales(self, step, ctx, probed):
        probed(5.0)
        g = graph(step, {"clips": clips("a.mp4"), "fit": "stretch",
                         "width": 640, "height": 480}, ctx)
        assert "scale=640:480," in g and "pad=" not in g and "crop=" not in g

    def test_a_silent_source_gets_generated_silence(self, step, ctx, probed):
        probed(5.0, {"b.mp4": {"has_audio": False}})
        g = graph(step, {"clips": clips("a.mp4", "b.mp4")}, ctx)
        assert "[1:a]" not in g
        assert ("anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=5,"
                "asetpts=PTS-STARTPTS[a1]") in g

    def test_an_all_silent_timeline_drops_audio_entirely(self, step, ctx, probed):
        probed(5.0, {"a.mp4": {"has_audio": False}, "b.mp4": {"has_audio": False}})
        cmd, _d, _n = step._build({"clips": clips("a.mp4", "b.mp4")}, ctx)
        assert "-an" in cmd and "anullsrc" not in cmd[cmd.index("-filter_complex") + 1]

    def test_no_audio_skips_the_audio_graph(self, step, ctx, probed):
        probed(5.0)
        cmd, _d, _n = step._build({"clips": clips("a.mp4", "b.mp4"), "no_audio": True}, ctx)
        assert "-an" in cmd
        assert "[0:a]" not in cmd[cmd.index("-filter_complex") + 1]


class TestFadesAndLevels:
    def test_fades_hit_both_tracks_at_the_clips_own_edges(self, step, ctx, probed):
        probed(8.0)
        g = graph(step, {"clips": [{"file": "/src/a.mp4", "fade_in": 1, "fade_out": 2}]}, ctx)
        assert "fade=t=in:st=0:d=1:color=black" in g
        assert "fade=t=out:st=6:d=2:color=black" in g
        assert "afade=t=in:st=0:d=1" in g
        assert "afade=t=out:st=6:d=2" in g

    def test_audio_fades_can_be_turned_off(self, step, ctx, probed):
        probed(8.0)
        g = graph(step, {"clips": [{"file": "/src/a.mp4", "fade_in": 1}], "audio_fade": False}, ctx)
        assert "fade=t=in" in g and "afade" not in g

    def test_the_fade_colour_is_configurable(self, step, ctx, probed):
        probed(8.0)
        g = graph(step, {"clips": [{"file": "/src/a.mp4", "fade_out": 1}], "fade_color": "white"}, ctx)
        assert "fade=t=out:st=7:d=1:color=white" in g

    def test_volume_scales_one_clips_audio(self, step, ctx, probed):
        probed(5.0)
        g = graph(step, {"clips": [{"file": "/src/a.mp4", "volume": 0.25}]}, ctx)
        assert "volume=0.25" in g


class TestCommandShape:
    def test_in_points_become_input_seeks(self, step, ctx, probed):
        probed(60.0)
        cmd, _d, _n = step._build({"clips": [{"file": "/src/a.mp4", "start": 12, "duration": 5},
                                             {"file": "/src/b.mp4", "duration": 7}]}, ctx)
        assert cmd[:9] == ["ffmpeg", "-y", "-ss", "12", "-t", "5", "-i", "/src/a.mp4", "-t"]
        assert cmd[9:12] == ["7", "-i", "/src/b.mp4"]

    def test_codec_knobs_reach_the_output(self, step, ctx, probed):
        probed(5.0)
        cmd, _d, _n = step._build({"clips": clips("a.mp4"), "crf": 20, "preset": "slow",
                                   "acodec": "libopus", "audio_bitrate": "128k"}, ctx)
        assert cmd[cmd.index("-crf") + 1] == "20"
        assert cmd[cmd.index("-preset") + 1] == "slow"
        assert cmd[cmd.index("-c:a") + 1] == "libopus"
        assert cmd[cmd.index("-movflags") + 1] == "+faststart"

    def test_stream_copy_is_rejected(self, step, ctx, probed):
        probed(5.0)
        with pytest.raises(ValueError, match="remove 'vcodec: copy'"):
            step._build({"clips": clips("a.mp4"), "vcodec": "copy"}, ctx)

    def test_run_reports_the_file_and_the_timeline_length(self, step, tmp_path, probed):
        probed(5.0)
        ctx = StepContext(step_id="film", workdir=tmp_path, dry_run=True)
        outputs = step.run({"clips": clips("a.mp4", "b.mp4"), "output": "film.mp4"}, ctx)
        assert outputs == {"file": str((tmp_path / "film" / "film.mp4").resolve()), "duration": 10.0}


class TestPreview:
    def test_every_clip_is_capped_so_all_joins_are_visible(self, step, tmp_path, probed):
        probed(120.0)
        ctx = StepContext(step_id="film", workdir=tmp_path, preview=3)
        _cmd, duration, _n = step._build({"clips": clips("a.mp4", "b.mp4", "c.mp4")}, ctx)
        assert duration == 9.0

    def test_a_transition_that_no_longer_fits_is_clamped_not_fatal(self, step, tmp_path, probed):
        probed(120.0)
        ctx = StepContext(step_id="film", workdir=tmp_path, preview=2)
        g = graph(step, {"clips": clips("a.mp4", "b.mp4"),
                         "transition": "fade", "transition_duration": 5}, ctx)
        assert "duration=1:offset=1[vx1]" in g       # clamped to half the headroom

    def test_the_output_is_preview_prefixed(self, step, tmp_path, probed):
        probed(30.0)
        ctx = StepContext(step_id="film", workdir=tmp_path, dry_run=True, preview=3)
        outputs = step.run({"clips": clips("a.mp4"), "output": "film.mp4"}, ctx)
        assert Path(outputs["file"]).name == "preview_film.mp4"


class TestPipeStage:
    def test_as_a_source_it_streams_a_fragmented_container(self, step, ctx, probed):
        probed(5.0)
        argv, meta = step.command({"clips": clips("a.mp4", "b.mp4")}, ctx,
                                  upstream=None, out=None, is_last=False)
        assert argv[-1] == "pipe:1"
        assert argv[argv.index("-movflags") + 1] == "+frag_keyframe+empty_moov"
        assert meta["input_args"] == ["-f", "mp4", "-i", "pipe:0"]

    def test_as_a_sink_it_writes_the_pipes_output(self, step, ctx, probed):
        probed(5.0)
        argv, meta = step.command({"clips": clips("a.mp4")}, ctx, upstream=None,
                                  out=Path("/tmp/film.mp4"), is_last=True)
        assert argv[-1] == "/tmp/film.mp4"
        assert meta == {}

    def test_it_cannot_consume_an_upstream_stage(self, step, ctx, probed):
        probed(5.0)
        with pytest.raises(ValueError, match="only be the FIRST stage"):
            step.command({"clips": clips("a.mp4")}, ctx,
                         upstream={"input_args": ["-i", "pipe:0"]}, out=None, is_last=False)
