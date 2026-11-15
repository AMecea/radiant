"""transcribe step — Whisper transcript with per-segment (and optionally per-word) timestamps.

Always writes a ``<input-stem>.txt`` with ``start\\tend\\ttext`` lines (handy for
eyeballing reel start/end timestamps). With ``word_timestamps: true`` it also writes a
``<input-stem>.words.json`` holding every segment with its words' own start/end times.
"""

import json
import sys
from pathlib import Path

from .base import Output, Param, Step, StepContext


class TranscribeStep(Step):
    action = "transcribe"
    summary = "Whisper transcript with per-segment (and optionally per-word) timestamps."
    params = (
        Param("input", "Audio/video file to transcribe.", type="path", required=True),
        Param("language", "Spoken-language hint passed to Whisper.", default="ro"),
        Param("model", "faster-whisper model name (e.g. tiny, base, turbo).", default="turbo"),
        Param("word_timestamps",
              "Also write <stem>.words.json with per-word start/end times "
              "(segments → words, each with start, end, word, probability).",
              type="bool", default=False),
    )
    outputs = (
        Output("transcript", "Absolute path to the written .txt transcript (segment level).",
               artifact=True),
        # Not an artifact: it's empty when word_timestamps is off, and an empty artifact
        # path would make the step look stale forever. Toggling the param is caught by
        # the input-drift warning instead.
        Output("words", "Absolute path to the .words.json word-level transcript, "
                        "or '' when word_timestamps is off."),
    )

    def run(self, params: dict, ctx: StepContext) -> dict:
        import subprocess

        input_path = Path(self.require(params, "input"))
        language = params.get("language", "ro")
        model_name = params.get("model", "turbo")
        want_words = self.as_bool(params.get("word_timestamps"))
        out = ctx.out_path(input_path.stem + ".txt")
        words_out = ctx.out_path(input_path.stem + ".words.json") if want_words else None
        result = {
            "transcript": str(out.resolve()),
            "words": str(words_out.resolve()) if words_out else "",
        }

        if ctx.dry_run:
            extra = f" + {words_out}" if words_out else ""
            print(f"  [dry-run] would transcribe {input_path} ({language}) → {out}{extra}")
            return result

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

        print(f"  Transcribing {transcribe_src} (language={language}"
              f"{', word timestamps' if want_words else ''})...")
        segments, info = model.transcribe(str(transcribe_src), language=language,
                                          word_timestamps=want_words)
        print(f"  Detected language: {info.language} (probability: {info.language_probability:.2f})")
        duration = float(info.duration) if getattr(info, "duration", None) else 0.0

        seg_records = []
        with open(out, "w") as f, tqdm(total=duration or None, unit="s", unit_scale=True, desc="Transcribing") as pbar:
            for segment in segments:
                f.write(f"{segment.start:.6f}\t{segment.end:.6f}\t{segment.text.strip()}\n")
                f.flush()
                if want_words:
                    seg_records.append(segment_record(segment))
                pbar.update(max(0.0, segment.end - pbar.n))

        print(f"  Transcript written to {out}")
        if words_out:
            write_words_json(words_out, seg_records, language=info.language, duration=duration)
            print(f"  Word-level transcript written to {words_out}")
        return result


def segment_record(segment) -> dict:
    """One faster-whisper segment (transcribed with word_timestamps) as a plain dict."""
    return {
        "start": round(float(segment.start), 3),
        "end": round(float(segment.end), 3),
        "text": segment.text.strip(),
        "words": [
            {
                "start": round(float(w.start), 3),
                "end": round(float(w.end), 3),
                "word": w.word.strip(),
                "probability": round(float(w.probability), 4),
            }
            for w in (segment.words or [])
        ],
    }


def write_words_json(path: Path, segments: list[dict], *, language: str, duration: float) -> None:
    payload = {"language": language, "duration": round(duration, 3), "segments": segments}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
