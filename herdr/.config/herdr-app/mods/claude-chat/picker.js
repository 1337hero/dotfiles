// Reads Claude Code's own /model picker and drives it. Pure: no "herdr" imports, `hc` comes in as an argument.
//
// The picker is the only way to change the model and effort of one running session without saving a
// default for new ones. Typed as `/model <name>` or `/effort <level>`, the choice is saved for every new
// session. So the only keys sent here are the bare `/model`, arrows, Esc, and `s` (this session only).
// `Enter` (set as default) is never sent.
//
// `hc` is { read(t) -> screen text, keys(t, [keys]), send(t, text), waitOutput(t, text, seconds),
// status(t) -> "idle" | "done" | "working" | "blocked" | ... }. Everything read from a screen is data.

import { STASH_HELD } from "./draft.js";
import { dialogUp } from "./route.js";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const EFFORT_LABEL = { low: "Low", medium: "Medium", high: "High", xhigh: "xHigh", max: "Max" };

// Models the pad shows until the picker has been read. The rows are re-read from the picker once per app start.
export const FALLBACK_MODELS = [
  { name: "Opus 5.5", family: "Opus", n: 2 },
  { name: "Fable 5.1", family: "Fable", n: 3 },
  { name: "Sonnet 5.5", family: "Sonnet", n: 4 },
  { name: "Haiku 5.5", family: "Haiku", n: 5 },
];

// A session between turns reads "idle", or "done" until its finished turn has been looked at. Both are safe.
// "working" and "blocked" are not, and neither is a state that could not be read.
export const readyState = (state) => state === "idle" || state === "done";

// A dialog already open, or a stash held in the prompt, means a send would land in the wrong place. Enter in an open /model
// saves a default. Returns the refusal, or null to carry on.
async function refused(hc, t) {
  const screen = await hc.read(t);
  if (await dialogUp(hc, screen)) return { ok: false, reason: "dialog" };
  return STASH_HELD.test(screen) ? { ok: false, reason: "stashed" } : null;
}

const plain = (s) => String(s ?? "").replace(/ /g, " ");

// The open /model picker, or null when the screen has none. `rows` are the visible rows only: the list
// scrolls, and `hiddenBelow` counts the rows past the last one drawn. Numbers are the picker's own, so
// they stay right when the list has scrolled. `marked` is the row the cursor is on, `current` the row
// with the tick (the session's model). `effort` is the effort line under the list, for the marked row.
// A rule under the heading is the prompt's, so that's a conversation quoting a picker, not one.
export function parsePicker(screen) {
  const lines = plain(screen).split("\n");
  const head = lines.findLastIndex((l) => /^\s*Select model\s*$/.test(l));
  if (head < 0 || lines.slice(head + 1).some((l) => /^\s*─{20,}/.test(l))) return null;
  const rows = [];
  let hiddenBelow = 0;
  let effort = null;
  let ended = false;
  for (const line of lines.slice(head + 1)) {
    const row = /^\s*([❯↑↓])?\s*(\d+)\.\s+(\S.*?)\s*$/.exec(line);
    if (row && !ended) {
      const [left, ...rest] = row[3].split(/\s{2,}/);
      const hint = rest.join("  ");
      const bare = left.replace(/\s*✔$/, "").trim();
      // Claude Code draws a model as its family ("Sonnet") with the version leading the hint ("Sonnet 5.5 · ..."), or as
      // the full name. Rows go by the full name, which is what the result line and the status line use.
      const version = !/\d/.test(bare) && hint.startsWith(`${bare} `) ? /^(\d[\d.]*)\s*·/.exec(hint.slice(bare.length + 1)) : null;
      rows.push({
        n: Number(row[2]),
        name: version ? `${bare} ${version[1]}` : bare,
        hint,
        marked: row[1] === "❯",
        current: /✔$/.test(left),
      });
      continue;
    }
    const more = /^\s*(?:…|\.\.\.)\s*\+(\d+)\s+models?\s*$/.exec(line);
    if (more) { hiddenBelow = Number(more[1]); continue; }
    const level = /^\s*\S\s+(Low|Medium|High|xHigh|Max)\s+effort(\s+\(default\))?(?:\s|$)/i.exec(line);
    if (level && rows.length) { effort = { level: level[1].toLowerCase(), isDefault: Boolean(level[2]) }; ended = true; continue; }
    if (/Esc to cancel/.test(line)) break;
  }
  if (!rows.length) return null;
  return {
    rows,
    marked: rows.find((r) => r.marked)?.n ?? null,
    current: rows.find((r) => r.current)?.n ?? null,
    hiddenAbove: rows[0].n > 1,
    hiddenBelow,
    effort,
    total: rows.at(-1).n + hiddenBelow,
    footer: plain(screen).includes("s to use this session only"),
  };
}

