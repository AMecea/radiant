"""Step contract and execution context.

Every step declares its inputs and outputs *uniformly* via :class:`Param` and
:class:`Output` specs (the ``params`` / ``outputs`` class attributes). Those
declarations are the single source of truth: the runner derives ``produces`` and
``artifacts`` from them, plan validation checks required params against them, and
``radiant help <action>`` renders its documentation from them. Document each
parameter right where it is declared (the ``Param.description``) — not in prose
that can drift.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

# Sentinel: a Param with no default (distinct from ``default=None``, which means
# "the default value is None").
_NO_DEFAULT = object()


@dataclass(frozen=True)
class Param:
    """One input parameter a step reads from its ``with:`` block.

    - ``name``        : the YAML key under ``with:``
    - ``description`` : what it does (rendered verbatim by ``help``)
    - ``type``        : display hint — ``str``/``int``/``float``/``bool``/``path``/
                        ``list``/``ranges``/``enum`` (purely informational)
    - ``required``    : when True, the plan fails validation if the key is absent
    - ``default``     : the value used when omitted (shown by ``help``; leave unset
                        for required params or params with no meaningful default)
    - ``choices``     : allowed values, for ``type="enum"``
    """

    name: str
    description: str
    type: str = "str"
    required: bool = False
    default: object = _NO_DEFAULT
    choices: tuple = ()

    @property
    def has_default(self) -> bool:
        return self.default is not _NO_DEFAULT


@dataclass(frozen=True)
class Output:
    """One value a step records in state for later steps to reference.

    - ``name``        : the output key (referenced as ``${steps.<id>.<name>}``)
    - ``description`` : what it holds
    - ``artifact``    : True when it's a filesystem path the runner can check for
                        staleness (a deleted artifact triggers a rebuild)
    """

    name: str
    description: str
    artifact: bool = False


class PauseSignal(Exception):
    """Raised by the ``pause`` step to halt the run cleanly (exit 0) for manual input."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


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

    Subclasses declare, uniformly:

    - ``action``  : the YAML ``action:`` name
    - ``summary`` : a one-line description (shown by ``radiant help``)
    - ``params``  : the ``Param`` specs the step reads from its ``with:`` block
    - ``outputs`` : the ``Output`` specs the step records in state

    and implement ``run``. ``produces`` / ``artifacts`` are *derived* from
    ``outputs`` (see ``produced_keys`` / ``artifact_keys``) — declare an output
    once and the rest follows.
    """

    action: str = ""
    summary: str = ""
    params: tuple[Param, ...] = ()
    outputs: tuple[Output, ...] = ()

    # ``--preview`` caps long work, so most steps produce truncated results that
    # must not be saved. A pure-analysis step whose outputs are identical with or
    # without the cap sets this False, and the runner persists its outputs even
    # from a preview run — measuring the sync offset takes minutes, and throwing
    # it away just because the run was a preview is pure waste.
    preview_affects_output: bool = True

    # -- derived spec views (single source of truth = ``outputs``) -----------

    @classmethod
    def produced_keys(cls) -> tuple[str, ...]:
        """Output keys the step writes to state (for plan reference validation)."""
        return tuple(o.name for o in cls.outputs)

    @classmethod
    def artifact_keys(cls) -> tuple[str, ...]:
        """Output keys that are filesystem paths (for staleness detection)."""
        return tuple(o.name for o in cls.outputs if o.artifact)

    @classmethod
    def required_params(cls) -> tuple[str, ...]:
        return tuple(p.name for p in cls.params if p.required)

    def run(self, params: dict, ctx: StepContext) -> dict:
        """Execute the step. Return a dict whose keys are exactly ``produced_keys``."""
        raise NotImplementedError

    def command(self, params: dict, ctx: StepContext, *, upstream: dict | None = None,
                out: Path | None = None, is_last: bool = False) -> tuple[list, dict]:
        """Build an argv for use as a stage inside a ``pipe`` step.

        - ``upstream``: metadata from the previous stage (e.g. ffmpeg input args
          describing its stdout), or ``None`` for the first stage.
        - ``out``: the output file path when this stage is a file *sink*, else
          ``None`` (the stage writes to stdout, or is a non-file sink).
        - ``is_last``: True when this is the pipe's final stage. A non-final
          stage must write to stdout; the final stage consumes the pipe.

        Returns ``(argv, meta)`` handed to the next stage. The *last* stage may
        return ``meta["produces"]`` (a dict) to set the pipe's outputs; otherwise
        the pipe records ``{"file": out}``. Steps that can't be piped leave this
        unimplemented.
        """
        raise NotImplementedError(f"action '{self.action}' cannot be used as a `pipe` stage")

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
