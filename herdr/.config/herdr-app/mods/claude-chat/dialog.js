// Reads Claude Code's dialogs from a terminal screen. No Herdr imports, so `node --test` can load this file.
// The screen is data: this only ever returns words to draw and numbers a press may send.
//
// A wrong card is the worst failure in the chat pane, so every reader here is strict. A dialog has to match its shape
// from the bottom line up, and has to agree with the status report. Anything else returns { kind: "terminal", reason },
// which means use the terminal. A tall dialog's top scrolls off the screen, which reads as "cut off". Only then is it
// worth reading again with history (`hc read <t> --lines N`), because that read can take 25 s.

const RULE = "─";
const DASH = "╌";
const CURSOR = "❯";

const REASONS = ["plan", "multi-select", "preview", "unreadable", "cut off", "not drawn"];
const terminal = (reason) => ({ kind: "terminal", reason });

// Reasons that can't change by reading again. The others may be a screen that's still drawing.
export const isFinal = (result) => result.kind === "terminal" && REASONS.slice(0, 3).includes(result.reason);

const PERMISSION_FOOT = /^Esc to cancel( · Tab to amend)?$/;
const QUESTION_FOOT = /^Enter to select · (↑\/↓ to navigate|Tab\/Arrow keys to navigate) · Esc to cancel$/;
const TAB_ROW = /^\s*(←\s+)?[☐☒]\s/;
const TICK_BOX = /^\[.\]\s/;
const TIP = /^Tip: .*? below\s*/;

// The tools with a saved real screen. Any other prompt goes to the terminal until it has one.
// `report` is every name the status report gives that tool, and `ask` the question it ends on.
const TOOLS = {
  "Bash command": { tool: "Bash", report: ["Bash"], ask: /^Do you want to proceed\?$/, body: "command" },
  "Create file": { tool: "Write", report: ["Write"], ask: /^Do you want to create .+\?$/, body: "file" },
  "Edit file": { tool: "Edit", report: ["Edit", "Update"], ask: /^Do you want to make this edit to .+\?$/, body: "file" },
};

// `hc read` adds a line of its own after the screen when its history runs out, so that line isn't part of the dialog.
const screenLines = (text) => {
  const lines = String(text).split("\n").map((l) => l.trimEnd());
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (lines[lines.length - 1]?.startsWith("[hc] incomplete:")) lines.pop();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines;
};

const length = (line) => [...line].length;
const isRule = (line, mark) => line.length >= 20 && [...line].every((c) => c === mark);
const squeeze = (text) => text.replace(/\s+/g, "");
const same = (a, b) => squeeze(a) === squeeze(b);

// A rule runs the terminal's full width, so it gives the width without being told.
const widthOf = (lines) => Math.max(0, ...lines.filter((l) => isRule(l, RULE)).map(length));
const reaches = (line, width) => width > 0 && length(line) >= width - 1;

// Whether a line that reaches the edge was cut mid-word. Claude Code only cuts a word too long to fit on a line by
// itself, so a word that would have fitted was wrapped at a space.
function cut(line, next, width) {
  const last = line.trim().split(/\s/).pop(), first = next.trim().split(/\s/)[0];
  return length(last) + length(first) > width - (length(next) - length(next.trimStart()));
}

function unwrap(lines, width) {
  let out = "";
  lines.forEach((line, i) => {
    const glued = i === 0 || (reaches(lines[i - 1], width) && cut(lines[i - 1], line, width));
    out += (glued ? "" : " ") + line.trim();
  });
  return out;
}

// Rows of a numbered list, read top down. `row` matches one row, and any line that isn't a row carries on the last one.
function numbered(lines, row) {
  const rows = [];
  for (const line of lines) {
    const m = row.exec(line);
    if (m) rows.push({ key: m[2], cursor: Boolean(m[1]), lines: [m[3]], raw: [line] });
    else if (!rows.length || !/^\s{4,}\S/.test(line)) return null;
    else { rows[rows.length - 1].lines.push(line.trim()); rows[rows.length - 1].raw.push(line); }
  }
  const counted = rows.every((r, i) => r.key === String(i + 1));
  return rows.length && counted && rows.filter((r) => r.cursor).length === 1 ? rows : null;
}

