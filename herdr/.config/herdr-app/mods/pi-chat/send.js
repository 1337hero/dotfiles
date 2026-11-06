// What the composer does to a live pi session: sending, stopping, and what a message sent but not yet in the transcript
// leaves behind. No Herdr imports, so `node --test` can load this file. `io` holds `hc(args)` and `pause(ms)`.
// An address that isn't one never reaches `hc`, where a leading dash would read as an option.

const ADDRESS = /^\w[\w:./-]*$/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const squash = (text) => String(text).replace(/\s+/g, "");
// A command with no output never shows in the transcript, so a message stops waiting after this either way.
const SENT_MS = 120_000;

export const NOTES = {
  blocked: "A dialog is open in the terminal", gone: "pi isn't running", failed: "Not sent", idle: "Nothing running",
};

const refuse = (reason) => ({ ok: false, reason, note: NOTES[reason] });

// Text for `hc send`. Newlines and tabs stay. Any other control character could act on the terminal.
export const cleanText = (text) => String(text ?? "").replace(/\r\n?/g, "\n").replace(CONTROL, "").trimEnd();

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// What's true of the session right now. Every flow starts here.
export async function sessionNow(io, terminal) {
  if (!ADDRESS.test(terminal ?? "")) return { live: false };
  const r = await io.hc(["get", "--json", terminal]).catch(() => null);
  const info = r?.code === 0 ? parse(r.stdout) : null;
  const name = info?.foreground?.name;
  if (info?.state !== "live" || !(typeof name === "string" && name.startsWith("pi"))) return { live: false };
  return { live: true, state: info.status?.state ?? null };
}

// Sends the composer's text. pi takes a message while it works and answers it after the turn, so being busy is no
// reason to refuse. A dialog would take the text as its own answer, so that is refused before any key is pressed.
export async function sendMessage(io, terminal, raw) {
  const text = cleanText(raw);
  if (!text) return refuse("failed");
  const now = await sessionNow(io, terminal);
  if (!now.live) return refuse("gone");
  if (now.state === "blocked") return refuse("blocked");
  const sent = await io.hc(["send", terminal, ...(text.startsWith("-") ? ["--"] : []), text]).catch(() => null);
  return sent?.code === 0 ? { ok: true } : refuse("failed");
}

// `hc interrupt` presses the stop key, and answers what happened: pi reports `still_working` while its stop hooks run,
// which still means it stopped. Anything sent during the turn is delivered afterwards as a new turn.
export async function stopTurn(io, terminal) {
  const now = await sessionNow(io, terminal);
  if (!now.live) return refuse("gone");
  if (now.state === "blocked") return refuse("blocked");
  if (now.state !== "working") return refuse("idle");
  const r = await io.hc(["interrupt", "--json", "--timeout", "2", terminal]).catch(() => null);
  return r?.code === 0 ? { ok: true } : refuse("failed");
}

// True when a transcript row is the message the pane sent.
function sentAs(item, row) {
  const text = squash(String(row.text));
  const want = squash(item.text);
  return row.clipped ? want.startsWith(text.slice(0, 200)) : want === text;
}

// What's still waiting after new rows land. A message the transcript has caught up with gives way to its own row, and
// its height carries across. Nothing proves a command with no output landed, so a message also goes after SENT_MS.
export function settleSent(sent, rows, now) {
  const left = [], settled = [];
  const users = rows.filter((row) => row.kind === "user");
  for (const item of sent) {
    const at = users.findIndex((row) => sentAs(item, row));
    if (at >= 0) settled.push([item, ...users.splice(at, 1)]);
    else if (now - item.at < SENT_MS) left.push(item);
  }
  return { left, settled };
}

// One flow at a time per pane, so a second send can't land before the first has left.
export function serial() {
  let tail = Promise.resolve();
  return (flow) => {
    const run = tail.then(flow, flow);
    tail = run.catch(() => null);
    return run;
  };
}
