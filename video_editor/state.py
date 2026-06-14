"""Persistent run state — the artifact registry stored at ``<workdir>/state.json``.

Tracks, per step id: status (``done``) and the outputs it produced (scalars stored
inline, file artifacts as absolute paths).
"""

import json
from pathlib import Path

STATE_FILENAME = "state.json"


class State:
    def __init__(self, workdir: Path, dry_run: bool = False):
        self.workdir = Path(workdir)
        self.path = self.workdir / STATE_FILENAME
        self.dry_run = dry_run
        self.data: dict = {"steps": {}}
        if self.path.exists():
            self.data = json.loads(self.path.read_text())
            self.data.setdefault("steps", {})

    # -- queries -------------------------------------------------------------

    def is_done(self, step_id: str) -> bool:
        return self.data["steps"].get(step_id, {}).get("status") == "done"

    def status(self, step_id: str) -> str:
        return self.data["steps"].get(step_id, {}).get("status", "pending")

    def outputs(self, step_id: str) -> dict:
        return self.data["steps"].get(step_id, {}).get("outputs", {})

    def get_output(self, step_id: str, key: str):
        return self.outputs(step_id).get(key)

    def has_output(self, step_id: str, key: str) -> bool:
        return self.is_done(step_id) and key in self.outputs(step_id)

    # -- mutations -----------------------------------------------------------

    def record(self, step_id: str, outputs: dict) -> None:
        self.data["steps"][step_id] = {"status": "done", "outputs": outputs}
        self.save()

    def save(self) -> None:
        if self.dry_run:
            return  # keep records in-memory only so downstream refs resolve
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, indent=2, ensure_ascii=False) + "\n")
