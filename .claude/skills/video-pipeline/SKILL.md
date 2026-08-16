---
name: video-pipeline
description: >-
  Author, validate, preview, and run radiant pipeline plans in this repo —
  ffmpeg-based video editing (transcode, trim/cut, clip/crop, and assembling
  several clips into one timeline with transitions) plus audio sync,
  Whisper transcription, and uploads (rclone remotes, YouTube). Use whenever the
  user wants to edit / process / transcode / trim / cut / clip / crop / merge /
  join / concatenate with transitions / sync /
  transcribe / upload a video with this project's radiant tool, or to
  create, validate, run, or preview a YAML plan or one of its steps.
---

# video-pipeline

`radiant` runs an ordered YAML **plan** of steps. Each step has an `id`, an
`action`, optional `needs`, and a `with:` parameter block; it writes artifacts to a
persistent workdir, and later steps reference earlier outputs. Runs are resumable.

## Golden rule: discover parameters from the tool, never guess

Each action's parameters and outputs are declared in code and rendered by the CLI.
**Always check `help` before writing or editing a step** — it is the single source
of truth and cannot drift.

```bash
uv run radiant help              # every action + one-line summary
uv run radiant help <action>    # one action's params (type/required/default) + outputs
```

If the user names an effect ("make it vertical", "drop the intro", "speed it up"),
map it to an action via `help` rather than inventing flags.

## Workflow

1. **Understand the request** and pick actions (`help` to confirm availability/params).
2. **Author or edit the plan YAML.** Crib structure from `examples/` (`sample.yaml` is
   the full sync→encode→upload→transcribe→clip→upload flow; `ffmpeg.yaml`, `trim.yaml`,
   `timeline.yaml`, `pipe.yaml`, `youtube.yaml`, `shell.yaml`, `stream_upload.yaml` are
   focused samples).
3. **Validate** — catches unknown actions, bad `${...}` refs, cycles, and missing
   required params *before* anything runs:
   ```bash
   uv run radiant validate --plan PATH
   ```
