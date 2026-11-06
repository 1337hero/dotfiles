// The usage panel's data: the headless /usage text, with its limits, and the Stats figures.
// No Herdr imports, so `node --test` can load this file.
import { runHeadless } from "./slash.js";

// ---- limits ----

// The bars at the top of the panel, from the limit lines of the headless /usage text. A plan without a limit has no line
// for it, so it gets no bar. The colour goes by how much is used, and the time zone comes off the reset to fit under a bar.
const toneOf = (used) => (used < 80 ? "done" : used < 100 ? "ansi3" : "blocked");
export const limitMeters = (limits) => (limits ?? []).map(({ label, used, resets }) => ({ label, used, tone: toneOf(used), resets: resets?.replace(/\s*\([^)]*\)\s*$/, "") ?? null }));

// ---- the headless /usage text ----

// The text of the /usage screen from a headless stream: the result line, else the local command's output.
export function usageText(stdout) {
  let found = null;
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.startsWith("{")) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.type === "result" && typeof d.result === "string" && d.result.trim()) return d.result;
    if (d?.type === "assistant" && typeof d.local_command_source === "string") found = d.local_command_source.replace(/^<local-command-stdout>/, "").replace(/<\/local-command-stdout>$/, "");
  }
  return found;
}

const num = (s) => Number(String(s).replace(/,/g, ""));

// "Current week (Fable): 2% used · resets Nov 2 at 4am (Europe/London)".
const LIMIT = /^(.+?):\s*(\d+)% used(?:\s*·\s*resets\s+(.*))?$/;
// "Last 24h · 4596 requests · 168 sessions".
const RANGE = /^(Last \S+)(?:\s*·\s*(.*))?$/;
// "  70%  Give "general-purpose" subagents a cheaper model" or "  22%  Turn off skills · 17k tokens per request".
const ADVICE = /^\s+(\d+)%\s+(.+)$/;
// "  Top skills: /go 3%, /wrap 1%, +4 more".
const TOP = /^\s+(Top [^:]+):\s*(.*)$/;

// The screen as data: the limits it lists, and for each range its request and session counts, advice lines and tops.
// A line it doesn't know is skipped. Nothing here is drawn as anything but text.
export function parseUsageText(text) {
  const out = { limits: [], ranges: [] };
  let range = null;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line) continue;
    const r = RANGE.exec(line);
    if (r && !line.startsWith(" ")) {
      const stats = r[2] ?? "";
      range = { label: r[1], requests: num(/([\d,]+) requests?/.exec(stats)?.[1] ?? 0), sessions: num(/([\d,]+) sessions?/.exec(stats)?.[1] ?? 0), advice: [], tops: [] };
      out.ranges.push(range);
      continue;
    }
    const top = TOP.exec(line);
    if (top && range) {
      const items = [];
      let more = 0;
      for (const part of top[2].split(", ")) {
        const m = /^\+(\d+) more$/.exec(part.trim());
        if (m) { more = num(m[1]); continue; }
        const item = /^(.+?)\s+(\d+)%$/.exec(part.trim());
        if (item) items.push({ name: item[1], pct: Number(item[2]) });
      }
      range.tops.push({ title: top[1], items, more });
      continue;
    }
    const adv = ADVICE.exec(line);
    if (adv && range) {
      const [title, ...rest] = adv[2].split(" · ");
      range.advice.push({ pct: Number(adv[1]), text: title.trim(), note: rest.join(" · ").trim() });
      continue;
    }
    const lim = LIMIT.exec(line);
    if (lim && !range) out.limits.push({ label: lim[1], used: Number(lim[2]), resets: lim[3] ?? null });
  }
  return out;
}

export const topOf = (range, title) => range?.tops.find((t) => t.title === title) ?? { title, items: [], more: 0 };

