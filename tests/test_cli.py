"""The command surface: run / list / state / set / forget / validate / help."""

import json

import pytest

from radiant.cli import main


def cli(*argv):
    main(list(argv))


@pytest.fixture
def plan_path(echo_plan):
    return str(echo_plan)


class TestRun:
    def test_runs_the_selected_step_only(self, plan_path, workdir):
        cli("run", "--plan", plan_path, "--step", "one")

        assert (workdir / "one" / "a.txt").exists()
        assert not (workdir / "two").exists()

    def test_vars_override(self, plan_path, workdir):
        cli("run", "--plan", plan_path, "--vars", "who=moon")
        assert (workdir / "one" / "a.txt").read_text() == "hello moon\n"

    def test_reuse_vars_replays_the_last_runs_overrides(self, plan_path, workdir):
        cli("run", "--plan", plan_path, "--vars", "who=moon")

        cli("run", "--plan", plan_path, "--reuse-vars", "--force")
        assert (workdir / "one" / "a.txt").read_text() == "hello moon\n"

    def test_without_reuse_vars_the_plan_file_wins_again(self, plan_path, workdir):
        cli("run", "--plan", plan_path, "--vars", "who=moon")

        cli("run", "--plan", plan_path, "--force")
        assert (workdir / "one" / "a.txt").read_text() == "hello world\n"

    def test_malformed_var_override(self, plan_path):
        with pytest.raises(SystemExit, match="expects key=value"):
            cli("run", "--plan", plan_path, "--vars", "oops")

    def test_a_missing_plan_file_is_reported(self, tmp_path):
        with pytest.raises(SystemExit, match="plan file not found"):
            cli("run", "--plan", str(tmp_path / "nope.yaml"))

    def test_workdir_override(self, plan_path, tmp_path):
        elsewhere = tmp_path / "elsewhere"
        cli("run", "--plan", plan_path, "--workdir", str(elsewhere), "--step", "one")
        assert (elsewhere / "one" / "a.txt").exists()


class TestState:
    def test_reports_an_empty_workdir(self, plan_path, capsys):
        cli("state", "--plan", plan_path)
        assert "No state recorded yet" in capsys.readouterr().out

    def test_shows_vars_inputs_and_outputs(self, plan_path, workdir, capsys):
        cli("run", "--plan", plan_path)
        capsys.readouterr()

        cli("state", "--plan", plan_path)

        out = capsys.readouterr().out
        assert "vars used by the last run:" in out
        assert "greeting = hello" in out
        assert f"out  file = {workdir / 'one' / 'a.txt'}" in out
        assert "in   cmd = echo hello world > {output}" in out
        assert "one (shell) — done" in out

    def test_flags_vars_the_plan_has_since_changed(self, plan_path, capsys):
        cli("run", "--plan", plan_path, "--vars", "who=moon")
        capsys.readouterr()

        cli("state", "--plan", plan_path)
        assert "who      = moon   (plan now: 'world')" in capsys.readouterr().out

    def test_pending_steps_are_listed_too(self, plan_path, capsys):
        cli("run", "--plan", plan_path, "--step", "one")
        capsys.readouterr()

        cli("state", "--plan", plan_path)
        assert "two (shell) — pending" in capsys.readouterr().out

    def test_json_dump_is_the_raw_record(self, plan_path, workdir, capsys):
        cli("run", "--plan", plan_path)
        capsys.readouterr()

        cli("state", "--plan", plan_path, "--json")

        assert json.loads(capsys.readouterr().out) == json.loads((workdir / "state.json").read_text())


