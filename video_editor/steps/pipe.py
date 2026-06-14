"""pipe step — run a sequence of stage commands connected by OS pipes.

This is the declarative version of the kind of composition the ``encode`` step
does internally (``braw-decode | ffmpeg``): each stage is a normal action that
knows how to emit a command for a pipe (it implements ``Step.command``). The
first stage is a *source* (writes stdout), the last is the *sink* (writes the
output file), and any middle stages are filters (stdin → stdout).

A pipe runs as **one unit**. It deliberately cannot be resumed at a sub-stage —
there are no intermediate artifacts, only the byte stream. If the output is
deleted the whole pipe re-runs. (Use separate plan steps when you want per-stage
resume; use a pipe when you want streaming with no large intermediate on disk.)

Params:
  output : final output filename (the sink stage writes here)        (required)
  stages : ordered list of stage specs, each ``{action, with}``      (required, >= 2)

Outputs:
  file : absolute path to the sink stage's output
"""

import subprocess
import sys
from pathlib import Path

from .base import Step, StepContext


class PipeStep(Step):
    action = "pipe"
    produces = ("file",)
    artifacts = ("file",)

    def run(self, params: dict, ctx: StepContext) -> dict:
        from . import get_step  # lazy: avoids a circular import with the registry

        output_name = self.require(params, "output")
        stages = self.require(params, "stages")
        if not isinstance(stages, list) or len(stages) < 2:
            raise ValueError("pipe requires a 'stages' list of at least 2 stages")
        out = ctx.out_path(output_name)

        # Build each stage's argv, threading metadata from one stage to the next.
        argvs: list[list] = []
        upstream: dict | None = None
        last = len(stages) - 1
        for i, stage in enumerate(stages):
            if not isinstance(stage, dict) or "action" not in stage:
                raise ValueError(f"pipe stage #{i + 1} must be a mapping with an 'action'")
            sub_params = dict(stage.get("with") or {})
            argv, meta = get_step(str(stage["action"])).command(
                sub_params, ctx, upstream=upstream, out=out if i == last else None
            )
            argvs.append(argv)
            upstream = meta

        printed = " | ".join(" ".join(str(c) for c in a) for a in argvs)
        print(f"  $ {printed}")
        if ctx.dry_run:
            print(f"  [dry-run] would run {len(argvs)}-stage pipe → {out}")
            return {"file": str(out.resolve())}

        # Spawn the stages, connecting each stdout to the next stdin.
        procs: list[subprocess.Popen] = []
        prev_stdout = None
        for i, argv in enumerate(argvs):
            stdout = None if i == last else subprocess.PIPE
            proc = subprocess.Popen(argv, stdin=prev_stdout, stdout=stdout)
            if prev_stdout is not None:
                prev_stdout.close()  # let the upstream proc get SIGPIPE when this one exits
            prev_stdout = proc.stdout
            procs.append(proc)

        procs[-1].wait()
        for proc in procs[:-1]:
            proc.wait()

        # The sink must succeed; upstream stages may exit on SIGPIPE (-13) when the
        # sink stops early (e.g. -t / -shortest), which is normal.
        if procs[-1].returncode != 0:
            sys.exit(f"pipe sink ({stages[-1]['action']}) failed with exit code {procs[-1].returncode}")
        for i, proc in enumerate(procs[:-1]):
            if proc.returncode not in (0, -13):
                sys.exit(f"pipe stage {i + 1} ({stages[i]['action']}) failed with exit code {proc.returncode}")

        return {"file": str(out.resolve())}
