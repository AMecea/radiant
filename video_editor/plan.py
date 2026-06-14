"""Plan model: YAML loading, reference resolution, validation, and the run loop."""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from . import hooks
from .state import State
from .steps import artifacts_for, get_step, produces_for
from .steps.base import StepContext

_REF_RE = re.compile(r"\$\{([^}]+)\}")


class PlanError(Exception):
    """A static problem with the plan (bad reference, cycle, unknown action…)."""


@dataclass
class PlanStep:
    index: int          # 1-based position
    id: str
    action: str
    needs: list[str]
    with_: dict = field(default_factory=dict)


@dataclass
class Plan:
    name: str
    workdir: Path
    vars: dict
    hooks: dict
    steps: list[PlanStep]
    path: Path

    # -- loading -------------------------------------------------------------

    @classmethod
    def load(cls, path: Path, var_overrides: dict | None = None, workdir_override: Path | None = None) -> "Plan":
        path = Path(path)
        if not path.exists():
            raise PlanError(f"plan file not found: {path}")
        doc = yaml.safe_load(path.read_text()) or {}

        name = doc.get("name") or path.stem
        merged_vars = dict(doc.get("vars") or {})
        if var_overrides:
            merged_vars.update(var_overrides)

        raw_steps = doc.get("steps") or []
        steps: list[PlanStep] = []
        for i, s in enumerate(raw_steps, start=1):
            if "id" not in s:
                raise PlanError(f"step #{i} is missing an 'id'")
            if "action" not in s:
                raise PlanError(f"step '{s['id']}' is missing an 'action'")
            steps.append(PlanStep(
                index=i,
                id=str(s["id"]),
                action=str(s["action"]),
                needs=list(s.get("needs") or []),
                with_=dict(s.get("with") or {}),
            ))

        workdir = workdir_override or doc.get("workdir") or (Path("runs") / name)
        return cls(
            name=name,
            workdir=Path(workdir),
            vars=merged_vars,
            hooks=dict(doc.get("hooks") or {}),
            steps=steps,
            path=path,
        )

    # -- lookups -------------------------------------------------------------

    @property
    def by_id(self) -> dict[str, PlanStep]:
        return {s.id: s for s in self.steps}

    def step_at(self, index: int) -> PlanStep:
        return self.steps[index - 1]

    # -- static validation ---------------------------------------------------

    def validate(self) -> None:
        ids = [s.id for s in self.steps]
        dupes = {x for x in ids if ids.count(x) > 1}
        if dupes:
            raise PlanError(f"duplicate step ids: {', '.join(sorted(dupes))}")

        by_id = self.by_id
        for s in self.steps:
            if s.action not in self._known_actions():
                raise PlanError(
                    f"step '{s.id}': unknown action '{s.action}' "
                    f"(known: {', '.join(self._known_actions())})"
                )
            for dep in s.needs:
                if dep not in by_id:
                    raise PlanError(f"step '{s.id}': needs unknown step '{dep}'")

        self._check_acyclic()

        # Every ${...} reference must resolve statically.
        for s in self.steps:
            for ref in self._refs_in(s.with_):
                self._validate_ref(ref, s)

    def _known_actions(self) -> list[str]:
        from .steps import REGISTRY
        return sorted(REGISTRY)

    def _check_acyclic(self) -> None:
        by_id = self.by_id
        state = {}  # id -> 0 unvisited, 1 visiting, 2 done

        def visit(node: str, stack: list[str]):
            if state.get(node) == 2:
                return
            if state.get(node) == 1:
                cycle = " -> ".join(stack + [node])
                raise PlanError(f"dependency cycle: {cycle}")
            state[node] = 1
            for dep in by_id[node].needs:
                visit(dep, stack + [node])
            state[node] = 2

        for s in self.steps:
            visit(s.id, [])

    def _validate_ref(self, ref: str, step: PlanStep) -> None:
        parts = ref.split(".")
        if parts[0] == "vars":
            if len(parts) != 2:
                raise PlanError(f"step '{step.id}': malformed reference '${{{ref}}}'")
            if parts[1] not in self.vars:
                raise PlanError(f"step '{step.id}': unknown var '{parts[1]}' in '${{{ref}}}'")
        elif parts[0] == "steps":
            if len(parts) != 3:
                raise PlanError(f"step '{step.id}': malformed reference '${{{ref}}}' (expected steps.<id>.<output>)")
            _, dep_id, out = parts
            by_id = self.by_id
            if dep_id not in by_id:
                raise PlanError(f"step '{step.id}': references unknown step '{dep_id}'")
            dep = by_id[dep_id]
            if dep.index >= step.index:
                raise PlanError(
                    f"step '{step.id}' references '{dep_id}' which is not an earlier step "
                    "(steps run in plan order; reorder so producers come first)"
                )
            if out not in produces_for(dep.action):
                raise PlanError(
                    f"step '{step.id}': step '{dep_id}' (action '{dep.action}') "
                    f"does not produce '{out}' (it produces: {', '.join(produces_for(dep.action)) or 'nothing'})"
                )
        else:
            raise PlanError(f"step '{step.id}': unknown reference root '{parts[0]}' in '${{{ref}}}'")

    @staticmethod
    def _refs_in(value) -> list[str]:
        found: list[str] = []
        if isinstance(value, str):
            found += _REF_RE.findall(value)
        elif isinstance(value, dict):
            for v in value.values():
                found += Plan._refs_in(v)
        elif isinstance(value, list):
            for v in value:
                found += Plan._refs_in(v)
        return found

    # -- reference resolution (runtime) --------------------------------------

    def resolve(self, value, step: PlanStep, state: State):
        """Resolve ${vars.x} / ${steps.id.out} in a (possibly nested) value."""
        if isinstance(value, dict):
            return {k: self.resolve(v, step, state) for k, v in value.items()}
        if isinstance(value, list):
            return [self.resolve(v, step, state) for v in value]
        if not isinstance(value, str):
            return value

        # Whole-string reference → preserve the resolved value's native type.
        m = _REF_RE.fullmatch(value.strip())
        if m:
            return self._resolve_ref(m.group(1), step, state)

        # Embedded reference(s) → string substitution.
        return _REF_RE.sub(lambda mt: str(self._resolve_ref(mt.group(1), step, state)), value)

    def _resolve_ref(self, ref: str, step: PlanStep, state: State):
        parts = ref.split(".")
        if parts[0] == "vars":
            return self.vars[parts[1]]
        if parts[0] == "steps":
            _, dep_id, out = parts
            if not state.is_done(dep_id):
                raise PlanError(
                    f"step '{step.id}' needs output '{out}' from step '{dep_id}', which hasn't run yet.\n"
                    f"  Run `--step {dep_id}` first (or include it in the range)."
                )
            if out not in state.outputs(dep_id):
                raise PlanError(
                    f"step '{step.id}' needs output '{out}' from step '{dep_id}', "
                    f"but that step produced no such output."
                )
            return state.get_output(dep_id, out)
        raise PlanError(f"unknown reference root '{parts[0]}' in '${{{ref}}}'")

    # -- step selection ------------------------------------------------------

    def select(self, selector: str | None) -> list[PlanStep]:
        if not selector:
            return list(self.steps)
        indices: set[int] = set()
        for token in selector.split(","):
            indices |= self._parse_token(token.strip())
        return [s for s in self.steps if s.index in indices]

    def _parse_token(self, token: str) -> set[int]:
        if not token:
            return set()
        last = len(self.steps)
        by_id = self.by_id

        # Exact id match wins (handles ids containing '-').
        if token in by_id:
            return {by_id[token].index}

        if "-" in token:
            left, right = token.split("-", 1)
            start = self._endpoint(left, default=1)
            end = self._endpoint(right, default=last)
            if start > end:
                start, end = end, start
            return set(range(start, end + 1))

        return {self._endpoint(token, default=None)}

    def _endpoint(self, tok: str, default):
        tok = tok.strip()
        if tok == "":
            return default
        if tok.isdigit():
            n = int(tok)
            if not (1 <= n <= len(self.steps)):
                raise PlanError(f"step index {n} out of range (1..{len(self.steps)})")
            return n
        if tok in self.by_id:
            return self.by_id[tok].index
        raise PlanError(f"unknown step '{tok}' in selector")

    # -- run -----------------------------------------------------------------

    def run(self, selector: str | None = None, force: bool = False,
            dry_run: bool = False, preview: int | None = None) -> None:
        self.validate()
        selected = self.select(selector)
        if not selected:
            print("No steps selected.")
            return

        # Preview runs are ephemeral: results stay in-memory so the chain resolves,
        # but state.json is never written — a later full run is neither skipped nor blocked.
        ephemeral = dry_run or preview is not None
        if not ephemeral:
            self.workdir.mkdir(parents=True, exist_ok=True)
        state = State(self.workdir, dry_run=ephemeral)
        print(f"Plan '{self.name}'  workdir={self.workdir}")
        if preview is not None:
            print(f"PREVIEW mode: long steps capped to {preview}s, outputs prefixed 'preview_', state not saved")
        print(f"Running steps: {', '.join(f'{s.index}:{s.id}' for s in selected)}\n")

        hook_ctx = {"name": self.name, "url": "", "step": "", "code": 0}
        hooks.run_hook(self.hooks, "on_start", hook_ctx, dry_run=dry_run)

        last_url = ""
        current = ""
        try:
            for s in selected:
                current = s.id
                if not force and self._is_fresh(s, state):
                    print(f"[{s.index}/{len(self.steps)}] {s.id} ({s.action}) — already done, skipping (use --force to rerun)")
                    last_url = state.get_output(s.id, "url") or last_url
                    continue

                print(f"[{s.index}/{len(self.steps)}] {s.id} ({s.action})")
                params = self.resolve(s.with_, s, state)
                ctx = StepContext(step_id=s.id, workdir=self.workdir, dry_run=dry_run, preview=preview)
                outputs = get_step(s.action).run(params, ctx)

                state.record(s.id, outputs)  # no-op on disk during dry-run
                print(f"  {'[dry-run] ' if dry_run else ''}outputs: {outputs}\n")
                last_url = (outputs or {}).get("url") or last_url
        except PlanError as e:
            hooks.run_hook(self.hooks, "on_failure", {**hook_ctx, "step": current, "code": 1}, dry_run=dry_run)
            sys.exit(f"Error: {e}")
        except BaseException:
            # SystemExit (a step's sys.exit) and any other failure both notify.
            hooks.run_hook(self.hooks, "on_failure", {**hook_ctx, "step": current, "code": 1}, dry_run=dry_run)
            raise

        hooks.run_hook(self.hooks, "on_success", {**hook_ctx, "url": last_url}, dry_run=dry_run)
        print("Done.")

    def _is_fresh(self, step: PlanStep, state: State) -> bool:
        """A step is fresh if done and all its file artifacts still exist."""
        if not state.is_done(step.id):
            return False
        for key in artifacts_for(step.action):
            path = state.get_output(step.id, key)
            if not path or not Path(path).exists():
                return False
        return True
