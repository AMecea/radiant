"""The step contract itself (registry, declared specs, help), plus the small
steps that are cheap to run for real: `shell`, `pipe`, `pause`."""

import pytest

from radiant.help import render_action, render_index
from radiant.steps import (REGISTRY, artifacts_for, get_step, preview_safe,
                           produces_for, required_params_for)
from radiant.steps.base import PauseSignal, Step, StepContext
from radiant.steps.pause import PauseStep
from radiant.steps.pipe import PipeStep
from radiant.steps.shell import ShellStep

ACTIONS = sorted(REGISTRY)


@pytest.fixture
def ctx(tmp_path):
    return StepContext(step_id="s", workdir=tmp_path)


class TestRegistry:
    @pytest.mark.parametrize("action", ACTIONS)
    def test_each_action_declares_a_matching_name_and_summary(self, action):
        cls = REGISTRY[action]
        assert cls.action == action
        assert cls.summary

    @pytest.mark.parametrize("action", ACTIONS)
    def test_derived_views_come_from_the_declared_outputs(self, action):
        cls = REGISTRY[action]
        assert produces_for(action) == tuple(o.name for o in cls.outputs)
        assert set(artifacts_for(action)) <= set(produces_for(action))
        assert set(required_params_for(action)) <= {p.name for p in cls.params}

    @pytest.mark.parametrize("action", ACTIONS)
    def test_help_renders_for_every_action(self, action):
        text = render_action(action)
        assert action in text
        for param in REGISTRY[action].params:
            assert param.name in text

    def test_the_index_covers_every_action(self):
        index = render_index()
        assert all(action in index for action in ACTIONS)

    def test_unknown_actions_are_rejected_with_a_hint(self):
        with pytest.raises(KeyError, match="unknown action"):
            get_step("teleport")

        assert produces_for("teleport") == ()
        assert artifacts_for("teleport") == ()
        assert required_params_for("teleport") == ()

    def test_only_analysis_steps_opt_out_of_preview_truncation(self):
        assert preview_safe("sync") is True
        assert preview_safe("encode") is False
        assert preview_safe("clip") is False
        assert preview_safe("teleport") is False


class TestParamHelpers:
    def test_require_rejects_absent_and_null(self):
        assert Step.require({"a": 0}, "a") == 0
        with pytest.raises(ValueError, match="missing required parameter 'a'"):
            Step.require({}, "a")
        with pytest.raises(ValueError, match="missing required parameter 'a'"):
            Step.require({"a": None}, "a")

    @pytest.mark.parametrize("value,expected", [
        (True, True), (False, False),
        ("true", True), ("True", True), ("yes", True), ("on", True), ("1", True),
        ("false", False), ("no", False), ("", False), (0, False), (1, True),
    ])
    def test_as_bool(self, value, expected):
        assert Step.as_bool(value) is expected

    def test_as_bool_default_applies_only_to_none(self):
        assert Step.as_bool(None, default=True) is True
        assert Step.as_bool(None) is False


class TestStepContext:
    def test_step_dir_is_created_under_the_workdir(self, tmp_path):
        ctx = StepContext(step_id="reel", workdir=tmp_path)
        assert ctx.step_dir == tmp_path / "reel"
        assert ctx.step_dir.is_dir()

    def test_out_dir_overrides_the_step_dir(self, tmp_path):
        ctx = StepContext(step_id="reel", workdir=tmp_path, out_dir=tmp_path / "custom")
        assert ctx.out_path("a.mp4") == tmp_path / "custom" / "a.mp4"

    def test_preview_outputs_cannot_masquerade_as_the_real_artifact(self, tmp_path):
        ctx = StepContext(step_id="reel", workdir=tmp_path, preview=5)
        assert ctx.out_path("reel.mp4").name == "preview_reel.mp4"

    def test_dry_run_echoes_without_executing(self, tmp_path, capsys):
        ctx = StepContext(step_id="s", workdir=tmp_path, dry_run=True)
        assert ctx.run(["false"]) is None
        assert "$ false" in capsys.readouterr().out

    def test_a_step_that_cannot_be_piped_says_so(self, ctx):
        with pytest.raises(NotImplementedError, match="cannot be used as a `pipe` stage"):
            get_step("transcribe").command({}, ctx)


