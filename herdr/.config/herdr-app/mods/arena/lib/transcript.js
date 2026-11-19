// A lane's latest answer. Claude Code and Codex write JSONL transcripts;
// Arena reads their tail. OpenCode exports its session as JSON on request.
// Other agents have no transcript Arena knows, so their card shows the end
// of the terminal screen instead, marked as such.

/** Claude Code names a project folder after its cwd, every character but letters and digits as "-". */
export const claudeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

const isPrompt = (record) => {
  if (record?.type !== "user" || record.isSidechain || record.isMeta) return false;
  const content = record.message?.content;
  if (typeof content === "string") return !/^\s*<(command-name|local-command-stdout|local-command-caveat)>/.test(content);
  return Array.isArray(content) && content.some((block) => block?.type === "text");
};

const textOf = (record) => {
  const content = record.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n\n");
};

/**
 * The last answer of the last turn: the text of the newest assistant message
 * that has any, after the newest prompt. Claude Code writes one record per
 * content block, so the records sharing that message's id are joined.
 * Returns "" when the turn has no text yet, and null without any turn.
 *
 * @param {string} jsonl
 * @returns {string | null}
 */
export function lastAnswer(jsonl) {
  const records = [];
  for (const line of String(jsonl ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* a line cut by tail, or one being written */ }
  }
  let start = -1;
  for (let i = records.length - 1; i >= 0; i--) if (isPrompt(records[i])) { start = i; break; }
  const turn = records.slice(start + 1).filter((r) => r?.type === "assistant" && !r.isSidechain);
  if (start < 0 && turn.length === 0) return null;
  let last = -1;
  for (let i = turn.length - 1; i >= 0; i--) if (textOf(turn[i]).trim()) { last = i; break; }
  if (last < 0) return "";
  const id = turn[last].message?.id;
  const parts = [];
  for (let i = last; i >= 0; i--) {
    const record = turn[i];
    if (id ? record.message?.id !== id : i !== last) break;
    const text = textOf(record);
    if (text.trim()) parts.unshift(text);
  }
  return parts.join("\n\n").trim();
}

// ---- Codex ----------------------------------------------------------------

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };

/**
 * Where a Codex session ran and when it began, from its rollout file's first
 * line: { cwd, at } or null.
 */
export function codexSessionMeta(firstLine) {
  const record = parse(firstLine);
  if (record?.type !== "session_meta" || typeof record.payload?.cwd !== "string") return null;
  const at = Date.parse(record.payload.timestamp ?? record.timestamp ?? "");
  return { cwd: record.payload.cwd, at: Number.isFinite(at) ? at : 0 };
}

/**
 * The last answer of a Codex rollout's last turn, read like Claude Code's:
 * the newest agent message after the newest user message. "" while the turn
 * has no text yet, null without any turn.
 *
 * @param {string} jsonl
 * @returns {string | null}
 */
export function codexLastAnswer(jsonl) {
  let seen = false, answer = "";
  for (const line of String(jsonl ?? "").split("\n")) {
    if (!line.trim()) continue;
    const record = parse(line);
    const payload = record?.type === "event_msg" ? record.payload : null;
    if (payload?.type !== "item_completed") continue;
    const item = payload.item;
    if (item?.type === "UserMessage") { seen = true; answer = ""; }
    else if (item?.type === "AgentMessage") {
      seen = true;
      const text = (Array.isArray(item.content) ? item.content : [])
        .filter((block) => typeof block?.text === "string").map((block) => block.text).join("\n\n").trim();
      if (text) answer = text;
    }
  }
  return seen ? answer : null;
}

// ---- OpenCode -------------------------------------------------------------

/**
 * The lane's session among `opencode session list --format json`: the newest
 * one in `dir` that began after the lane started (with a little slack), or null.
 */
export function opencodeSessionFor(listJson, dir, since) {
  const list = parse(listJson);
  if (!Array.isArray(list)) return null;
  let best = null;
  for (const s of list) {
    if (s?.directory !== dir || typeof s.id !== "string" || !(s.created >= since)) continue;
    if (!best || s.created > best.created) best = s;
  }
  return best?.id ?? null;
}

/**
 * The last answer of an `opencode session export`: the text of the newest
 * assistant message that has any, after the newest user message. Reasoning
 * and tool blocks are not the answer. "" while the turn has no text yet,
 * null without any turn.
 */
export function opencodeLastAnswer(exportJson) {
  const messages = parse(exportJson)?.messages;
  if (!Array.isArray(messages)) return null;
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.type === "user") { start = i; break; }
  if (start < 0) return null;
  for (let i = messages.length - 1; i > start; i--) {
    const m = messages[i];
    if (m?.type !== "assistant" || !Array.isArray(m.content)) continue;
    const text = m.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n\n").trim();
    if (text) return text;
  }
  return "";
}

// ---- any other agent: the screen -----------------------------------------

/** An agent's input line: Codex's `› Ask Codex…`, Claude Code's `❯`, inside a box or not. */
const INPUT_LINE = /^\s*[│|]?\s*[›❯]\s?/;
/** How far up from the bottom an input line counts as the agent's own chrome. */
const CHROME_ROWS = 6;

/**
 * The end of a screen, without trailing blank lines or prompt chrome: what a
 * card can show. An input line near the bottom, and the status lines under
 * it, belong to the agent's UI, not its answer.
 */
export function screenTail(text, lines = 24) {
  const rows = String(text ?? "").replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  const trim = () => { while (rows.length && !rows[rows.length - 1]) rows.pop(); };
  trim();
  let filled = 0;
  for (let i = rows.length - 1; i >= 0 && filled < CHROME_ROWS; i--) {
    if (!rows[i]) continue;
    filled++;
    if (INPUT_LINE.test(rows[i])) {
      // A box's top border sits right above its input line.
      const top = i > 0 && /^\s*[╭┌─]/.test(rows[i - 1]) ? i - 1 : i;
      rows.length = top;
      break;
    }
  }
  trim();
  return rows.slice(-lines).join("\n").trim();
}
