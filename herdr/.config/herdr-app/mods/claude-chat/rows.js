// The thread's model. Pure, with no Herdr or UI imports, so `node --test` can load this file. The row shapes are at the
// top of thread.js. A thread is { rows, start, end, more }: `rows` is every row read so far, oldest first, and `start` and
// `end` are the byte offsets they cover. A row is a plain object and stays one, so a later step can keep its own notes
// about a row by id without changing this model.
import { queueFrom } from "./send.js";

export const PAGE = 60;

export const emptyThread = () => ({ rows: [], results: {}, queue: [], start: null, end: 0, more: false });

// A result can land before its call: the page holding the call may not have been read yet. So results stay in a map by
// tool id, and `toolState` looks them up, whichever came first.
function withResults(thread, reply) {
  const results = { ...thread.results };
  const rows = [], queue = [];
  for (const row of reply.rows) {
    if (row.kind === "result") results[row.tool] = row;
    else if (row.kind === "queue") queue.push({ operation: row.op, content: row.text ?? undefined });
    else rows.push(row);
  }
  return { rows, results, queue };
}

// Rows read forward from `thread.end`. A reply that doesn't start there is stale and changes nothing.
export function appendReply(thread, reply) {
  if (reply.start !== thread.end) return thread;
  const { rows, results, queue } = withResults(thread, reply);
  return { ...thread, rows: rows.length ? thread.rows.concat(rows) : thread.rows, results, queue: queueFrom(queue, thread.queue), end: reply.end };
}

// A first read, or a page of history above what's already here. The queue is only ever live, so history adds nothing to it.
export function prependReply(thread, reply) {
  if (thread.start !== null && reply.end !== thread.start) return thread;
  const { rows, results, queue } = withResults(thread, reply);
  const first = thread.start === null;
  return { ...thread, rows: rows.concat(thread.rows), results, queue: first ? queueFrom(queue) : thread.queue, start: reply.start, end: first ? reply.end : thread.end, more: Boolean(reply.more) };
}

// What a tool line shows: "running", "ok" or "error", and how long it took.
export function toolState(row, results) {
  const result = results[row.tool];
  if (!result) return { status: "running", took: null, line: null };
  const took = row.at != null && result.at != null ? Math.max(0, result.at - row.at) : null;
  return { status: result.ok ? "ok" : "error", took, line: result.line };
}

const ASSISTANT = new Set(["text", "code", "tool"]);
const OVERHEAD = 26;

// Space above a row, from the agreed look: 14 between groups, 10 inside an assistant's message, 12 more above your own.
function gapAbove(prev, row) {
  if (!prev) return OVERHEAD;
  if (ASSISTANT.has(prev.kind) && ASSISTANT.has(row.kind)) return 10;
  return row.kind === "user" ? 26 : 14;
}

// The list's items from the rows. Anything pressable has to be its own item, because a list row can't hold a handler,
// so each tool line and each code card's header band is one. `open` is the set of open tool ids. `working` adds the
// status row at the end. `sent` is text the pane has sent and the transcript hasn't caught up with, drawn as your own.
export function listItems(thread, open, working, sent = []) {
  const { rows, results } = thread;
  const items = [];
  rows.forEach((row, i) => {
    const prev = rows[i - 1], next = rows[i + 1];
    const top = row.kind === "tool" && prev?.kind === "tool" ? 0 : gapAbove(prev, row);
    if (row.kind === "code") {
      items.push({ key: `${row.id}:head`, type: "code-head", row, top });
      items.push({ key: `${row.id}:body`, type: "code-body", row, top: 0 });
    } else if (row.kind === "tool") {
      const isOpen = open.has(row.tool);
      items.push({
        key: `tool:${row.tool}`, type: "tool", row, top, open: isOpen, ...toolState(row, results),
        first: prev?.kind !== "tool", last: next?.kind !== "tool",
      });
    } else {
      items.push({ key: row.id, type: row.kind, row, top });
    }
  });
  for (const item of sent) {
    items.push({ key: item.id, type: "user", row: { id: item.id, kind: "user", text: item.text }, top: gapAbove(rows.at(-1) ?? null, { kind: "user" }), sent: true });
  }
  if (working) items.push({ key: "status", type: "status", row: null, top: items.length ? 14 : OVERHEAD });
  return items;
}

// The status line a session reports. It's a word or an object, depending on who reported it.
export function statusText(report) {
  const text = typeof report === "string" ? report : report?.msg;
  return typeof text === "string" && text ? text : "Working";
}

const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE;

