// Runs live in Herdr's shared state (persisted in shared.json), so the
// launcher, every overview and every popup see the same record and redraw
// when it changes.
//
// run: { id, title, slug, created, space, folder, repo: { top, main, name } | null,
//        isolate, base, baseCommit, setup: string[], variants: { label, prompt }[],
//        autoFusion: agent | null, autoFused, judge: agent | null, overviewTab,
//        members: member[] }
// member: { id, role: "run" | "fusion", variant, index, agent: { key, name, run, icon, tint },
//           terminal, tab, dir, worktree, branch, start, created, endedAt, claude }

import { shared, setShared } from "herdr";

const KEY = "arena.runs";
const clone = (value) => JSON.parse(JSON.stringify(value));

/** @returns {Record<string, any>} */
export const runs = () => /** @type {any} */ (shared(KEY)) ?? {};
export const getRun = (id) => runs()[id] ?? null;

export function saveRun(run) {
  setShared(KEY, { ...runs(), [run.id]: run });
  return run;
}

/** Changes a run in place by a function on a copy; null when it is gone. */
export function updateRun(id, change) {
  const run = getRun(id);
  if (!run) return null;
  const next = clone(run);
  change(next);
  return saveRun(next);
}

export function updateMember(runId, memberId, change) {
  return updateRun(runId, (run) => {
    const member = run.members.find((m) => m.id === memberId);
    if (member) change(member);
  });
}

export function dropRun(id) {
  const all = { ...runs() };
  delete all[id];
  setShared(KEY, all);
  // The statuses its overview published for the side-by-side heads.
  const statuses = { ...laneStatuses() };
  if (id in statuses) { delete statuses[id]; setShared(STATUS, statuses); }
}

const STATUS = "arena.status";
/** Lane statuses each overview publishes, by run and member: { [runId]: { [memberId]: status } }. */
export const laneStatuses = () => /** @type {Record<string, Record<string, string>>} */ (shared(STATUS)) ?? {};

/** Records a run's lane statuses, only when one changed. */
export function publishStatuses(runId, statuses) {
  const all = laneStatuses();
  if (JSON.stringify(all[runId] ?? null) !== JSON.stringify(statuses)) setShared(STATUS, { ...all, [runId]: statuses });
}

/** The run and member a terminal belongs to. */
export function memberOfTerminal(address) {
  for (const run of Object.values(runs())) {
    const member = run.members.find((m) => m.terminal === address);
    if (member) return { run, member };
  }
  return null;
}

/** The run whose overview or lane is in a tab. */
export function runOfTab(tabId) {
  return Object.values(runs()).find((run) => run.overviewTab === tabId || run.members.some((m) => m.tab === tabId)) ?? null;
}

/** The launcher's last choices: agents, where, fusion. */
export const lastChoices = () => /** @type {any} */ (shared("arena.last")) ?? null;
export const saveChoices = (choices) => setShared("arena.last", choices);
