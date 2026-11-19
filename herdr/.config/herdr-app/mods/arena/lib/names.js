// Names a run hands out: its slug, its lanes' labels, branches and folders.

/**
 * A new member id: one more than any id the run has ever handed out, so an
 * archived lane's snapshot ref is never reused. `seq` is that high-water mark.
 */
export function nextMemberId(run) {
  const seen = (run.members ?? []).map((m) => Number(String(m.id).slice(1)) || 0);
  const seq = Math.max(run.seq ?? 0, 0, ...seen) + 1;
  return { id: `l${seq}`, seq };
}

/** Which variant stays shown after one is removed: the one being edited, wherever it moved. */
export function activeAfterRemoval(active, removed, countAfter) {
  const next = removed < active ? active - 1 : active;
  return Math.max(0, Math.min(next, countAfter - 1));
}

/** Seed for branch and folder names: "Fix the login bug!" → "fix-the-login-bug". */
export function slugify(text, fallback = "run") {
  const slug = String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || fallback;
}

/** A title from the prompt's first line when the person gave none. */
export function titleFromPrompt(prompt, fallback = "Parallel run") {
  const line = String(prompt ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  if (!line) return fallback;
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
}

/** Variant names: g1, g2 … are shown as A, B … */
export const variantLabel = (index) => String.fromCharCode(65 + index);

/**
 * "Claude Code", "Claude Code #2", "Codex · B": the agent, its repeat number
 * when the same agent runs more than once on a variant, and the variant when
 * there are several.
 */
export function laneLabel(member, variantCount) {
  const repeat = member.index > 1 ? ` #${member.index}` : "";
  const variant = variantCount > 1 && member.role !== "fusion" ? ` · ${member.variant}` : "";
  const name = member.agent?.name ?? "Agent";
  return member.role === "fusion" ? `Fusion · ${name}` : `${name}${repeat}${variant}`;
}

/**
 * The next repeat number for an agent on a variant. `retired` are lanes that
 * left the run but kept their branch (detached), so their numbers stay taken.
 */
export function nextIndex(members, variant, agentKey, retired = []) {
  const same = [...members, ...retired].filter((m) => m.role === "run" && m.variant === variant && m.agent?.key === agentKey);
  return same.reduce((n, m) => Math.max(n, m.index ?? 1), 0) + 1;
}

/** A lane's branch: arena/<slug>/<agent>-<n>, or arena/<slug>/<agent>-<n>-b for variant B. */
export function laneBranch(slug, member) {
  const variant = member.variant && member.variant !== "A" ? `-${member.variant.toLowerCase()}` : "";
  return `arena/${slug}/${slugify(member.agent?.key ?? "agent", "agent")}-${member.index ?? 1}${variant}`;
}

/** Where a lane's checkout goes, next to Herdr's own worktrees. */
export const worktreePath = (root, repoName, branch) => `${root}/${repoName}/${branch.replace(/\//g, "-")}`;

/** Splits a typed command like a shell would, for quotes and backslashes. */
export function splitCommand(text) {
  const out = [];
  let word = "", quote = null, any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < text.length && '$`"\\\n'.includes(text[i + 1])) word += text[++i];
      else word += c;
    } else if (c === "'" || c === '"') { quote = c; any = true; }
    else if (c === "\\" && i + 1 < text.length) { word += text[++i]; any = true; }
    else if (/\s/.test(c)) { if (word || any) out.push(word); word = ""; any = false; }
    else { word += c; any = true; }
  }
  if (word || any) out.push(word);
  return out;
}

/**
 * Agents whose trailing argument is not a first message take it with a flag:
 * `opencode merhaba` opens a folder named "merhaba".
 */
const PROMPT_FLAGS = { opencode: "--prompt" };

/**
 * How a lane's agent gets its task: `{ argv, task }` for `tab.new`. Herdr
 * appends `task` as the last argument, which most agents read as their first
 * message; the ones in PROMPT_FLAGS get it in argv with their flag instead.
 */
export function agentWithTask(agentArgv, task) {
  const flag = PROMPT_FLAGS[String(agentArgv[0] ?? "").split("/").pop()];
  if (!flag || !task || agentArgv.includes(flag)) return { argv: agentArgv, task };
  return { argv: [...agentArgv, flag, task], task: undefined };
}

/**
 * The argv a lane starts with. Setup commands run first, in the lane's
 * folder; `exec "$@"` then replaces that shell with the agent, so the task
 * Herdr appends lands as the agent's first message.
 */
export function laneArgv(agentArgv, setupCommands) {
  const setup = (setupCommands ?? []).map((c) => c.trim()).filter(Boolean);
  if (!setup.length) return agentArgv;
  return ["sh", "-c", `set -e\n${setup.join("\n")}\nexec "$@"`, "arena-setup", ...agentArgv];
}
