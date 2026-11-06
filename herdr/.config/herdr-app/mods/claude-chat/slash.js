// The / command list: read once per folder from a headless start, grouped and filtered here.
// No Herdr imports, so `node --test` can load this file. `exec` is passed in.
import { DIALOG_COMMANDS } from "./route.js";

export const GROUPS = ["This session", "In the chat", "Skills", "Opens the terminal", "End"];

// What the chat handles itself, and the table's commands that a headless start doesn't list.
const CHAT = { "/usage": "Limits, stats and what's using them", "/model": "Change the model and effort", "/effort": "Change the model and effort" };
const TERMINAL = {
  "/tui": "Swap to the terminal", "/terminal": "Swap to the terminal",
  "/permissions": "Tools and what they can do", "/memory": "Edit memory files", "/status": "Version, account and connections",
  "/hooks": "Hooks that run around tool calls", "/plugin": "Manage plugins", "/resume": "Pick up an earlier session",
  "/rewind": "Go back to an earlier point", "/add-dir": "Let Claude read another folder", "/ide": "Connect to an editor",
  "/statusline": "Set up the status line", "/login": "Sign in", "/logout": "Sign out", "/vim": "Turn vim keys on or off",
};
const END = { "/exit": "End the session, after asking" };
// Commands a person can't use from a prompt.
const HIDDEN = (name) => name.startsWith("__") || /\s/.test(name) || name === "workflow-launch-exec";

// Lines of stream-json from a headless start, with anything else skipped. The init message names the commands.
// `commands_changed` comes after the plugins load. It adds names and carries each description.
export function parseStream(text) {
  const out = { names: [], terminal: [], skills: [], described: {}, version: null };
  for (const line of String(text ?? "").split("\n")) {
    if (!line.startsWith("{")) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.type !== "system") continue;
    if (d.subtype === "init") {
      for (const key of ["slash_commands", "terminal_slash_commands", "skills"]) if (!Array.isArray(d[key])) d[key] = [];
      out.names = d.slash_commands.filter((n) => typeof n === "string");
      out.terminal = d.terminal_slash_commands.filter((n) => typeof n === "string");
      out.skills = d.skills.filter((n) => typeof n === "string");
      out.version = d.claude_code_version ?? null;
    } else if (d.subtype === "commands_changed" && Array.isArray(d.commands)) {
      for (const c of d.commands) if (typeof c?.name === "string") out.described[c.name] = { description: String(c.description ?? ""), hint: String(c.argumentHint ?? "") };
    }
  }
  return out;
}

// "Add a new project. (user)" reads as "Add a new project." The marker says where a command came from.
const SOURCE = /\s*\((?:user|project|claude\.ai sync|managed)\)\s*$/;
const MARKED = (text) => SOURCE.test(text);
const tidy = (text) => text.replace(SOURCE, "").replace(/\s+/g, " ").trim();

// Which group a command from Claude Code belongs to. A command with a source marker, a plugin prefix or an MCP prefix, or
// listed as a skill, is one the person added. The rest are Claude Code's own.
function groupOf(name, parsed) {
  const slash = `/${name}`;
  if (slash in CHAT) return "In the chat";
  if (slash in END) return "End";
  if (slash in TERMINAL || parsed.terminal.includes(name)) return "Opens the terminal";
  const info = parsed.described[name];
  if (parsed.skills.includes(name) || name.includes(":") || name.startsWith("mcp__") || (info && MARKED(info.description))) return "Skills";
  return "This session";
}

// Every command as { name, desc, group }, with the table's commands added whether or not Claude Code listed them.
export function buildList(parsed) {
  const names = [...new Set([...(parsed?.names ?? []), ...Object.keys(parsed?.described ?? {}), ...(parsed?.terminal ?? [])])].filter((n) => !HIDDEN(n));
  const p = { names: [], terminal: [], skills: [], described: {}, ...parsed };
  const byName = new Map();
  for (const name of names) {
    const slash = `/${name}`;
    const own = CHAT[slash] ?? END[slash] ?? TERMINAL[slash];
    const info = p.described[name];
    byName.set(slash, { name: slash, desc: own ?? (info?.description ? tidy(info.description) : ""), group: groupOf(name, p) });
  }
  for (const [table, group] of [[CHAT, "In the chat"], [TERMINAL, "Opens the terminal"], [END, "End"]]) {
    for (const [name, desc] of Object.entries(table)) {
      const had = byName.get(name);
      // Claude Code's own words for a dialog command are better than ours, when it lists one.
      byName.set(name, { name, desc: group === "Opens the terminal" && had?.desc && !(name === "/tui" || name === "/terminal") ? had.desc : desc, group });
    }
  }
  return [...byName.values()];
}