// The headless read for the What's using it tab. `trusted` is whether the folder is trusted (see folderTrusted). Throws when claude didn't run, or its text had no ranges.
export async function loadDetail(exec, folder, trusted) {
  const stdout = await runHeadless(exec, folder, "/usage", trusted);
  const text = usageText(stdout);
  const parsed = parseUsageText(text);
  // The limits can still be good when the rest isn't, so they go with the error.
  if (!parsed.ranges.length) throw Object.assign(new Error("no usage ranges in the text"), { limits: parsed.limits });
  return parsed;
}

// One headless read per folder at a time. Opening the panel and Refresh can come while one runs, and each would start another
// `claude -p`. A later press runs a new read, because Refresh is meant to.
const reading = new Map();
export function sharedDetail(exec, folder, trusted) {
  if (reading.has(folder)) return reading.get(folder);
  const read = loadDetail(exec, folder, trusted).finally(() => reading.delete(folder));
  reading.set(folder, read);
  return read;
}

// What `make()` built, kept in `box[name]` until `key` changes, for drawing that's too costly to repeat on every render.
export function keptOn(box, name, key, make) {
  const hit = box[name];
  if (hit?.key === key) return hit.value;
  const value = make();
  box[name] = { key, value };
  return value;
}

// ---- Stats, from stats-cache.json ----

export const RANGES = { all: "All time", d7: "Last 7 days", d30: "Last 30 days" };
const DAY = 864e5;
const day = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// The cache from its text, or null when it isn't the shape this reads.
export function parseStatsCache(text) {
  let c;
  try { c = JSON.parse(text); } catch { return null; }
  if (!c || !Array.isArray(c.dailyActivity) || typeof c.lastComputedDate !== "string") return null;
  return c;
}

// Streaks of days in a row with activity, inside [from, to] (ISO dates, inclusive). Current ends on `to`.
export function streaks(dates, from, to) {
  const have = new Set(dates.filter((d) => d >= from && d <= to));
  let best = 0, run = 0;
  for (let t = day(from); t <= day(to); t += DAY) {
    run = have.has(iso(t)) ? run + 1 : 0;
    if (run > best) best = run;
  }
  let current = 0;
  for (let t = day(to); t >= day(from) && have.has(iso(t)); t -= DAY) current++;
  return { best, current };
}

