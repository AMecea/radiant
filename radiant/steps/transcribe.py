"""transcribe step — Whisper transcript with per-segment timestamps.

Writes a ``<input-stem>.txt`` with ``start\\tend\\ttext`` lines (handy for eyeballing
reel start/end timestamps).
"""

import sys
from pathlib import Path

from .base import Output, Param, Step, StepContext


class TranscribeStep(Step):
    action = "transcribe"
    summary = "Whisper transcript with per-segment start/end timestamps."
    params = (
        Param("input", "Audio/video file to transcribe.", type="path", required=True),
        Param("language", "Spoken-language hint passed to Whisper.", default="ro"),
        Param("model", "faster-whisper model name (e.g. tiny, base, turbo).", default="turbo"),
    )
    outputs = (
        Output("transcript", "Absolute path to the written .txt transcript.", artifact=True),
    )

    def run(self, params: dict, ctx: StepContext) -> dict:
        import subprocess

        input_path = Path(self.require(params, "input"))
        language = params.get("language", "ro")
        model_name = params.get("model", "turbo")
        out = ctx.out_path(input_path.stem + ".txt")

        if ctx.dry_run:
            print(f"  [dry-run] would transcribe {input_path} ({language}) → {out}")
            return {"transcript": str(out.resolve())}

        if not input_path.exists():
            sys.exit(f"Error: input file not found: {input_path}")

        # Preview: transcribe only the first N seconds (trim to a temp wav first).
        transcribe_src = input_path
        if ctx.preview is not None:
            transcribe_src = ctx.step_dir / "preview_audio.wav"
            print(f"  Preview: transcribing first {ctx.preview}s only")
            subprocess.run(
                ["ffmpeg", "-y", "-t", str(ctx.preview), "-i", str(input_path),
                 "-ac", "1", "-ar", "16000", "-vn", str(transcribe_src)],
                check=True, stderr=subprocess.DEVNULL,
            )

        from faster_whisper import WhisperModel
        from tqdm import tqdm

        print(f"  Loading whisper '{model_name}' model...")
        model = WhisperModel(model_name, device="auto", compute_type="auto")

        print(f"  Transcribing {transcribe_src} (language={language})...")
        segments, info = model.transcribe(str(transcribe_src), language=language)
        print(f"  Detected language: {info.language} (probability: {info.language_probability:.2f})")
        duration = float(info.duration) if getattr(info, "duration", None) else 0.0

        with open(out, "w") as f, tqdm(total=duration or None, unit="s", unit_scale=True, desc="Transcribing") as pbar:
            for segment in segments:
                f.write(f"{segment.start:.6f}\t{segment.end:.6f}\t{segment.text.strip()}\n")
                f.flush()
                pbar.update(max(0.0, segment.end - pbar.n))

        print(f"  Transcript written to {out}")
        return {"transcript": str(out.resolve())}
