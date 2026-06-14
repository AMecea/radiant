"""pause step — a manual checkpoint.

When reached in a normal run, it halts the pipeline cleanly (exit 0) and notifies
the user that input is expected (e.g. read the transcript, pick reel timestamps,
then resume with `--step <next>-`). In `--dry-run` / `--preview` it does not halt —
those modes are meant to walk/produce the whole chain — it just prints a note.

Produces nothing. Optional param:
  message : text shown to the user when pausing
"""

from .base import PauseSignal, Step, StepContext

DEFAULT_MESSAGE = "Manual input expected before continuing."


class PauseStep(Step):
    action = "pause"
    produces = ()

    def run(self, params: dict, ctx: StepContext) -> dict:
        message = params.get("message") or DEFAULT_MESSAGE
        if ctx.dry_run or ctx.preview is not None:
            print(f"  [pause] would stop here for input: {message}")
            return {}
        raise PauseSignal(message)
