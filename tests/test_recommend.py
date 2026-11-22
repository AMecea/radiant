"""The recommend step: transcript → numbered lines → a model's line-numbered answer →
a `.clips.json` with word-exact times. The model itself is never called here: the
`command` backend is pointed at a shell command that prints a canned answer.
"""

import json
import shlex

import pytest

from radiant.steps import REGISTRY
from radiant.steps import recommend as rec
from radiant.steps.base import StepContext
from radiant.steps.recommend import (
    RecommendStep, build_prompt, parse_answer, place_clips, transcript_lines,
)


def transcript(*words):
    """A words.json from (start, end, word) triples, one word per Whisper segment —
    like the real ones, whose segments are only a few words long."""
    return {"language": "ro", "duration": words[-1][1],
            "segments": [{"words": [{"start": s, "end": e, "word": w}]} for s, e, w in words]}


#   line 1: "Why hasn't he come?"      0.0 – 2.0   (sentence end)
#   line 2: "Think about it"           2.2 – 3.4   (then a 2 s pause)
#   line 3: "Because he is patient."   5.4 – 7.6
SAMPLE = transcript(
    (0.0, 0.4, "Why"), (0.5, 0.9, "hasn't"), (1.0, 1.3, "he"), (1.4, 2.0, "come?"),
    (2.2, 2.6, "Think"), (2.7, 3.0, "about"), (3.1, 3.4, "it"),
    (5.4, 5.9, "Because"), (6.0, 6.2, "he"), (6.3, 6.5, "is"), (6.6, 7.6, "patient."),
)


@pytest.fixture
def ctx(tmp_path):
    return StepContext(step_id="rec", workdir=tmp_path)


@pytest.fixture
def words_file(tmp_path):
    p = tmp_path / "talk.words.json"
    p.write_text(json.dumps(SAMPLE))
    return p


def answering(tmp_path, answer) -> str:
    """A shell command that swallows the prompt and prints `answer`."""
    f = tmp_path / "answer.txt"
    f.write_text(answer if isinstance(answer, str) else json.dumps(answer))
    return f"cat > {shlex.quote(str(tmp_path / 'prompt.txt'))}; cat {shlex.quote(str(f))}"


class TestLines:
    def test_a_line_ends_at_a_sentence_end_or_a_pause(self):
        lines = transcript_lines(SAMPLE)
        assert [l["text"] for l in lines] == ["Why hasn't he come?", "Think about it", "Because he is patient."]
        assert [(l["start"], l["end"]) for l in lines] == [(0.0, 2.0), (2.2, 3.4), (5.4, 7.6)]

    def test_the_pause_threshold_is_adjustable(self):
        # with a 3 s threshold the 2 s silence no longer breaks the line
        assert [l["text"] for l in transcript_lines(SAMPLE, pause=3)] == [
            "Why hasn't he come?", "Think about it Because he is patient."]

    def test_unpunctuated_speech_still_breaks(self):
        run_on = transcript(*[(i * 0.5, i * 0.5 + 0.4, f"w{i}") for i in range(40)])
        lines = transcript_lines(run_on, max_words=16)
        assert [len(l["text"].split()) for l in lines] == [16, 16, 8]

    def test_a_transcript_without_words_has_no_lines(self):
        assert transcript_lines({"segments": [{"start": 0, "end": 1, "text": "hi"}]}) == []


class TestPrompt:
    def test_it_numbers_the_lines_and_carries_the_brief(self):
        prompt = build_prompt(transcript_lines(SAMPLE), count=5, min_seconds=15, max_seconds=60,
                              language="ro", guidance="For the church's Instagram.")
        assert "1 [0:00] Why hasn't he come?" in prompt
        assert "3 [0:05] Because he is patient." in prompt
        assert "the 5 best clips, each between 15 and 60 seconds" in prompt
        assert "in ro" in prompt
        assert "For the church's Instagram." in prompt

    def test_times_past_an_hour_show_the_hour(self):
        late = transcript((3725.0, 3726.0, "late."))
        assert "1 [1:02:05] late." in build_prompt(transcript_lines(late), count=1, min_seconds=1,
                                                   max_seconds=2, language="en")


class TestAnswer:
    def test_json_is_found_inside_prose_or_a_code_fence(self):
        text = 'Here you go:\n```json\n{"clips": [{"title": "A", "parts": [{"from": 1, "to": 1}]}]}\n```\nDone.'
        assert parse_answer(text) == [{"title": "A", "parts": [{"from": 1, "to": 1}]}]

    def test_an_answer_that_is_not_json_stops_the_step(self):
        with pytest.raises(SystemExit, match="didn't answer with JSON"):
            parse_answer("I could not find any clips.")
        with pytest.raises(SystemExit, match="isn't valid JSON"):
            parse_answer('{"clips": [}')

    def test_line_numbers_become_word_exact_times_best_first(self):
        lines = transcript_lines(SAMPLE)
        clips = place_clips([
            {"title": "Weaker", "score": 60, "why": "w", "tags": ["x"], "parts": [{"from": 2, "to": 2}]},
            {"title": "Question and answer", "score": 91, "why": "arc", "tags": ["question", " "],
             "parts": [{"from": 1, "to": 1}, {"from": 3, "to": 3}]},
        ], lines)
        assert [c["title"] for c in clips] == ["Question and answer", "Weaker"]
        assert clips[0] == {"title": "Question and answer", "score": 91, "tags": ["question"],
                            "why": "arc", "ranges": [[0.0, 2.0], [5.4, 7.6]]}

    def test_what_points_outside_the_transcript_is_dropped(self):
        lines = transcript_lines(SAMPLE)
        clips = place_clips([
            {"title": "Half real", "score": 250, "parts": [{"from": 1, "to": 2}, {"from": 3, "to": 9}]},
            {"title": "Backwards", "score": 80, "parts": [{"from": 3, "to": 1}]},
            {"title": "Nowhere", "score": 80, "parts": [{"from": 0, "to": 1}, {"to": 2}, "junk"]},
            {"score": "n/a", "parts": [{"from": "2", "to": "3"}]},
        ], lines)
        assert [(c["title"], c["score"], c["ranges"]) for c in clips] == [
            ("Half real", 100, [[0.0, 3.4]]),
            ("Clip 2", 0, [[2.2, 7.6]]),
        ]