// The rows the pad offers: the first row of each model family, in the picker's order, skipping "Default"
// (which is a second Opus row). Needs the top of the list. With `withState` it returns { models, complete },
// where complete means a family repeated, so every family is in.
export function padModels(picker, withState = false) {
  if (!picker || picker.hiddenAbove) return null;
  const seen = new Set();
  const out = [];
  let complete = false;
  for (const r of picker.rows) {
    if (/^default\b/i.test(r.name)) continue;
    const family = r.name.split(/\s+/)[0];
    if (seen.has(family)) { complete = true; break; }
    seen.add(family);
    out.push({ name: r.name, family, n: r.n });
  }
  if (!out.length) return null;
  return withState ? { models: out, complete } : out;
}

// Whether rows read from the picker can be trusted as the pad's models. A narrow terminal draws the picker another way,
// with family names only and the list cut short, and reading that must not replace good rows. Four rows with a version
// each is what it takes.
export function modelsLookRight(models) {
  return Array.isArray(models) && models.length >= 4 && models.every((m) => typeof m?.name === "string" && /\d/.test(m.name) && m.family && Number.isInteger(m.n));
}

// The model and effort on the status line, such as "model:  Haiku 5.5  -  low  context: ...". The status line
// is the user's own setup, so a miss is null and the composer shows nothing. The last one on the screen is the
// current one. Segments are split on the powerline glyphs, and the non-breaking spaces count as spaces.
export function parseStatus(screen) {
  let found = null;
  for (const raw of plain(screen).split("\n")) {
    const segs = raw.split(/[-]/).map((s) => s.trim());
    const at = segs.findIndex((s) => /^model:/.test(s));
    if (at < 0) continue;
    const value = (segs[at].slice("model:".length).trim() || segs[at + 1] || "").replace(/\s+/g, " ").split(/ context:/)[0].trim();
    const m = /^(.+?)(?: - (low|medium|high|xhigh|max))?$/i.exec(value);
    if (!m || !m[1] || /^context:/.test(m[1])) continue;
    found = { model: m[1].trim(), effort: m[2] ? m[2].toLowerCase() : null };
  }
  return found;
}

// What Claude Code printed after `s`, such as "Set model to Sonnet 5.5 for this session only with xhigh effort".
// Only the output of the latest `/model` counts, so a line left over from an earlier change is not mistaken for
// this one. The effort part is missing when the effort was not changed. A terminal narrower than the line breaks it between
// words, so line breaks count as spaces. The default row prints its model as "Opus 5.5 (default)".
export function parseApplied(screen) {
  const lines = plain(screen).split("\n");
  const echo = lines.findLastIndex((l) => /^\s*❯\s*\/model\s*$/.test(l));
  const text = lines.slice(echo + 1).join(" ").replace(/\s+/g, " ");
  let found = null;
  for (const m of text.matchAll(/Set model to (.+?)(?: \(default\))? for this session only(?: with (low|medium|high|xhigh|max) effort)?/gi)) {
    found = { model: m[1].trim(), effort: m[2] ? m[2].toLowerCase() : null };
  }
  return found;
}

// Once a conversation has history, Claude Code asks before it switches model: "Switch model?", with
// "1. Yes, switch to <model>" and "2. No, go back". Null when that question is not what the screen ends on: it's read up from
// the bottom, so a conversation quoting it can't decide what gets pressed. A narrow terminal can wrap the model's name.
export function parseSwitchDialog(screen) {
  const lines = plain(screen).split("\n");
  const end = lines.findLastIndex((l) => l.trim());
  const head = lines.findLastIndex((l) => /^\s*Switch model\?\s*$/.test(l));
  if (head < 0 || end < head || !/^\s*(?:❯\s*)?2\.\s+No, go back\s*$/.test(lines[end])) return null;
  const options = lines.slice(head + 1, end);
  const at = options.findIndex((l) => /^\s*(?:❯\s*)?1\.\s+Yes, switch to /.test(l));
  if (at < 0) return null;
  return { model: options.slice(at).join(" ").replace(/^\s*(?:❯\s*)?1\.\s+Yes, switch to /, "").trim().replace(/\s+/g, " ") };
}

// The context used, in percent, from the status line's `context:` part. Null when the screen has none.
export function parseContext(screen) {
  const all = [...plain(screen).matchAll(/context:\D*?([\d.]+)%/g)];
  return all.length ? Number(all.at(-1)[1]) : null;
}

