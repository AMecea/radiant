"""pipe step — run a sequence of stage commands connected by OS pipes.

This is the declarative version of the kind of composition the ``encode`` step
does internally (``braw-decode | ffmpeg``): each stage is a normal action that
knows how to emit a command for a pipe (it implements ``Step.command``). The
first stage is a *source* (writes stdout), the last is the *sink*, and any middle
stages are filters (stdin → stdout). The sink either writes the ``output`` file
(e.g. ``ffmpeg``, ``shell``) or consumes the stream itself (e.g.
``upload_stream`` → remote) and reports its own outputs.

A pipe runs as **one unit**. It deliberately cannot be resumed at a sub-stage —
there are no intermediate artifacts, only the byte stream. If the output is
deleted (or the sink produces no file) the whole pipe re-runs. (Use separate plan
steps for per-stage resume; use a pipe for streaming with no large intermediate.)

Params:
  output : final output filename, when the sink writes a file        (optional)
  stages : ordered list of stage specs, each ``{action, with}``      (required, >= 2)

Outputs (whichever the sink reports):
  file : absolute path to the sink's output file (file sinks), or
  url  : remote destination / public URL (streaming-upload sinks)
"""

import subprocess
import sys

from .base import Step, StepContext


class PipeStep(Step):
    action = "pipe"
    produces = ("file", "url")
    artifacts = ("file",)   # only file sinks are resumable; url-only pipes re-run

    def run(self, params: dict, ctx: StepContext) -> dict:
        from . import get_step  # lazy: avoids a circular import with the registry

        stages = self.require(params, "stages")
        if not isinstance(stages, list) or len(stages) < 2:
            raise ValueError("pipe requires a 'stages' list of at least 2 stages")
        output_name = params.get("output")
        out = ctx.out_path(output_name) if output_name else None

        # Build each stage's argv, threading metadata from one stage to the next.
        argvs: list[list] = []
        upstream: dict | None = None
        last = len(stages) - 1
        sink_meta: dict = {}
        for i, stage in enumerate(stages):
            if not isinstance(stage, dict) or "action" not in stage:
                raise ValueError(f"pipe stage #{i + 1} must be a mapping with an 'action'")
            sub_params = dict(stage.get("with") or {})
            is_last = i == last
            argv, meta = get_step(str(stage["action"])).command(
                sub_params, ctx, upstream=upstream, out=out if is_last else None, is_last=is_last
            )
            argvs.append(argv)
            upstream = meta
            if is_last:
                sink_meta = meta or {}

        # The sink may declare its own outputs (e.g. a url); otherwise it wrote `out`.
        outputs = sink_meta.get("produces")
        if outputs is None:
            if out is None:
                raise ValueError(
                    "pipe needs an 'output' filename (for a file sink) or a sink stage that "
                    "produces its own outputs (e.g. upload_stream)"
                )
            outputs = {"file": str(out.resolve())}

        printed = " | ".join(" ".join(str(c) for c in a) for a in argvs)
        print(f"  $ {printed}")
        if ctx.dry_run:
            print(f"  [dry-run] would run {len(argvs)}-stage pipe → {out if out is not None else '(streamed)'}")
            return outputs

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

        return outputs
