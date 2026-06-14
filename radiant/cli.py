"""Command-line entry point: ``radiant run | list | validate``."""

import argparse
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

    p_help = sub.add_parser("help", help="Document actions and their parameters/outputs")
    p_help.add_argument("action", nargs="?", help="Action to describe (omit to list all actions)")
    p_help.set_defaults(func=cmd_help)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
