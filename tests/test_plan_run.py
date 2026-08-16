"""The run loop: resumability, single-step reruns, preview/dry-run, drift
warnings, pause and hooks.

These run real `shell` steps, so what's asserted is what the tool actually does.
"""

import json

import pytest

from radiant.plan import Plan


def run(path, **kwargs):
    Plan.load(path, var_overrides=kwargs.pop("var_overrides", None),
              reuse_vars=kwargs.pop("reuse_vars", False)).run(**kwargs)


def state_of(workdir):
    return json.loads((workdir / "state.json").read_text())


class TestBasicRun:
    def test_runs_every_step_and_records_the_chain(self, echo_plan, workdir, capsys):
        run(echo_plan)

        assert (workdir / "one" / "a.txt").read_text() == "hello world\n"
        assert (workdir / "two" / "b.txt").read_text() == "hello world\n"

        data = state_of(workdir)
        assert data["name"] == "testplan"
        assert data["plan"] == str(echo_plan)
        assert data["mode"] == "run"
        assert data["vars"] == {"greeting": "hello", "who": "world"}
        assert data["steps"]["one"]["outputs"] == {"file": str(workdir / "one" / "a.txt")}
        assert data["steps"]["one"]["params"] == {
            "cmd": "echo hello world > {output}", "output": "a.txt",
        }
        assert data["steps"]["two"]["params"]["cmd"] == f"cat {workdir / 'one' / 'a.txt'} > {{output}}"
        assert "Done." in capsys.readouterr().out

    def test_records_the_vars_a_run_actually_used(self, echo_plan, workdir):
        run(echo_plan, var_overrides={"who": "moon"})
        assert state_of(workdir)["vars"] == {"greeting": "hello", "who": "moon"}

    def test_selecting_no_steps_does_nothing(self, echo_plan, workdir, capsys):
        run(echo_plan, selector="")     # empty selector means "all"
        capsys.readouterr()

        plan = Plan.load(echo_plan)
        plan.steps = []
        plan.run()
        assert "No steps selected." in capsys.readouterr().out

    def test_a_failing_step_stops_the_run(self, write_plan, workdir):
        path = write_plan({"steps": [
            {"id": "boom", "action": "shell", "with": {"cmd": "exit 3"}},
            {"id": "after", "action": "shell", "with": {"cmd": "echo x > {output}", "output": "c.txt"}},
        ]})

        with pytest.raises(SystemExit):
            run(path)

        assert not (workdir / "after").exists()
        assert state_of(workdir)["steps"] == {}


class TestResume:
    def test_finished_steps_are_skipped(self, echo_plan, workdir, capsys):
        run(echo_plan)
        (workdir / "one" / "a.txt").write_text("edited\n")
        capsys.readouterr()

        run(echo_plan)

        assert "already done, skipping" in capsys.readouterr().out
        assert (workdir / "one" / "a.txt").read_text() == "edited\n"   # not rebuilt

    def test_a_deleted_artifact_triggers_a_rebuild(self, echo_plan, workdir):
        run(echo_plan)
        (workdir / "one" / "a.txt").unlink()

        run(echo_plan)
        assert (workdir / "one" / "a.txt").read_text() == "hello world\n"

    def test_force_reruns_everything(self, echo_plan, workdir):
        run(echo_plan)
        (workdir / "one" / "a.txt").write_text("edited\n")

        run(echo_plan, force=True)
        assert (workdir / "one" / "a.txt").read_text() == "hello world\n"

    def test_a_single_step_rerun_reuses_recorded_upstream_outputs(self, echo_plan, workdir):
        run(echo_plan, selector="one")
        (workdir / "two").mkdir(parents=True, exist_ok=True)

        # `two` alone resolves ${steps.one.file} from state.json — `one` never reruns.
        run(echo_plan, selector="two")
        assert (workdir / "two" / "b.txt").read_text() == "hello world\n"

    def test_a_step_whose_producer_never_ran_says_how_to_fix_it(self, echo_plan):
        with pytest.raises(SystemExit) as exc:
            run(echo_plan, selector="two")

        message = str(exc.value)
        assert "needs output 'file' from step 'one'" in message
        assert "--step one" in message      # tells you what to run first


class TestDriftWarnings:
    def test_changed_vars_are_reported(self, echo_plan, capsys):
        run(echo_plan)
        capsys.readouterr()

        run(echo_plan, var_overrides={"who": "moon"})

        out = capsys.readouterr().out
        assert "vars changed since the last recorded run" in out
        assert "who: 'world' -> 'moon'" in out

    def test_a_skipped_step_flags_inputs_that_changed_under_it(self, echo_plan, capsys):
        run(echo_plan)
        capsys.readouterr()

        run(echo_plan, var_overrides={"who": "moon"})

        assert "! inputs changed since it ran (cmd)" in capsys.readouterr().out

    def test_no_warnings_when_nothing_moved(self, echo_plan, capsys):
        run(echo_plan)
        capsys.readouterr()

        run(echo_plan)

        out = capsys.readouterr().out
        assert "vars changed" not in out
        assert "inputs changed" not in out

    def test_v1_records_have_no_inputs_to_compare(self, echo_plan, workdir, capsys):
        run(echo_plan)
        data = state_of(workdir)
        for entry in data["steps"].values():
            entry.pop("params")
        (workdir / "state.json").write_text(json.dumps(data))
        capsys.readouterr()

        run(echo_plan, var_overrides={"who": "moon"})

        assert "inputs changed" not in capsys.readouterr().out