4. **Preview** the chain fast before committing to a long encode (caps long steps to a
   few seconds, prefixes outputs `preview_`, skips uploads, saves no state — except
   analysis-only steps like `sync`, whose result the cap can't change and which are
   therefore recorded so they aren't recomputed later):
   ```bash
   uv run radiant run --plan PATH --preview        # 5s
   uv run radiant run --plan PATH --preview 10
   ```
5. **Run** — all steps, or a slice with `--step` (see selectors below):
   ```bash
   uv run radiant run --plan PATH
   uv run radiant run --plan PATH --step sync
   uv run radiant run --plan PATH --step reel-upload_reel
   ```
6. **Inspect state** any time:
   ```bash
   uv run radiant list  --plan PATH      # compact: per-step status + outputs
   uv run radiant state --plan PATH      # full record: vars used, per-step inputs/outputs/timing
   uv run radiant state --plan PATH --json
   ```

Use `--dry-run` on `run` to print every command (and hook) without executing — good
for showing the user what will happen.

**Reruns keep earlier results.** `state.json` holds the vars of the last run plus each
step's resolved inputs and outputs, so `--step reel` on its own resolves
`${steps.sync.offset}` and `${steps.master.file}` from the record. When a value is
already known but was never recorded (measured by hand, read off an old log), pin it
instead of recomputing the producer:

```bash
uv run radiant set    --plan PATH sync.offset=722.307 sync.audio_trim=0
uv run radiant forget --plan PATH master        # drop a record so it runs again
uv run radiant run    --plan PATH --step master --reuse-vars   # reuse last run's vars
```

## Plan structure

```yaml
name: my_job                      # workdir defaults to ./runs/<name>/
vars:                             # reusable values, referenced as ${vars.KEY}
  src:    "/path/to/input.mp4"
  bucket: "gs:my-bucket/out/"
hooks:                            # optional shell hooks (placeholders {name}/{step}/{code}/{url}/{message})
  on_success: "echo '{name} done -> {url}'"
steps:
  - id: cut                       # unique id; referenced as ${steps.cut.<output>}
    action: trim
    with:
      input:  "${vars.src}"
      output: "cut.mp4"
      exclude: [{ start: 0, end: 12 }]
  - id: publish
    action: upload
    needs: [cut]                  # documents ordering; producers must precede consumers
    with:
      file:   "${steps.cut.file}" # consume an earlier step's output by reference
      remote: "${vars.bucket}"
      public: true
  - id: stream_720p               # `pipe`: stages run as ONE streamed command (no local file)
    action: pipe
    needs: [cut]
    with:
      stages:                     # ordered list of {action, with}; NO per-stage id/needs.
        - action: ffmpeg          #   first stage = source: transcode, write stream to stdout
          with:
            input: "${steps.cut.file}"
            scale: "-2:720"
        - action: upload_stream   #   last stage = sink: pipe straight to the remote
          with:
            remote:   "${vars.bucket}"
            filename: "cut_720p.mp4"
            public:   true
```

- **References:** `${vars.NAME}` and `${steps.<id>.<output>}`. A whole-string ref keeps
  the value's native type; embedded refs are stringified. Producers must be earlier
  steps; outputs are validated against what the producing action actually declares.
- **`pipe` stages:** a pipe step puts an ordered `stages:` list under `with:` — each
  entry is just `{action, with}` (stages have no `id`/`needs`; they're wired by order,
  first = source → last = sink). A file sink uses the pipe's own `output:`; a streaming
  sink (`upload_stream`) reports its own output (`url`). See `examples/pipe.yaml` for the
  canonical `braw_decode | ffmpeg` form.
- **Step selector** (`--step`): `N`, `N-M`, `N-`, `-M`, comma lists, step ids, and id
  ranges (`sync-reel`). Default = all.
- **Resumable / idempotent:** a finished step is skipped on re-run unless its file
  artifact was deleted (then it rebuilds) or you pass `--force`. Override vars for one
  run with `--vars k=v`, or reuse the last run's with `--reuse-vars`.
- **Artifacts:** land under `runs/<name>/<step-id>/`; `state.json` records the vars the
  run used and, per step, the resolved inputs, the outputs, and the timing.
- **Drift warnings:** a run reports vars that changed since the last recorded run, and
  skipped steps whose inputs no longer match what they were built from — that message
  means "the recorded output is stale, `--force` it", not a failure.

## Tips & gotchas

- **`pipe`** chains stages over OS pipes (`stage1 | stage2 | …`) and runs as one
  non-resumable unit (no intermediate file). Use it for streaming with no large
  throwaway; use separate steps when you want per-stage resume. `trim`/`ffmpeg` are the
  same implementation, so `include`/`exclude` cuts also work directly on an `ffmpeg`
  step.
- **`concat`** is the multi-source editor: an ordered `clips:` list (each with its own
  `start`/`end`|`duration`), joined by `transition: cut` or an ffmpeg `xfade` name, with
  a matching audio `acrossfade`. A clip's `transition` describes how it joins the clip
  *before* it, so the first clip's is ignored; a transition must be shorter than both
  clips it joins. Mismatched sources are normalised onto one canvas (`width`/`height`/
  `fps`/`fit`), and silent sources get generated silence. Trim inline for a single
  in/out point; use a separate `trim` step when a clip needs several ranges dropped.
- **`pause`** is a manual checkpoint: a normal run exits 0 at it and prints how to
  resume (`--step <next>-`); it does not halt under `--dry-run`/`--preview`.
- **BRAW** (`braw_decode`, BRAW-aware `encode`) needs the `braw-decode` binary at
  `lib/braw-decode/braw-decode`; it's specific to Blackmagic RAW input.
- **`upload`/`youtube`** are skipped under `--preview`; YouTube prompts for OAuth on
  first use and caches the token.

After editing a plan, validate it; before a long encode, preview it.
