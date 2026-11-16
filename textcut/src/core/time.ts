export type TimeStyle = "clock" | "seconds";

/** "83.4" | "1:23.4" | "00:01:23.400" → seconds (NaN when unparseable). */
export function parseTime(v: string | number): number {
  if (typeof v === "number") return v;
  const s = v.trim();
  if (!s) return NaN;
  if (!s.includes(":")) return Number(s);
  return s.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

/** seconds → "HH:MM:SS.mmm" (clock) or "83.450" (seconds). */
export function fmtTime(t: number, style: TimeStyle = "clock", decimals = 3): string {
  if (!Number.isFinite(t)) return "—";
  if (style === "seconds") return t.toFixed(decimals);
  const neg = t < 0;
  const unit = 10 ** decimals;
  let ms = Math.round(Math.abs(t) * unit);
  const h = Math.floor(ms / (3600 * unit)); ms -= h * 3600 * unit;
  const m = Math.floor(ms / (60 * unit)); ms -= m * 60 * unit;
  const sec = Math.floor(ms / unit); ms -= sec * unit;
  const frac = decimals ? "." + String(ms).padStart(decimals, "0") : "";
  return (neg ? "-" : "") + [h, m, sec].map((x) => String(x).padStart(2, "0")).join(":") + frac;
}

/** Compact display form: "1:23.4" or "1:02:03.0". */
export function fmtShort(t: number): string {
  if (!Number.isFinite(t)) return "—";
  const tenths = Math.round(t * 10);
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const s = ((tenths % 600) / 10).toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function fmtDur(d: number): string {
  return d < 60 ? d.toFixed(1) + "s" : fmtShort(d);
}