class TestDryRun:
    def test_nothing_runs_and_nothing_is_recorded(self, echo_plan, workdir, capsys):
        run(echo_plan, dry_run=True)

        assert not (workdir / "state.json").exists()
        assert not (workdir / "one" / "a.txt").exists()
        assert "[dry-run] outputs:" in capsys.readouterr().out

    def test_it_never_clobbers_a_real_record(self, echo_plan, workdir):
        run(echo_plan)
        before = state_of(workdir)

        run(echo_plan, dry_run=True, force=True)
        assert state_of(workdir) == before


class TestPreview:
    def _preview_plan(self, write_plan):
        return write_plan({
            "vars": {"v": "measured"},
            "steps": [
                {"id": "probe", "action": "probe", "with": {"value": "${vars.v}"}},
                {"id": "render", "action": "shell",
                 "with": {"cmd": "echo ${steps.probe.value} > {output}", "output": "out.txt"}},
            ],
        })

    def test_outputs_are_prefixed_and_ordinary_steps_are_not_recorded(
            self, probe_action, write_plan, workdir):
        run(self._preview_plan(write_plan), preview=2)

        assert (workdir / "render" / "preview_out.txt").exists()
        assert not (workdir / "render" / "out.txt").exists()
        assert list(state_of(workdir)["steps"]) == ["probe"]   # only the preview-proof step

    def test_an_analysis_step_survives_the_preview(self, probe_action, write_plan, workdir, capsys):
        run(self._preview_plan(write_plan), preview=2)

        entry = state_of(workdir)["steps"]["probe"]
        assert entry["outputs"] == {"value": "measured"}
        assert entry["mode"] == "preview"
        assert "recorded to state.json" in capsys.readouterr().out

    def test_the_later_real_run_does_not_recompute_it(self, probe_action, write_plan, workdir, capsys):
        run(self._preview_plan(write_plan), preview=2)
        capsys.readouterr()

        run(self._preview_plan(write_plan))

        out = capsys.readouterr().out
        assert "probe (probe) — already done, skipping" in out
        assert (workdir / "render" / "out.txt").read_text() == "measured\n"

    def test_a_preview_never_publishes_over_a_real_record(self, probe_action, write_plan, workdir):
        run(self._preview_plan(write_plan))
        before = state_of(workdir)

        run(self._preview_plan(write_plan), preview=2, force=True)

        after = state_of(workdir)
        assert after["steps"]["render"] == before["steps"]["render"]
        assert after["steps"]["probe"]["mode"] == "preview"     # only this one is refreshed


class TestPause:
    def test_it_halts_cleanly_and_leaves_the_rest_unrun(self, write_plan, workdir, capsys):
        path = write_plan({"steps": [
            {"id": "first", "action": "shell", "with": {"cmd": "echo x > {output}", "output": "a.txt"}},
            {"id": "wait", "action": "pause", "with": {"message": "check the cut"}},
            {"id": "later", "action": "shell", "with": {"cmd": "echo y > {output}", "output": "b.txt"}},
        ]})

        run(path)   # no SystemExit: pausing is a clean stop

        out = capsys.readouterr().out
        assert "PAUSED at step 2: wait" in out
        assert "check the cut" in out
        assert "--step later-" in out
        assert (workdir / "first" / "a.txt").exists()
        assert not (workdir / "later").exists()
        assert list(state_of(workdir)["steps"]) == ["first"]

    def test_it_does_not_halt_a_preview(self, write_plan, capsys):
        path = write_plan({"steps": [
            {"id": "wait", "action": "pause", "with": {"message": "hold"}},
            {"id": "later", "action": "shell", "with": {"cmd": "echo y > {output}", "output": "b.txt"}},
        ]})

        run(path, preview=2)
        assert "PAUSED" not in capsys.readouterr().out


class TestHooks:
    def test_on_success_receives_the_last_url(self, write_plan, tmp_path, workdir):
        marker = tmp_path / "hook.txt"
        path = write_plan({
            "hooks": {"on_start": f"echo start >> {marker}",
                      "on_success": f"echo 'done {{name}}' >> {marker}"},
            "steps": [{"id": "one", "action": "shell",
                       "with": {"cmd": "echo x > {output}", "output": "a.txt"}}],
        })

        run(path)
        assert marker.read_text() == "start\ndone testplan\n"

    def test_on_failure_fires_with_the_failing_step(self, write_plan, tmp_path):
        marker = tmp_path / "hook.txt"
        path = write_plan({
            "hooks": {"on_failure": f"echo 'failed {{step}}' >> {marker}"},
            "steps": [{"id": "boom", "action": "shell", "with": {"cmd": "exit 1"}}],
        })

        with pytest.raises(SystemExit):
            run(path)
        assert marker.read_text() == "failed boom\n"

    def test_hooks_only_print_under_dry_run(self, write_plan, tmp_path, capsys):
        marker = tmp_path / "hook.txt"
        path = write_plan({
            "hooks": {"on_start": f"echo start >> {marker}"},
            "steps": [{"id": "one", "action": "shell", "with": {"cmd": "true"}}],
        })

        run(path, dry_run=True)
        assert not marker.exists()
        assert "[hook:on_start]" in capsys.readouterr().out
