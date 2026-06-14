"""Optional shell hooks: on_start / on_success / on_failure.

Defined per-plan under ``hooks:``. The user puts whatever they want there
(``caffeinate``, ``telegram send``, ...). Hook strings support ``{name}``,
``{step}``, ``{code}`` and ``{url}`` placeholders. Missing hooks are no-ops; a
failing hook is reported but never masks the underlying run result.
"""

import subprocess

_PLACEHOLDERS = ("name", "step", "code", "url", "message")


def _format(template: str, ctx: dict) -> str:
    safe = {k: ctx.get(k, "") for k in _PLACEHOLDERS}
    try:
        return template.format(**safe)
    except (KeyError, IndexError, ValueError):
        # Don't let a stray brace in the user's command break the run.
        return template


def run_hook(hooks: dict, name: str, ctx: dict, dry_run: bool = False) -> None:
    template = (hooks or {}).get(name)
    if not template:
        return
    cmd = _format(template, ctx)
    print(f"  [hook:{name}] $ {cmd}")
    if dry_run:
        return
    try:
        subprocess.run(cmd, shell=True, check=True)
    except subprocess.CalledProcessError as e:
        print(f"  [hook:{name}] warning: exited {e.returncode} (ignored)")
