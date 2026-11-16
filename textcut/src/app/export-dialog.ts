/**
 * The export dialog: pick a format and processing (crop, resize, audio filters),
 * then run it in the browser, copy the equivalent ffmpeg command or radiant plan,
 * or copy a link that opens this same export for someone else.
 * The command, the plan and the in-browser run come from the same job (core/ffjob.ts).
 */

import type { Clip } from "../core/formats";
import { buildJob, jobToShell, outputExt, type AudioCodec, type CutMode, type CutSpec } from "../core/ffjob";
import type { ExportPreset } from "../core/link";
import { radiantPlan } from "../core/radiant";
import { cropRect, normalizeOps, opDef, OPS, type Field, type Frame, type OpState } from "../core/ops";
import { fmtDur } from "../core/time";
import { copyText, download, fmtBytes, h, modal, toast } from "./dom";
import { exportWav, runCut } from "./export";
import { saveSettings, type Settings } from "./settings";
import type { MediaSource } from "./sources";

export interface ExportContext {
  heading: string;
  /** one line under the heading, e.g. what was removed */
  summary?: string;
  ranges: readonly Clip[];
  media: MediaSource | null;
  hasVideo: boolean;
  /** source frame size (null when unknown / audio) */
  frame: Frame | null;
  video: HTMLVideoElement;
  stem: string;
  settings: Settings;
  /** opened from a shared link: its format & processing (the user's settings stay untouched) */
  preset?: ExportPreset | null;
  /** a link that opens the editor on this export */
  shareLink(p: ExportPreset): Promise<{ link: string; warnings: string[] }>;
}

type ModeId = "exact" | "copy" | "wav" | "m4a" | "mp3";

interface ModeDef {
  id: ModeId;
  label: string;
  note: string;
  cut: CutMode;
  codec?: AudioCodec;
  video: boolean;   // can apply video ops
  audio: boolean;   // can apply audio ops
}