// What the status report says, or null when it's only the generic text.
function reported(report) {
  const msg = report?.msg ?? "";
  const approve = /^approve (\w+)(?:: ([\s\S]*))?$/.exec(msg);
  if (approve) return { tool: approve[1], what: approve[2] ?? null };
  if (msg.startsWith("answer: ") && msg.endsWith(")")) return { answer: msg.slice("answer: ".length) };
  return null;
}

// `<question> (<a> · <b>)`. Both can hold brackets, so only the question on the screen says where one ends.
function splitAnswer(answer, asked) {
  for (let at = answer.indexOf(" ("); at >= 0; at = answer.indexOf(" (", at + 1)) {
    if (same(answer.slice(0, at), asked)) return { question: answer.slice(0, at), labels: answer.slice(at + 2, -1).split(" · ") };
  }
  return null;
}

// The report ends a long command with an ellipsis, so only what it shows has to match.
function agrees(whole, shown) {
  const cut = shown.endsWith("…");
  return cut ? squeeze(whole).startsWith(squeeze(shown.slice(0, -1))) : same(whole, shown);
}

// What Claude Code says between a command and the question, in its own words: `This command requires approval`, or a
// warning in a box when it's long. A blank line sets it off from the question. Null is nothing there, undefined a shape
// that hasn't been seen.
function reasonOf(block, width) {
  if (!block.length) return null;
  if (block[block.length - 1] || !block.every((l) => !l || l.startsWith(" "))) return undefined;
  return unwrap(block.filter(Boolean).map((l) => l.replace(/^ │ ?/, "")), width - 3);
}

// Read from the bottom up: the foot, the options, the question, any reason, then the box. A command's own text sits inside
// the box and is indented, and a rule starts at the left edge, so nothing a command holds can pose as any of these. Options
// are only ever the rows straight under the question.
function permission(lines, report) {
  const foot = lines.length - 1;
  let ask = foot - 1;
  while (ask >= 0 && !/^ Do you want .+\?$/.test(lines[ask])) ask--;
  let close = ask - 1;
  while (close >= 0 && !isRule(lines[close], DASH) && !isRule(lines[close], RULE)) close--;
  if (close < 1 || !isRule(lines[close], DASH)) return terminal("unreadable");

  let top = close - 1;
  while (top >= 0 && !isRule(lines[top], RULE)) top--;
  if (top < 0) return terminal("cut off");

  const shape = TOOLS[lines[top + 1]?.trim()];
  const question = lines[ask].trim();
  if (!shape || !shape.ask.test(question)) return terminal("unreadable");

  const open = lines.findIndex((l, i) => i > top && isRule(l, DASH));
  if (open >= close - 1) return terminal("unreadable");

  const rows = numbered(lines.slice(ask + 1, foot).filter(Boolean), /^ (?:(❯) |  )(\d+)\. (.*)$/);
  if (!rows) return terminal("unreadable");

  const says = reported(report);
  if (says && !shape.report.includes(says.tool)) return terminal("unreadable");

  const width = widthOf(lines);
  const header = lines.slice(top + 2, open).filter(Boolean);
  const raw = lines.slice(open + 1, close);
  const reason = shape.body === "command" ? reasonOf(lines.slice(close + 1, ask), width) : close === ask - 1 ? null : undefined;
  if (reason === undefined) return terminal("unreadable");
  let body, why = null, target = null;
  if (shape.body === "command") {
    body = commandBody(raw, width, says?.what);
    if (body === null || (says?.what && !agrees(body, says.what))) return terminal("unreadable");
    why = unwrap(header, width).replace(TIP, "") || null;
  } else {
    body = raw.join("\n");
    const shown = unwrap(header, width).replace(TIP, "");
    const tail = shown.replace(/^…/, "");
    if (!tail || (says?.what && !squeeze(says.what).endsWith(squeeze(tail)))) return terminal("unreadable");
    target = says?.what ?? shown;
  }

  const options = rows.map((r) => ({ key: r.key, label: unwrap(joinable(r), width) }));
  return card({ kind: "permission", tool: shape.tool, title: question, why, reason, target, body, bodyKind: shape.body, options });
}

