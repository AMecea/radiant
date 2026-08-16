"""Command-line entry point: ``radiant run | list | state | set | forget | validate``."""

import argparse
import json
import sys
from pathlib import Path

from .plan import Plan, PlanError


def _parse_vars(pairs: list[str]) -> dict:
    out = {}
    for p in pairs or []:
        if "=" not in p:
            sys.exit(f"Error: --vars expects key=value, got '{p}'")
        k, v = p.split("=", 1)
        out[k.strip()] = v
    return out


def _load(args) -> Plan:
    try:
        return Plan.load(
            Path(args.plan),
            var_overrides=_parse_vars(getattr(args, "vars", None)),
            workdir_override=Path(args.workdir) if getattr(args, "workdir", None) else None,
            reuse_vars=getattr(args, "reuse_vars", False),
        )
    except PlanError as e:
        sys.exit(f"Error: {e}")


def cmd_run(args) -> None:
    plan = _load(args)
    plan.run(selector=args.step, force=args.force, dry_run=args.dry_run, preview=args.preview)


def cmd_validate(args) -> None:
    plan = _load(args)
    try:
        plan.validate()
    except PlanError as e:
        sys.exit(f"Error: {e}")
    print(f"Plan '{plan.name}' is valid. {len(plan.steps)} steps:")
    for s in plan.steps:
        needs = f"  needs: {', '.join(s.needs)}" if s.needs else ""
        print(f"  {s.index}. {s.id} ({s.action}){needs}")


def cmd_list(args) -> None:
    from .state import State

    plan = _load(args)
    state = State(plan.workdir)
    print(f"Plan '{plan.name}'  workdir={plan.workdir}\n")
    print(f"  {'#':>2}  {'id':<16} {'action':<12} {'status':<9} outputs")
    print(f"  {'-'*2}  {'-'*16} {'-'*12} {'-'*9} {'-'*20}")
    for s in plan.steps:
        status = state.status(s.id)
        outs = state.outputs(s.id)
        out_str = ", ".join(f"{k}={_short(v)}" for k, v in outs.items()) if outs else ""
        print(f"  {s.index:>2}  {s.id:<16} {s.action:<12} {status:<9} {out_str}")


def _short(value) -> str:
    s = str(value)
    return s if len(s) <= 40 else "…" + s[-39:]


def cmd_state(args) -> None:
    """Show everything the workdir remembers: the vars the last run used and,
    per step, the inputs it ran with and the outputs it produced."""
    from .state import State

    plan = _load(args)
    state = State(plan.workdir)

    if args.json:
        print(json.dumps(state.data, indent=2, ensure_ascii=False, default=str))
        return

    if not state.path.exists():
        print(f"No state recorded yet at {state.path}")
        return

    info = state.run_info()
    print(f"Plan '{plan.name}'  workdir={plan.workdir}")
    print(f"  state:    {state.path}")
    if info.get("updated_at"):
        print(f"  last run: {info['updated_at']}  (mode: {info.get('mode', '?')})")

    recorded_vars = state.vars()
    if recorded_vars:
        width = max(len(k) for k in recorded_vars)
        print("\nvars used by the last run:")
        for k, v in recorded_vars.items():
            now = plan.vars.get(k, v)
            drift = "" if now == v else f"   (plan now: {now!r})"
            print(f"  {k:<{width}} = {v}{drift}")

    print("\nsteps:")
    for s in plan.steps:
        entry = state.entry(s.id)
        if not entry:
            print(f"  {s.index:>2}  {s.id} ({s.action}) — pending")
            continue
        tags = [entry.get("status", "?")]
        if entry.get("mode") and entry["mode"] != "run":
            tags.append(entry["mode"])
        if entry.get("source") == "manual":
            tags.append("set by hand")
        if entry.get("duration_s") is not None:
            tags.append(f"{entry['duration_s']:.1f}s")
        when = f"  {entry['finished_at']}" if entry.get("finished_at") else ""
        print(f"  {s.index:>2}  {s.id} ({s.action}) — {', '.join(tags)}{when}")
        for key, value in (entry.get("outputs") or {}).items():
            print(f"        out  {key} = {value}")
        for key, value in (entry.get("params") or {}).items():
            print(f"        in   {key} = {_short(value)}")


