// Decides what happens to text typed in the composer. Pure: no Herdr imports, so `node --test` can load it.
// `kind` is one of:
//   message   send the text as a message
//   command   send it as a / command, and watch for a dialog opening (the safety net)
//   picker    the model and effort pad, with `which` and an optional `value`
//   usage     open or close the usage panel; `tab` says which tab a /stats should land on
//   swap      swap to the terminal; nothing is sent
//   terminal  send it, then swap to the terminal; the command opens a dialog
//   exit      ask first, because it ends the session
//   none      nothing to do
export const DIALOG_COMMANDS = ["/permissions", "/memory", "/status", "/hooks", "/plugin", "/resume", "/rewind", "/add-dir", "/ide", "/statusline", "/login", "/logout", "/vim"];
const DIALOG = new Set(DIALOG_COMMANDS);

export function route(text) {
  const t = String(text ?? "").trim();
  if (!t) return { kind: "none" };
  if (!t.startsWith("/")) return { kind: "message" };
  const [typed, value] = t.split(/\s+/);
  // Compared in lower case, so `/Exit` and `/Model sonnet` can't slip past the card or the pad if Claude Code takes them too.
  // `head` of a plain command stays as typed.
  const head = typed.toLowerCase();
  if (head === "/") return { kind: "none" };
  // A path such as /Users/me/notes.md is text, not a command name.
  if (head.indexOf("/", 1) > 0) return { kind: "message" };
  if (head === "/model" || head === "/effort") return { kind: "picker", which: head.slice(1), value: value ?? null };
  if (head === "/usage") return { kind: "usage", tab: "using" };
  // /stats prints the /usage text headless, so the panel's Stats tab is where it belongs.
  if (head === "/stats") return { kind: "usage", tab: "stats" };
  if (head === "/tui" || head === "/terminal") return { kind: "swap" };
  if (DIALOG.has(head)) return { kind: "terminal", head };
  // /quit is Claude Code's other name for /exit.
  if (head === "/exit" || head === "/quit") return { kind: "exit", head };
  return { kind: "command", head: typed };
}

// Whether a route sends the text to Claude Code.
export const sends = (r) => r.kind === "message" || r.kind === "command" || r.kind === "terminal";

// The safety net: a command that isn't in the table might open a dialog. Claude Code ends a dialog's footer with
// `Esc to cancel`, and `/config` ends with `Esc to close` or `Esc to clear`. A running turn shows `esc to interrupt`, which
// isn't a dialog. Only the foot of the screen counts: higher up, a conversation can quote those words, and the prompt and the
// status line take the foot of a screen with no dialog on it.
const FOOTER_LINES = 3;
export const dialogOpen = (screen) => /\bEsc to (cancel|close|clear|exit|go back|dismiss)\b/.test(String(screen ?? "").split("\n").filter((line) => line.trim()).slice(-FOOTER_LINES).join("\n"));
// The session file says so too, whatever the terminal's width: `status` "waiting" and `waitingFor` "dialog open". A narrow
// terminal can scroll a dialog's footer out of view, which is how the screen alone missed `/mcp` at 42 columns.
export const waitingOnDialog = (session) => session?.status === "waiting" && /dialog/i.test(session?.waitingFor ?? "");

// Whether a dialog of Claude Code's own is open, such as /model, /resume or /config. Those read `done` or `idle` from `hc`,
// not `blocked`, so a key sent then lands in the dialog, and Enter in an open /model saves a default. `source.dialog()`
// says what the session file says, which holds when the footer has scrolled off a narrow terminal.
export async function dialogUp(source, screen) {
  if (dialogOpen(screen)) return true;
  try { return Boolean(await source.dialog?.()); } catch { return false; }
}

// How long after sending a / command to look at the transcript and the screen. The second look is for a slow send.
export const NET_MS = [2000, 5000];

// Watches a / command that isn't in the table, in case it opens a dialog, which has nothing to show in the chat. If nothing
// reached the transcript and a dialog is up, the terminal is the place for it. `host` is { threadEnd(), session(),
// screen(), own(), swap(cx) }, and `after(ms, look)` starts a look later, where it can wait on `screen`. `own` is true while
// the pane has Claude Code's model picker open itself. That reads the same as any dialog, and it's no reason to leave the
// chat. A flow won't open the picker over a dialog, so no real one can hide behind it.
export function dialogNet(host, after) {
  const watch = { end: host.threadEnd(), done: false };
  const swap = (cx) => { watch.done = true; host.swap(cx); };
  const look = async (cx) => {
    if (watch.done || host.threadEnd() !== watch.end) { watch.done = true; return; }
    if (host.own()) return;
    if (waitingOnDialog(host.session())) { swap(cx); return; }
    const screen = await host.screen();
    if (!watch.done && !host.own() && dialogOpen(screen)) swap(cx);
  };
  for (const ms of NET_MS) after(ms, look);
}