const joinable = (row) => [row.raw[0].replace(/^\s*(❯\s*)?\d+\.\s/, (m) => " ".repeat(length(m))), ...row.raw.slice(1)];

// A command with a line break, or over 80 columns, has a box mark on every line. Any other has no mark, and fills more than
// one line only in a narrow split. With no mark, the report has to name the command, so it can be held to that.
function commandBody(raw, width, named) {
  const boxed = raw.filter((l) => l.startsWith(" │")).length;
  if (boxed === raw.length) return commandText(raw, width);
  return !boxed && named && raw.every(Boolean) ? unwrap(raw, width) : null;
}

// A command's lines, without the box. A line that reaches the edge carries on, and any other ends where it did.
function commandText(raw, width) {
  const text = raw.map((l) => l.replace(/^ │ ?/, ""));
  let out = text[0] ?? "";
  for (let i = 1; i < raw.length; i++) {
    if (!reaches(raw[i - 1], width)) out += "\n";
    else if (!cut(text[i - 1], text[i], width - 3)) out += " ";
    out += text[i];
  }
  return out;
}

function tabsOf(line) {
  const cells = line.replace(/^\s*←\s+/, "").replace(/\s+→$/, "").trim().split(/\s{2,}/);
  const tabs = cells.filter((c) => !c.startsWith("✔")).map((c) => ({ label: c.slice(1).trim(), answered: c.startsWith("☒") }));
  return { tabs, submit: cells.some((c) => c === "✔ Submit") };
}

// The nearest tab row with a rule straight above it, so a question's own text can't pose as one.
function tabRow(lines) {
  for (let i = lines.length - 1; i > 0; i--) if (TAB_ROW.test(lines[i]) && isRule(lines[i - 1], RULE)) return i;
  return -1;
}

function questionRows(lines) {
  const rows = [];
  let at = lines.length - 1;
  while (at >= 0) {
    const m = /^(?:(❯) |  )(\d+)\. (.*)$/.exec(lines[at]);
    if (m) {
      rows.unshift(at);
      if (m[2] === "1") return rows;
    }
    at--;
  }
  return null;
}

function question(lines, report) {
  const foot = lines.length - 1;
  const row = tabRow(lines);
  if (row < 0) return terminal("cut off");
  const below = lines.slice(row + 1, foot);
  while (below.length && !below[below.length - 1]) below.pop();
  if (below.some((l) => TICK_BOX.test(l.replace(/^(❯ |  )\d+\. /, "")) && /^(❯ |  )\d+\. /.test(l))) return terminal("multi-select");
  if (!QUESTION_FOOT.test(lines[foot].trim())) return terminal(/n to add notes/.test(lines[foot]) ? "preview" : "unreadable");

  const starts = questionRows(below);
  if (!starts) return terminal("unreadable");
  const first = starts[0];
  const list = below.slice(first).filter((l) => l && !isRule(l, RULE));
  const rows = numbered(list, /^(?:(❯) |  )(\d+)\. (.*)$/);
  if (!rows || rows.length < 3) return terminal("unreadable");
  if (!isRule(below[below.length - 2] ?? "", RULE) || rows[rows.length - 1].lines[0] !== "Chat about this") return terminal("unreadable");
  if (rows[rows.length - 2].lines[0] !== "Type something.") return terminal("unreadable");

  const { tabs, submit } = tabsOf(lines[row]);
  if (!tabs.length || (submit && tabs.length < 2)) return terminal("unreadable");

  const width = widthOf(lines);
  const text = below.slice(0, first).filter(Boolean).map((l) => l.replace(/^│ ?/, ""));
  if (!text.length) return terminal("unreadable");
  let asked = unwrap(text, width);

  const says = reported(report);
  const match = says?.answer ? splitAnswer(says.answer, asked) : null;
  if (match) asked = match.question;
  else if (!submit && says?.answer) return terminal("unreadable");

  const choices = rows.slice(0, -2);
  const labels = match?.labels.length === choices.length ? match.labels : null;
  if (match && !labels) return terminal("unreadable");
  const options = [];
  for (let i = 0; i < choices.length; i++) {
    const option = choiceOf(choices[i], labels?.[i] ?? null, width);
    if (!option) return terminal("unreadable");
    options.push(option);
  }
  const typing = rows.slice(-2).map((r) => ({ key: r.key, label: r.lines[0].replace(/\.$/, "") }));
  return card({
    kind: "question", question: asked, options, typing,
    tabs: submit ? tabs : null, step: submit ? tabs.findIndex((t) => !t.answered) : 0, tab: submit ? null : tabs[0].label,
  });
}

