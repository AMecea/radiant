# CLAUDE.md

Two projects share this repo: `radiant` (Python, a YAML-driven ffmpeg pipeline tool) and
`textcut/` (TypeScript, a static browser app that cuts audio/video by transcript).
`README.md` and `textcut/README.md` are the user-facing docs; keep them in step with
behaviour changes.

## Commands

radiant (from the repo root, managed with `uv`):

```bash
uv run pytest                                   # whole suite, ~2s
uv run pytest tests/test_plan_run.py -k preview # one file / one test
uv run radiant help [action]                    # actions, or one action's params + outputs
uv run radiant validate --plan examples/sample.yaml
uv run radiant run --plan PATH [--step ID] [--preview [SECONDS]]
uv run radiant list|state --plan PATH           # per-step status / full record
```

textcut (from `textcut/`):

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest, core logic only
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + static site in dist/
```

Pushing `textcut/**` to `main` runs `.github/workflows/textcut-pages.yml` (test, build,
deploy to GitHub Pages).

## radiant layout

- `radiant/cli.py` — entry point (`radiant.cli:main`): `run`, `validate`, `list`, `state`,
  `set`, `forget`, `help`.
- `radiant/plan.py` — `Plan` / `PlanStep`: load YAML, validate (known actions, refs,
  acyclic), resolve references between steps, select steps, run resumably, warn on
  var/param drift.
- `radiant/state.py` — `State`: per-workdir record of each step's outputs and params.
- `radiant/media.py` — ffprobe, duration, BRAW format detection, codec args, `rclone_copy`.
- `radiant/hooks.py` — templated plan hooks. `radiant/help.py` — help rendered from the
  step param specs.
- `radiant/steps/base.py` — `Step`, `Param`, `Output`, `StepContext`, `PauseSignal`.
- `radiant/steps/__init__.py` — the action registry.
- Steps: `ffmpeg` (general), `trim` (subclasses `FfmpegStep`), `concat`, `clip`, `encode`,
  `sync`, `transcribe`, `recommend`, `upload`, `upload_stream`, `youtube`, `shell`, `pipe`, `pause`,
  `braw_decode`.

Adding or changing a step: declare its `params` / `outputs` on the step class (that is
what `radiant help` and plan validation read), register it in `steps/__init__.py`, and
add tests under `tests/`.

`lib/braw-decode` is a git submodule; the BRAW paths need a `braw-decode` binary the user
supplies. `examples/` holds sample plans. The `video-pipeline` skill
(`.claude/skills/video-pipeline/SKILL.md`) covers authoring and running plans.

## textcut layout

- `src/core/` — pure logic, no DOM, covered by `tests/`: `transcript`, `ranges`, `edits`,
  `search`, `time`, `wav`, `ffjob` (ffmpeg job + shell command), `ops` (crop / resize /
  audio filter ops), `captions` (burned-in ASS captions), `formats` (clip export
  formats), `radiant` (emits a radiant plan), `link` (shareable URL encoding), `recs`
  (recommended clips read from a `<stem>.clips.json`; textcut shows them, it does not
  pick them), `fontfile` (reads a user's own .ttf / .otf for captions), `app` (the name
  the app shows).
- `src/app/` — UI: `editor` (main `Editor` class), `timeline`, `open-view`,
  `export-dialog`, `export`, `ffmpeg-client` + `ffmpeg-worker` (ffmpeg.wasm), `sources`,
  `settings`, `userfont` (the user's caption font, kept in IndexedDB), `dom`.

Keep new logic in `src/core/` so it stays testable without a browser.

The app shows itself as "rReelIT" (`APP_NAME` in `src/core/app.ts`); the folder, storage
keys and generated file names still say `textcut`.

## Where the two meet

- The `transcribe` step (with `word_timestamps: true`) writes `<stem>.words.json`, which
  textcut opens. Changing that format means changing `radiant/steps/transcribe.py` and
  `textcut/src/core/transcript.ts` together.
- The `recommend` step writes `<stem>.clips.json` (recommended clips), which textcut reads
  when it sits next to the `.words.json`. Changing that format means changing
  `radiant/steps/recommend.py` and `textcut/src/core/recs.ts` together.
- `textcut/src/core/radiant.ts` emits a plan for radiant's `ffmpeg` step, so parameter
  changes in `radiant/steps/ffmpeg.py` must be mirrored there.
