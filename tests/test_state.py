"""The run record: what gets written, what survives an ephemeral run, and how
schema v1 files behave."""

import json

from radiant.state import SCHEMA_VERSION, State


def read(path):
    return json.loads(path.read_text())


def test_fresh_workdir_has_no_state(workdir):
    state = State(workdir)
    assert state.data == {"version": SCHEMA_VERSION, "vars": {}, "steps": {}}
    assert state.status("nope") == "pending"
    assert state.is_done("nope") is False
    assert state.outputs("nope") == {}
    assert state.params("nope") == {}
    assert state.vars() == {}
    assert not state.path.exists()


def test_record_persists_inputs_outputs_and_timing(workdir):
    state = State(workdir)
    state.record(
        "sync", {"offset": 722.307, "audio_trim": 0.0},
        action="sync", params={"video": "/v.braw", "analysis_duration": 1200},
        started_at="2026-08-16T17:00:00+03:00", duration_s=1203.4567,
    )

    entry = read(state.path)["steps"]["sync"]
    assert entry["status"] == "done"
    assert entry["action"] == "sync"
    assert entry["mode"] == "run"
    assert entry["outputs"] == {"offset": 722.307, "audio_trim": 0.0}
    assert entry["params"] == {"video": "/v.braw", "analysis_duration": 1200}
    assert entry["started_at"] == "2026-08-16T17:00:00+03:00"
    assert entry["duration_s"] == 1203.457  # rounded to ms
    assert entry["finished_at"]


def test_reload_sees_what_a_previous_process_recorded(workdir):
    State(workdir).record("sync", {"offset": 12.5}, action="sync", params={"a": 1})

    state = State(workdir)
    assert state.is_done("sync")
    assert state.get_output("sync", "offset") == 12.5
    assert state.has_output("sync", "offset")
    assert not state.has_output("sync", "missing")
    assert state.params("sync") == {"a": 1}


def test_begin_run_stamps_vars_before_any_step(workdir):
    state = State(workdir)
    state.begin_run(name="job", plan_path="/plans/job.yaml", vars={"raw": "/a.braw"}, mode="run")

    # On disk immediately, so a run that dies partway still records what it used.
    data = read(state.path)
    assert data["name"] == "job"
    assert data["plan"] == "/plans/job.yaml"
    assert data["mode"] == "run"
    assert data["vars"] == {"raw": "/a.braw"}
    assert State(workdir).vars() == {"raw": "/a.braw"}


def test_header_is_written_before_the_bulky_steps(workdir):
    state = State(workdir)
    state.begin_run(name="job", plan_path="/p.yaml", vars={"x": 1}, mode="run")
    state.record("one", {"file": "/f"}, action="shell")

    assert list(read(state.path)) == ["version", "name", "plan", "mode", "updated_at", "vars", "steps"]


def test_paths_are_serialised_rather_than_crashing(workdir, tmp_path):
    state = State(workdir)
    state.record("one", {"file": tmp_path / "x.mp4"}, action="shell")
    assert read(state.path)["steps"]["one"]["outputs"]["file"] == str(tmp_path / "x.mp4")


class TestEphemeral:
    def test_records_stay_in_memory(self, workdir):
        state = State(workdir, ephemeral=True)
        state.begin_run(name="job", plan_path="/p.yaml", vars={"x": 1}, mode="preview")
        state.record("one", {"file": "/f"}, action="shell")

        assert state.is_done("one")          # downstream refs still resolve
        assert not state.path.exists()       # ...but nothing is published

    def test_persist_publishes_only_that_step(self, workdir):
        state = State(workdir, ephemeral=True)
        state.begin_run(name="job", plan_path="/p.yaml", vars={"x": 1}, mode="preview")
        state.record("probe", {"value": 42}, action="probe", persist=True)
        state.record("encode", {"file": "/preview_out.mp4"}, action="ffmpeg")

        data = read(state.path)
        assert list(data["steps"]) == ["probe"]     # the truncated encode is not published
        assert data["steps"]["probe"]["outputs"] == {"value": 42}
        assert data["vars"] == {"x": 1}             # header carried over for a fresh file

    def test_persist_merges_into_an_existing_record(self, workdir):
        State(workdir).record("one", {"file": "/real.mp4"}, action="shell")

        state = State(workdir, ephemeral=True)
        state.record("probe", {"value": 42}, action="probe", persist=True)

        steps = read(state.path)["steps"]
        assert set(steps) == {"one", "probe"}       # the earlier real run is untouched
        assert steps["one"]["outputs"] == {"file": "/real.mp4"}


class TestManualSet:
    def test_creates_a_record_marked_as_hand_set(self, workdir):
        state = State(workdir)
        state.set_output("sync", "offset", 722.307, action="sync")

        entry = read(state.path)["steps"]["sync"]
        assert entry == {
            "outputs": {"offset": 722.307},
            "params": {},
            "status": "done",
            "source": "manual",
            "finished_at": entry["finished_at"],
            "action": "sync",
        }
        assert State(workdir).get_output("sync", "offset") == 722.307

    def test_overwrites_a_computed_value_and_drops_its_stale_timing(self, workdir):
        state = State(workdir)
        state.record("sync", {"offset": 1.5, "audio_trim": 0.0}, action="sync",
                     duration_s=1203.4, mode="preview", started_at="2026-08-16T17:00:00+03:00")
        state.set_output("sync", "offset", 99.5)

        entry = read(state.path)["steps"]["sync"]
        assert entry["outputs"] == {"offset": 99.5, "audio_trim": 0.0}   # siblings kept
        assert entry["source"] == "manual"
        assert "duration_s" not in entry and "mode" not in entry and "started_at" not in entry


class TestForget:
    def test_removes_a_record(self, workdir):
        state = State(workdir)
        state.record("one", {"file": "/f"}, action="shell")

        assert state.forget("one") is True
        assert not state.is_done("one")
        assert read(state.path)["steps"] == {}

    def test_is_a_no_op_for_an_unrecorded_step(self, workdir):
        assert State(workdir).forget("nope") is False


class TestSchemaV1:
    """Old files predate vars/params/timing — they must still load and run."""

    def _write_v1(self, workdir):
        workdir.mkdir(parents=True)
        (workdir / "state.json").write_text(json.dumps({
            "steps": {"sync": {"status": "done", "outputs": {"offset": 690.5}}}
        }))

    def test_outputs_are_still_readable(self, workdir):
        self._write_v1(workdir)
        state = State(workdir)

        assert state.is_done("sync")
        assert state.get_output("sync", "offset") == 690.5
        assert state.params("sync") == {}    # nothing recorded back then
        assert state.vars() == {}
        assert state.data["version"] == 1

    def test_upgrades_in_place_without_losing_old_steps(self, workdir):
        self._write_v1(workdir)
        state = State(workdir)
        state.begin_run(name="job", plan_path="/p.yaml", vars={"x": 1}, mode="run")
        state.record("master", {"file": "/m.mp4"}, action="ffmpeg")

        data = read(state.path)
        assert data["version"] == SCHEMA_VERSION
        assert data["steps"]["sync"]["outputs"] == {"offset": 690.5}
        assert data["steps"]["master"]["outputs"] == {"file": "/m.mp4"}
