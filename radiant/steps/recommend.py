"""recommend step — propose the passages of a recording worth cutting into reels / shorts.

Reads the word-level transcript the ``transcribe`` step writes (``<stem>.words.json``),
asks a language model which passages would stand on their own as a short vertical
video, and writes ``<stem>.clips.json`` — the file textcut lists as "Recommended" when
it sits next to the ``.words.json``.

The model never writes timestamps. The transcript is handed to it as numbered lines
that break where the speaker does (a sentence end or a pause), and it answers with
line numbers; the step turns those back into word-exact times. A proposed clip
therefore always starts and ends on a real phrase boundary.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

from .base import Output, Param, Step, StepContext

DEFAULT_MODEL = "claude-opus-5-5"
SENTENCE_END = re.compile(r"[.!?…][\"'”’»)\]]*$")

# What the model must answer with. Used as the API's structured-output schema, and
# spelled out in the prompt for the `command` backend, which can't enforce it.
ANSWER_SCHEMA = {
    "type": "object",
    "properties": {
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "score": {"type": "integer"},
                    "why": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "parts": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"from": {"type": "integer"}, "to": {"type": "integer"}},
                            "required": ["from", "to"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["title", "score", "why", "tags", "parts"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["clips"],
    "additionalProperties": False,
}


class RecommendStep(Step):
    action = "recommend"
    summary = "Propose reel / short clips from a word-level transcript (writes <stem>.clips.json)."
    params = (
        Param("words", "The <stem>.words.json written by `transcribe` with word_timestamps: true.",
              type="path", required=True),
        Param("count", "How many clips to propose.", type="int", default=12),
        Param("min_seconds", "Shortest clip worth proposing.", type="float", default=20),
        Param("max_seconds", "Longest clip worth proposing.", type="float", default=90),
        Param("language", "Language for the titles, tags and reasons "
                          "(default: the transcript's own language)."),
        Param("guidance", "Anything the model should know when choosing: who the audience is, "
                          "where the clips are posted, what to prefer or avoid."),
        Param("model", "Claude model that picks the clips (needs ANTHROPIC_API_KEY).",
              default=DEFAULT_MODEL),
        Param("effort", "How hard the model thinks about it.", type="enum", default="high",
              choices=("low", "medium", "high", "xhigh", "max")),
        Param("command", "Instead of the Claude API, pipe the prompt to this shell command and "
                         "read its answer from stdout — e.g. 'claude -p' to use a logged-in "
                         "Claude Code. `model` and `effort` are then ignored."),
        Param("pause", "A silence at least this long (seconds) ends a transcript line, so a "
                       "clip can start or end there.", type="float", default=0.6),
    )
    outputs = (
        Output("clips", "Absolute path to the written <stem>.clips.json.", artifact=True),
    )

    def run(self, params: dict, ctx: StepContext) -> dict:
        words_path = Path(self.require(params, "words"))
        stem = re.sub(r"\.words\.json$|\.json$", "", words_path.name, flags=re.I)
        out = ctx.out_path(stem + ".clips.json")
        result = {"clips": str(out.resolve())}
        count = int(params.get("count") or 12)
        lo = float(params.get("min_seconds") or 20)
        hi = float(params.get("max_seconds") or 90)
        command = params.get("command")
        model = params.get("model") or DEFAULT_MODEL

        if ctx.dry_run:
            who = f"`{command}`" if command else model
            print(f"  [dry-run] would ask {who} for {count} clips from {words_path} → {out}")
            return result
        if not words_path.exists():
            sys.exit(f"Error: word-level transcript not found: {words_path} "
                     "(run `transcribe` with word_timestamps: true)")

        data = json.loads(words_path.read_text(encoding="utf-8"))
        lines = transcript_lines(data, pause=float(params.get("pause") or 0.6))
        if not lines:
            sys.exit(f"Error: {words_path} has no word timestamps "
                     "(run `transcribe` with word_timestamps: true)")

        prompt = build_prompt(
            lines, count=count, min_seconds=lo, max_seconds=hi,
            language=params.get("language") or data.get("language") or "the transcript's language",
            guidance=params.get("guidance"),
        )
        print(f"  {len(lines)} transcript lines, {lines[-1]['end'] / 60:.0f} min — asking "
              f"{'`' + command + '`' if command else model} for {count} clips...")
        answer = (ask_command(command, prompt) if command
                  else ask_claude(prompt, model=model, effort=params.get("effort") or "high"))

        clips = place_clips(parse_answer(answer), lines)[:count]
        if not clips:
            sys.exit("Error: the model proposed no usable clips.")
        with open(out, "w", encoding="utf-8") as f:
            json.dump({"v": 1, "clips": clips}, f, ensure_ascii=False, indent=2)
            f.write("\n")
        for c in clips:
            secs = sum(e - s for s, e in c["ranges"])
            print(f"    {c['score']:3d}  {clock(c['ranges'][0][0]):>8}  {secs:4.0f}s  {c['title']}")
        print(f"  {len(clips)} recommended clips written to {out}")
        return result


# -- transcript → numbered lines ------------------------------------------------


def transcript_lines(data: dict, *, pause: float = 0.6, max_words: int = 16) -> list[dict]:
    """The transcript as lines that end where the speaker does: at a sentence end, a
    pause of at least ``pause`` seconds, or — failing both — after ``max_words`` words.
    Each line is ``{"start", "end", "text"}``; line numbers are 1-based positions."""
    words = [w for seg in data.get("segments", []) for w in seg.get("words") or []
             if str(w.get("word", "")).strip()]
    lines: list[dict] = []
    cur: list[dict] = []
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        text = str(w["word"]).strip()
        if (nxt is None or SENTENCE_END.search(text) or len(cur) >= max_words
                or float(nxt["start"]) - float(w["end"]) >= pause):
            lines.append({
                "start": float(cur[0]["start"]), "end": float(cur[-1]["end"]),
                "text": " ".join(str(x["word"]).strip() for x in cur),
            })
            cur = []
    return lines


def clock(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def build_prompt(lines: list[dict], *, count: int, min_seconds: float, max_seconds: float,
                 language: str, guidance: str | None = None) -> str:
    numbered = "\n".join(f"{i} [{clock(l['start'])}] {l['text']}" for i, l in enumerate(lines, 1))
    extra = f"\nWhat the editor asked for:\n{guidance.strip()}\n" if guidance and guidance.strip() else ""
    return f"""\