class TestSet:
    def test_pins_a_value_a_later_step_then_consumes(self, probe_action, write_plan, workdir, capsys):
        path = str(write_plan({"steps": [
            {"id": "probe", "action": "probe", "with": {"value": "computed"}},
            {"id": "render", "action": "shell",
             "with": {"cmd": "echo ${steps.probe.value} > {output}", "output": "out.txt"}},
        ]}))

        cli("set", "--plan", path, "probe.value=pinned")
        cli("run", "--plan", path, "--step", "render")

        assert (workdir / "render" / "out.txt").read_text() == "pinned\n"
        assert "set probe.value = 'pinned'" in capsys.readouterr().out

    @pytest.mark.parametrize("raw,expected", [
        ("722.307", 722.307),
        ("0", 0),
        ("true", True),
        ("null", None),
        ("hello", "hello"),
        ("00:18:51", "00:18:51"),      # not valid JSON → kept as a string
    ])
    def test_value_types(self, probe_action, write_plan, workdir, raw, expected):
        path = str(write_plan({"steps": [{"id": "probe", "action": "probe", "with": {"value": "x"}}]}))

        cli("set", "--plan", path, f"probe.value={raw}")

        data = json.loads((workdir / "state.json").read_text())
        assert data["steps"]["probe"]["outputs"]["value"] == expected

    def test_several_assignments_at_once(self, write_plan, workdir):
        path = str(write_plan({"steps": [
            {"id": "sync", "action": "sync", "with": {"video": "v.mp4", "audio": "a.wav"}},
        ]}))

        cli("set", "--plan", path, "sync.offset=722.307", "sync.audio_trim=0")

        outputs = json.loads((workdir / "state.json").read_text())["steps"]["sync"]["outputs"]
        assert outputs == {"offset": 722.307, "audio_trim": 0}

    def test_rejects_an_unknown_step(self, plan_path):
        with pytest.raises(SystemExit, match="unknown step 'ghost'"):
            cli("set", "--plan", plan_path, "ghost.file=/x")

    def test_rejects_an_output_the_action_does_not_produce(self, plan_path):
        with pytest.raises(SystemExit, match="does not produce 'offset'"):
            cli("set", "--plan", plan_path, "one.offset=1")

    def test_rejects_a_malformed_assignment(self, plan_path):
        with pytest.raises(SystemExit, match="expected <step>.<output>=<value>"):
            cli("set", "--plan", plan_path, "one=1")


class TestForget:
    def test_makes_a_step_run_again(self, plan_path, workdir, capsys):
        cli("run", "--plan", plan_path)
        (workdir / "one" / "a.txt").write_text("edited\n")

        cli("forget", "--plan", plan_path, "one")
        cli("run", "--plan", plan_path)

        assert (workdir / "one" / "a.txt").read_text() == "hello world\n"
        assert "forgot one" in capsys.readouterr().out

    def test_says_when_there_was_nothing_to_forget(self, plan_path, capsys):
        cli("forget", "--plan", plan_path, "one")
        assert "nothing recorded for one" in capsys.readouterr().out

    def test_rejects_an_unknown_step(self, plan_path):
        with pytest.raises(SystemExit, match="unknown step 'ghost'"):
            cli("forget", "--plan", plan_path, "ghost")


class TestListAndValidate:
    def test_list_shows_status_and_outputs(self, plan_path, capsys):
        cli("run", "--plan", plan_path, "--step", "one")
        capsys.readouterr()

        cli("list", "--plan", plan_path)

        out = capsys.readouterr().out
        assert "one" in out and "done" in out
        assert "two" in out and "pending" in out

    def test_validate_lists_the_steps(self, plan_path, capsys):
        cli("validate", "--plan", plan_path)

        out = capsys.readouterr().out
        assert "is valid. 2 steps:" in out
        assert "2. two (shell)  needs: one" in out

    def test_validate_reports_a_broken_plan(self, write_plan):
        path = str(write_plan({"steps": [{"id": "one", "action": "teleport"}]}))
        with pytest.raises(SystemExit, match="unknown action 'teleport'"):
            cli("validate", "--plan", path)


class TestHelp:
    def test_index_lists_every_action(self, capsys):
        cli("help")

        out = capsys.readouterr().out
        for action in ("sync", "ffmpeg", "clip", "upload", "pipe"):
            assert action in out

    def test_one_action_documents_params_and_outputs(self, capsys):
        cli("help", "sync")

        out = capsys.readouterr().out
        assert "analysis_duration" in out
        assert "default 600" in out
        assert "offset" in out

    def test_unknown_action(self, capsys):
        cli("help", "teleport")
        assert "Unknown action 'teleport'" in capsys.readouterr().out
