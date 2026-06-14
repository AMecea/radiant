"""shell step — run an arbitrary shell command, standalone or as a `pipe` stage.

Standalone it just runs ``cmd`` (honouring --dry-run). Inside a ``pipe`` it slots
into the chain as whatever the command is: a **source** (writes stdout), a
**filter** (stdin → stdout), or a **sink** (consumes the stream / writes a file).
The command runs via ``sh -c``, so normal shell features work — inner pipes,
redirects, env vars, etc.

The token ``{output}`` in ``cmd`` is replaced with the resolved output path
(``runs/<name>/<id>/<output>``, ``preview_``-prefixed under --preview). Set
``output`` when the command writes a file you want tracked as the artifact (so a
finished step is skipped on re-run unless the file is deleted).

Examples
  # standalone: probe + thumbnail
  - id: thumb
    action: shell
    with:
      cmd: "ffmpeg -y -i ${steps.master.file} -ss 5 -vframes 1 {output}"
      output: thumb.jpg
  # pipe source: feed a download into ffmpeg
  - action: shell
    with: { cmd: "curl -fsSL ${vars.url}" }
  # pipe sink: compress a stream to a file
  - action: shell
    with: { cmd: "zstd -q -o {output} -", output: master.mkv.zst }

Params:
  cmd     : shell command to run (required); ``{output}`` → resolved output path
  output  : output filename; when set, produced as ``file`` and tracked for resume

Outputs:
  file : absolute path to ``output`` (only when ``output`` is set)
"""

import subprocess
import sys
from pathlib import Path

from .base import Step, StepContext


class ShellStep(Step):
    action = "shell"
    produces = ("file",)
    artifacts = ("file",)

    def _resolve(self, params: dict, ctx: StepContext, out: Path | None) -> str:
        cmd = str(self.require(params, "cmd"))
        if "{output}" in cmd:
            if out is None:
                raise ValueError("shell cmd uses {output} but no 'output' filename was given")
            cmd = cmd.replace("{output}", str(out))
        return cmd

    def run(self, params: dict, ctx: StepContext) -> dict:
        output = params.get("output")
        out = ctx.out_path(output) if output else None
        cmd = self._resolve(params, ctx, out)

        print(f"  $ {cmd}")
        if not ctx.dry_run:
            try:
                subprocess.run(cmd, shell=True, check=True)
            except subprocess.CalledProcessError as e:
                sys.exit(f"shell command failed with exit code {e.returncode}: {cmd}")
        return {"file": str(out.resolve())} if out else {}

    def command(self, params: dict, ctx: StepContext, *, upstream: dict | None = None,
                out: Path | None = None, is_last: bool = False) -> tuple[list, dict]:
        # A stage may write a file via its own `output` (or the pipe's, passed as `out`).
        output = params.get("output")
        target = out if out is not None else (ctx.out_path(output) if output else None)
        cmd = self._resolve(params, ctx, target)
        argv = ["sh", "-c", cmd]
        if is_last:
            produces = {"file": str(target.resolve())} if target else {}
            return argv, {"produces": produces}
        return argv, {}
