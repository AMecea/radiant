"""Action registry: maps a plan's ``action:`` name to its Step implementation."""

from .base import Step, StepContext
from .braw_decode import BrawDecodeStep
from .clip import ClipStep
from .encode import EncodeStep
from .ffmpeg import FfmpegStep
from .pause import PauseStep
from .pipe import PipeStep
from .shell import ShellStep
from .sync import SyncStep
from .transcribe import TranscribeStep
from .trim import TrimStep
from .upload import UploadStep
from .upload_stream import UploadStreamStep
from .youtube import YouTubeUploadStep

_STEP_CLASSES = [
    SyncStep, EncodeStep, ClipStep, TranscribeStep, UploadStep,
    PauseStep, FfmpegStep, BrawDecodeStep, PipeStep, ShellStep, UploadStreamStep,
    TrimStep, YouTubeUploadStep,
]

REGISTRY: dict[str, type[Step]] = {cls.action: cls for cls in _STEP_CLASSES}


def get_step(action: str) -> Step:
    if action not in REGISTRY:
        known = ", ".join(sorted(REGISTRY))
        raise KeyError(f"unknown action '{action}' (known actions: {known})")
    return REGISTRY[action]()


def produces_for(action: str) -> tuple[str, ...]:
    """Output keys an action declares (for plan reference validation)."""
    return REGISTRY[action].produces if action in REGISTRY else ()


def artifacts_for(action: str) -> tuple[str, ...]:
    """Output keys that are filesystem paths (for staleness detection)."""
    return REGISTRY[action].artifacts if action in REGISTRY else ()


__all__ = ["Step", "StepContext", "REGISTRY", "get_step", "produces_for", "artifacts_for"]