def cmd_set(args) -> None:
    """Pin step outputs by hand: ``radiant set --plan p.yaml sync.offset=690.53``.

    Useful when you already know a value (measured once, read off a previous log,
    or eyeballed) and want a later single-step rerun to consume it without
    re-running the producer."""
    from .state import State
    from .steps import produces_for

    plan = _load(args)
    state = State(plan.workdir)
    by_id = plan.by_id

    for assignment in args.assignments:
        if "=" not in assignment or "." not in assignment.split("=", 1)[0]:
            sys.exit(f"Error: expected <step>.<output>=<value>, got '{assignment}'")
        target, raw = assignment.split("=", 1)
        step_id, _, key = target.strip().rpartition(".")
        if step_id not in by_id:
            sys.exit(f"Error: unknown step '{step_id}' in plan '{plan.name}'")
        action = by_id[step_id].action
        produced = produces_for(action)
        if key not in produced:
            sys.exit(
                f"Error: step '{step_id}' (action '{action}') does not produce '{key}' "
                f"(it produces: {', '.join(produced) or 'nothing'})"
            )
        state.set_output(step_id, key, _coerce(raw), action=action)
        print(f"  set {step_id}.{key} = {_coerce(raw)!r}")

    print(f"Saved to {state.path}")


def _coerce(raw: str):
    """Store numbers/booleans/null as JSON scalars, everything else as a string."""
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def cmd_forget(args) -> None:
    """Drop recorded state for one or more steps so they run again."""
    from .state import State

    plan = _load(args)
    state = State(plan.workdir)
    for step_id in args.steps:
        if step_id not in plan.by_id:
            sys.exit(f"Error: unknown step '{step_id}' in plan '{plan.name}'")
        print(f"  {'forgot' if state.forget(step_id) else 'nothing recorded for'} {step_id}")


def cmd_help(args) -> None:
    from .help import render_action, render_index

    if args.action:
        print(render_action(args.action))
    else:
        print(render_index())


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(prog="radiant", description="YAML-driven video/audio pipeline.")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_common(p):
        p.add_argument("--plan", required=True, help="Path to the plan YAML")
        p.add_argument("--workdir", help="Override the plan's workdir (default: ./runs/<name>)")

    p_run = sub.add_parser("run", help="Run plan steps")
    add_common(p_run)
    p_run.add_argument("--step", help="Step selector: N, N-M, N-, -M, id, id1-id2, comma lists (default: all)")
    p_run.add_argument("--vars", nargs="*", metavar="K=V", help="Override/extend plan vars for this run")
    p_run.add_argument(
        "--reuse-vars", action="store_true",
        help="Start from the vars recorded by the last run in this workdir "
             "(so a one-off --vars need not be retyped on a single-step rerun); "
             "--vars still wins",
    )
    p_run.add_argument("--force", action="store_true", help="Rerun steps already marked done")
    p_run.add_argument("--dry-run", action="store_true", help="Print commands without running them")
    p_run.add_argument(
        "--preview", nargs="?", type=int, const=5, default=None, metavar="SECONDS",
        help="Preview mode: cap long steps (encode/clip/transcribe) to N seconds "
             "(default 5), skip uploads, prefix outputs 'preview_', and don't save state "
             "(so a later full run isn't skipped). Run again freely.",
    )
    p_run.set_defaults(func=cmd_run)

    p_val = sub.add_parser("validate", help="Validate the plan (refs, DAG, actions)")
    add_common(p_val)
    p_val.add_argument("--vars", nargs="*", metavar="K=V", help="Vars to consider during validation")
    p_val.set_defaults(func=cmd_validate)

    p_list = sub.add_parser("list", help="List steps and their state")
    add_common(p_list)
    p_list.add_argument("--vars", nargs="*", metavar="K=V", help=argparse.SUPPRESS)
    p_list.set_defaults(func=cmd_list)

    p_state = sub.add_parser("state", help="Show recorded vars, per-step inputs and outputs")
    add_common(p_state)
    p_state.add_argument("--vars", nargs="*", metavar="K=V", help=argparse.SUPPRESS)
    p_state.add_argument("--json", action="store_true", help="Dump the raw state.json")
    p_state.set_defaults(func=cmd_state)

    p_set = sub.add_parser("set", help="Pin a step output by hand (e.g. sync.offset=690.53)")
    add_common(p_set)
    p_set.add_argument("assignments", nargs="+", metavar="STEP.OUTPUT=VALUE")
    p_set.add_argument("--vars", nargs="*", metavar="K=V", help=argparse.SUPPRESS)
    p_set.set_defaults(func=cmd_set)

    p_forget = sub.add_parser("forget", help="Drop recorded state for steps so they run again")
    add_common(p_forget)
    p_forget.add_argument("steps", nargs="+", metavar="STEP_ID")
    p_forget.add_argument("--vars", nargs="*", metavar="K=V", help=argparse.SUPPRESS)
    p_forget.set_defaults(func=cmd_forget)

    p_help = sub.add_parser("help", help="Document actions and their parameters/outputs")
    p_help.add_argument("action", nargs="?", help="Action to describe (omit to list all actions)")
    p_help.set_defaults(func=cmd_help)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
