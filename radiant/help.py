"""Render action documentation from each step's declared ``params`` / ``outputs``.

This is the single consumer of the uniform step spec for human-facing help. Both
``radiant help`` (the action index) and ``radiant help <action>`` (one
action's parameters and outputs) are built entirely from the declarations, so the
docs can never drift from what the code actually reads.
"""

from __future__ import annotations

from .steps import REGISTRY
from .steps.base import Param


def _fmt_default(p: Param) -> str:
    """A short tag shown after a param: requiredness and/or its default."""
    if p.required:
        return "required"
    if not p.has_default or p.default is None:
        return "optional"
    if p.default == "":
        return 'default ""'
    if isinstance(p.default, bool):
        return f"default {str(p.default).lower()}"
    return f"default {p.default}"


def _type_label(p: Param) -> str:
    if p.type == "enum" and p.choices:
        return "|".join(str(c) for c in p.choices)
    return p.type


def action_summaries() -> list[tuple[str, str]]:
    """(action, summary) for every registered action, sorted by name."""
    rows = []
    for action in sorted(REGISTRY):
        cls = REGISTRY[action]
        rows.append((action, cls.summary or "(no summary)"))
    return rows


def render_index() -> str:
    """The ``radiant help`` overview: every action and its one-liner."""
    rows = action_summaries()
    width = max((len(a) for a, _ in rows), default=0)
    lines = [
        "Available actions (use `radiant help <action>` for parameters):",
        "",
    ]
    for action, summary in rows:
        lines.append(f"  {action:<{width}}  {summary}")
    lines += [
        "",
        "Plans reference an earlier step's output with ${steps.<id>.<output>}",
        "and a plan var with ${vars.<name>}.",
    ]
    return "\n".join(lines)


def render_action(action: str) -> str:
    """Full help for one action: summary, parameters, and outputs."""
    if action not in REGISTRY:
        known = ", ".join(sorted(REGISTRY))
        return f"Unknown action '{action}'. Known actions: {known}"

    cls = REGISTRY[action]
    lines = [f"{action} — {cls.summary or '(no summary)'}", ""]

    if cls.params:
        name_w = max(len(p.name) for p in cls.params)
        type_w = max(len(_type_label(p)) for p in cls.params)
        lines.append("Parameters:")
        for p in cls.params:
            tag = _fmt_default(p)
            head = f"  {p.name:<{name_w}}  {_type_label(p):<{type_w}}  ({tag})"
            lines.append(head)
            lines.append(f"      {p.description}")
        lines.append("")
    else:
        lines.append("Parameters: none")
        lines.append("")

    if cls.outputs:
        out_w = max(len(o.name) for o in cls.outputs)
        lines.append("Outputs:")
        for o in cls.outputs:
            tag = " (artifact)" if o.artifact else ""
            lines.append(f"  {o.name:<{out_w}}{tag}  {o.description}")
    else:
        lines.append("Outputs: none")

    return "\n".join(lines)
