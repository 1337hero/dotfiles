// Finds the pi session behind a terminal, and reads its transcript through pi-tail.py. No Herdr imports, so
// `node --test` can load this file: hc, exec and home come in as arguments. A miss returns null, and the pane
// keeps what it has.
//
// pi keeps one folder of sessions per working folder, `~/.pi/agent/sessions/<cwd, in its own spelling>/<time>_<id>.jsonl`,
// and writes to the file while the session goes on. Nothing records which of them a running terminal has open, so
// the file is looked for by name first (a label set by this mod's own pi extension, or by revive's), and by being
// the newest one in the folder otherwise. `PI_CODING_AGENT_DIR` moves the whole folder; a session using it isn't found.

const EXTENSION = ".jsonl";
// Labels a terminal can carry, naming the session file it is running.
export const LABEL_KEYS = ["pi-chat.transcript", "revive.transcript"];

export const agentDir = (home) => `${home}/.pi/agent`;

// pi spells a working folder out into a folder name of its own: `~/.pi/agent/sessions/--home-me-app--`.
export const slug = (cwd) => `--${String(cwd ?? "").replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

export const sessionDir = (home, cwd) => `${agentDir(home)}/sessions/${slug(cwd)}`;

export const folderOf = (path) => path.slice(0, path.lastIndexOf("/"));

// What `hc get --json` says about a terminal, or null.
export function terminalInfo(stdout) {
  try {
    const info = JSON.parse(stdout);
    const foreground = info?.foreground;
    if (!foreground || typeof foreground.name !== "string") return null;
    return {
      name: foreground.name,
      pid: foreground.pid ?? null,
      cwd: foreground.cwd ?? info.cwd ?? null,
      labels: info.labels && typeof info.labels === "object" ? info.labels : {},
    };
  } catch {
    return null;
  }
}

// pi renames its process, so this is pi's own name and not the runtime that runs it.
export const isPi = (info) => Boolean(info) && /^(π|pi)(-|$)/.test(info.name);

// The session file a terminal is running, from a label something put on it.
export const labelPath = (info) =>
  LABEL_KEYS.map((key) => info?.labels?.[key]).find((path) => typeof path === "string" && path.startsWith("/") && path.endsWith(EXTENSION)) ?? null;

export const exists = async (exec, path) => (await exec("test", ["-f", path]).catch(() => null))?.code === 0;

// The newest session file in a folder: the one being written now, when nothing names it.
export async function newestTranscript(exec, dir) {
  const r = await exec("sh", ["-c", 'ls -t "$1"/*.jsonl 2>/dev/null | head -1', "sh", dir]).catch(() => null);
  const path = r?.code === 0 ? r.stdout.trim() : "";
  return path.endsWith(EXTENSION) ? path : null;
}

// The session behind a terminal: { path, dir, cwd, pid }, or null when this isn't a pi terminal.
// `keep` is the file now showing, which stays while it is still there, so a pane doesn't move to another session's
// file in the same folder.
export async function findSession({ hc, exec, home }, terminal, keep = null) {
  const got = await hc(["get", terminal, "--json"]).catch(() => null);
  if (got?.code !== 0) return null;
  const info = terminalInfo(got.stdout);
  if (!isPi(info) || !info.cwd) return null;
  const dir = sessionDir(home(), info.cwd);
  const named = labelPath(info);
  const path = named ?? (keep && (await exists(exec, keep)) ? keep : null) ?? (await newestTranscript(exec, dir));
  return path ? { path, dir: folderOf(path), cwd: info.cwd, pid: info.pid } : null;
}

// Reads that overlap can land out of order. Each call of `next()` starts one, and answers a check that is true until a
// newer one starts.
export function latest() {
  let newest = 0;
  return () => {
    const mine = ++newest;
    return () => mine === newest;
  };
}

// A different session, after `/new`, `/resume` or a `cd`.
export const sessionMoved = (before, after) => Boolean(before && after) && before.path !== after.path;

// Runs the helper. `python3 -I -S` keeps it away from anything in the folder or site packages, and starts faster.
export async function tail({ exec }, helper, path, ...args) {
  const r = await exec("python3", ["-I", "-S", helper, path, ...args.map(String)]).catch(() => null);
  if (r?.code !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// One read at a time. A wake during a read sets `state.dirty`, which asks for another straight after it. `once()` is one
// read, and `current()` says the thread is still the one this loop started for. A read that throws ends the loop through
// `failed(error)`, and `reading` is let go either way, or the thread would never read again. A loop for a thread that's
// gone leaves `reading` alone, because the new thread's loop owns it.
export async function readLoop(state, { once, current, failed }) {
  try {
    do {
      state.dirty = false;
      await once();
      if (!current()) return;
    } while (state.dirty);
  } catch (error) {
    if (current()) failed(error);
  } finally {
    if (current()) state.reading = false;
  }
}
