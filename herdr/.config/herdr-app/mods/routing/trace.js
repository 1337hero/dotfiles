// Magpie's routing trace, kept in the same terms as its Routing page.

export const PALETTE = ["#d97757", "#bd8638", "#a59234", "#849e4a", "#5aa66c", "#25a98f", "#00a6b0", "#2e9fc9", "#5e95d7", "#858ad7", "#a47fca", "#bb77b1"];
const HUES = { claude: 0, "claude-code": 0, codex: 9, gemini: 7, copilot: 10, cursor: 5, opencode: 2, crush: 11, goose: 3, pi: 4, omp: 11, omo: 10, dsh: 6, commandcode: 1, mimocode: 8, deveco: 7 };
const NAMES = { "claude-code": "Claude Code", claude: "Claude", codex: "Codex", pi: "Pi", omp: "OpenCode", opencode: "OpenCode", gemini: "Gemini CLI", cursor: "Cursor", copilot: "Copilot", goose: "Goose", crush: "Crush", other: "your agent" };

export function normalize(r) {
  r.order ||= [];
  r.tries ||= [];
  r.left ||= [];
  return r;
}

export const sourceOf = (r) => r.callerKey ? `${r.agent}\u0001${r.callerKey}` : r.agent || "other";
export const agentName = (id) => NAMES[id] || id || "your agent";
export const callerName = (r) => r.callerKeyName || agentName(r.agent);
export const accountName = (w) => w.kind === "provider" ? w.name : w.who || w.name || w.provider;
export const seat = (w) => `${w.id}\u0000${w.model || ""}${w.fixed ? `:${w.fixed}` : ""}`;
export const tryOk = (tr) => tr.status < 400 && !tr.fail;
export const activeTry = (r) => r.tries.find((tr) => !tr.done);

export function triedSeat(r, tr) {
  const w = r.order.find((x) => seat(x) === seat(tr))
    || r.order.find((x) => x.id === tr.id && (x.model || "") === (tr.model || ""))
    || r.order.find((x) => x.id === tr.id);
  return seat(w || tr);
}

export function hueOf(id, given = new Map(), near = new Set()) {
  const known = given.get(id);
  if (known && !near.has(known)) return known;
  let h = HUES[id];
  if (h == null) {
    h = 0;
    for (const ch of String(id || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  }
  const used = new Set(given.values());
  let index = 0;
  while (index < PALETTE.length && (used.has(PALETTE[(h + index) % PALETTE.length]) || near.has(PALETTE[(h + index) % PALETTE.length]))) index++;
  const color = PALETTE[(h + index) % PALETTE.length];
  given.set(id, color);
  return color;
}

export function stagedRoutes(routes, current, now) {
  const all = [...routes.values()].sort((a, b) => a.id - b.id);
  const last = new Map();
  for (const r of all) last.set(sourceOf(r), r);
  const out = all.filter((r) => !r.done || (last.get(sourceOf(r)) === r && Date.parse(r.time) + (r.ms || 0) > now - 12000));
  if (current && !out.some((r) => r.id === current.id)) out.push(current);
  const agents = [...new Set(out.map(sourceOf))].slice(-4);
  return out.filter((r) => agents.includes(sourceOf(r))).sort((a, b) => a.id - b.id);
}

export function accountState(r, w) {
  const id = seat(w);
  const tries = r.tries.filter((tr) => triedSeat(r, tr) === id);
  const active = tries.find((tr) => !tr.done);
  const answered = tries.some((tr) => tr.done && tryOk(tr));
  const failed = [...tries].reverse().find((tr) => tr.done && !tryOk(tr));
  let status = "API key";
  if (active) status = "answering…";
  else if (answered) status = "answered this request";
  else if (failed) status = `${failed.status || "Error"} · ${failWord(failed.fail)}${r.done && failed === r.tries[r.tries.length - 1] ? "" : " · went on to the next"}`;
  else if (w.rest && Date.parse(w.rest.until) > Date.now()) status = `${failWord(w.rest.why)} · resting`;
  else if (w.unlisted) status = "not listed for this model";
  else if (w.free) status = "free · costs nothing";
  else if (w.known) status = `${Math.round(w.used || 0)}% used`;
  else if (w.kind === "account") status = "what’s left not known yet";
  else if (w.routing === "usage") status = `${Math.round(w.tokens || 0).toLocaleString()} tokens lately`;
  else if (w.kind === "provider") status = "one key";
  if (active && r.bytes) status += ` · ${formatBytes(r.bytes)}`;
  return { active: Boolean(active), answered, failed, status };
}

export function failWord(why) {
  return ({ rate: "rate limited", credit: "out of credit", quota: "quota used up", auth: "sign-in required", canceled: "canceled", overloaded: "servers overloaded", offline: "network down", refused: "refused (safety filter)", shape: "request not understood", restricted: "account restricted by the vendor" })[why] || "failed";
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

export function modeOf(r) {
  const first = r.order.find((w) => !w.fallback) || r.order[0];
  const routing = r.group?.routing || first?.routing || "";
  const names = { "": "Smart", order: "In order", drain: "Until used up", rotate: "In turn", usage: "Least used", pace: "Use before expiry", manual: "Manual", weight: "By weight", free: "Free first", cheap: "Cheapest first", expiring: "Free quota by expiry", fast: "Speed first" };
  const descriptions = {
    "": "Smart: of the accounts with quota to spare, the one whose allowance renews soonest goes first. One resting after a failure goes last.",
    order: "In order: the first answers everything until it can’t; then the next.",
    rotate: "In turn: each conversation’s next turn goes to the account after the one that answered its last.",
    usage: "Least used first: the account with the most allowance left goes first; a key by the tokens magpie sent it lately.",
    weight: "Requests spread over the keys or accounts by their weights, evenly over a few requests.",
    free: "Requests go to what costs nothing first, then to a paid account only when none can answer.",
    cheap: "Cheapest first: the model that costs least now goes first.",
    fast: "Speed first: the account that answered fastest lately goes first.",
  };
  return { name: names[routing] || routing, description: descriptions[routing] || descriptions[""], first };
}

export function caption(r) {
  if (!r) return "Every request an agent sends to magpie shows up here, routed for real.";
  const first = r.order[0];
  if (!first) return r.done ? r.error || `Nothing could take ${r.model}.` : "magpie hasn’t routed this request yet, so who takes it isn’t picked yet.";
  const who = accountName(first);
  if (r.order.length === 1) return first.kind === "account" ? `${who} is the only account on for ${r.model} — nothing to choose between.` : `${first.name} has one key on — nothing to choose between.`;
  const active = activeTry(r);
  if (active) return `${who} goes first. A magpie is carrying the request to ${accountName(r.order.find((w) => seat(w) === triedSeat(r, active)) || first)}.`;
  if (r.done && r.status >= 400) return `${callerName(r)} received ${r.status}: ${failWord(r.fail)}.`;
  if (r.done) return `${callerName(r)}’s request was answered by ${r.served || r.model}.`;
  return `${who} goes first; routing weighed ${r.order.length} accounts or keys for ${r.model}.`;
}

export function routeStatus(r) {
  if (!r.done) return "Routing";
  if (r.canceled) return "Canceled";
  if (r.status >= 400 || r.fail) return `${r.status || "Error"} · ${failWord(r.fail)}`;
  return `${r.status || 200} · answered`;
}
