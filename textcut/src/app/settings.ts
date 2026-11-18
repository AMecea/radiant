import type { TimeStyle } from "../core/time";
import type { ClipFormat } from "../core/formats";
import type { OpState } from "../core/ops";

export interface Settings {
  /** gaps at least this long (s) are shown as pauses */
  pauseMin: number;
  /** padding (s) added around selections / clips, so cuts don't clip syllables */
  pad: number;
  timeStyle: TimeStyle;
  /** keep the current word scrolled into view while playing */
  follow: boolean;
  /** jump over pauses while playing */
  skipPauses: boolean;
  copyFormat: ClipFormat;
  rate: number;
  /** a deleted pause is shortened to this many seconds */
  pauseKeep: number;
  /** while playing, jump over what the text edits removed */
  previewEdits: boolean;
  /** short audio fades at every join of an export */
  smoothJoins: boolean;
  /** processing applied on export (crop, scale, audio filters) */
  ops: OpState[];
  exportMode: string;
  /** commands use $INPUT/$OUTPUT and radiant vars instead of the literal URL */
  useVars: boolean;
  /** transcript lines: "seg" (as transcribed), "sentence", or max words per line */
  lineMode: string;
}

const DEFAULTS: Settings = {
  pauseMin: 0.6,
  pad: 0.08,
  timeStyle: "clock",
  follow: true,
  skipPauses: false,
  copyFormat: "ranges",
  rate: 1,
  pauseKeep: 0.3,
  previewEdits: true,
  smoothJoins: true,
  ops: [],
  exportMode: "",
  useVars: false,
  lineMode: "seg",
};

const KEY = "textcut.settings.v1";

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

export function loadJson<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

export function saveJson(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* quota / private mode */ }
}
