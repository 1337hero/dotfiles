// Git for lanes. Every function takes the mod's `exec`, so the same code runs
// in Herdr and under `node --test`.
//
// A lane's work is normally uncommitted: agents don't commit, so its branch
// still points at the start commit. Its state is therefore read through a
// throwaway index: `git add -A` into it, then `write-tree`. The tree holds tracked, staged, unstaged and untracked (not
// ignored) files, and the real index, HEAD and branch are never touched.

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
export const SNAPSHOT_IDENTITY = [
  "GIT_AUTHOR_NAME=Herdr Arena", "GIT_AUTHOR_EMAIL=arena@herdr.invalid",
  "GIT_COMMITTER_NAME=Herdr Arena", "GIT_COMMITTER_EMAIL=arena@herdr.invalid",
];

/**
 * Snapshots stay under this ref prefix until someone deletes them. Each one
 * gets its own ref (why it was taken, and when), so a later snapshot of the
 * same lane never replaces the commit an earlier fusion was handed.
 */
export const snapshotRef = (runId, laneId, why = "archive", when = Date.now()) =>
  `refs/herdr-arena/runs/${runId}/${laneId}/${why}-${when.toString(36)}`;

/** Whether a folder is still a checkout (someone may have deleted it, or pruned it). */
export const isCheckout = async (exec, dir) => (await exec("test", ["-d", dir]).catch(() => ({ code: 1 }))).code === 0
  && (await git(exec, dir, ["rev-parse", "--is-inside-work-tree"])).out === "true";

export async function git(exec, cwd, args, env = []) {
  const r = env.length ? await exec("env", [...env, "git", ...args], { cwd }) : await exec("git", args, { cwd });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

async function must(exec, cwd, args, env, what) {
  const r = await git(exec, cwd, args, env);
  if (!r.ok) throw new Error(`${what}: ${r.err || `git ${args[0]} failed`}`);
  return r.out;
}

/** The repo a folder belongs to: { top, main, name }, or null outside git. */
export async function repoOf(exec, folder) {
  const top = await git(exec, folder, ["rev-parse", "--show-toplevel"]);
  const common = await git(exec, folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, name: main.split("/").pop() };
}

/**
 * Local branches, the checked out one first. On a detached HEAD (a tag, a
 * bisect) `current` is "HEAD", so runs start from what is checked out, not
 * from whichever branch moved last.
 */
export async function branches(exec, top) {
  const named = (await git(exec, top, ["branch", "--show-current"])).out;
  const list = await git(exec, top, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]);
  const names = list.ok ? list.out.split("\n").filter(Boolean) : [];
  const current = named || "HEAD";
  return { current, detached: !named, names: [current, ...names.filter((n) => n !== current)] };
}

/** `git diff --numstat` output → { files, insertions, deletions }. Binary files count as files. */
export function parseNumstat(text) {
  let files = 0, insertions = 0, deletions = 0;
  for (const line of String(text ?? "").split("\n")) {
    const [a, d, ...path] = line.split("\t");
    if (!path.length) continue;
    files++;
    insertions += Number(a) || 0;
    deletions += Number(d) || 0;
  }
  return { files, insertions, deletions };
}

/** The worktree as one tree object, through a throwaway index: { head, tree }. */
export async function stateTree(exec, dir) {
  const head = await must(exec, dir, ["rev-parse", "--verify", "HEAD"], [], "Worktree has no HEAD commit");
  const temp = (await exec("mktemp", ["-d"])).stdout.trim();
  if (!temp) throw new Error("Could not make a temporary folder");
  const env = [`GIT_INDEX_FILE=${temp}/index`];
  try {
    // A copy of the real index carries its stat cache, so `add -A` hashes only
    // what changed; a fresh `read-tree` index would hash every file again.
    const real = await git(exec, dir, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const copied = real.ok && (await exec("cp", [real.out, `${temp}/index`]).catch(() => ({ code: 1 }))).code === 0;
    if (!copied) await must(exec, dir, ["read-tree", head], env, "Failed to read the worktree state");
    await must(exec, dir, [...READ, "add", "-A"], env, "Failed to read the worktree state");
    const tree = await must(exec, dir, ["write-tree"], env, "Failed to read the worktree state");
    return { head, tree };
  } finally {
    await exec("rm", ["-rf", temp]).catch(() => undefined);
  }
}

/**
 * What a lane changed since `base`: { files, insertions, deletions, head, tree }.
 * The state it read can be handed to `snapshot`, so a lane is scanned once.
 */
export async function laneStat(exec, dir, base) {
  const state = await stateTree(exec, dir);
  const out = await must(exec, dir, ["diff", "--numstat", "--no-renames", base, state.tree], [], "Failed to read changes");
  return { ...parseNumstat(out), ...state };
}

/** A unified diff between two tree-ish objects, never through a user's external diff or textconv. */
export const rangeDiff = (exec, dir, from, to) =>
  must(exec, dir, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", from, to], [], "Failed to read the diff");

/** The lane's full diff since `base`, as text. */
export async function laneDiff(exec, dir, base) {
  const { tree } = await stateTree(exec, dir);
  return rangeDiff(exec, dir, base, tree);
}

/**
 * Saves the worktree into a commit on `ref`, its parent the commit it stands
 * on: { ref, commit, head }. `state` is a `stateTree` read just before, when
 * there is one.
 */
export async function snapshot(exec, dir, ref, state = null) {
  const { head, tree } = state ?? await stateTree(exec, dir);
  const commit = await must(exec, dir, ["commit-tree", tree, "-p", head, "-m", "Herdr Arena run snapshot"], SNAPSHOT_IDENTITY, "Failed to write snapshot commit");
  await must(exec, dir, ["update-ref", ref, commit], [], "Failed to store snapshot ref");
  return { ref, commit, head };
}

/** Whether a local branch exists. */
export const branchExists = async (exec, repo, branch) => (await git(exec, repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok;

/** The folder's path inside its repo ("packages/api/", or "" at the top), as git sees it: symlinks resolved. */
export const prefixOf = async (exec, folder) => (await git(exec, folder, ["rev-parse", "--show-prefix"])).out;

/** Whether a folder (a prefix like "packages/api/") exists in a commit. */
export const folderAt = async (exec, repo, commit, prefix) =>
  !prefix || (await git(exec, repo.main, ["cat-file", "-e", `${commit}:${prefix.replace(/\/$/, "")}`])).ok;

/** A new branch at `start`, checked out at `path`. */
export async function addWorktree(exec, repo, path, branch, start) {
  await must(exec, repo.top, ["worktree", "add", "-b", branch, path, start], [], "git worktree add failed");
}

/**
 * Removes a lane's checkout and its branch. Never the main checkout. The work
 * should be snapshotted first: `--force` drops uncommitted changes.
 */
export async function removeWorktree(exec, repo, path, branch) {
  if (!path || path === repo.main || path === repo.top) throw new Error("Refusing to remove the main checkout");
  const removed = await git(exec, repo.main, ["worktree", "remove", "--force", path]);
  if (!removed.ok) throw new Error(`git worktree remove failed: ${removed.err}`);
  if (branch) await git(exec, repo.main, ["branch", "-D", branch]);
}