You are choosing the passages of a recording that an editor will cut into short vertical \
videos (Instagram Reels, YouTube Shorts, TikTok). The editor trusts your list: they will \
open the first few and publish them, so a clip that needs the rest of the recording to make \
sense, or that trails off, costs them time.

Below is the full transcript, one numbered line per phrase, each with the time it starts. \
It was transcribed automatically, so expect misheard words and missing punctuation.

Propose the {count} best clips, each between {min_seconds:.0f} and {max_seconds:.0f} seconds \
long (a line's length is the gap to the next line's start time).

What makes a clip work:
- The first sentence stops the scroll: a question, a bold claim, the start of a story, a \
tension the viewer wants resolved. Start on that line, not on the sentences that lead up to it.
- It stands alone. Someone who has never heard the speaker follows it with no context: no \
"as I said", no pronoun whose referent was left behind, no reading reference without its point.
- It carries one idea and lands it. End on the line that pays it off — a conclusion, a \
punchline, a sentence worth quoting — and stop there, before the speaker moves on.
- Stories, concrete images, direct address and honest tension hold attention better than \
exposition or lists.
- Prefer variety across the recording over several clips making the same point; do not \
overlap clips.

A clip is normally one continuous passage. Use two parts only when it clearly makes a better \
clip — a question asked early and answered much later, or a passage with a digression in the \
middle worth skipping — and say so in the reason. Parts play in the order you list them.

Announcements, greetings, prayers read out, housekeeping and passages that only make sense \
inside the room are not clips. If the recording has fewer than {count} passages that would \
really work, return fewer.
{extra}
For each clip give:
- "title": a short hook for the post, in {language} — what would make someone stop, not a summary.
- "score": 0-100, how well it would work as a standalone short. Be discriminating: reserve \
90+ for clips you would publish as they are, and let weaker ones score lower.
- "why": one or two sentences, in {language}, on why it works and anything the editor should check.
- "tags": one to three short labels in {language} for the kind of clip (question, story, \
application, quote, ...).
- "parts": the line numbers it covers, as {{"from": first line, "to": last line}}, inclusive.

