#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "faster-whisper",
#   "tqdm",
# ]
# ///

import sys
import wave
from pathlib import Path
from faster_whisper import WhisperModel
from tqdm import tqdm


def main():
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio.wav>", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    output_path = Path(audio_path).with_suffix(".txt")

    print("Loading whisper large model...", file=sys.stderr)
    model = WhisperModel("turbo", device="auto", compute_type="auto")

    with wave.open(audio_path) as wf:
        duration = wf.getnframes() / wf.getframerate()

    print(f"Transcribing {audio_path}...", file=sys.stderr)
    segments, info = model.transcribe(audio_path, language="ro")

    print(f"Detected language: {info.language} (probability: {info.language_probability:.2f})", file=sys.stderr)

    with open(output_path, "w") as f, tqdm(total=duration, unit="s", unit_scale=True, desc="Transcribing") as pbar:
        for segment in segments:
            f.write(f"{segment.start:.6f}\t{segment.end:.6f}\t{segment.text.strip()}\n")
            f.flush()
            pbar.update(segment.end - pbar.n)

    print(f"Labels written to {output_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