// One choice: its label, the note under it, and whether it's the answer already given. With a label from the report,
// that decides where the label ends. Without one, the first line is the label.
function choiceOf(row, label, width) {
  const first = row.lines[0].replace(/\s*✔$/, "");
  const chosen = first !== row.lines[0];
  const rest = row.raw.slice(1);
  if (!label) return { key: row.key, label: first, note: unwrap(rest, width) || null, chosen };
  for (let n = 0; n <= rest.length; n++) {
    if (same(`${first}${rest.slice(0, n).join("")}`, label)) return { key: row.key, label, note: unwrap(rest.slice(n), width) || null, chosen };
  }
  return null;
}

function review(lines) {
  const row = tabRow(lines);
  if (row < 0) return terminal("unreadable");
  const body = lines.slice(row + 1).filter(Boolean);
  const { tabs, submit } = tabsOf(lines[row]);
  const rows = numbered(body.slice(-2), /^(?:(❯) |  )(\d+)\. (.*)$/);
  if (!submit || !rows || body[0] !== "Review your answers" || body[body.length - 3] !== "Ready to submit your answers?") return terminal("unreadable");
  if (rows[0].lines[0] !== "Submit answers" || rows[1].lines[0] !== "Cancel") return terminal("unreadable");

  const width = widthOf(lines);
  const answers = [];
  for (const line of body.slice(1, -3)) {
    if (line.startsWith(" ● ")) answers.push({ question: [line], answer: [] });
    else if (!answers.length) return terminal("unreadable");
    else if (line.startsWith("   → ") || answers[answers.length - 1].answer.length) answers[answers.length - 1].answer.push(line);
    else answers[answers.length - 1].question.push(line);
  }
  if (answers.length !== tabs.length || answers.some((a) => !a.answer.length)) return terminal("unreadable");
  return card({
    kind: "review", tabs,
    answers: answers.map((a, i) => ({
      tab: tabs[i].label,
      question: unwrap(a.question, width).replace(/^● /, ""),
      answer: unwrap(a.answer, width).replace(/^→ /, ""),
    })),
    options: rows.map((r) => ({ key: r.key, label: r.lines[0] })),
  });
}

// `key` names the dialog: its words, with the spacing gone, so the same dialog at another width is still the same.
function card(fields) {
  const { why, reason, tool, title, target, body, question: asked, options, tabs, answers } = fields;
  const words = [fields.kind, tool, title, why, reason, target, body, asked, options.map((o) => [o.key, o.label]), tabs, answers];
  return { ...fields, key: squeeze(JSON.stringify(words)) };
}

// A question's last line wraps in a narrow split, so it's put back together first.
function joinFoot(lines) {
  const n = lines.length;
  if (n < 2 || !/^Enter to select /.test(lines[n - 2].trim())) return lines;
  return [...lines.slice(0, n - 2), `${lines[n - 2]} ${lines[n - 1].trim()}`];
}

// `text` is `hc read` output, and `report` the terminal's report: { kind, msg }.
export function parseDialog(text, report) {
  const lines = joinFoot(screenLines(text));
  const kind = report?.kind;
  if (!lines.length || (kind !== "permission" && kind !== "question")) return terminal("unreadable");
  if (report.msg === "approve plan") return terminal("plan");
  const last = lines[lines.length - 1].trim();
  if (kind === "permission") return PERMISSION_FOOT.test(last) ? permission(lines, report) : terminal("not drawn");
  if (/^(❯ |  )2\. Cancel$/.test(lines[lines.length - 1])) return review(lines);
  return /Esc to cancel/.test(last) ? question(lines, report) : terminal("not drawn");
}