class TestStep:
    def test_it_is_registered(self):
        assert REGISTRY["recommend"] is RecommendStep
        assert RecommendStep.required_params() == ("words",)
        assert RecommendStep.artifact_keys() == ("clips",)

    def test_it_writes_the_clips_file_textcut_reads(self, ctx, words_file, tmp_path):
        cmd = answering(tmp_path, {"clips": [
            {"title": "De ce n-a venit?", "score": 92, "why": "Întrebare și răspuns.",
             "tags": ["întrebare"], "parts": [{"from": 1, "to": 3}]},
            {"title": "Second", "score": 70, "why": "", "tags": [], "parts": [{"from": 2, "to": 2}]},
        ]})
        out = RecommendStep().run({"words": str(words_file), "command": cmd, "count": 1}, ctx)

        path = ctx.step_dir / "talk.clips.json"
        assert out == {"clips": str(path.resolve())}
        # the format textcut reads; `count` caps what the model returned
        assert json.loads(path.read_text()) == {"v": 1, "clips": [
            {"title": "De ce n-a venit?", "score": 92, "tags": ["întrebare"],
             "why": "Întrebare și răspuns.", "ranges": [[0.0, 7.6]]},
        ]}
        assert "De ce n-a venit?" in path.read_text()  # not \u-escaped
        # the command got the numbered transcript on stdin
        assert "2 [0:02] Think about it" in (tmp_path / "prompt.txt").read_text()

    def test_without_a_command_it_asks_the_claude_api(self, ctx, words_file, monkeypatch):
        asked = {}

        def fake(prompt, *, model, effort):
            asked.update(model=model, effort=effort, prompt=prompt)
            return json.dumps({"clips": [{"title": "T", "score": 80, "why": "", "tags": [],
                                          "parts": [{"from": 3, "to": 3}]}]})

        monkeypatch.setattr(rec, "ask_claude", fake)
        RecommendStep().run({"words": str(words_file), "effort": "low"}, ctx)

        assert asked["model"] == "claude-opus-5-5" and asked["effort"] == "low"
        assert "in ro" in asked["prompt"]  # the transcript's own language
        assert json.loads((ctx.step_dir / "talk.clips.json").read_text())["clips"][0]["ranges"] == [[5.4, 7.6]]

    def test_dry_run_asks_nobody(self, tmp_path, words_file, capsys):
        dry = StepContext(step_id="rec", workdir=tmp_path, dry_run=True)
        out = RecommendStep().run({"words": str(words_file), "command": "exit 1"}, dry)
        assert out["clips"].endswith("talk.clips.json")
        assert "would ask `exit 1` for 12 clips" in capsys.readouterr().out
        assert not (dry.step_dir / "talk.clips.json").exists()

    def test_a_preview_run_does_not_clobber_the_real_file(self, tmp_path, words_file):
        preview = StepContext(step_id="rec", workdir=tmp_path, preview=5)
        cmd = answering(tmp_path, {"clips": [{"title": "T", "score": 1, "parts": [{"from": 1, "to": 1}]}]})
        out = RecommendStep().run({"words": str(words_file), "command": cmd}, preview)
        assert out["clips"].endswith("preview_talk.clips.json")

    def test_failures_stop_the_step_with_a_reason(self, ctx, words_file, tmp_path):
        with pytest.raises(SystemExit, match="word-level transcript not found"):
            RecommendStep().run({"words": str(tmp_path / "missing.words.json"), "command": "true"}, ctx)

        segments_only = tmp_path / "plain.words.json"
        segments_only.write_text(json.dumps({"segments": [{"start": 0, "end": 1, "text": "hi"}]}))
        with pytest.raises(SystemExit, match="no word timestamps"):
            RecommendStep().run({"words": str(segments_only), "command": "true"}, ctx)

        with pytest.raises(SystemExit, match="exited 3: boom"):
            RecommendStep().run({"words": str(words_file), "command": "cat >/dev/null; echo boom >&2; exit 3"}, ctx)

        nothing = answering(tmp_path, {"clips": [{"title": "T", "parts": [{"from": 50, "to": 60}]}]})
        with pytest.raises(SystemExit, match="no usable clips"):
            RecommendStep().run({"words": str(words_file), "command": nothing}, ctx)
