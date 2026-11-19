// Fusion: one more agent reads the lanes' results and builds the best of them.
//
// - answers mode (a lane has no worktree, or nothing changed): the fusion
//   works in the project folder and gets each lane's final answer;
// - code mode (every lane has a worktree and at least one changed files): each
//   lane is snapshotted into a commit, the fusion gets its own worktree at
//   the commit the lanes started from, and reads the attempts with git.

export const FUSION_VISIBLE = "Merge the parallel results above into one final result.";

export const FUSION_INSTRUCTIONS = `Several agents worked on the same task in parallel. Their results follow.

Write one final answer that is better than any single result: keep what each got right, fill the gaps one left with what another found, settle disagreements in favour of the most specific and best-supported claim, and drop repetition.

Answer the task directly. Don't describe the results one by one or say that you were given several.

=== INPUTS ===`;

export const codeInstructions = (baseCommit, attemptCount) => `${attemptCount} agents made parallel attempts at the same coding task. Combine them into one result.

This worktree is fresh, checked out at ${baseCommit}: the commit every attempt started from. Each attempt's full state, uncommitted and new files included, is stored as a snapshot commit (listed below). Inspect them with git rather than guessing:

- \`git diff --stat ${baseCommit} <snapshot>\` summarises an attempt.
- \`git diff ${baseCommit} <snapshot> -- <path>\` shows its changes to one file.
- \`git show <snapshot>:<path>\` prints a file as the attempt left it.

Paths are from the repository root, wherever you are in it.

Steps:
1. Read every attempt's final answer and change summary, and choose the strongest one as the starting point.
2. Bring it in with \`git restore --source=<snapshot> --staged --worktree -- :/\`. This takes the whole repository, files the attempt deleted included; pass paths instead of \`:/\` to take only some.
3. Where the attempts differ, compare those files and carry over what the others did better: fixes, tests, edge cases, clearer code.
4. Make the whole consistent, and run the project's checks if it has any.
5. Leave the changes uncommitted. End with a short note: which attempt you started from and what you took from each of the others.

Look at diffs file by file as you need them; don't dump every attempt in full.

=== INPUTS ===`;

// Diffs are inlined only while all of them together stay under this share of
// the judge's context window; otherwise the judge reads them with git.
const INLINE_DIFF_CONTEXT_SHARE = 0.1;
// Rough token cost of one changed line (content plus diff framing): a cheap
// first look, before any diff is read.
const TOKENS_PER_DIFF_LINE = 12;
// Rough bytes per token, for the diffs once they are read.
const BYTES_PER_TOKEN = 4;
// Herdr can't ask an agent its context window; this is the common floor.
export const ASSUMED_CONTEXT = 200_000;
// The task travels as a program argument; the OS caps those (macOS: 1 MiB in all).
export const MAX_TASK_BYTES = 256 * 1024;

/** Selected lanes whose worktrees hold changes and who all have one: that is a code fusion. */
export const fusionModeFor = (stats) => (
  stats.length > 0 && stats.every((s) => s.hasWorktree) && stats.some((s) => (s.diff?.files ?? 0) > 0) ? "code" : "answers"
);

/**
 * Whether the diffs are worth reading to inline: their changed lines alone
 * already fit the budget. A few very long lines (minified or generated files)
 * pass this, so `diffsFit` checks the text itself afterwards.
 */
export const mightInlineDiffs = (changedLines, contextLimit = ASSUMED_CONTEXT) => (
  contextLimit > 0 && changedLines * TOKENS_PER_DIFF_LINE <= contextLimit * INLINE_DIFF_CONTEXT_SHARE
);

/** Whether the read diffs, by their size, fit the judge's budget and a program argument. */
export const diffsFit = (texts, contextLimit = ASSUMED_CONTEXT) => {
  const bytes = texts.reduce((n, t) => n + utf8Length(t ?? ""), 0);
  return bytes / BYTES_PER_TOKEN <= contextLimit * INLINE_DIFF_CONTEXT_SHARE && bytes <= MAX_TASK_BYTES / 2;
};

/** UTF-8 byte length without TextEncoder, which a mod's runtime may lack. */
export function utf8Length(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** One task block per prompt variant that has a source. */
export const taskBlocks = (prompts) => {
  const entries = [...prompts];
  return entries.map(([variant, text]) => (entries.length > 1
    ? `\n\n[Task, variant ${variant}]\n${text.trim()}\n[End of task]`
    : `\n\n[Task]\n${text.trim()}\n[End of task]`));
};

/**
 * @param {{ prompts: Map<string, string>, sources: { label: string, reply: string }[] }} input
 */
export function answersPrompt({ prompts, sources }) {
  return [
    FUSION_INSTRUCTIONS,
    ...taskBlocks(prompts),
    ...sources.map((s, i) => `\n\n[Result ${i + 1} · ${s.label}]\n${s.reply}\n[End of result ${i + 1}]`),
    "\n\n=== END OF INPUTS ===\nWrite the final answer now.",
    `\n\n${FUSION_VISIBLE}`,
  ].join("");
}

/**
 * @param {{ baseCommit: string, prompts: Map<string, string>, sources: { label: string, reply: string, snapshot: { commit: string, head: string }, diff: { files: number, insertions: number, deletions: number } | null, diffText?: string }[] }} input
 */
export function codePrompt({ baseCommit, prompts, sources }) {
  return [
    codeInstructions(baseCommit, sources.length),
    ...taskBlocks(prompts),
    ...sources.map((s, i) => {
      const stat = s.diff ? `${s.diff.files} files, +${s.diff.insertions} −${s.diff.deletions}` : "unknown";
      const lines = [
        `\n\n[Attempt ${i + 1} · ${s.label}]`,
        `Snapshot: ${s.snapshot.commit}`,
        `Started at: ${s.snapshot.head}`,
        `Changes: ${stat}`,
        "Its final answer:",
        s.reply,
      ];
      if (s.diffText) lines.push("Its diff:", s.diffText);
      lines.push(`[End of attempt ${i + 1}]`);
      return lines.join("\n");
    }),
    "\n\n=== END OF INPUTS ===\nBuild the combined result in this worktree now.",
    `\n\n${FUSION_VISIBLE}`,
  ].join("");
}
