# Radiant

A YAML-driven **ffmpeg video-editing pipeline** — transcode, cut/trim, crop/clip, and
assemble several sources into one timeline with transitions — with
a few extra goodies built around it: automatic camera↔mic audio sync, Whisper
transcription, and uploads (rclone remotes and YouTube). You declare an ordered plan of
steps once and the runner executes it, resumably.

> **Built entirely with [Claude Code](https://claude.com/claude-code).** This is a
> personal tool — I make it public in case it's useful, but it's shaped around my own
> workflow rather than as a general-purpose product.

> **`braw_decode` is a personal need, not a general feature.** I shoot on a Blackmagic
> camera, so I needed to decode Blackmagic RAW (`.braw`). The `braw_decode` step and the
> BRAW-aware `encode` path exist for that and depend on a `braw-decode` binary you supply
> yourself (see [Requirements](#requirements)). If you don't shoot BRAW, ignore them —
> everything else works on any container ffmpeg can read.

## `radiant` — the pipeline tool

The whole flow (sync → encode → upload → transcribe → reel-clip → upload) is declared
once in a YAML **plan**. Steps run a slice at a time and each writes output artifacts
into a persistent workdir, so later steps consume earlier steps' outputs by reference
and runs are resumable.

```bash
uv run radiant validate --plan examples/sample.yaml      # check refs, DAG, actions
uv run radiant run      --plan examples/sample.yaml --step sync       # just step 1
uv run radiant run      --plan examples/sample.yaml --step master     # heavy encode
uv run radiant run      --plan examples/sample.yaml --step transcribe # find reel timestamps
uv run radiant run      --plan examples/sample.yaml --step reel-upload_reel
uv run radiant list     --plan examples/sample.yaml      # per-step status + outputs
uv run radiant state    --plan examples/sample.yaml      # vars used + per-step inputs/outputs/timing
uv run radiant state    --plan examples/sample.yaml --json

uv run radiant set      --plan examples/sample.yaml sync.offset=722.307   # pin a value by hand
uv run radiant forget   --plan examples/sample.yaml reel                  # drop a step's record

uv run radiant help                  # list every action and its one-liner
uv run radiant help ffmpeg           # parameters + outputs for one action

uv run radiant run      --plan examples/sample.yaml --preview      # 5s preview of the whole chain
uv run radiant run      --plan examples/sample.yaml --preview 10    # 10s preview
```

- **Step selector** (`--step`): `N`, `N-M`, `N-`, `-M`, comma lists, step ids, and id ranges (`sync-reel`). Default = all.
- **Artifacts & state:** outputs land under `runs/<plan-name>/<step-id>/`; `state.json` is the run record — the `vars` the run used, and per step the *resolved* `with:` parameters it ran with, the outputs it produced, and its timing. Referenced as `${steps.<id>.<output>}` and `${vars.<key>}` in the plan.
- **Resumable / idempotent:** a finished step is skipped on re-run unless its artifact was deleted (then it rebuilds) or you pass `--force`. Rerunning one step alone (`--step reel`) pulls every upstream value — the sync offset, the master path — out of `state.json` instead of recomputing it.
- **Drift warnings:** because the inputs are recorded too, a re-run tells you when a `var` changed since the last run, and when a step marked done was built from inputs that have since changed (`--force` to rebuild).
- **Fail-fast:** running a step whose upstream artifact doesn't exist yet errors with guidance instead of doing the wrong thing.
- **`--preview [SECONDS]`** (default 5): caps the long steps (`encode`, `clip`, `transcribe`, and each clip of a `concat` timeline) to a few seconds so you can sanity-check sync/framing/timestamps fast. Outputs are written `preview_`-prefixed, uploads are skipped, and **state is not saved** — so the preview never blocks or gets mistaken for the real run. The one exception is an analysis-only step whose result the cap cannot change (`sync`, declared with `preview_affects_output = False`): its outputs *are* recorded, so a 20-minute cross-correlation isn't thrown away just because you ran a preview.
- **`--dry-run`** prints every command (and hook) without executing (its results are never recorded); **`--vars k=v`** overrides plan vars for one run, and **`--reuse-vars`** starts from the vars the last run recorded so a one-off override needn't be retyped on the single-step rerun.
- **`state` / `set` / `forget`:** `state` prints what the workdir remembers (add `--json` for the raw record); `set <step>.<output>=<value>` pins a value you already know so a later step can consume it without running the producer; `forget <step>` drops a record so it runs again.
- **Hooks:** optional `on_start` / `on_success` / `on_failure` / `on_pause` shell commands in the plan (`{name}`/`{step}`/`{code}`/`{url}`/`{message}` placeholders) — put `caffeinate` / `telegram` piping there.

Step actions: `sync` (offset detect), `encode` (trim + replace audio + re-encode; braw & standard), `clip` (segment + 9:16 crop / face-track), `trim` (keep/drop a list of time ranges), `concat` (assemble several clips into one timeline, with transitions), `transcribe` (Whisper timestamps), `ffmpeg` (general-purpose transcode/convert from basic parameters), `pipe` (compose stages via OS pipes), `shell` (arbitrary command / pipe stage), `upload` (rclone), `upload_stream` (stream a pipe straight to a remote), `youtube` (upload to YouTube), `braw_decode` (BRAW→raw source stage), `pause` (manual checkpoint). Run `radiant help` for the full list, or `radiant help <action>` for one action's parameters. See `examples/sample.yaml`, `examples/ffmpeg.yaml`, `examples/trim.yaml`, `examples/timeline.yaml`, `examples/pipe.yaml`, and `examples/youtube.yaml`.

Each action declares its parameters and outputs uniformly (the `params` / `outputs` specs on its step class), so `radiant help <action>` documents every parameter — type, whether it's required, its default, and what it does — straight from the code. Required parameters are checked at `validate`/`run` time, and `${steps.<id>.<output>}` references are checked against the declared outputs.

### `ffmpeg` — general-purpose transcode / convert

The plain ffmpeg escape hatch (no sync/braw logic): one input, one output, and the common knobs — `vcodec`/`acodec` (or `copy` to stream-copy), `crf`, `preset`, `video_bitrate`/`audio_bitrate`, `scale`, `vf`, `fps`, `start`/`end`/`duration`, `no_audio`, `audio` (mux a separate audio track), `pix_fmt`, `faststart` (mp4/mov only), `format`, plus an `extra_args` list for raw flags. It also accepts `include`/`exclude` range lists (the same cut the `trim` action does — `select`/`aselect`, video + audio cut together and in sync; forces a re-encode). Handy for downscales, trims, audio extraction, gif previews, and remuxes; honours `--preview` (caps to N seconds). See `examples/ffmpeg.yaml` for transcode / trim / extract-audio / gif samples.

### `trim` — keep or drop a list of time ranges

Give `trim` **either** an `include` list (keep only those ranges) **or** an `exclude` list (keep everything else); each range is a `{start, end}` mapping or an `[start, end]` pair, in seconds (`90`, `12.5`) or clock strings (`"00:01:30"`, `"1:30"`). It cuts video and audio on the same expression in a single ffmpeg pass (`select`/`aselect` + `setpts`), so the kept pieces concatenate gap-free and stay in sync — no temp files or per-segment muxing. Because `select` rewrites frames it always re-encodes, so `vcodec: copy` / `acodec: copy` are rejected. It works standalone or as a `pipe` stage (source/filter/sink). See `examples/trim.yaml`.

`trim` is just the `ffmpeg` action with a *required* `include`/`exclude` cut — both actions share one implementation, so you can also add `include`/`exclude` directly to any `ffmpeg` step (e.g. to cut while you encode/scale in a single pass).

### `concat` — assemble clips into one timeline (transitions, fades)

The linear-editing primitive: an ordered `clips:` list, each entry a source with its own in/out point, joined by a hard **cut** or a **transition**.

```yaml
- id: film
  action: concat
  with:
    output: film.mp4
    transition: fade                # default join between clips…
    transition_duration: 1.0
    width: 1920                     # …and the canvas everything is fitted to
    height: 1080
    fps: 30
    clips:
      - { file: "${vars.intro}", end: 6, fade_in: 1 }          # fade up from black
      - { file: "${steps.talk.file}", transition: dissolve, start: 120, duration: 240 }
      - { file: "${vars.broll}", transition: cut, duration: 12, volume: 0.25 }
      - { file: "${vars.outro}", transition: wipeleft, transition_duration: 0.75, fade_out: 2 }
```

- **Per clip:** `file`, `start` + (`end` | `duration`) for the in/out point, `transition` + `transition_duration` (how it joins the clip *before* it — so reordering clips carries their transitions along), `fade_in`/`fade_out` (video and audio), `volume`. Times are seconds or clock strings, as everywhere else.
- **Transitions:** `cut`, or any ffmpeg `xfade` name — `fade`, `fadeblack`, `dissolve`, `wipeleft/right/up/down`, `slide*`, `smooth*`, `circleopen/close`, `pixelize`, `zoomin`, `cover*`/`reveal*`, … A transition *overlaps* the two clips, so the audio gets a matching `acrossfade` and the timeline gets shorter by exactly that much (the reported `duration` output accounts for it). It is an error for a transition to outlast either clip it joins.
- **Mixed sources just work:** every clip is normalised onto a common canvas first — scale (`fit: contain` letterbox / `cover` crop-to-fill / `stretch`), pad, `fps`, SAR, pixel format, timebase — because `xfade` refuses to mix geometries. A source with no audio track gets generated silence, so the audio timeline stays aligned; if *nothing* has audio, the result is video-only.
- **One pass:** the whole timeline is a single `-filter_complex` ffmpeg invocation with input-level seeks — no temp files, no per-segment muxing, no generation loss between cuts. Outputs `file` and `duration`.
- **`--preview N`** caps *each clip* to N seconds (shrinking transitions that no longer fit) so you can watch every join in a few seconds rather than seeing only the head of clip 1.
- It can also be the **source stage of a `pipe`** (it reads its own clips, so it's always first) — assemble and upload without the intermediate file. See `examples/timeline.yaml`.

### `pipe` — compose stages via OS pipes

`pipe` chains several actions into a single streaming command (`stage1 | stage2 | …`), the same shape `encode` uses internally (`braw-decode | ffmpeg`) but assembled declaratively from reusable stages. The first stage is a **source** (writes stdout), the last is the **sink** (writes the `output` file); geometry/format metadata flows from one stage to the next (e.g. `braw_decode` tells `ffmpeg` the rawvideo size + fps). A stage opts in by implementing `Step.command`; today `braw_decode` (source), `concat` (source — it reads its own clips), `ffmpeg`/`trim` (filter or sink), `shell` (any role), and `upload_stream` (streaming sink) do.

A pipe runs as **one unit** — no intermediate file lands on disk, so there's nothing to resume mid-pipe; if the output is deleted the whole pipe re-runs. Use a pipe when you want streaming with no large throwaway intermediate; use separate plan steps when you want per-stage resume. `examples/pipe.yaml` reproduces the `master` encode as `braw_decode | ffmpeg` (the built-in `encode` action is unchanged).

### `pause` — manual checkpoints

Drop a `pause` step where you need to do something by hand (e.g. read the transcript and choose reel start/end). When the run reaches it, it **exits 0**, prints a notice (and fires the `on_pause` hook if set, so you get a telegram ping), and does **not** run the remaining steps:

```yaml
- id: pick_timestamps
  action: pause
  needs: [transcribe]
  with:
    message: "Read the transcript and set reel start/end, then resume with --step reel-"
```

The notice tells you exactly how to resume (`run … --step <next>-`). `pause` is not recorded in state, so it always halts a normal run — you step over it by selecting the steps after it. In `--dry-run` and `--preview` it does **not** halt (those modes are meant to walk/produce the whole chain) — it just prints a note.

## Tests

```bash
uv run pytest                       # whole suite, ~2s
uv run pytest tests/test_plan_run.py -k preview
```

`tests/` covers the parts that decide what happens to your footage: plan loading and
validation, `${...}` resolution, step selectors, the run loop (resume, `--force`,
single-step reruns, `--preview`/`--dry-run` state handling, drift warnings, `pause`,
hooks), the state record (including schema-v1 files), every CLI command, and the ffmpeg
argv the steps build. Most of it runs real `shell` steps rather than mocks — a plan of
`echo`/`cat` commands exercises the same code path a real encode does. No test needs
rclone, YouTube or the network; the `sync` offset test is skipped when `ffmpeg` is absent.

## Claude Code skill

A [Claude Code](https://claude.com/claude-code) skill lives at `.claude/skills/video-pipeline/` — it teaches Claude how to author, validate, preview, and run plans with this tool. Working **inside this repo** it's picked up automatically (no install). To use it from anywhere, install it as a personal skill:

```bash
mkdir -p ~/.claude/skills && cp -r .claude/skills/video-pipeline ~/.claude/skills/
```

Then in Claude Code just ask in plain language ("trim the intro off this clip", "transcribe and upload"), or invoke it explicitly with `/video-pipeline`.

## Requirements

**System tools** (must be installed separately):

| Tool | Install |
|---|---|
| `uv` | `brew install uv` |
| `ffmpeg` (with libx264 + VideoToolbox) | `brew install ffmpeg` |
| `rclone` (for `upload`) | `brew install rclone` |
| `braw-decode` (only for BRAW) | Place binary at `lib/braw-decode/braw-decode` |

**Python dependencies** are declared inline (PEP 723) and installed automatically by `uv` on first run — no manual `pip install` needed.

Inputs can be any container ffmpeg reads (MP4, MOV, MXF, …); Blackmagic RAW (`.braw`) additionally needs the `braw-decode` binary above.

## License

[MIT](LICENSE) © Flavius Mecea