// The keys to move the cursor to a row, by its number. Up and down never wrap: the target is always near.
export function planModel(picker, target) {
  if (!picker) return { error: "no picker" };
  if (picker.marked == null) return { error: "no marked row" };
  const row = picker.rows.find((r) => r.name === target.name);
  const n = row ? row.n : target.n;
  if (!Number.isInteger(n) || n < 1 || n > picker.total) return { error: `no row for ${target.name}` };
  const delta = n - picker.marked;
  return { keys: Array(Math.abs(delta)).fill(delta > 0 ? "down" : "up"), n };
}

// The keys to move the effort line to a level. Left and right stop at Low and Max.
export function planEffort(picker, level) {
  const want = EFFORTS.indexOf(level);
  if (want < 0) return { error: `unknown effort ${level}` };
  if (!picker?.effort) return { error: "no effort line" };
  const delta = want - EFFORTS.indexOf(picker.effort.level);
  return { keys: Array(Math.abs(delta)).fill(delta > 0 ? "right" : "left") };
}

// Whether the picker shows exactly this choice: the cursor on the model's row and the effort line at the level.
export function matches(picker, choice) {
  if (!picker) return false;
  const row = picker.rows.find((r) => r.marked);
  return Boolean(row) && row.name === choice.model && (choice.effort == null || picker.effort?.level === choice.effort);
}

// Reads the screen until `ok(screen)` holds, up to `tries` reads. Between reads it waits for `text` to be
// printed, for at most `seconds`, so a redraw that is a moment behind a key press is not mistaken for a miss.
async function screenWhen(hc, t, ok, { text, seconds = 1, tries = 6 } = {}) {
  let screen = "";
  for (let i = 0; i < tries; i++) {
    screen = await hc.read(t);
    if (ok(screen)) return { screen, ok: true };
    if (text) await hc.waitOutput(t, text, seconds);
  }
  return { screen, ok: false };
}

// Sends Esc and reads back that the picker, or the switch question, is gone. A second Esc goes only to a screen
// that still shows one: on an empty prompt, Esc twice opens the rewind list. Never throws.
async function leave(hc, t) {
  try {
    for (let i = 0; i < 3; i++) {
      await hc.keys(t, ["esc"]);
      const gone = await screenWhen(hc, t, (s) => !parsePicker(s) && !parseSwitchDialog(s), { text: "Kept model", seconds: 1, tries: 4 });
      if (gone.ok) return true;
    }
    return false;
  } catch { return false; }
}

// Opens the picker and returns the rows the pad offers, from the top of the list. The list shows as many
// rows as the terminal has room for, so on a short screen it walks down a page at a time until a model
// family repeats. Esc closes it again.
export async function readModels(hc, t) {
  if (!readyState(await hc.status(t))) return { ok: false, reason: "busy" };
  const stop = await refused(hc, t);
  if (stop) return stop;
  await hc.send(t, "/model");
  const open = await screenWhen(hc, t, (s) => parsePicker(s), { text: "Select model" });
  if (!open.ok) return { ok: false, reason: "no picker" };
  let result;
  try {
    let picker = parsePicker(open.screen);
    const step = async (key, count, moved) => {
      await hc.keys(t, Array(count).fill(key));
      const seen = await screenWhen(hc, t, (s) => moved(parsePicker(s)), { tries: 4, text: "Select model" });
      return parsePicker(seen.screen) ?? picker;
    };
    // Up to the top first: the picker opens on the session's own model, which may be far down.
    for (let i = 0; i < 20 && picker.hiddenAbove; i++) {
      const was = picker.rows[0].n;
      picker = await step("up", Math.max(1, picker.rows.length - 1), (p) => p && p.rows[0].n < was);
    }
    const known = new Map();
    for (let i = 0; i < 20; i++) {
      for (const r of picker.rows) known.set(r.n, r);
      const rows = [...known.values()].sort((x, y) => x.n - y.n);
      const state = padModels({ rows, hiddenAbove: false }, true);
      if (state?.complete || !picker.hiddenBelow) break;
      const last = picker.rows.at(-1).n;
      picker = await step("down", Math.max(1, picker.rows.length), (p) => p && p.rows.at(-1).n > last);
    }
    const models = padModels({ rows: [...known.values()].sort((x, y) => x.n - y.n), hiddenAbove: false }, false);
    result = models ? { ok: true, models, effort: picker.effort } : { ok: false, reason: "no rows" };
  } catch (error) {
    result = { ok: false, reason: "error", detail: String(error?.message ?? error) };
  }
  return { ...result, closed: await leave(hc, t) };
}

