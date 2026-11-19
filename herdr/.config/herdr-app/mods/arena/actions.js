// What a run does to the machine: worktrees, tabs, agents, snapshots.
// Structural changes go through `herdr-app do`, which answers with the ids
// it made (a mod's `run()` returns nothing), so a lane always knows its
// terminal and tab.

import { exec, hc, home, readTextFile, run, terminals, agents, notify } from "herdr";
import { getRun, saveRun, updateRun, updateMember, dropRun } from "./store.js";
import * as G from "./lib/git.js";
import { agentWithTask, laneArgv, laneBranch, laneLabel, nextIndex, nextMemberId, slugify, worktreePath } from "./lib/names.js";
import { lastAnswer, claudeProjectDir, screenTail, codexLastAnswer, codexSessionMeta, opencodeSessionFor, opencodeLastAnswer } from "./lib/transcript.js";
import { answersPrompt, codePrompt, fusionModeFor, mightInlineDiffs, diffsFit, utf8Length, MAX_TASK_BYTES } from "./lib/fusion.js";

/** Lane checkouts go next to the worktree mod's: ~/.herdr/worktrees/<repo>/<branch with dashes>. */
export const WORKTREE_ROOT = () => `${home()}/.herdr/worktrees`;
/** The most lanes one launch starts: more would starve the machine. */
export const MAX_LANES = 5;

export async function appDo(command, args) {
  let r = null, failure = null;
  for (const bin of ["herdr-app", `${home()}/.local/bin/herdr-app`, "/usr/local/bin/herdr-app"]) {
    try { r = await exec(bin, ["do", command, JSON.stringify(args)]); break; } catch (e) { failure = e; }
  }
  if (!r) throw new Error(`herdr-app is not on PATH (${failure})`);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `${command} failed`);
  try { return JSON.parse(r.stdout); } catch { return {}; }
}

const short = (text, n) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);
export const tabName = (r, member) => `${short(r.title, 18)} · ${laneLabel(member, r.variants.length)}`;
export const overviewName = (title) => `Arena · ${short(title, 24)}`;

/** Hands out a member id the run has never used, and records it as used. */
function allocateId(runId) {
  let id = null;
  updateRun(runId, (r) => { const next = nextMemberId(r); r.seq = next.seq; id = next.id; });
  if (!id) throw new Error("This run is no longer available.");
  return id;
}

/**
 * Where the project folder sits inside its repo ("packages/api/"), so a lane
 * runs in the same folder of its worktree. Read from git at launch, so a
 * symlinked path (/tmp → /private/tmp) still finds it.
 */
const inside = (r) => (r.prefix ? `/${r.prefix.replace(/\/$/, "")}` : "");

/**
 * Starts one member: its checkout (when the run is isolated or it is a code
 * fusion), then a tab with its agent and the task as its first message. A
 * checkout whose tab never started is removed again; it holds nothing.
 */
async function startMember(r, member, task, { checkout, start, branch, root = false }) {
  let dir = r.folder, worktree = null;
  if (checkout) {
    worktree = worktreePath(WORKTREE_ROOT(), r.repo.name, branch);
    // Never take over a branch someone (or an earlier lane) already has.
    if (await G.branchExists(exec, r.repo, branch)) throw new Error(`Branch ${branch} already exists.`);
    await G.addWorktree(exec, r.repo, worktree, branch, start);
    // A code fusion works across the whole repo, so it starts at the top.
    dir = worktree + (root ? "" : inside(r));
  }
  let made;
  try {
    const agent = agentWithTask(member.agent.run, task);
    made = await appDo("tab.new", {
      name: tabName(r, member),
      space: r.space,
      folder: dir,
      argv: laneArgv(agent.argv, checkout ? r.setup : []),
      ...(agent.task === undefined ? {} : { task: agent.task }),
    });
  } catch (error) {
    if (worktree) await G.removeWorktree(exec, r.repo, worktree, branch).catch(() => undefined);
    throw error;
  }
  const started = { ...member, dir, worktree, branch: checkout ? branch : null, start: start ?? null, terminal: made.terminal, tab: made.tab, created: Date.now(), endedAt: null };
  updateRun(r.id, (next) => { next.members.push(started); });
  return started;
}

