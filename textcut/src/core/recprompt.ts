import { parseRecs, type Rec } from "./recs";
import { endsSentence, type Word } from "./transcript";

/**
 * Recommended clips from whatever AI the person already uses: textcut writes the
 * prompt, they paste it into a chat, and paste the answer back.
 *
 * The AI never writes timestamps. It gets the transcript as numbered lines that end
 * where the speaker does (a sentence end or a pause) and answers with line numbers,
 * which are turned back into times here — so a proposed clip always starts and ends
 * on a real phrase boundary, however sloppy the AI is with numbers.
 *
 * radiant's `recommend` step (radiant/steps/recommend.py) does the same thing
 * unattended, with the same prompt; keep the two in step.
 *
 * The answer comes back in one of two forms. JSON, pasted back by hand (the only
 * form radiant uses). Or — when the recording was opened from a link — a link: the
 * recording's own, with the clips added to its end (`ai=`, see {@link readRecLink}),
 * so that clicking it in the chat opens the recording with the clips in place.
 */

export interface PromptLine {
  /** start of its first word / end of its last, seconds */
  s: number;
  e: number;
  text: string;
}

export interface PromptOptions {
  count: number;
  minSeconds: number;
  maxSeconds: number;
  /** language for titles, tags and reasons, as a name or a code */
  language: string;
  /** anything the AI should know: audience, where the clips go, what to avoid */
  guidance?: string;
  /**
   * Have the AI answer with a link instead of JSON: the address to add the clips
   * to, ending in `ai=<number of lines>;` ({@link recLinkStub}).
   */
  link?: string;
}

/**
 * The transcript as lines that end at a sentence end, at a silence of at least
 * `pause` seconds or — failing both — after `maxWords` words. Line numbers are
 * 1-based positions in the result.
 *
 * `asTranscribed` is each word before any spelling fix. Lines are broken by it, so
 * that the numbers mean the same passage for everybody who has the recording,
 * whatever they corrected; the text shown is still the corrected one.
 */
export function promptLines(words: readonly Word[], pause = 0.6, maxWords = 16, asTranscribed?: readonly string[]): PromptLine[] {
  const lines: PromptLine[] = [];
  let first = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!, next = words[i + 1];
    if (!next || endsSentence(asTranscribed?.[i] ?? w.w) || i - first + 1 >= maxWords || next.s - w.e >= pause) {
      lines.push({ s: words[first]!.s, e: w.e, text: words.slice(first, i + 1).map((x) => x.w).join(" ") });
      first = i + 1;
    }
  }
  return lines;
}

function clock(seconds: number): string {
  const t = Math.floor(seconds), p = (n: number) => String(n).padStart(2, "0");
  return t >= 3600 ? `${Math.floor(t / 3600)}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}` : `${Math.floor(t / 60)}:${p(t % 60)}`;
}

const JSON_ANSWER = (lang: string) => `For each clip give:
- "title": a short hook for the post, in ${lang} — what would make someone stop, not a summary.
- "score": 0-100, how well it would work as a standalone short. Be discriminating: reserve 90+ for clips you would publish as they are, and let weaker ones score lower.
- "why": one or two sentences, in ${lang}, on why it works and anything the editor should check.
- "tags": one to three short labels in ${lang} for the kind of clip (question, story, application, quote, ...).
- "parts": the line numbers it covers, as {"from": first line, "to": last line}, inclusive.

Answer with one JSON object and nothing else, in this shape:
{"clips": [{"title": "...", "score": 90, "why": "...", "tags": ["..."], "parts": [{"from": 12, "to": 19}]}]}`;

