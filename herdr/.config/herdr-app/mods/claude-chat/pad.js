// The model and effort pad's state, and the context gauge's numbers. Pure: no "herdr" imports.
//
// The pad is a grid, effort across and model down. A cursor sits on one cell. Arrow keys move it by one cell
// and stop at the edges, and a press or drag puts it under the pointer. None of that reaches the session: the
// cell applies once, as the pad closes, unless Esc closed it. See `padClosed`.
// Nothing here talks to Claude Code: `padChoice` hands the chosen cell to `applyChoice` in picker.js.
import { EFFORTS, EFFORT_LABEL, FALLBACK_MODELS } from "./picker.js";

// The pad's field, in pixels, as the mockup lays it out: five columns across, one row per model.
export const FIELD = { width: 246, height: 144, labelWidth: 44, cardWidth: 324 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// A pad on `models` (rows from the picker, or the fallback), starting on the session's current model and
// effort. A model or effort that isn't known starts on the first row or on High.
export function newPad(models, current = {}) {
  const rows = models?.length ? models : FALLBACK_MODELS;
  const byName = rows.findIndex((m) => m.name === current.model);
  const byFamily = rows.findIndex((m) => current.model && m.family === String(current.model).split(/\s+/)[0]);
  const col = EFFORTS.indexOf(current.effort);
  return { models: rows, row: byName >= 0 ? byName : Math.max(0, byFamily), col: col >= 0 ? col : EFFORTS.indexOf("high") };
}

const ARROWS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

// One arrow key. Returns a new pad; the cursor stops at the edges, it does not wrap.
export function movePad(pad, key) {
  const d = ARROWS[key];
  if (!d) return pad;
  return { ...pad, col: clamp(pad.col + d[0], 0, EFFORTS.length - 1), row: clamp(pad.row + d[1], 0, pad.models.length - 1) };
}

// The cell under a point inside the field, `x` and `y` from the field's top left.
export function padAt(pad, x, y, width = FIELD.width, height = FIELD.height) {
  const col = clamp(Math.floor((x / width) * EFFORTS.length), 0, EFFORTS.length - 1);
  const row = clamp(Math.floor((y / height) * pad.models.length), 0, pad.models.length - 1);
  return { ...pad, row, col };
}

// A key in the pad: arrows move, Enter applies, Escape closes. `keystroke` is the event's own spelling.
export function padKey(pad, keystroke) {
  const key = String(keystroke);
  if (ARROWS[key]) return { pad: movePad(pad, key), action: null };
  if (key === "enter") return { pad, action: "apply" };
  if (key === "escape") return { pad, action: "close" };
  return { pad, action: null };
}

// What applying the pad would set: the model's row name and the effort level, plus the pad row for the key plan.
export function padChoice(pad) {
  const row = pad.models[pad.row];
  return { choice: { model: row.name, effort: EFFORTS[pad.col] }, row };
}

// The heading: the model's name, and the effort in words.
export function padReadout(pad) {
  const row = pad.models[pad.row];
  return { model: row.name, effort: EFFORT_LABEL[EFFORTS[pad.col]] };
}

// The labels down the left side: the family name, "Opus", not "Opus 5.5".
export const padRowLabels = (pad) => pad.models.map((m) => m.family);

// The centre of a cell, in pixels from the field's top left.
export function padPoint(row, col, rows, width = FIELD.width, height = FIELD.height) {
  return { x: ((col + 0.5) * width) / EFFORTS.length, y: ((row + 0.5) * height) / rows };
}

// Whether the pad's cell is what the session already runs.
export const padIsCurrent = (pad, current) => {
  const { choice } = padChoice(pad);
  return choice.model === current?.model && choice.effort === current?.effort;
};

// What closing the pad does, other than by Esc. `start` is the pad as it opened and `waiting` says a choice hasn't applied
// yet. A puck that ended where it began changes nothing, so nothing goes to the terminal: "none". Moved back onto what the
// session already runs, it takes back the choice that's waiting: "cancel". Anything else is "apply".
export function padClosed(pad, start, current, waiting = false) {
  if (pad.row === start.row && pad.col === start.col) return "none";
  return waiting && padIsCurrent(pad, current) ? "cancel" : "apply";
}

// ---- The context gauge: a tick meter, 13 ticks wide ----

export const GAUGE_TICKS = 13;

// How many ticks light for a percent, 0 to 100. A missing percent lights none.
export function gaugeLit(percent, ticks = GAUGE_TICKS) {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return 0;
  return clamp(Math.round((ticks * clamp(percent, 0, 100)) / 100), 0, ticks);
}

// Which theme colour the lit ticks take: calm under 60, warm under 85, then the blocked colour.
export function gaugeTone(percent) {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return "dim";
  return percent < 60 ? "done" : percent < 85 ? "working" : "blocked";
}

// The gauge's number, such as "22%". Whole percents, and a dash with no reading.
export const gaugeLabel = (percent) => (typeof percent === "number" && Number.isFinite(percent) ? `${Math.round(percent)}%` : "-");

// ---- Typed `/model` and `/effort`, and what the pane does about them ----

const note = (text) => ({ open: true, note: text });

// What the composer does with a typed `/model` or `/effort`. Neither is ever sent to the terminal, because typed with a
// value they save a default for every new session. `null` means the text isn't one of them. Otherwise `{ open: true }`
// opens the pad, with `note` when the value didn't make sense, and `{ choose, row }` is a choice to apply to this session
// only. A model or effort the text doesn't name is null in the choice, so `applyChoice` keeps what the session has.
// `models` are the pad's rows.
export function routeModel(text, models) {
  const m = /^\/(model|effort)(?:\s+(\S.*?))?\s*$/i.exec(String(text ?? "").trim());
  if (!m || String(text).includes("\n")) return null;
  const [, command, rest] = m;
  const words = rest ? rest.toLowerCase().split(/\s+/) : [];
  if (!words.length) return { open: true };
  const rows = models?.length ? models : FALLBACK_MODELS;
  const rowFor = (word) => rows.find((r) => r.family.toLowerCase() === word || r.name.toLowerCase() === word);
  let row = null, effort = null;
  if (command.toLowerCase() === "model") {
    row = rowFor(words[0] === "default" ? "" : words[0]);
    if (!row && words.length > 1) row = rowFor(`${words[0]} ${words[1]}`);
    if (!row) return note(`There's no model called ${rest}`);
    effort = words.find((w, i) => i > 0 && EFFORTS.includes(w)) ?? null;
  } else {
    if (words.length !== 1 || !EFFORTS.includes(words[0])) return note(`The efforts are ${EFFORTS.map((e) => EFFORT_LABEL[e]).join(", ")}`);
    effort = words[0];
  }
  return { choose: { model: row?.name ?? null, effort }, row };
}

// The model and effort to show. The status line trails a change by a few seconds, so for `graceMs` after an apply a
// reading that differs from what was set doesn't replace it.
export function mergeCurrent(current, read, applied, now, graceMs = 20000) {
  if (!read?.model) return current ?? null;
  const same = applied && read.model === applied.model && read.effort === applied.effort;
  if (applied && !same && now - applied.at < graceMs) return current ?? null;
  return { model: read.model, effort: read.effort ?? (read.model === current?.model ? current?.effort ?? null : null) };
}

// A choice on top of one that's waiting, or `waiting` null. An apply takes seconds, and a turn can take minutes, so `/model`
// then `/effort` have to add up. What the new choice names replaces what's waiting, and the rest stays.
export function addChoice(waiting, choice, row) {
  return {
    choice: { model: choice.model ?? waiting?.choice.model ?? null, effort: choice.effort ?? waiting?.choice.effort ?? null },
    row: choice.model ? row : waiting?.row ?? null,
  };
}

const APPLY_NOTES = {
  "no picker": "The model picker didn't open",
  unconfirmed: "The change wasn't confirmed",
  dialog: "A dialog is open in the terminal",
  stashed: "A stashed line is in the terminal",
  "no effort line": "The terminal is too small to show the effort",
  other: "The model didn't change",
};

// What a finished apply leaves: the new `current` and `applied`, whether the choice stays `pending`, the `note`, and whether
// to `read` the status line. After anything but a busy answer the session may not be what the pane holds, so the status line
// is read, and `applied` goes so that its grace can't hide what the status line says.
export function afterApply(r, current, applied, now) {
  if (r.ok) {
    const set = { ...r.set, effort: r.set.effort ?? current?.effort ?? null };
    return { current: set, applied: { ...set, at: now }, pending: false, note: null, read: true };
  }
  if (r.reason === "busy") return { current, applied, pending: true, note: null, read: false };
  const note = r.closed === false ? "The model picker is still open in the terminal" : APPLY_NOTES[r.reason] ?? APPLY_NOTES.other;
  return { current, applied: null, pending: false, note, read: true };
}

// `tried` after the session's state changes. Only a run of ready states holds it, so a busy answer at idle is tried again
// once a turn has come and gone, even when that ends on idle again.
export const triedAfter = (tried, state) => (state === "idle" || state === "done" ? tried : null);

// What to do next with a choice that's waiting. It runs once the session is between turns, and not again for the same
// state after a try that came to nothing, so a busy answer can't spin.
export function nextStep({ pending, applying, state, tried }) {
  if (!pending || applying) return null;
  const ready = state === "idle" || state === "done";
  return ready && tried !== state ? "apply" : null;
}
