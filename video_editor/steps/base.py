"""Step contract and execution context."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass
class StepContext:
    """Runtime context handed to a step's ``run``.

    - ``step_id``  : the plan's id for this step
    - ``workdir``  : the plan's persistent working directory
    - ``step_dir`` : ``<workdir>/<step_id>/`` (created on access)
    - ``dry_run``  : when True, steps should print commands instead of running them
    """

    step_id: str
    workdir: Path
    dry_run: bool = False
    out_dir: Path | None = None  # explicit override (used by the thin standalone wrappers)
    preview: int | None = None   # preview mode: cap long steps to this many seconds

    @property
    def step_dir(self) -> Path:
        d = self.out_dir if self.out_dir is not None else self.workdir / self.step_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def out_path(self, name: str) -> Path:
        """Resolve an output filename inside the step dir, prefixing 'preview_'
        in preview mode so a preview never clobbers or masquerades as the real artifact."""
        if self.preview is not None:
            name = "preview_" + name
        return self.step_dir / name

    def run(self, cmd: list, **kwargs) -> subprocess.CompletedProcess | None:
        """Echo and run a command, honouring ``dry_run``."""
        print(f"  $ {' '.join(str(c) for c in cmd)}")
        if self.dry_run:
            return None
        return subprocess.run(cmd, check=True, **kwargs)


class Step:
    """Base class for a pipeline action.

    Subclasses set ``action`` (the YAML ``action:`` name) and ``produces`` (the
    output keys the step writes to state), and implement ``run``.
    """

    action: str = ""
    produces: tuple[str, ...] = ()
    # Subset of ``produces`` that are filesystem paths — used by the runner to
    # detect when a "done" step's artifact has been deleted and must be rebuilt.
    artifacts: tuple[str, ...] = ()

    def run(self, params: dict, ctx: StepContext) -> dict:
        """Execute the step. Return a dict whose keys are exactly ``produces``."""
        raise NotImplementedError

    # -- small param helpers shared by steps ---------------------------------

    @staticmethod
    def require(params: dict, key: str):
        if key not in params or params[key] is None:
            raise ValueError(f"missing required parameter '{key}'")
        return params[key]

    @staticmethod
    def as_bool(value, default: bool = False) -> bool:
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in ("1", "true", "yes", "on")