/**
 * spec: { title, space, folder, repo, isolate, base, setup, autoFusion,
 *         variants: { label, prompt, agents: agent[] }[] }
 * Lanes that fail to start are counted; the others still launch.
 */
export async function launch(spec) {
  const id = `r${Date.now().toString(36)}`;
  const baseCommit = spec.isolate ? (await G.git(exec, spec.repo.top, ["rev-parse", "--verify", `${spec.base}^{commit}`])).out : null;
  if (spec.isolate && !baseCommit) throw new Error(`${spec.base} has no commit to start from.`);
  let prefix = spec.repo ? await G.prefixOf(exec, spec.folder) : "";
  let moved = null;
  if (spec.isolate && prefix && !(await G.folderAt(exec, spec.repo, baseCommit, prefix))) {
    // The folder isn't in the base commit (new, untracked, or from another branch).
    moved = prefix;
    prefix = "";
  }
  const r = saveRun({
    id,
    title: spec.title,
    slug: `${slugify(spec.title)}-${id.slice(-4)}`,
    created: Date.now(),
    space: spec.space,
    folder: spec.folder,
    repo: spec.repo,
    isolate: spec.isolate,
    base: spec.base,
    baseCommit,
    setup: spec.setup,
    variants: spec.variants.map(({ label, prompt }) => ({ label, prompt })),
    autoFusion: spec.autoFusion ?? null,
    autoFused: false,
    judge: spec.autoFusion ?? null,
    overviewTab: null,
    seq: 0,
    retired: [],
    prefix,
    // Lanes are still being started: automatic fusion waits for all of them.
    launching: true,
    members: [],
  });
  let overview;
  try {
    overview = await appDo("tab.new", { name: overviewName(r.title), space: r.space, mod: "arena", props: { run: id } });
  } catch (error) {
    // Nothing was started yet: leave no record behind.
    dropRun(id);
    throw error;
  }
  updateRun(id, (next) => { next.overviewTab = overview.tab; });

  let failed = 0;
  const errors = [];
  for (const variant of spec.variants) {
    for (const agent of variant.agents) {
      const current = getRun(id);
      const member = { id: allocateId(id), role: "run", variant: variant.label, agent, index: nextIndex(current.members, variant.label, agent.key) };
      try {
        await startMember(current, member, variant.prompt, { checkout: r.isolate, start: baseCommit, branch: laneBranch(r.slug, member) });
      } catch (error) { failed++; errors.push(String(error?.message ?? error)); }
    }
  }
  updateRun(id, (next) => { next.launching = false; });
  if (!getRun(id)?.members.length) {
    // Nothing started: take the run back, so the launcher stays open with the prompt.
    dropRun(id);
    run("tab.close", { id: overview.tab, confirmed: true });
    throw new Error(`No run could be started. ${errors[0] ?? ""}`.trim());
  }
  run("tab.select", { id: overview.tab });
  if (moved) notify({ title: "Arena", body: `${moved} isn't in ${spec.base}, so the runs work from the repository's top folder.`, level: "info" });
  if (failed) notify({ title: "Arena", body: `Some runs could not be started. Failed: ${failed}.\n${errors[0] ?? ""}`, level: "warning" });
  return { id, failed };
}

/** Runs the same prompt on one more agent in this run. */
export async function addLane(runId, variantLabel, agent) {
  const r = getRun(runId);
  const variant = r?.variants.find((v) => v.label === variantLabel);
  if (!r || !variant) throw new Error("This run is no longer available.");
  const member = { id: allocateId(runId), role: "run", variant: variant.label, agent, index: nextIndex(r.members, variant.label, agent.key, r.retired ?? []) };
  return startMember(getRun(runId), member, variant.prompt, { checkout: r.isolate, start: r.baseCommit, branch: laneBranch(r.slug, member) });
}