// "claude-opus-5-5" is "Opus 5.5". A date on the end, such as -20251001, is dropped.
export function modelName(id) {
  const m = /^claude-([a-z]+)-(\d+(?:-\d+)*?)(?:-\d{8})?$/.exec(String(id ?? ""));
  if (!m) return String(id ?? "");
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].replace(/-/g, ".")}`;
}

// 12.5b, 8.0m, 640.2k. Under a thousand is the number.
export const compact = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}b` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}m` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));

// "4d 23h", "5h 12m", "9m", "40s".
export function duration(ms) {
  const s = Math.floor(ms / 1000);
  if (!(s >= 0)) return "-";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return m ? `${m}m` : `${s}s`;
}

const sumTokens = (o) => Object.values(o ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);

// The first date a range covers, ending on the cache's last day. `all` starts at the first activity.
function rangeStart(cache, key) {
  const end = cache.lastComputedDate;
  if (key === "d7") return iso(day(end) - 6 * DAY);
  if (key === "d30") return iso(day(end) - 29 * DAY);
  const first = cache.dailyActivity.map((d) => d.date).sort()[0] ?? end;
  const joined = typeof cache.firstSessionDate === "string" ? cache.firstSessionDate.slice(0, 10) : first;
  return first < joined ? first : joined;
}

// The longest session of the last 7 and 30 days. The cache holds only the all-time one, so for the shorter ranges /stats
// rescans the transcripts, and longest.py does the same. Resolves to { d7, d30 } in milliseconds, a null for a range with
// no session, and to null when the helper didn't run or its answer wasn't that shape.
export async function longestRanges({ exec }, helper, projects, end) {
  const r = await exec("python3", ["-I", "-S", helper, projects, end]).catch(() => null);
  if (r?.code !== 0) return null;
  let d;
  try { d = JSON.parse(r.stdout); } catch { return null; }
  const ms = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  return d && typeof d === "object" && "d7" in d && "d30" in d ? { d7: ms(d.d7), d30: ms(d.d30) } : null;
}

// The views with the shorter ranges' longest session filled in. `found` is longestRanges' answer. Null (the helper failed)
// leaves them as they were.
export function withLongest(views, found) {
  if (!found) return views;
  const out = { ...views };
  for (const key of ["d7", "d30"]) if (out[key]) out[key] = { ...out[key], longest: found[key] };
  return out;
}

// The figures of one range, as /stats shows them. The cache is computed up to `lastComputedDate`, a day behind the
// live /stats, and every range ends there. The cache holds only the all-time longest session, which is in All time's range
// by being the longest. For the shorter ranges `longest` is undefined until longestRanges answers (see withLongest), then
// a length or null for a range with no session.
export function statsFigures(cache, key) {
  const end = cache.lastComputedDate, from = rangeStart(cache, key);
  const days = cache.dailyActivity.filter((d) => d.date >= from && d.date <= end);
  const active = days.filter((d) => d.messageCount > 0);
  const top = active.reduce((best, d) => (!best || d.messageCount > best.messageCount ? d : best), null);
  const tokensByModel = {};
  for (const d of (cache.dailyModelTokens ?? []).filter((x) => x.date >= from && x.date <= end)) for (const [m, n] of Object.entries(d.tokensByModel ?? {})) tokensByModel[m] = (tokensByModel[m] ?? 0) + n;
  const all = key === "all";
  const perModel = all ? Object.fromEntries(Object.entries(cache.modelUsage ?? {}).map(([m, u]) => [m, sumTokens({ a: u.inputTokens, b: u.outputTokens, c: u.cacheReadInputTokens, d: u.cacheCreationInputTokens })])) : tokensByModel;
  const favourite = Object.entries(perModel).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const s = streaks(active.map((d) => d.date), from, end);
  const held = cache.longestSession && typeof cache.longestSession.duration === "number" ? cache.longestSession.duration : null;
  const longest = all ? held : undefined;
  return {
    key, from, to: end,
    favourite: favourite ? modelName(favourite) : null,
    tokens: sumTokens(perModel),
    sessions: all && typeof cache.totalSessions === "number" ? cache.totalSessions : days.reduce((a, d) => a + (d.sessionCount || 0), 0),
    longest,
    activeDays: active.length,
    span: Math.round((day(end) - day(from)) / DAY) + 1,
    longestStreak: s.best,
    currentStreak: s.current,
    topDay: top?.date ?? null,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "Oct 22".
export const dayLabel = (isoDate) => (isoDate ? `${MONTHS[+isoDate.slice(5, 7) - 1]} ${+isoDate.slice(8, 10)}` : "-");

// Input, output and cache totals, for the line under the figures.
export function tokenTotals(cache) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const u of Object.values(cache.modelUsage ?? {})) {
    t.input += u.inputTokens || 0; t.output += u.outputTokens || 0; t.cacheRead += u.cacheReadInputTokens || 0; t.cacheWrite += u.cacheCreationInputTokens || 0;
  }
  return t;
}


// ---- the heat grid ----

export const WEEKS = 27;

// The last 27 weeks as columns of seven days, Sunday first, the last column holding the cache's last day. Level 0 is a
// day with no messages, and 1 to 4 are the quartiles of the active days in the grid. A day after the last one is `future`.
// It doesn't depend on the range, so it's worked out once. A range dims the days before its `from`, which the view compares.
export function heatGrid(cache) {
  const end = cache.lastComputedDate, endMs = day(end);
  const lastSunday = endMs - new Date(endMs).getUTCDay() * DAY;
  const firstMs = lastSunday - (WEEKS - 1) * 7 * DAY;
  const counts = new Map(cache.dailyActivity.map((d) => [d.date, d.messageCount || 0]));
  const values = [];
  for (let t = firstMs; t <= endMs; t += DAY) { const n = counts.get(iso(t)); if (n > 0) values.push(n); }
  values.sort((a, b) => a - b);
  const at = (q) => values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;
  const q1 = at(0.25), q2 = at(0.5), q3 = at(0.75);
  const level = (n) => (!n ? 0 : n <= q1 ? 1 : n <= q2 ? 2 : n <= q3 ? 3 : 4);
  const weeks = [], months = [];
  let seen = -1;
  for (let w = 0; w < WEEKS; w++) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const date = iso(firstMs + (w * 7 + d) * DAY), future = date > end;
      col.push({ date, count: counts.get(date) || 0, level: future ? 0 : level(counts.get(date) || 0), future });
    }
    weeks.push(col);
    const month = new Date(firstMs + w * 7 * DAY).getUTCMonth();
    if (month !== seen) { seen = month; months.push({ col: w, name: MONTHS[month] }); }
  }
  // Two labels closer than three columns would run together, so the first one goes.
  if (months.length > 1 && months[1].col - months[0].col < 3) months.shift();
  return { weeks, months, cells: weeks.length * 7 };
}

// Everything the Stats tab draws for one range. `heat` and `totals` are the same for every range, so they can be passed in.
export function statsView(cache, key, heat = heatGrid(cache), totals = tokenTotals(cache)) {
  const f = statsFigures(cache, key);
  return { ...f, heat, totals };
}

// All three ranges. Code that has just loaded runs far slower than the 55 ms render limit allows, and the limit stops a
// task too ("interrupted" in a promise continuation, measured in the private window), so `pause` is awaited between the
// steps and each one gets a limit of its own. Pass something like `() => cx.sleep(0)`.
export async function buildStats(cache, pause = async () => {}) {
  const heat = heatGrid(cache);
  await pause();
  const totals = tokenTotals(cache);
  const out = {};
  for (const key of Object.keys(RANGES)) { out[key] = statsView(cache, key, heat, totals); await pause(); }
  return out;
}

// ---- colour and size, worked out here so render only reads them ----

const hex = (c) => { const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(c)); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };
// `a` laid over `b` at strength `f`, as "#rrggbb". A colour that isn't #rrggbb comes back as `a`.
export function blend(a, b, f) {
  const x = hex(a), y = hex(b);
  if (!x || !y) return a;
  return `#${x.map((v, i) => Math.round(v * f + y[i] * (1 - f)).toString(16).padStart(2, "0")).join("")}`;
}

