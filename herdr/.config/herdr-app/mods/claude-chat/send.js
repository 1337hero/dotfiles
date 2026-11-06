// What the composer does to a live session: sending, stopping, and Claude Code's own queue. No Herdr imports, so
// `node --test` can load this file. `io` holds `hc(args)` and `pause(ms)`. Everything read back from a screen or a
// transcript is data, and only ever decides whether a fixed key is pressed.
import { sendAside, STASH_HELD } from "./draft.js";
import { dialogUp } from "./route.js";

// The screen shows the prompt between its last two rules, starting at `❯`, with later rows indented by two.
const RULE = /^─{20,}/;
const PROMPT = /^❯[ \u00a0]?/;
const QUEUE_HINT = "Press up to edit queued messages";
const PASTED = /^\[Pasted text #\d+ \+(\d+) lines\]/;
const IMAGE_TOKEN = /\[Image #\d+\]/g;
const IMAGE_MARK = /\[Image #\d+\]/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const MACHINE = /^<(task-notification|agent-message|cross-session-message|hc)\b/;
const PASTED_BLOCK = /<pasted_content\b[^>]*>\n?([\s\S]*?)\n?<\/pasted_content\b[^>]*>/g;
const ADDRESS = /^\w[\w:./-]*$/;
const UNSAFE_PATH = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const SEND_NOW = "ctrl+enter";
const POLL_MS = 150;
const QUIET_POLLS = 7; // A send that never shows in the prompt has gone through by then.
const STUCK_POLLS = 16; // A send still in the prompt by then has lost its Enter.
const PULL_POLLS = 14;
const CLEAR_TRIES = 3;

export const NOTES = {
  blocked: "A dialog is open in the terminal",
  stashed: "A stashed line is in the terminal",
  gone: "Claude Code isn't running",
  failed: "Not sent",
  stuck: "In the terminal's prompt, not sent",
  idle: "Nothing running",
  waiting: "Still queued in the terminal",
  draft: "The terminal's prompt has text",
  nothing: "Nothing queued",
  unreadable: "Can't read the terminal's prompt",
  terminal: "The queue is in the terminal's prompt",
  image: "Queued images change in the terminal",
  split: "Queue moved back here",
};

const refuse = (reason) => ({ ok: false, reason, note: NOTES[reason] });

// Text for `hc send`. Newlines and tabs stay. Any other control character could act on the terminal.
export const cleanText = (text) => String(text ?? "").replace(/\r\n?/g, "\n").replace(CONTROL, "").trimEnd();

const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
const squash = (text) => String(text).replace(/\s+/g, "");
const lineCount = (text) => String(text).split("\n").length;

// The prompt's rows, or null when the screen has no prompt to read, as with a dialog. `text` is empty for an empty prompt.
export function promptBody(screen) {
  const lines = String(screen ?? "").split("\n");
  const rules = lines.flatMap((line, i) => (RULE.test(line) ? [i] : []));
  if (rules.length < 2) return null;
  const rows = lines.slice(rules.at(-2) + 1, rules.at(-1));
  if (!PROMPT.test(rows[0] ?? "")) return null;
  const clean = rows.map((row, i) => (i ? row.replace(/^[ \u00a0]{1,2}/, "") : row.replace(PROMPT, "")).trimEnd());
  return { lines: clean, text: clean.join("\n").trim() };
}

// Terminal rows back into text. A row ends in a wrap when the next word couldn't have fitted on it.
// Used only when the queue's own text can't be matched, so it may read slightly differently.
export function joinRows(rows, cols) {
  const width = Math.max(1, cols - 2);
  return rows.reduce((text, row, i) => {
    if (!i) return row;
    const last = rows[i - 1];
    if (last.length >= width - 1) return text + row;
    return text + (last.length + 1 + row.split(" ")[0].length > width ? " " : "\n") + row;
  }, "");
}

// The items in the order the prompt shows them, or null when the prompt holds something else. Items are `{ text }`.
export function arrange(known, rows) {
  const left = [...known], items = [];
  let rest = rows.map(squash).join("");
  while (rest) {
    const pasted = rest.match(/^\[Pastedtext#\d+\+(\d+)lines\]/);
    const at = left.findIndex((item) => (pasted ? lineCount(item.text) - 1 === Number(pasted[1]) : rest.startsWith(squash(item.text))));
    if (at < 0) return null;
    rest = rest.slice(pasted ? pasted[0].length : squash(left[at].text).length);
    items.push(...left.splice(at, 1));
  }
  return items.length ? items : null;
}

// What's true of the session right now. The panel's last read could be seconds old. Every flow starts here, so an
// address that isn't one never reaches `hc`, where a leading dash would read as an option.
export async function sessionNow(io, terminal) {
  if (!ADDRESS.test(terminal ?? "")) return { live: false };
  const r = await io.hc(["get", "--json", terminal]).catch(() => null);
  const info = r?.code === 0 ? parse(r.stdout) : null;
  if (info?.state !== "live" || !info.foreground?.name?.startsWith("claude")) return { live: false };
  return { live: true, state: info.status?.state ?? null, cols: info.cols ?? 0 };
}

const screenOf = async (io, terminal) => (await io.hc(["read", terminal]).catch(() => null))?.stdout ?? "";

// What goes to `hc send` when images wait with the text. Claude Code attaches a path that's alone on its line as the
// image itself, reading the file there and then, and shows `[Image #n]` in the prompt in its place.
export const withImages = (text, images) => [text, ...images].filter(Boolean).join("\n");

// True while the prompt still holds exactly this message. Anything else there, such as a draft that has come back, isn't it.
function holds(body, text, images) {
  const tokens = body.text.match(IMAGE_TOKEN)?.length ?? 0;
  const pasted = body.text.match(PASTED);
  if (Number(pasted?.[1]) === lineCount(text) - 1) return true;
  return tokens === images && Boolean(body.text) && squash(body.text.replace(IMAGE_TOKEN, "")) === squash(text);
}

// A send can leave its text in the prompt with its Enter lost, and the next send then joins it. So it waits until the
// prompt has taken the text and let it go, and sends Enter once if it's still there. False when it never left.
async function settle(io, terminal, text, images = 0) {
  const sitting = async () => {
    const body = promptBody(await screenOf(io, terminal));
    return Boolean(body) && holds(body, text, images);
  };
  let seen = false;
  for (let i = 0; i < STUCK_POLLS; i++) {
    const now = await sitting();
    if (seen && !now) return true;
    seen ||= now;
    if (!seen && i >= QUIET_POLLS) return true;
    await io.pause(POLL_MS);
  }
  // A command that opens a dialog, such as /config, leaves its text showing in the prompt under it, and an Enter there
  // would change a setting. This happened once, to auto-compact in the real settings file. A dialog means it was delivered.
  if (await dialogUp(io, await screenOf(io, terminal))) return true;
  // A / command can open a dialog whose footer and session status haven't shown yet, so it never gets the Enter.
  if (text.startsWith("/")) return false;
  // An empty send is an Enter that `hc` refuses on a blocked session. A bare key could land on a dialog that opened just
  // now, and Enter there would approve it.
  await io.hc(["send", terminal, ""]).catch(() => null);
  for (let i = 0; i < QUIET_POLLS; i++) {
    await io.pause(POLL_MS);
    if (!(await sitting())) return true;
  }
  return false;
}

const reasonOf = (result) => (parse(result?.stderr)?.error?.kind === "blocked" ? "blocked" : "failed");

async function deliver(io, terminal, text, images, send) {
  const sent = await send();
  if (sent?.code !== 0) return refuse(reasonOf(sent));
  return (await settle(io, terminal, text, images)) ? { ok: true } : refuse("stuck");
}

// Sends the composer's text. Refuses before any key is pressed while a dialog is open, because Ctrl+S would land on it,
// and while a stash is held, because a second Ctrl+S would replace it. `hc send` itself queues it during a turn.
// `images` are paths to files, and a message can be images alone.
export async function sendMessage(io, terminal, raw, images = []) {
  const text = cleanText(raw);
  if ((!text && !images.length) || images.some((path) => UNSAFE_PATH.test(path))) return refuse("failed");
  const now = await sessionNow(io, terminal);
  if (!now.live) return refuse("gone");
  if (now.state === "blocked") return refuse("blocked");
  const shown = await screenOf(io, terminal);
  if (await dialogUp(io, shown)) return refuse("blocked");
  if (STASH_HELD.test(shown)) return refuse("stashed");
  return deliver(io, terminal, text, images.length, () => sendAside(io, terminal, withImages(text, images)));
}

// Claude Code's own Ctrl+Enter: everything queued goes in now and a running tool moves to the background.
// With no tool running the key does nothing and the queue waits for the turn to end, so the prompt is read back: a press that
// moved nothing says so. It does nothing to an open dialog, but none is pressed into.
// The key also submits what's typed in the terminal's prompt, so anything there but the queue's hint stops it.
export async function sendNow(io, terminal) {
  const now = await sessionNow(io, terminal);
  if (!now.live) return refuse("gone");
  if (now.state === "blocked") return refuse("blocked");
  if (now.state !== "working") return refuse("idle");
  const body = promptBody(await screenOf(io, terminal));
  if (!body) return refuse("unreadable");
  if (body.text && body.text !== QUEUE_HINT) return refuse("draft");
  const r = await io.hc(["keys", terminal, SEND_NOW]).catch(() => null);
  if (r?.code !== 0) return refuse("failed");
  if (body.text !== QUEUE_HINT) return { ok: true };
  for (let i = 0; i < PULL_POLLS; i++) {
    await io.pause(POLL_MS);
    if (promptBody(await screenOf(io, terminal))?.text !== QUEUE_HINT) return { ok: true };
  }
  return { ok: true, note: NOTES.waiting };
}

// `hc interrupt` reports `still_working` while the Stop hooks run, and that still means it stopped. Anything queued
// is delivered afterwards as new turns. Esc would cancel a dialog, so none is pressed into.
export async function stopTurn(io, terminal) {
  const now = await sessionNow(io, terminal);
  if (!now.live) return refuse("gone");
  if (now.state === "blocked") return refuse("blocked");
  if (now.state !== "working") return refuse("idle");
  const r = await io.hc(["interrupt", "--json", "--timeout", "2", terminal]).catch(() => null);
  return r?.code === 0 ? { ok: true } : refuse("failed");
}

// One Ctrl+U clears one row on screen and the next takes the line break, so it's pressed twice a row and checked.
async function clearPrompt(io, terminal, body) {
  const want = squash(body.text);
  for (let i = 0; i < CLEAR_TRIES; i++) {
    await io.hc(["keys", terminal, ...Array(body.lines.length * 2 + 2).fill("ctrl+u")]).catch(() => null);
    await io.pause(POLL_MS);
    const left = promptBody(await screenOf(io, terminal));
    if (!left || !left.text || !want.includes(squash(left.text))) return true;
  }
  return false;
}

// The prompt redraws over several frames as it grows, so one read can catch it half drawn. Two the same mean it's done.
async function pulledBody(io, terminal) {
  let last = null;
  for (let i = 0; i < PULL_POLLS; i++) {
    await io.pause(POLL_MS);
    const body = promptBody(await screenOf(io, terminal));
    const full = body?.text && body.text !== QUEUE_HINT ? body : null;
    if (full && full.text === last?.text) return full;
    last = full;
  }
  return null;
}

// Presses up, which pulls everything queued into the prompt as lines, takes it out and clears the prompt. `known` is
// what the pane believes is queued, as `{ text }`. The screen rewraps text, so the known text is used when it matches.
// A long paste shows only as a placeholder, so one that can't be matched stays in the terminal. A queued image only
// lives in Claude Code, and sending its `[Image #n]` as text would lose it, so that queue isn't touched from here.
export async function pullQueue(io, terminal, known = []) {
  const now = await sessionNow(io, terminal);
  if (!now.live) return refuse("gone");
  if (now.state === "blocked") return refuse("blocked");
  if (now.state !== "working") return refuse("idle");
  if (known.some((item) => IMAGE_MARK.test(item.text ?? ""))) return refuse("image");
  const before = promptBody(await screenOf(io, terminal));
  if (!before) return refuse("unreadable");
  if (before.text !== QUEUE_HINT) return refuse(before.text ? "draft" : "nothing");
  await io.hc(["keys", terminal, "up"]);
  const body = await pulledBody(io, terminal);
  if (!body) return refuse("nothing");
  const items = arrange(known, body.lines);
  if (!items && body.lines.some((row) => PASTED.test(row) || IMAGE_MARK.test(row))) return refuse("terminal");
  const text = items ? items.map((item) => item.text).join("\n") : joinRows(body.lines, now.cols);
  return { ok: true, items, text, cleared: await clearPrompt(io, terminal, body) };
}

// Up takes the whole queue, so Remove pulls it and sends the others again, in the prompt's order. With no way to tell
// the messages apart, or if a send is refused, what's left comes back as `text` for the composer, so nothing is lost.
export async function removeQueued(io, terminal, known, row) {
  const pulled = await pullQueue(io, terminal, known);
  if (!pulled.ok) return pulled;
  // Text still in the prompt would join the next send, and go with it.
  if (!pulled.cleared) return refuse("terminal");
  if (!pulled.items) return { ...refuse("split"), text: pulled.text };
  const at = pulled.items.findIndex((item) => item.text === row.text);
  const others = pulled.items.filter((_, i) => i !== at).map((item) => item.text);
  for (let i = 0; i < others.length; i++) {
    const text = cleanText(others[i]);
    const sent = await deliver(io, terminal, text, 0, () => io.hc(["send", terminal, ...(text.startsWith("-") ? ["--"] : []), text]).catch(() => null));
    if (!sent.ok) return { ...sent, text: others.slice(sent.reason === "stuck" ? i + 1 : i).join("\n") };
  }
  return { ok: true, again: others };
}

// One queue line from the transcript onto the list. `dequeue` names nothing, so it takes the front. A line can have no
// `content`, and that row reads as text null. Lines arrive after hooks run, so the order can differ from the real one.
export function applyQueueLine(queue, line) {
  const content = typeof line?.content === "string" ? line.content : null;
  switch (line?.operation) {
    case "enqueue": return [...queue, { text: content }];
    case "dequeue": return queue.slice(1);
    case "popAll": return [];
    case "remove": {
      const at = queue.findIndex((item) => item.text === content);
      const gone = at >= 0 ? at : queue.findIndex((item) => item.text === null);
      return gone < 0 ? queue : queue.filter((_, i) => i !== gone);
    }
    default: return queue;
  }
}

export const queueFrom = (lines, start = []) => lines.reduce(applyQueueLine, start);

// `<pasted_content>` is how a long paste comes back from the transcript.
export const plainQueued = (text) => String(text).replace(PASTED_BLOCK, "$1");

// The tray's rows. Subagent results and notes share the queue but aren't the person's. Nothing is queued unless a
// turn is running, which clears a line that never came. `pending` is text sent but not in the transcript yet, which
// takes hooks several seconds, so it shows at once and its row takes over when it arrives.
export function trayRows(queue, state, pending = []) {
  if (state !== "working" && state !== "blocked") return [];
  const left = [...pending];
  const take = (text) => {
    const at = left.findIndex((item) => squash(item) === squash(text));
    if (at >= 0) left.splice(at, 1);
  };
  const shown = queue.filter((item) => !MACHINE.test(item.text ?? "")).map((item) => {
    const text = item.text === null ? left.shift() ?? null : plainQueued(item.text);
    if (item.text !== null) take(text);
    return { text };
  });
  return [...shown, ...left.map((text) => ({ text }))];
}

const SENT_MS = 120_000;
const WORD = /\[image\]/g;

// True when a transcript row is this sent message. A row says [image] where an image went.
function sentAs(item, row) {
  const text = squash(String(row.text).replace(WORD, ""));
  const want = squash(item.text);
  return (row.clipped ? want.startsWith(text.slice(0, 200)) : want === text) && item.images <= (row.images ?? 0);
}

// What's still waiting after new rows land. A queued message gives way to its queue row, and anything else to its own
// row in the thread. Nothing proves a command with no output landed, so a message also goes after two minutes.
// `settled` pairs each one with the row that took over, so its height can carry across.
export function settleSent(sent, rows, queue, now) {
  const left = [], settled = [];
  const users = rows.filter((row) => row.kind === "user");
  const texts = queue.map((item) => squash(plainQueued(item.text ?? "").replace(/\[Image #\d+\]/g, "")));
  for (const item of sent) {
    const at = users.findIndex((row) => sentAs(item, row));
    if (at >= 0) settled.push([item, ...users.splice(at, 1)]);
    else if (!(item.queued && texts.includes(squash(item.text))) && now - item.at < SENT_MS) left.push(item);
  }
  return { left, settled };
}

// Dropped files as text for the composer, each escaped the way a terminal escapes a dropped path.
export function withPaths(text, paths) {
  const list = paths.map((path) => path.replace(/([\\\s"'$`])/g, "\\$1")).join(" ");
  if (!list) return text;
  return !text || /\s$/.test(text) ? `${text}${list} ` : `${text} ${list} `;
}

// A press of Enter can add its newline before `submit` arrives. This takes that newline back out.
export function withoutEnter(before, now) {
  if (now.length !== before.length + 1) return now;
  for (let i = 0; i < now.length; i++) {
    if (now[i] !== before[i]) return now[i] === "\n" && now.slice(i + 1) === before.slice(i) ? before : now;
  }
  return now;
}

// One flow at a time per pane, so a second send can't land in the prompt before the first has left it.
export function serial() {
  let tail = Promise.resolve();
  return (flow) => {
    const run = tail.then(flow, flow);
    tail = run.catch(() => null);
    return run;
  };
}