export function openExportDialog(ctx: ExportContext): void {
  const { settings: s, media, hasVideo } = ctx;
  const ranges = ctx.ranges.map((c) => ({ s: c.s, e: c.e }));
  const total = ranges.reduce((n, r) => n + (r.e - r.s), 0);
  const srcExt = (media?.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  const preset = ctx.preset ?? null;
  // Working state: from the shared link, or the user's last choices (saved back only then).
  const st = {
    ops: preset ? normalizeOps((preset.o ?? []).map((o) => ({ id: o.id, on: true, p: o.p }))) : normalizeOps(s.ops),
    smooth: preset ? preset.f !== 0 : s.smoothJoins,
    vars: preset ? preset.vars === 1 : s.useVars,
  };

  const modes: ModeDef[] = [
    ...(hasVideo || !media ? [{
      id: "exact" as const, label: "Video, exact (MP4, H.264)", cut: "exact" as const, video: true, audio: true,
      note: "frame-accurate, can crop & filter; re-encodes, so it's slow in the browser (≈ real time)",
    }] : []),
    {
      id: "copy", cut: "copy", video: false, audio: false,
      label: hasVideo ? `Video, fast (${srcExt === "mov" ? "MOV" : "MP4"}, no re-encode)` : `Original format (${srcExt.toUpperCase() || "copy"}, no re-encode)`,
      note: hasVideo ? "instant, lossless; but cuts snap to keyframes (up to a few seconds off) — not for word-level edits" : "quick, lossless",
    },
    {
      id: "wav", label: "WAV audio", cut: "audio", codec: "pcm", video: false, audio: true,
      note: srcExt === "wav" ? "instant, lossless — cut straight from the file (filters go through ffmpeg)" : "lossless",
    },
    { id: "m4a", label: "M4A (AAC) audio", cut: "audio", codec: "aac", video: false, audio: true, note: "re-encoded" },
    { id: "mp3", label: "MP3 audio", cut: "audio", codec: "mp3", video: false, audio: true, note: "re-encoded" },
  ];
  let mode: ModeDef = modes.find((m) => m.id === (preset?.m ?? s.exportMode)) ?? modes[0]!;
  const save = () => {
    if (preset) return;
    Object.assign(s, { exportMode: mode.id, ops: st.ops, smoothJoins: st.smooth, useVars: st.vars });
    saveSettings(s);
  };

  // ---------------------------------------------------------------- format
  const modeList = h("div", { class: "choices" }, ...modes.map((m) => {
    const input = h("input", {
      type: "radio", name: "fmt", value: m.id, checked: m.id === mode.id,
      onchange: () => { mode = m; save(); renderOps(); update(); },
    });
    return h("label", { class: "choice" }, input, h("span", {}, h("strong", {}, m.label), h("small", {}, m.note)));
  }));

  // ---------------------------------------------------------------- processing
  const opsBox = h("div", { class: "ops" });
  const joins = h("input", {
    type: "checkbox", checked: st.smooth,
    onchange: () => { st.smooth = joins.checked; save(); update(); },
  });

  function renderOps(): void {
    opsBox.replaceChildren();
    const usable = OPS.filter((d) => (d.stream === "video" ? mode.video && hasVideo : mode.audio));
    if (!usable.length) {
      opsBox.append(h("p", { class: "muted" }, "No processing in this mode — pick “exact” or an audio format to crop or filter."));
      return;
    }
    for (const d of usable) {
      const op = st.ops.find((o) => o.id === d.id)!;
      const body = h("div", { class: "op-body", hidden: !op.on });
      const on = h("input", {
        type: "checkbox", checked: op.on,
        onchange: () => { op.on = on.checked; body.hidden = !op.on; save(); update(); },
      });
      const sync: Array<() => void> = [];
      const changed = () => { save(); sync.forEach((f) => f()); update(); };
      if (d.id === "crop" && ctx.frame) {
        const prev = cropPreview(ctx.video, ctx.frame, op, changed);
        sync.push(prev.sync);
        body.append(prev.el);
      }
      const grid = h("div", { class: "op-fields" });
      for (const f of d.fields) {
        const r = fieldInput(f, op, changed);
        sync.push(r.sync);
        grid.append(r.el);
      }
      body.append(grid);
      opsBox.append(h("div", { class: "op" },
        h("label", { class: "chk op-head" }, on, h("strong", {}, d.label), h("small", { class: "muted" }, d.help)),
        body));
    }
  }

  // ---------------------------------------------------------------- command / plan
  const name = h("input", { type: "text", value: preset?.n ?? `${ctx.stem}_cut`, "aria-label": "File name", oninput: () => update() });
  const cmdPre = h("pre", { class: "mono cmd" });
  const yamlPre = h("pre", { class: "mono cmd" });
  const notes = h("div", {});
  const varsChk = h("input", {
    type: "checkbox", checked: st.vars,
    onchange: () => { st.vars = varsChk.checked; save(); update(); },
  });

  const specOf = (): Omit<CutSpec, "input" | "output" | "tmp"> => ({
    ranges, mode: mode.cut, audioCodec: mode.codec, hasVideo, frame: ctx.frame,
    ops: st.ops.filter((o) => {
      const d = opDef(o.id);
      return d && (d.stream === "video" ? mode.video : mode.audio);
    }),
    fade: st.smooth ? 0.01 : 0,
  });
  const extOf = () => outputExt(mode.cut, media?.name ?? ".mp4", hasVideo || !media, mode.codec);
  const audioOpsOn = () => st.ops.some((o) => o.on && opDef(o.id)?.stream === "audio");
  const fileName = () => `${name.value || ctx.stem + "_cut"}.${extOf()}`;

  let script = "", plan = "";
  function update(): void {
    const input = media?.kind === "url" ? media.url : media?.name ?? `${ctx.stem}.mp4`;
    const output = fileName();
    const spec = { ...specOf(), input, output };
    try {
      const job = buildJob(spec);
      script = jobToShell(job, st.vars ? { input, output } : undefined);
      notes.replaceChildren(...job.notes.map((n) => h("p", { class: "notice" }, n)));
      plan = radiantPlan(spec, {
        vars: st.vars, name: `textcut_${ctx.stem}`.replace(/[^\w-]+/g, "_"),
        comment: `textcut — ${ctx.heading}: ${ranges.length} range${ranges.length === 1 ? "" : "s"}, ${fmtDur(total)}`,
      });
    } catch (e) {
      script = plan = `# ${(e as Error).message}`;
    }
    cmdPre.textContent = script;
    yamlPre.textContent = plan;
  }

  const stem = () => name.value || ctx.stem + "_cut";
  const snippet = (title: string, note: string, pre: HTMLElement, copy: () => string, file: () => [string, string, string]) =>
    h("div", { class: "snippet" },
      h("div", { class: "row" }, h("strong", {}, title), h("span", { class: "muted" }, note), h("span", { class: "spacer" }),
        h("button", { onclick: () => void copyText(copy(), title) }, "Copy"),
        h("button", { title: "Download", onclick: () => { const [text, fname, type] = file(); download(text, fname, type); } },
          file()[1].replace(/^.*\./, "."))),
      pre);
  const cmd = h("div", {},
    h("label", { class: "chk" }, varsChk, "Variables",
      h("small", { class: "muted" }, " — $INPUT / $OUTPUT and radiant ${vars.input} / ${vars.output}, defaulting to this URL and name")),
    snippet("ffmpeg command", "— the same job the browser runs", cmdPre, () => script,
      () => [`#!/bin/sh\n# textcut — ${ctx.heading}: ${ranges.length} ranges, ${fmtDur(total)}\n${script}\n`, `${stem()}.sh`, "text/x-shellscript"]),
    snippet("radiant plan", "— an ffmpeg step", yamlPre, () => plan, () => [plan, `${stem()}.yaml`, "application/yaml"]));

  // ---------------------------------------------------------------- link
  const presetOf = (): ExportPreset => ({
    v: 1,
    r: ranges.map((r) => [+r.s.toFixed(3), +r.e.toFixed(3)]),
    h: ctx.heading,
    m: mode.id,
    o: specOf().ops?.filter((o) => o.on).map((o) => ({ id: o.id, p: o.p })),
    f: st.smooth ? 1 : 0,
    n: name.value || undefined,
    vars: st.vars ? 1 : 0,
  });
  const linkBtn = h("button", {
    title: "A link that opens this export — ranges, format and processing — so someone else can run it in their browser or copy the command",
    onclick: async () => {
      const { link, warnings } = await ctx.shareLink(presetOf());
      await copyText(link, "Export link");
      if (warnings.length) toast(warnings[0]!, "info", 6000);
    },
  }, "🔗 Copy link");

  // ---------------------------------------------------------------- run
  const bar = h("progress", { max: 1, value: 0, hidden: true });
  const status = h("p", { class: "muted" });
  const logEl = h("pre", { class: "log" });
  const hasMedia = !!media;

  const body = h("div", {},
    h("p", {}, `${ranges.length} range${ranges.length === 1 ? "" : "s"}, ${fmtDur(total)} total.`,
      ctx.summary ? h("span", { class: "muted" }, ` ${ctx.summary}`) : null),
    h("h4", {}, "Format"), modeList,
    h("h4", {}, "Processing"), opsBox,
    preset ? h("p", { class: "notice" }, "Opened from a shared link: run it here, or copy the command / plan below.") : null,
    ranges.length > 1 ? h("label", { class: "chk" }, joins, "Smooth joins",
      h("small", { class: "muted" }, " — 10 ms audio fades at every cut, against clicks")) : null,
    hasMedia ? h("label", { class: "field" }, "File name", name)
             : h("p", { class: "notice" }, "Load the media to export in the browser — or run the command below."),
    bar, status, h("details", { class: "logbox" }, h("summary", {}, "ffmpeg log"), logEl),
    notes, cmd);

  const go = h("button", { class: "primary", disabled: !hasMedia }, "Export");
  const stop = h("button", { hidden: true }, "Cancel");
  const dlg = modal(ctx.heading, body, [linkBtn, h("span", { class: "spacer" }), stop, go]);
  dlg.el.classList.add("wide");
  renderOps();
  update();

  let ac: AbortController | null = null;
  stop.onclick = () => ac?.abort();
  go.onclick = async () => {
    if (!media) return;
    ac = new AbortController();
    go.disabled = true;
    stop.hidden = false;
    bar.hidden = false;
    logEl.textContent = "";
    status.className = "muted";
    const progress = (msg: string, frac?: number) => {
      status.textContent = msg;
      if (frac == null) bar.removeAttribute("value"); else bar.value = frac;
    };
    const t0 = performance.now();
    try {
      let blob: Blob, ext: string, extra = "";
      if (mode.id === "wav" && !audioOpsOn()) {
        blob = await exportWav(media, ranges, progress);
        ext = "wav";
      } else {
        const r = await runCut(media, {
          spec: specOf(), ext: extOf(), progress, signal: ac.signal,
          log: (line) => { logEl.textContent += line + "\n"; },
        });
        ({ blob, ext } = r);
        if (r.net) extra = ` · fetched ${fmtBytes(r.net.fetched)} of ${fmtBytes(r.net.size)} in ${r.net.requests} requests`;
      }
      const file = `${stem()}.${ext}`;
      download(blob, file);
      status.textContent = `Saved ${file} (${fmtBytes(blob.size)}) in ${fmtDur((performance.now() - t0) / 1000)}${extra}`;
      if (!dlg.el.open) toast("Export finished");
    } catch (e) {
      status.textContent = (e as Error).message;
      status.className = "error";
    } finally {
      go.disabled = false;
      stop.hidden = true;
      ac = null;
    }
  };
}

// ------------------------------------------------------------------ fields

function fieldInput(f: Field, st: OpState, changed: () => void): { el: HTMLElement; sync: () => void } {
  if (f.type === "select") {
    const sel = h("select", { onchange: () => { st.p[f.key] = sel.value; changed(); } },
      ...f.options.map(([v, l]) => h("option", { value: v, selected: String(st.p[f.key]) === v }, l)));
    return { el: h("label", { class: "field" }, f.label, sel), sync: () => { sel.value = String(st.p[f.key]); } };
  }
  const out = h("span", { class: "muted mono" });
  const show = () => {
    const v = Number(st.p[f.key]);
    out.textContent = f.unit === "%" ? `${Math.round(v)}%` : f.max <= 1 ? v.toFixed(2) : String(v);
  };
  const range = h("input", {
    type: "range", min: f.min, max: f.max, step: f.step, value: String(st.p[f.key]),
    oninput: () => { st.p[f.key] = Number(range.value); show(); changed(); },
  });
  show();
  return {
    el: h("label", { class: "field" }, h("span", {}, f.label, " ", out), range),
    sync: () => { range.value = String(st.p[f.key]); show(); },
  };
}

/**
 * The current frame with the crop box on top; drag the box to move it. Works for
 * cross-origin media too (the canvas is only drawn, never read back).
 */
function cropPreview(video: HTMLVideoElement, frame: Frame, st: OpState, changed: () => void): { el: HTMLElement; sync: () => void } {
  const maxW = 560, maxH = 260;
  const k = Math.min(maxW / frame.width, maxH / frame.height);
  const cw = Math.round(frame.width * k), ch = Math.round(frame.height * k);
  const canvas = h("canvas", { width: cw, height: ch });
  try { canvas.getContext("2d")!.drawImage(video, 0, 0, cw, ch); } catch { /* no frame yet */ }
  const box = h("div", { class: "crop-box", title: "Drag to position" });
  const dims = h("span", { class: "crop-dims mono" });
  const wrap = h("div", { class: "crop-wrap", style: `width:${cw}px;height:${ch}px` }, canvas, box, dims);

  const sync = () => {
    const r = cropRect(st.p, frame);
    Object.assign(box.style, {
      left: `${(r.x / frame.width) * 100}%`, top: `${(r.y / frame.height) * 100}%`,
      width: `${(r.w / frame.width) * 100}%`, height: `${(r.h / frame.height) * 100}%`,
    });
    dims.textContent = `${r.w}×${r.h}`;
  };
  let drag: { x: number; y: number; cx: number; cy: number } | null = null;
  box.addEventListener("pointerdown", (e) => {
    box.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, cx: Number(st.p.cx), cy: Number(st.p.cy) };
  });
  box.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const cx = drag.cx + (e.clientX - drag.x) / cw, cy = drag.cy + (e.clientY - drag.y) / ch;
    // Store the clamped centre, so dragging past an edge doesn't build up slack.
    const r = cropRect({ ...st.p, cx, cy }, frame);
    st.p.cx = +((r.x + r.w / 2) / frame.width).toFixed(4);
    st.p.cy = +((r.y + r.h / 2) / frame.height).toFixed(4);
    changed();
  });
  const end = () => { drag = null; };
  box.addEventListener("pointerup", end);
  box.addEventListener("pointercancel", end);
  sync();
  return { el: wrap, sync };
}
