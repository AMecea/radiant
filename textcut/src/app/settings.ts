import type { TimeStyle } from "../core/time";
import type { ClipFormat } from "../core/formats";

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
}

const DEFAULTS: Settings = {
  pauseMin: 0.6,
  pad: 0.08,
  timeStyle: "clock",
  follow: true,
  skipPauses: false,
  copyFormat: "ranges",
  rate: 1,
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
