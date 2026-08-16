"""Static plan handling: loading, validation, reference resolution, selectors.

Everything here runs without executing a step.
"""

import pytest

from radiant.plan import Plan, PlanError, PlanStep
from radiant.state import State

SHELL = "shell"


def shell_step(step_id, cmd="echo hi", **extra):
    return {"id": step_id, "action": SHELL, "with": {"cmd": cmd, **extra}}


class TestLoad:
    def test_missing_file(self, tmp_path):
        with pytest.raises(PlanError, match="plan file not found"):
            Plan.load(tmp_path / "nope.yaml")

    def test_name_defaults_to_the_filename(self, tmp_path):
        path = tmp_path / "my_job.yaml"
        path.write_text("steps: []\n")
        assert Plan.load(path).name == "my_job"

    def test_workdir_defaults_under_runs(self, tmp_path):
        path = tmp_path / "p.yaml"
        path.write_text("name: job\nsteps: []\n")
        assert Plan.load(path).workdir.as_posix() == "runs/job"

    def test_workdir_override_beats_the_plan(self, write_plan, tmp_path):
        plan = Plan.load(write_plan({"steps": []}), workdir_override=tmp_path / "elsewhere")
        assert plan.workdir == tmp_path / "elsewhere"

    def test_step_needs_an_id_and_an_action(self, write_plan):
        with pytest.raises(PlanError, match="missing an 'id'"):
            Plan.load(write_plan({"steps": [{"action": SHELL}]}))
        with pytest.raises(PlanError, match="missing an 'action'"):
            Plan.load(write_plan({"steps": [{"id": "one"}]}))

    def test_steps_are_indexed_from_one(self, load_plan):
        plan = load_plan({"steps": [shell_step("one"), shell_step("two")]})
        assert [s.index for s in plan.steps] == [1, 2]
        assert plan.step_at(2).id == "two"
        assert set(plan.by_id) == {"one", "two"}


class TestVarPrecedence:
    def _plan_doc(self):
        return {"vars": {"a": "plan", "b": "plan"},
                "steps": [shell_step("one", "echo ${vars.a} ${vars.b}")]}

    def test_overrides_beat_the_plan_file(self, load_plan):
        plan = load_plan(self._plan_doc(), var_overrides={"a": "cli"})
        assert plan.vars == {"a": "cli", "b": "plan"}

    def test_reuse_vars_reads_the_last_run(self, write_plan, workdir):
        path = write_plan(self._plan_doc())
        State(workdir).begin_run(name="testplan", plan_path=path,
                                 vars={"a": "recorded", "b": "recorded"}, mode="run")

        assert Plan.load(path).vars == {"a": "plan", "b": "plan"}
        assert Plan.load(path, reuse_vars=True).vars == {"a": "recorded", "b": "recorded"}

    def test_overrides_still_win_over_reused_vars(self, write_plan, workdir):
        path = write_plan(self._plan_doc())
        State(workdir).begin_run(name="testplan", plan_path=path,
                                 vars={"a": "recorded", "b": "recorded"}, mode="run")

        plan = Plan.load(path, var_overrides={"a": "cli"}, reuse_vars=True)
        assert plan.vars == {"a": "cli", "b": "recorded"}

    def test_reuse_vars_on_a_fresh_workdir_is_harmless(self, write_plan):
        assert Plan.load(write_plan(self._plan_doc()), reuse_vars=True).vars == {"a": "plan", "b": "plan"}


class TestValidate:
    def test_a_good_plan_passes(self, load_plan):
        load_plan({
            "vars": {"who": "world"},
            "steps": [
                shell_step("one", "echo ${vars.who} > {output}", output="a.txt"),
                {"id": "two", "action": SHELL, "needs": ["one"],
                 "with": {"cmd": "cat ${steps.one.file}"}},
            ],
        }).validate()

    def test_duplicate_ids(self, load_plan):
        with pytest.raises(PlanError, match="duplicate step ids: one"):
            load_plan({"steps": [shell_step("one"), shell_step("one")]}).validate()

    def test_unknown_action(self, load_plan):
        with pytest.raises(PlanError, match="unknown action 'teleport'"):
            load_plan({"steps": [{"id": "one", "action": "teleport"}]}).validate()

    def test_needs_an_unknown_step(self, load_plan):
        with pytest.raises(PlanError, match="needs unknown step 'ghost'"):
            load_plan({"steps": [{"id": "one", "action": SHELL,
                                  "needs": ["ghost"], "with": {"cmd": "x"}}]}).validate()

    def test_missing_required_param(self, load_plan):
        with pytest.raises(PlanError, match="missing required parameter\\(s\\): cmd"):
            load_plan({"steps": [{"id": "one", "action": SHELL, "with": {}}]}).validate()

    def test_dependency_cycle(self, load_plan):
        with pytest.raises(PlanError, match="dependency cycle"):
            load_plan({"steps": [
                {"id": "one", "action": SHELL, "needs": ["two"], "with": {"cmd": "x"}},
                {"id": "two", "action": SHELL, "needs": ["one"], "with": {"cmd": "x"}},
            ]}).validate()

    def test_unknown_var_reference(self, load_plan):
        with pytest.raises(PlanError, match="unknown var 'nope'"):
            load_plan({"steps": [shell_step("one", "echo ${vars.nope}")]}).validate()

    def test_malformed_var_reference(self, load_plan):
        with pytest.raises(PlanError, match="malformed reference"):
            load_plan({"steps": [shell_step("one", "echo ${vars.a.b}")]}).validate()

    def test_unknown_reference_root(self, load_plan):
        with pytest.raises(PlanError, match="unknown reference root 'env'"):
            load_plan({"steps": [shell_step("one", "echo ${env.HOME}")]}).validate()

    def test_reference_to_an_unknown_step(self, load_plan):
        with pytest.raises(PlanError, match="references unknown step 'ghost'"):
            load_plan({"steps": [shell_step("one", "cat ${steps.ghost.file}")]}).validate()

    def test_reference_to_a_later_step(self, load_plan):
        with pytest.raises(PlanError, match="not an earlier step"):
            load_plan({"steps": [
                shell_step("one", "cat ${steps.two.file}"),
                shell_step("two", "echo x > {output}", output="b.txt"),
            ]}).validate()

    def test_reference_to_an_output_the_action_does_not_produce(self, load_plan):
        with pytest.raises(PlanError, match="does not produce 'offset'"):
            load_plan({"steps": [
                shell_step("one", "echo x > {output}", output="a.txt"),
                shell_step("two", "echo ${steps.one.offset}"),
            ]}).validate()

    def test_references_nested_in_lists_and_maps_are_checked(self, load_plan):
        with pytest.raises(PlanError, match="unknown var 'nope'"):
            load_plan({"steps": [{"id": "one", "action": "ffmpeg", "with": {
                "input": "in.mp4", "output": "out.mp4",
                "extra_args": ["-metadata", "title=${vars.nope}"],
            }}]}).validate()