// The heat grid's five fills, level 0 first: an empty well, then the accent colour climbing to full strength.
export const HEAT_STEPS = [0, 0.4, 0.58, 0.78, 1];
export const heatColors = (ink, well) => HEAT_STEPS.map((f, i) => (i === 0 ? well : blend(ink, well, f)));

// The panel's height in pixels for what it shows, so its opening spring has a target. Every row has a fixed height,
// so this is a sum, and anything over `max` scrolls inside the panel.
export const TOPS_SHOWN = 5;
export const PANEL = { header: 41, pad: 26, meters: 55, section: 68, advice: 33, adviceNote: 45, top: 23, topHead: 21, heat: 120, figures: 131, line: 27, loading: 28 };
export function usageHeight({ tab, detail, range, statsFigures: figs }, max = 520) {
  const base = PANEL.header + PANEL.pad + PANEL.meters + PANEL.section;
  let page;
  if (tab === "stats") page = figs ? PANEL.heat + PANEL.figures + PANEL.line : PANEL.loading;
  else if (!detail) page = PANEL.loading;
  else {
    const r = detail.ranges.find((x) => x.label === range) ?? detail.ranges[0];
    const advice = (r?.advice ?? []).reduce((a, x) => a + (x.note ? PANEL.adviceNote : PANEL.advice), 0);
    const tops = ["Top skills", "Top subagents"].reduce((a, title) => { const n = Math.min(TOPS_SHOWN, topOf(r, title).items.length); return a + (n ? PANEL.topHead + n * PANEL.top : 0); }, 0);
    page = Math.max(advice, tops, PANEL.loading);
  }
  return Math.min(max, base + page);
}