/** The answer as a link: the clips written at the end of the recording's address. */
function linkAnswer(link: string, lang: string): string {
  const tail = link.slice(link.lastIndexOf("ai="));
  return `For each clip decide:
- its lines: the line numbers it covers, first-last, inclusive.
- a score: 0-100, how well it would work as a standalone short. Be discriminating: reserve 90+ for clips you would publish as they are, and let weaker ones score lower.
- a title: a short hook for the post, in ${lang} — what would make someone stop, not a summary.
- why: one sentence, in ${lang}, on why it works and anything the editor should check.

Your answer is one link, which opens the recording with your clips in it. Build it by copying this address exactly, character for character, and writing the clips straight after it:

${link}

Write each clip as lines~score~title~why and put ; between clips:
- lines: first-last, like 12-19 (a single line: 12-12). A clip in two parts: 12-19,40-44.
- title and why: write _ in place of every space. Keep accented letters as they are (ă, ș, é). Do not use the characters & # % ~ ; ( ) " or line breaks in them; reword instead.
- No spaces anywhere in the link, and nothing after the last clip.

For two clips, the end of the link would look like this:
…${tail}12-19~92~Why_hasn't_he_come_yet?~Opens_on_a_question_and_answers_it;40-44,61-63~81~The_door_that_stayed_open~A_story_with_a_clear_ending

Answer with the link and nothing else, as a Markdown link so it can be clicked: [Open the clips](the whole link)`;
}

/** How the `ai=` value starts: the number of lines the clips are counted in. */
export function recLinkStub(nLines: number): string {
  return `${nLines};`;
}

/** The whole message to paste into an AI chat. */
export function buildRecPrompt(lines: readonly PromptLine[], o: PromptOptions): string {
  const numbered = lines.map((l, i) => `${i + 1} [${clock(l.s)}] ${l.text}`).join("\n");
  const guidance = o.guidance?.trim();
  const extra = guidance ? `\nWhat the editor asked for:\n${guidance}\n` : "";
  const lang = o.language.trim() || "the transcript's language";
  return `You are choosing the passages of a recording that an editor will cut into short vertical videos (Instagram Reels, YouTube Shorts, TikTok). The editor trusts your list: they will open the first few and publish them, so a clip that needs the rest of the recording to make sense, or that trails off, costs them time.

Below is the full transcript, one numbered line per phrase, each with the time it starts. It was transcribed automatically, so expect misheard words and missing punctuation.

Propose the ${o.count} best clips, each between ${Math.round(o.minSeconds)} and ${Math.round(o.maxSeconds)} seconds long (a line's length is the gap to the next line's start time).

What makes a clip work:
- The first sentence stops the scroll: a question, a bold claim, the start of a story, a tension the viewer wants resolved. Start on that line, not on the sentences that lead up to it.
- It stands alone. Someone who has never heard the speaker follows it with no context: no "as I said", no pronoun whose referent was left behind, no reading reference without its point.
- It carries one idea and lands it. End on the line that pays it off — a conclusion, a punchline, a sentence worth quoting — and stop there, before the speaker moves on.
- Stories, concrete images, direct address and honest tension hold attention better than exposition or lists.
- Prefer variety across the recording over several clips making the same point; do not overlap clips.

A clip is normally one continuous passage. Use two parts only when it clearly makes a better clip — a question asked early and answered much later, or a passage with a digression in the middle worth skipping — and say so in the reason. Parts play in the order you list them.

Announcements, greetings, prayers read out, housekeeping and passages that only make sense inside the room are not clips. If the recording has fewer than ${o.count} passages that would really work, return fewer.
${extra}
${o.link ? linkAnswer(o.link, lang) : JSON_ANSWER(lang)}

<transcript>
${numbered}
</transcript>`;
}

/** "12-19", "12-19,40-44" — and "12" for a single line */
const LINK_LINES = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;

/**
 * The clips an AI wrote at the end of a link (the `ai=` value, already
 * URL-decoded): `412;12-19~92~A_title~Why_it_works;40-44,61-63~81~Another`.
 *
 * The first piece is how many lines the transcript had for the AI; a different
 * count here means the link belongs to another recording (or another way of
 * breaking lines), and its numbers would point at the wrong passages.
 * Each clip is `lines~score~title~why`, "_" standing for a space. Read leniently:
 * the fields are told apart by what they look like, not by their place, and a clip
 * that makes no sense is skipped.
 */