export function formatTook(ms) {
  if (ms == null) return "";
  if (ms < MINUTE) return `${(ms / SECOND).toFixed(1)}s`;
  return `${Math.floor(ms / MINUTE)}m ${Math.floor((ms % MINUTE) / SECOND)}s`;
}

export function formatWorked(ms) {
  const seconds = Math.round(ms / SECOND);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

const pad = (n) => String(n).padStart(2, "0");

export const clock = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

export const workedLine = (row) => `Worked for ${formatWorked(row.ms)} · ${clock(new Date(row.at))}`;

// A fence names a language loosely. The editor wants its own name for it.
const LANGUAGES = {
  "": "text", js: "javascript", jsx: "javascript", mjs: "javascript", ts: "typescript", tsx: "tsx", py: "python", python3: "python",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", yml: "yaml", md: "markdown", rs: "rust", rb: "ruby", "c++": "cpp", golang: "go",
};

export const editorLanguage = (lang) => LANGUAGES[lang] ?? lang;

export const codeLines = (code) => code.split("\n").length;

// Heights here are in the app's own pixels. `on_size_change` works in window pixels, so a measure is divided by the zoom
// when it lands. The list's sizes are in the app's pixels: it scales them itself.
export const LAYOUT = { TOOL: 30, TOOL_EDGE: 4, CODE_HEAD: 33, CODE_LINE: 20, CODE_PAD: 25, BOTTOM: 18, STATUS: 24, LINE: 23 };

export const measured = (item) => item.type === "text" || item.type === "user" || item.type === "sys" || (item.type === "tool" && item.open);

// Height key. An open tool line is a different height from a shut one, and shutting it needs no second measure.
export const sizeKey = (item) => (item.type === "tool" && item.open ? `${item.key}:open` : item.key);

export function fixedHeight(item) {
  switch (item.type) {
    case "tool": return item.open ? null : LAYOUT.TOOL + (item.first ? LAYOUT.TOOL_EDGE : 0) + (item.last ? LAYOUT.TOOL_EDGE : 0);
    case "code-head": return LAYOUT.CODE_HEAD;
    case "code-body": return codeLines(item.row.code) * LAYOUT.CODE_LINE + LAYOUT.CODE_PAD;
    case "worked": return 20;
    case "status": return LAYOUT.STATUS;
    default: return null;
  }
}

const shutTool = (item) => fixedHeight({ ...item, open: false });

// What the thread's list is handed: the spacer, then each item with its gap above, and room under the last. In the app's
// pixels, the same as the `.h()` each row is drawn at, because the list scales its sizes by the zoom itself.
export function listSizes(items, heights, { overscan, tail = 0 }) {
  const sizes = [overscan];
  items.forEach((item, i) => sizes.push(heightOf(item, heights) + (i === items.length - 1 ? LAYOUT.BOTTOM + tail : 0)));
  return sizes;
}

// An item's height with its gap, or null while it hasn't been measured. A tool line opening keeps its shut height until
// it's measured, so it never leaves the list.
export function heightOf(item, heights) {
  const body = fixedHeight(item) ?? heights[sizeKey(item)] ?? (item.type === "tool" ? shutTool(item) : null);
  return body == null ? null : item.top + body;
}

// A row joins the list once its height is known.
export const shownItems = (items, heights) => items.filter((item) => heightOf(item, heights) != null);

// Rows to measure, newest first. `fresh` holds the keys measured at this width: older heights still draw until then.
export function pendingItems(items, fresh, limit) {
  const out = [];
  for (let i = items.length - 1; i >= 0 && out.length < limit; i--) {
    if (measured(items[i]) && !fresh.has(sizeKey(items[i]))) out.push(items[i]);
  }
  return out;
}

// `scroll_to_item` puts an item at the top of the list's box, and the box starts `overscan` above the view. So to show
// item `index` at the top of the view, aim at the item that far above it.
export function aimAbove(items, heights, index, overscan) {
  let reach = 0;
  for (let i = index - 1; i >= 0; i--) {
    reach += heightOf(items[i], heights) ?? 0;
    if (reach >= overscan) return i;
  }
  return 0;
}

// Mixes two #rrggbb colours. The well sits between the ground and a card, and the theme doesn't name it.
export function mix(from, to, share) {
  const channel = (hex, at) => parseInt(hex.slice(at, at + 2), 16);
  const part = (at) => Math.round(channel(from, at) + (channel(to, at) - channel(from, at)) * share).toString(16).padStart(2, "0");
  return /^#[0-9a-f]{6}/i.test(from) && /^#[0-9a-f]{6}/i.test(to) ? `#${part(1)}${part(3)}${part(5)}` : from;
}