// Without a headless read the table's commands still work.
export const fallbackList = () => buildList({ names: [], terminal: [], skills: [], described: {} });

// The typed part in the accent colour is [start, end) in the name, counted from the slash.
// A command that starts with what's typed ranks first. Then one that has it inside, such as `brainstorming` in
// `superpowers:brainstorming`. Ties go alphabetically.
export function filterList(list, typed) {
  const q = String(typed ?? "").replace(/^\//, "").toLowerCase();
  const sections = [];
  for (const title of GROUPS) {
    const items = [];
    for (const c of list) {
      if (c.group !== title) continue;
      const at = q ? c.name.slice(1).toLowerCase().indexOf(q) : -1;
      if (q && at < 0) continue;
      items.push({ ...c, hit: q ? [1 + at, 1 + at + q.length] : null, rank: at === 0 ? 0 : 1 });
    }
    items.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    if (items.length) sections.push({ title, items: items.map(({ rank, ...c }) => c) });
  }
  return { sections, flat: sections.flatMap((s) => s.items) };
}

// The name split for drawing: text before the match, the match, and the rest.
export function nameParts(item) {
  if (!item.hit) return { before: "", match: "", after: item.name };
  return { before: item.name.slice(0, item.hit[0]), match: item.name.slice(item.hit[0], item.hit[1]), after: item.name.slice(item.hit[1]) };
}

const same = (row, typed) => row.name.toLowerCase() === String(typed).trim().toLowerCase();

// What Enter runs while the list is open: the selected command, when what's typed is only part of a name. A name typed in full
// runs as typed, unless the arrows (`moved`) chose another row. The list sorts by group, so its first row can be anything.
export function pick(text, item, rows = [], moved = false) {
  if (!item || !completing(text) || (!moved && rows.some((row) => same(row, text)))) return text;
  return same(item, text) ? text : item.name;
}

// The row a list starts on: the one that's what's typed, or the first.
export const startRow = (rows, typed) => Math.max(0, rows.findIndex((row) => same(row, typed)));

// Moves the selection by one row and wraps at both ends.
export const step = (index, delta, count) => (count ? (index + delta + count) % count : 0);

// Whether the composer's text should show the list: a slash and a name, with no space yet.
export const completing = (text) => /^\/[^\s/]*$/.test(String(text ?? ""));

// ---- the keys ----

// A Textarea binds enter, up, down, tab and escape itself. A binding beats `on_key_down`, so `on_key_down` above the text never
// hears them. The way past that is a binding of our own at the same depth, which wins because it was added later, as
// `mods/win98/menu.js` does for Escape. These only exist while something wants the key, so the arrows still move the cursor
// the rest of the time. Shift+Enter stays the input's. If the Enter binding ever misses, `submit` in `composerInput` does the same job.
export const KEY_CONTEXT = { text: "ChatComposer", panel: "ChatComposerPanel", list: "ChatComposerList" };
export const SEND_ACTION = "chat_composer_send";
export const LIST_KEYS = ["up", "down", "tab", "escape"];
export const keyAction = (key) => `chat_composer_${key}`;

const inside = (context) => `${context} > Input`;

export const keyBindings = () => [
  ...Object.values(KEY_CONTEXT).map((context) => ({ keystroke: "enter", action: SEND_ACTION, context: inside(context) })),
  ...LIST_KEYS.map((key) => ({ keystroke: key, action: keyAction(key), context: inside(KEY_CONTEXT.list) })),
  { keystroke: "escape", action: keyAction("escape"), context: inside(KEY_CONTEXT.panel) },
];

// What wants the keys above the text. `list` is the / list with rows to move through. `panel` is anything Escape closes.
export function keysWanted({ slash, exit, usage }) {
  if (slash?.flat?.length) return "list";
  return slash || exit || (usage && !usage.closing) ? "panel" : null;
}

// ---- the headless start ----

export const HEADLESS = ["-p", "--no-session-persistence", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
const userLine = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
// `zsh -i` gives the shell's profile, as it does for the terminals. The message is one argument, never shell text.
// `claude` runs in the background with a watchdog. If it's still going after HEADLESS_S seconds the watchdog stops it,
// and kills it 2 s later if it's still there, so a hang can't leave processes behind. That's inside `exec`'s own 30 s.
export const HEADLESS_S = 20;
export const SCRIPT = [
  'line=$1; shift',
  'printf "%s\\n" "$line" | claude "$@" &',
  'pid=$!',
  `( sleep ${HEADLESS_S}; kill -TERM $pid 2>/dev/null; sleep 2; kill -KILL $pid 2>/dev/null ) &`,
  'dog=$!',
  'wait $pid; code=$?',
  'pkill -P $dog 2>/dev/null; kill $dog 2>/dev/null',
  'exit $code',
].join("\n");
// The watchdog's TERM or KILL ends `claude` with 143 or 137.
const STOPPED = new Set([143, 137]);

// Whether Claude Code has accepted trust for exactly this folder, from the text of its .claude.json. `claude -p` skips the
// trust question and runs the folder's own settings and hooks, so a headless start only goes where a session already could.
// A parent folder's trust doesn't count, as in the terminal.
export function folderTrusted(claudeJson, folder) {
  try { return JSON.parse(claudeJson)?.projects?.[folder]?.hasTrustDialogAccepted === true; } catch { return false; }
}

// Where that file can be. Claude Code keeps it in the home folder, or in its config folder under CLAUDE_CONFIG_DIR.
export const trustFiles = (dir, home) => [`${dir}/.claude.json`, `${home}/.claude.json`];

// Runs `claude -p` in a folder with one message, which costs no turn when it's a local command such as /usage.
// Resolves to its stdout. Throws when the folder isn't trusted, so nothing runs there, or when it didn't finish in time.
// There's no JS timer here: a mod has no `setTimeout` or `clearTimeout`. The watchdog stops `claude`, and `exec` itself
// gives up at 30 s, so the read always settles.
export async function runHeadless(exec, folder, text, trusted) {
  if (trusted !== true) throw new Error("folder not trusted");
  const r = await exec("zsh", ["-ic", SCRIPT, "zsh", userLine(text), ...HEADLESS], { cwd: folder });
  if (STOPPED.has(r.code)) throw new Error("claude -p took too long");
  if (r.code !== 0 && !/"subtype"\s*:\s*"init"/.test(String(r.stdout))) throw new Error(`claude -p exited ${r.code}`);
  return r.stdout;
}

// Cached per folder for the life of the app. A failed read is tried again after RETRY_MS, never sooner, because each
// headless start runs the user's hooks. Concurrent askers share one read. A read always settles, because `runHeadless`
// gives up, so a hang drops the shared promise and counts as a failure like any other.
const RETRY_MS = 60_000;
const cache = new Map();

export const cachedList = (folder) => cache.get(folder)?.list ?? null;
export const resetCache = () => cache.clear();

// `trusted(folder)` says whether the folder is trusted, and a folder that isn't gets the table's commands only.
export function ensureList(folder, { exec, trusted, now = Date.now }) {
  const hit = cache.get(folder);
  if (hit?.promise) return hit.promise;
  if (hit?.list) return Promise.resolve(hit.list);
  if (hit?.failedAt != null && now() - hit.failedAt < RETRY_MS) return Promise.resolve(null);
  const entry = { list: null, failedAt: null, promise: null };
  entry.promise = Promise.resolve().then(() => trusted?.(folder)).then((ok) => runHeadless(exec, folder, "/usage", ok === true)).then((out) => {
    const parsed = parseStream(out);
    if (!parsed.names.length) throw new Error("no commands in the init message");
    entry.list = buildList(parsed);
    return entry.list;
  }).catch(() => { entry.failedAt = now(); return null; }).finally(() => { entry.promise = null; });
  cache.set(folder, entry);
  return entry.promise;
}

// ---- the card's rows ----

// Rows are fixed heights, so the card can be laid out and sized without measuring anything.
export const ROW = { item: 34, head: 28, gap: 6, pad: 6, max: 318 };

// The list as rows for a virtual list: a header band per section, then its commands. `index` counts commands only,
// the way the selection does. `top` is the row's offset from the top of the list.
export function completionRows(sections) {
  const rows = [];
  let top = 0, index = 0;
  sections.forEach((s, i) => {
    // The first header sits flush with the card's top edge. Later ones have a gap above.
    const size = i === 0 ? ROW.head : ROW.head + ROW.gap;
    rows.push({ kind: "head", title: s.title, size, top, first: i === 0 });
    top += size;
    for (const item of s.items) { rows.push({ kind: "item", item, size: ROW.item, top, index }); top += ROW.item; index++; }
  });
  return rows;
}

// The height of everything in the list, with the padding under the last row, and the card's height up to the most it grows.
export const contentHeight = (rows) => (rows.length ? rows[rows.length - 1].top + rows[rows.length - 1].size + ROW.pad : 0);
export const listHeight = (rows, max = ROW.max) => Math.min(max, contentHeight(rows));

// Where the selected command sits, so a plate can spring to it, and which row to scroll to when the list overflows.
export const selectedRow = (rows, index) => rows.find((r) => r.kind === "item" && r.index === index) ?? null;
export const rowNumber = (rows, index) => rows.findIndex((r) => r.kind === "item" && r.index === index);