export const isCard = (result) => result.kind !== "terminal";

// A press reads the screen again first. It goes through only while the session is blocked on the very dialog the card
// shows, and only for a key that dialog still offers. `press` is an option's key, "esc", or "left" or "right" between steps.
export function checkPress(shown, fresh, status, press) {
  if (status !== "blocked" || !fresh || !isCard(fresh) || fresh.key !== shown.key) return { send: null };
  if (press === "esc") return { send: fresh.kind === "review" ? null : "esc" };
  if (press === "left" || press === "right") return { send: fresh.tabs ? press : null };
  return { send: fresh.options.some((o) => o.key === press) ? press : null };
}

// The presses from one step of a several-question dialog to another. Submit is the step after the last question.
export function stepKeys(from, to) {
  return Array.from({ length: Math.abs(to - from) }, () => (to > from ? "right" : "left"));
}

// How long to go on reading a screen with no dialog on it. The status can turn blocked well before the dialog is drawn,
// because hooks run first, so this has to outlast slow hooks.
export const DRAW_MS = 30000;
// How long a dialog that's there but can't be read gets, in case it was caught mid-draw.
export const READ_MS = 3000;
// How long a dialog stays up after a press lands. The status stays blocked and the screen doesn't change for seconds,
// so a card over that dialog would take a second press. If it's still there after this, the press didn't land.
export const HOLD_MS = 20000;

export const idle = { phase: "idle", card: null };

// Where the card stands after a read. `read` is what parseDialog returned. `swap` means go to the terminal, and comes
// once per dialog, so nobody who comes back to the chat is sent away again. A read that changes nothing answers the same
// `state`, because a new one asks for a render, and this runs on every poll.
export function follow(state, { status, read }, now) {
  if (status !== "blocked") return { state: idle };
  if (!read) return { state };
  // The dialog leaving the screen means the press landed. So the same dialog drawn again after that is a new one, such as
  // the same command asked twice, and shows as a card. A status that isn't blocked has already let go, above.
  if (state.phase === "pressed" && now - state.at < HOLD_MS) {
    if (read.reason === "not drawn") return { state: state.gone ? state : { ...state, gone: true } };
    const moved = isCard(read) ? read.key !== state.key || Boolean(state.gone) : isFinal(read);
    if (!moved) return { state };
  }
  if (isCard(read)) {
    if (state.phase === "card" && state.card?.key === read.key) return { state };
    return { state: { phase: "card", card: state.card?.key === read.key && !state.gone ? state.card : read } };
  }
  if (state.phase === "terminal") return { state };
  const since = state.phase === "waiting" ? state.since : now;
  if (isFinal(read) || now - since >= (read.reason === "not drawn" ? DRAW_MS : READ_MS)) return { state: { phase: "terminal", card: null, reason: read.reason }, swap: true };
  if (state.phase === "waiting" && state.reason === read.reason) return { state };
  return { state: { phase: "waiting", card: null, since, reason: read.reason } };
}

// After a press lands. A card with steps stays up, dimmed, until the next step is on the screen.
export const pressed = (card, now) => ({ phase: "pressed", card: card.tabs ? card : null, key: card.key, at: now });

// The commands that show the terminal, or null when the chat isn't the focused pane: `pane.focus` would pull the window
// to another tab. A chat side by side with its terminal only moves focus, because a second zoom undoes a zoom.
export function terminalSteps(panes, pairs, terminal) {
  const term = panes.find((p) => p.terminal === terminal);
  if (!term) return null;
  const chats = panes.filter((p) => p.mod === "claude-chat" && p.tab === term.tab);
  const chat = chats.find((p) => pairs[p.pane] === terminal) ?? (chats.length === 1 ? chats[0] : null);
  if (!chat?.focused) return null;
  return [...(chat.zoomed ? [["pane.zoom", { pane: term.pane }]] : []), ["pane.focus", { pane: term.pane }]];
}