Answer with one JSON object and nothing else, in this shape:
{{"clips": [{{"title": "...", "score": 90, "why": "...", "tags": ["..."], \
"parts": [{{"from": 12, "to": 19}}]}}]}}

<transcript>
{numbered}
</transcript>"""


# -- asking ---------------------------------------------------------------------


def ask_claude(prompt: str, *, model: str, effort: str) -> str:
    """One request to the Claude API; returns the answer's JSON text."""
    import anthropic

    try:
        client = anthropic.Anthropic()
        # Streamed so a long think can't run into an HTTP timeout. `fallbacks` lets
        # the API re-run the request on another model if a safety classifier
        # declines it, instead of failing the step.
        with client.beta.messages.stream(
            model=model,
            max_tokens=32000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": effort,
                           "format": {"type": "json_schema", "schema": ANSWER_SCHEMA}},
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            message = stream.get_final_message()
    except anthropic.AuthenticationError:
        sys.exit("Error: the Claude API rejected the credentials — check ANTHROPIC_API_KEY.")
    except anthropic.NotFoundError:
        sys.exit(f"Error: the Claude API doesn't know the model '{model}'.")
    except anthropic.RateLimitError:
        sys.exit("Error: the Claude API rate limit was hit — run the step again in a minute.")
    except anthropic.APIStatusError as e:
        sys.exit(f"Error: the Claude API answered {e.status_code}: {e.message}")
    except anthropic.APIConnectionError as e:
        sys.exit(f"Error: couldn't reach the Claude API ({e}).")
    except anthropic.AnthropicError as e:
        # No credentials at all lands here.
        sys.exit(f"Error: {e}\nSet ANTHROPIC_API_KEY, or give the step a `command` "
                 "(e.g. 'claude -p') to use a logged-in Claude Code instead.")

    if message.stop_reason == "refusal":
        sys.exit("Error: the model declined to read this transcript.")
    if message.stop_reason == "max_tokens":
        sys.exit("Error: the model's answer was cut off before it finished.")
    usage = message.usage
    print(f"  {message.model}: {usage.input_tokens} tokens in, {usage.output_tokens} out")
    return next((b.text for b in message.content if b.type == "text"), "")


def ask_command(command: str, prompt: str) -> str:
    """Pipe the prompt to a shell command and return what it prints."""
    print(f"  $ {command}  < prompt ({len(prompt)} chars)")
    done = subprocess.run(command, shell=True, input=prompt, capture_output=True, text=True)
    if done.returncode != 0:
        sys.exit(f"Error: `{command}` exited {done.returncode}: {done.stderr.strip()[-500:]}")
    return done.stdout


# -- answer → clips -------------------------------------------------------------


def parse_answer(text: str) -> list[dict]:
    """The clips in a model's answer. Tolerates prose or a code fence around the JSON."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        sys.exit(f"Error: the model didn't answer with JSON: {text.strip()[:200]!r}")
    try:
        data = json.loads(text[start:end + 1])
    except json.JSONDecodeError as e:
        sys.exit(f"Error: the model's answer isn't valid JSON ({e}).")
    clips = data.get("clips") if isinstance(data, dict) else None
    return [c for c in clips if isinstance(c, dict)] if isinstance(clips, list) else []


def place_clips(proposed: list[dict], lines: list[dict]) -> list[dict]:
    """Turn line-numbered proposals into the clips of a ``.clips.json``, best first.
    Parts that point outside the transcript are dropped, and a clip with none left goes."""
    clips = []
    for c in proposed:
        ranges = []
        for part in c.get("parts") or []:
            try:
                a, b = int(part["from"]), int(part["to"])
            except (KeyError, TypeError, ValueError):
                continue
            if 1 <= a <= b <= len(lines):
                ranges.append([round(lines[a - 1]["start"], 2), round(lines[b - 1]["end"], 2)])
        if not ranges:
            continue
        try:
            score = max(0, min(100, int(round(float(c.get("score"))))))
        except (TypeError, ValueError):
            score = 0
        tags = c.get("tags") if isinstance(c.get("tags"), list) else []
        clips.append({
            "title": str(c.get("title") or "").strip() or f"Clip {len(clips) + 1}",
            "score": score,
            "tags": [str(t).strip() for t in tags if str(t).strip()],
            "why": str(c.get("why") or "").strip(),
            "ranges": ranges,
        })
    clips.sort(key=lambda c: -c["score"])
    return clips