class TestResolve:
    def _plan(self, load_plan):
        return load_plan({
            "vars": {"who": "world", "count": 3, "ratio": 1.5},
            "steps": [shell_step("one"), shell_step("two")],
        })

    def test_whole_string_reference_keeps_its_native_type(self, load_plan):
        plan = self._plan(load_plan)
        step, state = plan.step_at(1), State(plan.workdir)

        assert plan.resolve("${vars.count}", step, state) == 3
        assert plan.resolve("  ${vars.ratio}  ", step, state) == 1.5

    def test_embedded_references_are_stringified(self, load_plan):
        plan = self._plan(load_plan)
        step, state = plan.step_at(1), State(plan.workdir)

        assert plan.resolve("hello ${vars.who} x${vars.count}", step, state) == "hello world x3"

    def test_nested_structures_and_non_strings_pass_through(self, load_plan):
        plan = self._plan(load_plan)
        step, state = plan.step_at(1), State(plan.workdir)

        resolved = plan.resolve(
            {"a": ["${vars.who}", 7], "b": {"c": "${vars.count}"}, "d": True},
            step, state,
        )
        assert resolved == {"a": ["world", 7], "b": {"c": 3}, "d": True}

    def test_step_output_comes_from_state(self, load_plan):
        plan = self._plan(load_plan)
        state = State(plan.workdir)
        state.record("one", {"file": "/tmp/a.txt"}, action=SHELL)

        assert plan.resolve("${steps.one.file}", plan.step_at(2), state) == "/tmp/a.txt"

    def test_referencing_a_step_that_has_not_run_explains_how_to_fix_it(self, load_plan):
        plan = self._plan(load_plan)

        with pytest.raises(PlanError, match="hasn't run yet"):
            plan.resolve("${steps.one.file}", plan.step_at(2), State(plan.workdir))

    def test_referencing_a_missing_output_of_a_finished_step(self, load_plan):
        plan = self._plan(load_plan)
        state = State(plan.workdir)
        state.record("one", {}, action=SHELL)

        with pytest.raises(PlanError, match="produced no such output"):
            plan.resolve("${steps.one.file}", plan.step_at(2), state)


class TestSelect:
    @pytest.fixture
    def plan(self, load_plan):
        return load_plan({"steps": [shell_step(x) for x in ("a", "b", "c", "d")]})

    def ids(self, plan, selector):
        return [s.id for s in plan.select(selector)]

    def test_no_selector_runs_everything(self, plan):
        assert self.ids(plan, None) == ["a", "b", "c", "d"]
        assert self.ids(plan, "") == ["a", "b", "c", "d"]

    @pytest.mark.parametrize("selector,expected", [
        ("2", ["b"]),
        ("2-3", ["b", "c"]),
        ("3-", ["c", "d"]),
        ("-2", ["a", "b"]),
        ("1,3", ["a", "c"]),
        ("b", ["b"]),
        ("b-d", ["b", "c", "d"]),
        ("d-b", ["b", "c", "d"]),      # reversed endpoints are normalised
        ("a,c-d", ["a", "c", "d"]),
        ("2,2", ["b"]),                # duplicates collapse
    ])
    def test_selectors(self, plan, selector, expected):
        assert self.ids(plan, selector) == expected

    def test_selection_is_always_in_plan_order(self, plan):
        assert self.ids(plan, "4,1") == ["a", "d"]

    def test_index_out_of_range(self, plan):
        with pytest.raises(PlanError, match="out of range"):
            plan.select("9")

    def test_unknown_step_in_selector(self, plan):
        with pytest.raises(PlanError, match="unknown step 'zzz'"):
            plan.select("zzz")

    def test_an_id_containing_a_dash_wins_over_range_syntax(self, load_plan):
        plan = load_plan({"steps": [shell_step("a"), shell_step("upload-reel"), shell_step("c")]})
        assert [s.id for s in plan.select("upload-reel")] == ["upload-reel"]


def test_plan_step_defaults():
    step = PlanStep(index=1, id="one", action=SHELL, needs=[])
    assert step.with_ == {}