// ---- reading a lane ------------------------------------------------------

const isClaude = (member, agent) => /claude/i.test(agent?.app ?? "") || /(^|\/)claude$/.test(member.agent?.run?.[0] ?? "");

/** Claude Code's transcript for a terminal: its foreground pid → ~/.claude/sessions/<pid>.json. */
async function claudeTranscript(address) {
  const got = await hc(["get", address, "--json"]);
  const pid = JSON.parse(got.stdout || "{}")?.foreground?.pid;
  if (!pid) return null;
  const text = await readTextFile(`${home()}/.claude/sessions/${pid}.json`);
  if (!text) return null;
  const session = JSON.parse(text);
  if (!session?.sessionId) return null;
  const projects = `${home()}/.claude/projects`;
  const file = `${session.sessionId}.jsonl`;
  if (session.cwd) {
    const direct = `${projects}/${claudeProjectDir(session.cwd)}/${file}`;
    if ((await exec("test", ["-f", direct])).code === 0) return direct;
  }
  // The folder naming is Claude Code's own detail; the session id is unique across projects.
  const found = await exec("find", [projects, "-maxdepth", "2", "-name", file]);
  return found.stdout.split("\n").find(Boolean) ?? null;
}

const isCodex = (member, agent) => /codex/i.test(agent?.app ?? "") || /(^|\/)codex$/.test(member.agent?.run?.[0] ?? "");

/**
 * A Codex lane's rollout: the newest ~/.codex/sessions file that began in the
 * lane's folder after the lane started. Codex keeps no pid → session map, so
 * the folder is the link: a lane sharing its folder with another Codex lane
 * of the run has none, since their files can't be told apart.
 */
async function codexTranscript(r, member) {
  if (!member.dir) return null;
  const sharing = r.members.some((m) => m.id !== member.id && m.dir === member.dir && isCodex(m, null));
  if (sharing) return null;
  const minutes = Math.ceil((Date.now() - (member.created ?? Date.now())) / 60000) + 2;
  // Recently written rollouts that mention the folder as a cwd; the first line says whose it is.
  const found = await exec("find", [`${home()}/.codex/sessions`, "-name", "rollout-*.jsonl", "-mmin", `-${minutes}`]);
  const files = found.stdout.split("\n").filter(Boolean);
  if (!files.length) return null;
  const hits = await exec("grep", ["-l", "-F", `"cwd":${JSON.stringify(member.dir)}`, ...files]);
  let best = null;
  for (const file of hits.stdout.split("\n").filter(Boolean)) {
    const head = await exec("head", ["-n", "1", file]);
    const meta = codexSessionMeta(head.stdout);
    // A little slack: the clocks are the same, but the lane's start is noted after tab.new answers.
    if (meta?.cwd === member.dir && meta.at >= (member.created ?? 0) - 10000 && (!best || meta.at > best.at)) best = { file, at: meta.at };
  }
  return best?.file ?? null;
}

const found = new Map();

/**
 * Where a program lives, for `exec`. Mods run with a login shell's PATH, but
 * agent installers often add theirs only in the interactive rc
 * (~/.opencode/bin in .zshrc), where Herdr starts the agents themselves. So:
 * PATH, then the usual install folders, then the person's interactive shell.
 * @returns {Promise<string | null>}
 */