export function readRecLink(value: string, lines: readonly PromptLine[]): Rec[] {
  const pieces = value.trim().split(";").map((x) => x.trim()).filter(Boolean);
  if (pieces.length && /^\d+$/.test(pieces[0]!)) {
    if (Number(pieces[0]) !== lines.length) {
      throw new Error("These clips were made for another recording, or an older version of this one. Ask the AI again with a fresh prompt.");
    }
    pieces.shift();
  }
  const text = (x: string) => x.replace(/[_\s]+/g, " ").trim();
  const clips = pieces.flatMap((piece): Array<Record<string, unknown>> => {
    const fields = piece.split("~").map((x) => x.trim());
    // The lines are the field that looks like a range; failing that (a single
    // line, "6"), the first bare number — the score then comes after it.
    let at = fields.findIndex((f) => /[-,]/.test(f) && LINK_LINES.test(f));
    if (at < 0) at = fields.findIndex((f) => LINK_LINES.test(f));
    if (at < 0) return [];
    const ranges = fields[at]!.split(",").flatMap((r): Array<[number, number]> => {
      const [a, b = a] = r.split("-").map(Number) as [number, number?];
      return a >= 1 && a <= b && b <= lines.length ? [[lines[a - 1]!.s, lines[b - 1]!.e]] : [];
    });
    if (!ranges.length) return [];
    const rest = fields.filter((_, i) => i !== at);
    const si = rest.findIndex((f) => /^\d{1,3}$/.test(f) && Number(f) <= 100);
    const score = si >= 0 ? Number(rest[si]) : undefined;
    const words = rest.filter((_, i) => i !== si).map(text).filter(Boolean);
    return [{ title: words[0] ?? "", why: words.slice(1).join(" "), ...(score != null ? { score } : {}), ranges }];
  });
  if (!clips.length) throw new Error("The link has no clips that point at lines of this transcript. Was it made from this recording's prompt?");
  return parseRecs(clips);
}

/** The `ai=` value of a link somewhere in `text`, URL-decoded; null when there is none. */
export function findRecLink(text: string): string | null {
  const m = text.match(/[#&?]ai=([^\s&<>"\])]+)/);
  if (!m) return null;
  const raw = m[1]!.replace(/\+/g, " ");
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function lineNo(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) ? n : NaN;
}

/**
 * The clips in an AI's answer to `buildRecPrompt`, as recommendations with real
 * times. Tolerates prose or a code fence around the JSON, and an answer that gives
 * `ranges` in seconds instead of line numbers. An answer that is a link (pasted
 * because it wouldn't click) is read as one. Throws with a message for the person
 * who pasted it when nothing usable is found.
 */
export function readRecAnswer(text: string, lines: readonly PromptLine[]): Rec[] {
  const linked = findRecLink(text);
  if (linked != null && !/"clips"\s*:/.test(text)) return readRecLink(linked, lines);
  const open = text.search(/[{[]/);
  const close = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (open < 0 || close <= open) throw new Error("That doesn't look like the AI's answer — it should contain { \"clips\": [ … ] }.");
  let data: unknown;
  try {
    data = JSON.parse(text.slice(open, close + 1));
  } catch {
    throw new Error("The answer is cut off or isn't valid JSON. Copy the AI's whole answer, or ask it to send the JSON again.");
  }
  const list: unknown = Array.isArray(data) ? data : (data as { clips?: unknown } | null)?.clips;
  if (!Array.isArray(list)) throw new Error("The answer has no \"clips\" list.");

  const clips = list.flatMap((item): Array<Record<string, unknown>> => {
    if (!item || typeof item !== "object") return [];
    const o = item as Record<string, unknown>;
    if (!Array.isArray(o.parts)) return [o]; // already has ranges in seconds, or is unusable
    const ranges = o.parts.flatMap((p): Array<[number, number]> => {
      const q = (p ?? {}) as Record<string, unknown>;
      const a = lineNo(q.from), b = lineNo(q.to);
      return a >= 1 && a <= b && b <= lines.length ? [[lines[a - 1]!.s, lines[b - 1]!.e]] : [];
    });
    return ranges.length ? [{ ...o, ranges }] : [];
  });
  const recs = parseRecs(clips);
  if (!recs.length) throw new Error("None of the clips in the answer point at lines of this transcript. Was it made from this recording's prompt?");
  return recs;
}