// Changes one session's model and effort. `wanted` is { model: <row name>, effort: <EFFORTS entry> }, and
// `row` is the pad row, { name, n }, for the model. A null model or effort stays as the session has it, read from the
// picker, which opens on the session's own model and effort. The pane's own idea of them can be behind, so a `/effort` that
// used it could move the session to another model. The steps:
//   send /model, wait for the picker, move to the model row, move the effort line, read back, then `s`.
// Any mismatch sends Esc and returns { ok: false }. Only runs while the session is idle. `opts.setAside`
// is called before anything is sent, for the composer's half-typed line (step 5 supplies it). `set` in the result is the
// model and effort the session is on afterwards.
export async function applyChoice(hc, t, wanted, row, opts = {}) {
  if (!readyState(await hc.status(t))) return { ok: false, reason: "busy" };
  const stop = await refused(hc, t);
  if (stop) return stop;
  await opts.setAside?.();
  await hc.send(t, "/model");
  const open = await screenWhen(hc, t, (s) => parsePicker(s), { text: "Select model" });
  if (!open.ok) return { ok: false, reason: "no picker" };
  const fail = async (reason, detail) => ({ ok: false, reason, detail, closed: await leave(hc, t) });
  try {
    let picker = parsePicker(open.screen);
    const choice = { model: wanted.model ?? picker.rows.find((r) => r.marked)?.name, effort: wanted.effort ?? picker.effort?.level ?? null };
    if (!choice.model) return await fail("plan", "the picker shows no model to keep");
    const move = planModel(picker, { name: row?.name ?? choice.model, n: row?.n });
    if (move.error) return await fail("plan", move.error);
    if (move.keys.length) {
      await hc.keys(t, move.keys);
      const seen = await screenWhen(hc, t, (s) => parsePicker(s)?.rows.some((r) => r.marked && r.n === move.n), { text: choice.model });
      picker = parsePicker(seen.screen);
      if (!seen.ok || !picker) return await fail("model", "the cursor did not reach the row");
    }
    // A small terminal can leave the effort line off the screen. Only a choice that names an effort needs it.
    if (wanted.effort && !picker.effort) return await fail("no effort line", "the effort line is off the screen");
    if (!picker.effort) choice.effort = null;
    const turn = choice.effort ? planEffort(picker, choice.effort) : { keys: [] };
    if (turn.error) return await fail("plan", turn.error);
    if (turn.keys.length) {
      await hc.keys(t, turn.keys);
      const seen = await screenWhen(hc, t, (s) => parsePicker(s)?.effort?.level === choice.effort, { text: `${EFFORT_LABEL[choice.effort]} effort` });
      picker = parsePicker(seen.screen);
      if (!seen.ok || !picker) return await fail("effort", "the effort line did not reach the level");
    }
    // The read-back: the screen as it is right now must show exactly the choice.
    const last = parsePicker(await hc.read(t));
    if (!matches(last, choice)) return await fail("mismatch", `screen shows ${last?.rows.find((r) => r.marked)?.name} / ${last?.effort?.level}`);
    await hc.keys(t, ["s"]);
    // Claude Code prints the result, or first asks "Switch model?" once the conversation has history. Answer that with
    // its own "1", only when it names the chosen model. Then the result must name the chosen model and effort. A model
    // that wasn't asked for is the row the picker opened on, and the default row prints another name than its row's.
    const applied = (s) => {
      const a = parseApplied(s);
      return Boolean(a) && (!wanted.model || a.model === wanted.model) && (!choice.effort || a.effort === null || a.effort === choice.effort);
    };
    const settled = (s) => !parsePicker(s) && (parseSwitchDialog(s) !== null || applied(s));
    let done = await screenWhen(hc, t, settled, { text: "model", seconds: 2 });
    const dialog = done.ok ? parseSwitchDialog(done.screen) : null;
    if (dialog) {
      if (dialog.model !== choice.model) return await fail("dialog", `the question names ${dialog.model}`);
      await hc.keys(t, ["1"]);
      done = await screenWhen(hc, t, (s) => !parseSwitchDialog(s) && !parsePicker(s) && applied(s), { text: "Set model to", seconds: 2 });
    }
    if (!done.ok) {
      if (parsePicker(done.screen) || parseSwitchDialog(done.screen)) return await fail("apply", "the picker or its question stayed open");
      return { ok: false, reason: "unconfirmed", detail: "Claude Code printed no line naming the model", closed: true };
    }
    const result = parseApplied(done.screen);
    const set = { model: result.model, effort: result.effort ?? choice.effort };
    // The status line catches up a second or two later. It is a check, not a condition: a status line that
    // never shows the model (not every setup has one) leaves `status` null.
    const same = (s) => parseStatus(s)?.model === set.model && parseStatus(s)?.effort === set.effort;
    const line = await screenWhen(hc, t, same, { text: set.model, seconds: 2, tries: 4 });
    return { ok: true, confirmed: true, applied: result, set, status: line.ok ? "match" : parseStatus(line.screen) ? "stale" : null };
  } catch (error) {
    return { ok: false, reason: "error", detail: String(error?.message ?? error), closed: await leave(hc, t) };
  }
}