async function locate(bin) {
  if (bin.includes("/")) return bin;
  if (found.has(bin)) return found.get(bin);
  const executable = async (path) => Boolean(path) && (await exec("test", ["-x", path]).catch(() => null))?.code === 0;
  const lastPath = (out) => String(out ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/")).pop();
  let path = lastPath((await exec("sh", ["-c", 'command -v -- "$1"', "sh", bin]).catch(() => null))?.stdout);
  if (!(await executable(path))) {
    path = null;
    for (const dir of [`${home()}/.${bin}/bin`, `${home()}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin"]) {
      if (await executable(`${dir}/${bin}`)) { path = `${dir}/${bin}`; break; }
    }
  }
  if (!path && /^[\w.+-]+$/.test(bin)) {
    const shell = (await exec("sh", ["-c", 'printf %s "$SHELL"']).catch(() => null))?.stdout?.trim();
    if (shell) {
      const candidate = lastPath((await exec(shell, ["-ic", `command -v ${bin}`]).catch(() => null))?.stdout);
      if (await executable(candidate)) path = candidate;
    }
  }
  if (path) found.set(bin, path);
  return path ?? null;
}

const isOpencode = (member, agent) => /opencode/i.test(agent?.app ?? "") || /(^|\/)opencode$/.test(member.agent?.run?.[0] ?? "");

/**
 * An OpenCode lane's answer, from its own CLI: the session it started in the
 * lane's folder, exported as JSON. Like Codex, a folder shared with another
 * OpenCode lane of the run can't tell their sessions apart.
 * @returns {Promise<string | null | undefined>} undefined when it can't be read
 */
async function opencodeReply(runId, member) {
  const r = getRun(runId);
  if (!r || !member.dir) return undefined;
  if (r.members.some((m) => m.id !== member.id && m.dir === member.dir && isOpencode(m, null))) return undefined;
  const bin = await locate(member.agent?.run?.[0] || "opencode");
  if (!bin) return undefined;
  let id = member.opencode ?? null;
  if (!id) {
    const list = await exec(bin, ["session", "list", "-n", "20", "--format", "json"], { cwd: member.dir });
    if (list.code !== 0) return undefined;
    id = opencodeSessionFor(list.stdout, member.dir, (member.created ?? 0) - 10000);
    if (!id) return undefined;
    updateMember(runId, member.id, (m) => { m.opencode = id; });
  }
  const got = await exec(bin, ["session", "export", id], { cwd: member.dir });
  return got.code === 0 ? opencodeLastAnswer(got.stdout) : undefined;
}

/** The tail of a transcript, read with `answer`; null when it can't be read. */
async function readTail(path, answer) {
  const tail = await exec("tail", ["-n", "600", path]);
  return tail.code === 0 ? answer(tail.stdout) : undefined;
}

/**
 * The lane's latest answer: { state: "ready", text, screen? } or { state: "error" }.
 * The transcript path is kept on the member, so the answer stays readable
 * after the agent quits.
 */
export async function laneReply(runId, member) {
  try {
    const agent = agents().find((a) => a.address === member.terminal);
    if (isCodex(member, agent)) {
      let path = member.codex ?? null;
      if (!path) {
        const r = getRun(runId);
        path = r ? await codexTranscript(r, member).catch(() => null) : null;
        if (path) updateMember(runId, member.id, (m) => { m.codex = path; });
      }
      if (path) {
        const text = await readTail(path, codexLastAnswer);
        if (text !== undefined) return { state: "ready", text: text ?? "" };
      }
    }
    if (isOpencode(member, agent)) {
      const text = await opencodeReply(runId, member).catch(() => undefined);
      if (text !== undefined) return { state: "ready", text: text ?? "" };
    }
    if (isClaude(member, agent)) {
      let path = member.claude ?? null;
      const live = await claudeTranscript(member.terminal).catch(() => null);
      if (live && live !== path) { path = live; updateMember(runId, member.id, (m) => { m.claude = live; }); }
      if (path) {
        const tail = await exec("tail", ["-n", "600", path]);
        if (tail.code === 0) {
          const text = lastAnswer(tail.stdout);
          return { state: "ready", text: text ?? "" };
        }
      }
    }
    if (!terminals().some((t) => t.address === member.terminal)) return { state: "ready", text: "" };
    const screen = await hc(["read", member.terminal]);
    if (screen.code !== 0) return { state: "error" };
    return { state: "ready", text: screenTail(screen.stdout), screen: true };
  } catch {
    return { state: "error" };
  }
}

/** What a lane changed since it started: { state: "ready", stat } | { state: "error" } | null without a checkout. */
export async function laneChanges(member) {
  if (!member.worktree || !member.start) return null;
  try { return { state: "ready", stat: await G.laneStat(exec, member.worktree, member.start) }; }
  catch { return { state: "error" }; }
}

export const laneDiffText = (member) => G.laneDiff(exec, member.worktree, member.start);

// ---- leaving a run -------------------------------------------------------

/**
 * Waits until a terminal has ended or is gone, up to `ms`. Only herdr-core
 * saying so counts: a failed or unreadable answer is asked again, never taken
 * for "ended", because removal follows.
 */
async function ended(address, ms = 8000) {
  const until = Date.now() + ms;
  for (;;) {
    const got = await hc(["get", address, "--json"]).catch(() => null);
    let answer = null;
    try { answer = JSON.parse(got?.stdout || "null"); } catch { /* asked again below */ }
    if (answer?.error?.kind === "not_found") return true;
    if (got?.code === 0 && answer?.state && answer.state !== "live") return true;
    if (Date.now() > until) return false;
    await exec("sleep", ["0.25"]);
  }
}

/**
 * Puts members away: close all their tabs at once and wait for every agent
 * to end, so nothing writes to a checkout any more; then, one by one,
 * snapshot each checkout into a private ref, and only then remove it and its
 * branch. A member whose step fails keeps its checkout, with its work, and is
 * returned with the reason. The project's own folder is never removed.
 * A checkout someone already deleted has nothing left to save: git forgets
 * it, and its branch stays.
 * @returns {Promise<{ member: any, error: string }[]>}
 */
async function putAway(r, members) {
  for (const member of members) if (member.tab) run("tab.close", { id: member.tab, confirmed: true });
  const gone = await Promise.all(members.map((m) => (m.terminal ? ended(m.terminal) : true)));
  const failures = [];
  for (const [i, member] of members.entries()) {
    try {
      if (!gone[i]) throw new Error("Its agent is still running; its worktree was left as it was.");
      if (member.worktree) {
        if (await G.isCheckout(exec, member.worktree)) {
          await G.snapshot(exec, member.worktree, G.snapshotRef(r.id, member.id, "archive"));
          await G.removeWorktree(exec, r.repo, member.worktree, member.branch);
        } else {
          await G.git(exec, r.repo.main, ["worktree", "prune"]);
        }
      }
      updateRun(r.id, (next) => { next.members = next.members.filter((m) => m.id !== member.id); });
    } catch (error) { failures.push({ member, error: String(error?.message ?? error) }); }
  }
  return failures;
}

/** A run with one member left is no longer a run: its tab gets the run's title. */
function dissolveIfAlone(runId) {
  const r = getRun(runId);
  if (!r || r.members.length > 1) return false;
  const survivor = r.members[0];
  if (survivor?.tab) run("tab.rename", { id: survivor.tab, name: r.title });
  dropRun(runId);
  if (survivor?.tab) run("tab.select", { id: survivor.tab });
  if (r.overviewTab) run("tab.close", { id: r.overviewTab, confirmed: true });
  return true;
}

/** Keeps one member and cleans up the others. Returns those that could not be cleaned up. */
export async function keep(runId, keptId) {
  const r = getRun(runId);
  const kept = r?.members.find((m) => m.id === keptId);
  if (!r || !kept) throw new Error("This run is no longer available.");
  const failures = await putAway(r, r.members.filter((m) => m.id !== keptId));
  const name = laneLabel(kept, r.variants.length);
  if (failures.length) {
    notify({ title: "Arena", body: failures.length === 1 ? `Kept ${name}. One run could not be cleaned up and was left as it was.\n${failures[0].error}` : `Kept ${name}. ${failures.length} runs could not be cleaned up and were left as they were.\n${failures[0].error}`, level: "warning" });
    return failures;
  }
  if (kept.tab) run("tab.rename", { id: kept.tab, name: r.title });
  notify({ title: "Arena", body: `Kept ${name}${kept.branch ? ` on ${kept.branch}` : ""}`, level: "success", timeout: 4000 });
  dropRun(runId);
  if (kept.tab) run("tab.select", { id: kept.tab });
  if (r.overviewTab) run("tab.close", { id: r.overviewTab, confirmed: true });
  return [];
}

/** Archives one member; the rest of the run stays. */
export async function archiveMember(runId, memberId) {
  const r = getRun(runId);
  const member = r?.members.find((m) => m.id === memberId);
  if (!member) return;
  const [failure] = await putAway(r, [member]);
  if (failure) throw new Error(failure.error);
  dissolveIfAlone(runId);
}

/** Leaves the run as an ordinary tab, in its own folder or worktree. */
export function detach(runId, memberId) {
  const r = getRun(runId);
  const member = r?.members.find((m) => m.id === memberId);
  if (!member) return;
  if (member.tab) run("tab.rename", { id: member.tab, name: r.title });
  // Its branch stays, so its repeat number stays taken.
  updateRun(runId, (next) => {
    next.members = next.members.filter((m) => m.id !== memberId);
    next.retired = [...(next.retired ?? []), { role: member.role, variant: member.variant, index: member.index, agent: { key: member.agent?.key } }];
  });
  notify({ title: "Arena", body: `${laneLabel(member, r.variants.length)} is now a separate tab`, level: "info", timeout: 3000 });
  dissolveIfAlone(runId);
}

/** Archives every member, then the overview. Returns how many could not be archived. */
export async function archiveRun(runId) {
  const r = getRun(runId);
  if (!r) return 0;
  const failures = await putAway(r, r.members);
  if (failures.length) {
    notify({ title: "Arena", body: `Some runs could not be archived.\n${failures[0].error}`, level: "warning" });
    return failures.length;
  }
  dropRun(runId);
  if (r.overviewTab) run("tab.close", { id: r.overviewTab, confirmed: true });
  return 0;
}

export function rename(runId, title) {
  const next = updateRun(runId, (r) => { r.title = title; });
  if (!next) return;
  if (next.overviewTab) run("tab.rename", { id: next.overviewTab, name: overviewName(title) });
  for (const member of next.members) if (member.tab) run("tab.rename", { id: member.tab, name: tabName(next, member) });
}

// ---- fusion ---------------------------------------------------------------

export class NoFusionOutputsError extends Error {
  constructor() { super("No answers found to fuse."); }
}

/**
 * Fuses the selected settled lanes into a new member. Each source's answer is
 * read again; a read failure stops the fusion instead of dropping a source.
 * A lane is left out only when it has neither an answer nor changed files.
 *
 * Code fusion starts from the run's base commit, the one every lane started
 * from, even if a lane committed on its branch since: each lane's snapshot
 * holds its committed and uncommitted work alike.
 */
export async function fuse(runId, sourceIds, judge) {
  const r = getRun(runId);
  if (!r) throw new Error("This run is no longer available.");
  const chosen = r.members.filter((m) => m.role === "run" && sourceIds.includes(m.id));
  let sources = [];
  for (const member of chosen) {
    const label = laneLabel(member, r.variants.length);
    const reply = await laneReply(runId, member);
    if (reply.state !== "ready") throw new Error(`Could not read ${label}'s answer.`);
    // One scan of the checkout serves both the change count and the snapshot.
    const state = member.worktree && member.start ? await G.laneStat(exec, member.worktree, member.start) : null;
    if (!reply.text && !(state?.files > 0)) continue;
    const text = !reply.text ? "(It ended without a final answer. Read its changes.)"
      : reply.screen ? `(The end of its terminal screen; this agent has no transcript Arena can read.)\n${reply.text}` : reply.text;
    sources.push({ member, label, reply: text, answered: Boolean(reply.text), state });
  }
  const mode = fusionModeFor(sources.map((s) => ({ hasWorktree: Boolean(s.member.worktree), diff: s.state })));
  // Combining answers needs answers.
  if (mode === "answers") sources = sources.filter((s) => s.answered);
  if (!sources.length) throw new NoFusionOutputsError();
  const prompts = new Map();
  for (const variant of r.variants) if (sources.some((s) => s.member.variant === variant.label)) prompts.set(variant.label, variant.prompt);

  const member = { id: allocateId(runId), role: "fusion", variant: "F", agent: judge, index: r.members.filter((m) => m.role === "fusion").length + 1 };

  if (mode === "code") {
    const baseCommit = r.baseCommit ?? sources[0].member.start;
    const snapshots = [];
    for (const s of sources) snapshots.push(await G.snapshot(exec, s.member.worktree, G.snapshotRef(r.id, s.member.id, "fusion"), s.state));
    const changed = sources.reduce((n, s) => n + (s.state ? s.state.insertions + s.state.deletions : 0), 0);
    // Line counts first, so large diffs are never read; then their real size.
    let texts = [];
    if (mightInlineDiffs(changed)) {
      try { for (const snap of snapshots) texts.push(await G.rangeDiff(exec, r.repo.top, baseCommit, snap.commit)); }
      catch { texts = []; }
      if (!diffsFit(texts)) texts = [];
    }
    const withDiffs = sources.map((s, i) => ({
      label: s.label,
      reply: s.reply,
      snapshot: { commit: snapshots[i].commit, head: baseCommit },
      diff: s.state ? { files: s.state.files, insertions: s.state.insertions, deletions: s.state.deletions } : null,
      diffText: texts[i],
    }));
    let task = codePrompt({ baseCommit, prompts, sources: withDiffs });
    // The judge reads the snapshots with git anyway; without diffs the task stays an argument the OS takes.
    if (utf8Length(task) > MAX_TASK_BYTES) task = codePrompt({ baseCommit, prompts, sources: withDiffs.map((s) => ({ ...s, diffText: undefined })) });
    if (utf8Length(task) > MAX_TASK_BYTES) throw new Error("The answers are too long to hand to one agent.");
    // A run can be fused more than once; each fusion gets its own branch.
    const branch = `arena/${r.slug}/fusion-${Date.now().toString(36)}`;
    return { mode, member: await startMember(getRun(runId), member, task, { checkout: true, start: baseCommit, branch, root: true }) };
  }
  const task = answersPrompt({ prompts, sources });
  if (utf8Length(task) > MAX_TASK_BYTES) throw new Error("The answers are too long to hand to one agent.");
  // A run of separate worktrees keeps the person's checkout out of reach: the
  // judge gets a worktree of its own too, at the lanes' starting commit.
  const own = r.isolate ? { checkout: true, start: r.baseCommit, branch: `arena/${r.slug}/fusion-${Date.now().toString(36)}` } : { checkout: false };
  return { mode, member: await startMember(getRun(runId), member, task, own) };
}

/** Marks a run fused before starting, so automatic fusion runs exactly once. */
export function claimAutoFusion(runId) {
  const r = getRun(runId);
  if (!r?.autoFusion || r.autoFused) return false;
  updateRun(runId, (next) => { next.autoFused = true; });
  return true;
}

/** Automatic fusion found too little to fuse: it won't run, and the run says why. */
export function skipAutoFusion(runId, reason) {
  if (!claimAutoFusion(runId)) return;
  updateRun(runId, (next) => { next.autoSkipped = reason; });
  notify({ title: "Arena", body: `Automatic fusion skipped: ${reason}`, level: "info" });
}
