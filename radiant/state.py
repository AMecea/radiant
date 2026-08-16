"""Persistent run state — the run record stored at ``<workdir>/state.json``.

Records, for the run as a whole: which plan produced it and the ``vars`` it ran
with; and per step: status, the *resolved* ``with:`` parameters the step
actually ran with, the outputs it produced (scalars inline, file artifacts as
absolute paths), and timing.

Keeping the inputs next to the outputs is what makes single-step reruns safe:
a later ``--step reel`` resolves ``${steps.sync.offset}`` from here instead of
recomputing a 20-minute cross-correlation, ``radiant state`` shows you the
values a past run produced, and the runner can warn when a step is marked done
but the inputs it was built from have since changed.

Schema v1 files (``{"steps": {<id>: {status, outputs}}}``) load unchanged; the
extra fields simply appear as steps are re-recorded.
"""

import json
from datetime import datetime
from pathlib import Path

STATE_FILENAME = "state.json"
SCHEMA_VERSION = 2


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


class State:
    """The run record. ``ephemeral`` (dry-run / preview) keeps writes in memory
    so downstream references still resolve while state.json stays untouched —
    except for steps explicitly persisted via ``record(..., persist=True)``,
    which are merged into the file one step at a time."""

    def __init__(self, workdir: Path, ephemeral: bool = False):
        self.workdir = Path(workdir)
        self.path = self.workdir / STATE_FILENAME
        self.ephemeral = ephemeral
        self.data: dict = {"version": SCHEMA_VERSION, "vars": {}, "steps": {}}
        if self.path.exists():
            self.data = json.loads(self.path.read_text())
            self.data.setdefault("version", 1)
            self.data.setdefault("vars", {})
            self.data.setdefault("steps", {})

    # -- queries -------------------------------------------------------------

    def is_done(self, step_id: str) -> bool:
        return self.data["steps"].get(step_id, {}).get("status") == "done"

    def status(self, step_id: str) -> str:
        return self.data["steps"].get(step_id, {}).get("status", "pending")

    def entry(self, step_id: str) -> dict:
        return self.data["steps"].get(step_id, {})

    def outputs(self, step_id: str) -> dict:
        return self.entry(step_id).get("outputs", {})

    def params(self, step_id: str) -> dict:
        """The resolved ``with:`` block the step last ran with ({} for v1 records)."""
        return self.entry(step_id).get("params", {})

    def get_output(self, step_id: str, key: str):
        return self.outputs(step_id).get(key)

    def has_output(self, step_id: str, key: str) -> bool:
        return self.is_done(step_id) and key in self.outputs(step_id)

    def vars(self) -> dict:
        """The vars the last recorded run used (empty for a fresh workdir)."""
        return dict(self.data.get("vars") or {})

    def run_info(self) -> dict:
        """Run-level metadata: name, plan, mode, updated_at (whichever are set)."""
        return {k: self.data[k] for k in ("name", "plan", "mode", "updated_at") if k in self.data}

    # -- mutations -----------------------------------------------------------

    def begin_run(self, *, name: str, plan_path, vars: dict, mode: str) -> None:
        """Stamp the run-level record before the first step, so the vars a run
        used are on disk even if it fails partway."""
        self.data["version"] = SCHEMA_VERSION
        self.data["name"] = name
        self.data["plan"] = str(plan_path)
        self.data["mode"] = mode
        self.data["vars"] = dict(vars)
        self.data["updated_at"] = _now()
        self.save()

    def record(self, step_id: str, outputs: dict, *, action: str = "", params: dict | None = None,
               started_at: str = "", duration_s: float | None = None, mode: str = "run",
               persist: bool = False) -> None:
        entry = {
            "status": "done",
            "action": action,
            "mode": mode,
            "outputs": dict(outputs or {}),
            "params": dict(params or {}),
        }
        if started_at:
            entry["started_at"] = started_at
        entry["finished_at"] = _now()
        if duration_s is not None:
            entry["duration_s"] = round(duration_s, 3)

        self.data["steps"][step_id] = entry
        self.data["updated_at"] = _now()
        if self.ephemeral:
            if persist:
                self._merge_step_to_disk(step_id, entry)
        else:
            self.save()

    def set_output(self, step_id: str, key: str, value, *, action: str = "") -> None:
        """Pin one output by hand (``radiant set sync.offset=690.53``) so a rerun
        of a *later* step can use it without recomputing the producer."""
        entry = self.data["steps"].setdefault(step_id, {"outputs": {}, "params": {}})
        entry.setdefault("outputs", {})[key] = value
        entry["status"] = "done"
        entry["source"] = "manual"
        entry["finished_at"] = _now()
        # Timing/mode described the computation that produced the old value.
        for stale in ("mode", "duration_s", "started_at"):
            entry.pop(stale, None)
        if action and not entry.get("action"):
            entry["action"] = action
        self.data["updated_at"] = _now()
        self.save(force=True)

    def forget(self, step_id: str) -> bool:
        """Drop a step's record so it runs again. Returns False if nothing was recorded."""
        if step_id not in self.data["steps"]:
            return False
        del self.data["steps"][step_id]
        self.data["updated_at"] = _now()
        self.save(force=True)
        return True

    # -- persistence ---------------------------------------------------------

    def save(self, force: bool = False) -> None:
        if self.ephemeral and not force:
            return  # keep records in-memory only so downstream refs resolve
        self._write(self.data)

    def _merge_step_to_disk(self, step_id: str, entry: dict) -> None:
        """Write a single step into the on-disk record without publishing the
        rest of an ephemeral run's in-memory results."""
        disk: dict = {"version": SCHEMA_VERSION, "vars": {}, "steps": {}}
        if self.path.exists():
            disk = json.loads(self.path.read_text())
            disk.setdefault("steps", {})
        else:
            # Nothing on disk yet: carry over the run-level stamp only.
            for key in ("name", "plan", "vars"):
                if key in self.data:
                    disk[key] = self.data[key]
        disk["steps"][step_id] = entry
        disk["updated_at"] = _now()
        self._write(disk)

    def _write(self, data: dict) -> None:
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(_ordered(data), indent=2, ensure_ascii=False, default=str) + "\n"
        )


_KEY_ORDER = ("version", "name", "plan", "mode", "updated_at", "vars", "steps")


def _ordered(data: dict) -> dict:
    """Header first, then vars, then steps — so the file reads top-down."""
    out = {k: data[k] for k in _KEY_ORDER if k in data}
    out.update({k: v for k, v in data.items() if k not in out})
    return out
