// Finds the Claude Code session behind a terminal, and reads its transcript through tail.py. No Herdr imports, so
// `node --test` can load this file: hc, exec and readTextFile come in as arguments. A miss returns null, and the pane
// keeps what it has.

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The Claude Code folders that can hold a session's files, from the home folder. Someone who runs Claude Code under
// CLAUDE_CONFIG_DIR adds that folder here.
const CONFIG_DIRS = [".claude"];
export const configDirs = (home) => CONFIG_DIRS.map((dir) => `${home}/${dir}`);

// Claude Code names a project's folder after its path, with everything but letters and digits as dashes.
export const projectSlug = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

export const sessionFile = (dir, pid) => `${dir}/sessions/${pid}.json`;

export const folderOf = (path) => path.slice(0, path.lastIndexOf("/"));

export function foregroundPid(stdout) {
  try {
    const pid = JSON.parse(stdout)?.foreground?.pid;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

export function parseSession(text, dir) {
  try {
    const s = JSON.parse(text);
    if (!SESSION_ID.test(s?.sessionId ?? "") || typeof s.cwd !== "string") return null;
    return {
      dir, pid: s.pid, sessionId: s.sessionId, name: s.name ?? null, status: s.status ?? null, waitingFor: typeof s.waitingFor === "string" ? s.waitingFor : null, cwd: s.cwd, updatedAt: s.updatedAt ?? 0,
      transcript: `${dir}/projects/${projectSlug(s.cwd)}/${s.sessionId}.jsonl`,
    };
  } catch { return null; }
}

// Two config folders can both hold a file for a pid, because pids come round again.
// The one written last is the live one.
export function newestSession(sessions) {
  return sessions.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

export async function findSession({ hc, readTextFile, home }, terminal) {
  const got = await hc(["get", terminal, "--json"]).catch(() => null);
  const pid = got?.code === 0 ? foregroundPid(got.stdout) : null;
  if (!pid) return null;
  const dirs = configDirs(home());
  const texts = await Promise.all(dirs.map((dir) => readTextFile(sessionFile(dir, pid)).catch(() => null)));
  return newestSession(texts.map((text, i) => text && parseSession(text, dirs[i])));
}

// `/resume` and a `cd` can leave the transcript under another project's folder, so look for it by id.
export async function locateTranscript({ exec }, session) {
  if (!SESSION_ID.test(session.sessionId)) return null;
  const r = await exec("sh", ["-c", 'ls -t "$1"/projects/*/"$2".jsonl 2>/dev/null', "sh", session.dir, session.sessionId]).catch(() => null);
  return r?.code === 0 ? r.stdout.split("\n").find(Boolean) ?? null : null;
}

// Reads that overlap can land out of order. Each call of `next()` starts one, and answers a check that's true until a newer
// one starts.
export function latest() {
  let newest = 0;
  return () => { const mine = ++newest; return () => mine === newest; };
}

// Same session, or has `/clear` or `/resume` moved it?
export const sessionMoved = (before, after) => Boolean(before && after) && before.sessionId !== after.sessionId;

// Whether a batch of changed paths touches this session's transcript. Other sessions write to the same folder.
export const wakesTranscript = (paths, transcript) => paths.includes(transcript);

export const wakesSession = (paths, session) => paths.some((p) => p === sessionFile(session.dir, session.pid));

// Runs the helper. `python3 -I -S` keeps it away from anything in the folder or site packages, and starts faster.
export async function tail({ exec }, helper, path, ...args) {
  const r = await exec("python3", ["-I", "-S", helper, path, ...args.map(String)]).catch(() => null);
  if (r?.code !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
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