class TestShellStep:
    def test_runs_the_command_and_reports_the_artifact(self, ctx, tmp_path):
        outputs = ShellStep().run({"cmd": "echo hi > {output}", "output": "a.txt"}, ctx)

        assert outputs == {"file": str((tmp_path / "s" / "a.txt").resolve())}
        assert (tmp_path / "s" / "a.txt").read_text() == "hi\n"

    def test_a_command_without_an_output_produces_nothing(self, ctx):
        assert ShellStep().run({"cmd": "true"}, ctx) == {}

    def test_a_failing_command_exits_with_its_code_in_the_message(self, ctx):
        with pytest.raises(SystemExit, match="exit code 3"):
            ShellStep().run({"cmd": "exit 3"}, ctx)

    def test_the_output_placeholder_needs_an_output_name(self, ctx):
        with pytest.raises(ValueError, match="uses \\{output\\} but no 'output'"):
            ShellStep().run({"cmd": "cat > {output}"}, ctx)

    def test_dry_run_does_not_touch_the_filesystem(self, tmp_path):
        ctx = StepContext(step_id="s", workdir=tmp_path, dry_run=True)
        ShellStep().run({"cmd": "echo hi > {output}", "output": "a.txt"}, ctx)
        assert not (tmp_path / "s" / "a.txt").exists()

    def test_as_a_pipe_sink_it_reports_the_pipes_output(self, ctx, tmp_path):
        target = tmp_path / "m.zst"
        argv, meta = ShellStep().command({"cmd": "zstd -o {output} -"}, ctx,
                                         upstream={}, out=target, is_last=True)
        assert argv == ["sh", "-c", f"zstd -o {target} -"]
        assert meta == {"produces": {"file": str(target.resolve())}}

    def test_as_a_pipe_source_it_just_writes_stdout(self, ctx):
        argv, meta = ShellStep().command({"cmd": "curl -fsSL http://x/y"}, ctx, is_last=False)
        assert argv == ["sh", "-c", "curl -fsSL http://x/y"]
        assert meta == {}


class TestPipeStep:
    def test_stages_are_chained_and_the_sink_writes_the_output(self, ctx, tmp_path):
        outputs = PipeStep().run({
            "output": "out.txt",
            "stages": [
                {"action": "shell", "with": {"cmd": "printf 'a\\nb\\nc\\n'"}},
                {"action": "shell", "with": {"cmd": "grep -v b"}},
                {"action": "shell", "with": {"cmd": "cat > {output}"}},
            ],
        }, ctx)

        out = tmp_path / "s" / "out.txt"
        assert outputs == {"file": str(out.resolve())}
        assert out.read_text() == "a\nc\n"

    def test_a_failing_sink_fails_the_pipe(self, ctx):
        with pytest.raises(SystemExit, match="pipe sink"):
            PipeStep().run({"output": "out.txt", "stages": [
                {"action": "shell", "with": {"cmd": "echo hi"}},
                {"action": "shell", "with": {"cmd": "exit 4"}},
            ]}, ctx)

    def test_fewer_than_two_stages_is_not_a_pipe(self, ctx):
        with pytest.raises(ValueError, match="at least 2 stages"):
            PipeStep().run({"stages": [{"action": "shell", "with": {"cmd": "true"}}]}, ctx)

    def test_a_stage_must_name_an_action(self, ctx):
        with pytest.raises(ValueError, match="stage #2 must be a mapping"):
            PipeStep().run({"output": "o", "stages": [
                {"action": "shell", "with": {"cmd": "true"}},
                {"cmd": "true"},
            ]}, ctx)

    def test_an_ffmpeg_sink_needs_somewhere_to_write(self, ctx):
        with pytest.raises(ValueError, match="needs an 'output'"):
            PipeStep().run({"stages": [
                {"action": "shell", "with": {"cmd": "echo hi"}},
                {"action": "ffmpeg", "with": {}},
            ]}, ctx)

    def test_a_sink_that_writes_no_file_produces_no_artifact(self, ctx):
        # e.g. streaming the bytes somewhere else — legal, just not resumable.
        assert PipeStep().run({"stages": [
            {"action": "shell", "with": {"cmd": "echo hi"}},
            {"action": "shell", "with": {"cmd": "cat > /dev/null"}},
        ]}, ctx) == {}

    def test_dry_run_prints_the_whole_chain_without_spawning_it(self, tmp_path, capsys):
        ctx = StepContext(step_id="s", workdir=tmp_path, dry_run=True)
        PipeStep().run({"output": "out.txt", "stages": [
            {"action": "shell", "with": {"cmd": "echo hi"}},
            {"action": "shell", "with": {"cmd": "cat > {output}"}},
        ]}, ctx)

        out = capsys.readouterr().out
        assert "sh -c echo hi | sh -c cat >" in out
        assert "[dry-run] would run 2-stage pipe" in out
        assert not (tmp_path / "s" / "out.txt").exists()


class TestPauseStep:
    def test_it_signals_a_halt(self, ctx):
        with pytest.raises(PauseSignal, match="check the cut"):
            PauseStep().run({"message": "check the cut"}, ctx)

    def test_it_stays_out_of_the_way_in_dry_run_and_preview(self, tmp_path):
        assert PauseStep().run({}, StepContext(step_id="p", workdir=tmp_path, dry_run=True)) == {}
        assert PauseStep().run({}, StepContext(step_id="p", workdir=tmp_path, preview=5)) == {}
