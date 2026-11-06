// Step 7's controller: what the composer's `/` commands do. It holds the state of the `/` list, the usage panel and the
// /exit card, and draws them for main.js's panel slot. `host` is what the pane gives it:
//   terminal, session(), threadEnd(), own(), paneHeight(), submit(text, cx), send(text, cx), say(note, cx), moved(height), input
// Colours come from `theme()` in the view files.
import { h_flex, v_flex, VirtualListScrollHandle } from "gpui-base";
import { appHome, exec, hc, home, panes, readTextFile, run, shared } from "herdr";
import { terminalSteps } from "./dialog.js";
import { dialogNet, route } from "./route.js";
import { cachedList, completing, completionRows, ensureList, fallbackList, filterList, folderTrusted, keysWanted, pick, rowNumber, startRow, step, trustFiles } from "./slash.js";
import { buildStats, limitMeters, longestRanges, parseStatsCache, sharedDetail, usageHeight, withLongest } from "./usage-data.js";
import { usagePanel } from "./usage-view.js";
import { completionCard, exitCard } from "./slash-view.js";

// The same width and sides as the composer's foot in main.js, so the cards line up with it.
const SIDE = 24, GAP = 8;
const ENTER_MS = 40, CLOSE_MS = 350;
// `/model` and `/effort` are taken by the model control before this gets the text. A line that still gets here is one it
// won't take, such as several lines, and a name sent through would save a default for every new session.
const AWAY_NOTE = "Opened in the terminal";
const PICKER_NOTE = "Not sent. Use the model control";
let fallback = null;

export class Commands {
  constructor(cx, host) {
    this.cx = cx; this.host = host;
    this.scroll = VirtualListScrollHandle.new();
    this.usage = null; this.slash = null; this.exit = false;
  }

  folder() { return this.host.session()?.cwd ?? null; }

  // `claude -p` skips the trust question, so it only runs where the terminal has accepted the folder.
  async trusted(folder) {
    const session = this.host.session();
    if (!session || !folder) return false;
    const texts = await Promise.all(trustFiles(session.dir, home()).map((path) => readTextFile(path).catch(() => null)));
    return texts.some((text) => folderTrusted(text, folder));
  }

  // ---- the hook before anything is sent ----

  // Enter with the list open runs the highlighted row. This comes before anything reads the text, because what's typed can
  // be a command in its own right, such as `/model` with the arrows moved off it. The row goes round again so it takes the
  // same road as typed text. False when the text stands.
  chosen(text, cx) {
    const chosen = pick(text, this.slash?.flat?.[this.slash.index], this.slash?.flat, this.slash?.moved);
    this.slash = null;
    if (chosen === text) return false;
    this.host.submit(chosen, cx);
    return true;
  }

  // True when it was handled here, and the composer clears and sends nothing. False sends the text as usual.
  handle(text, cx) {
    const r = route(text);
    if (r.kind === "message") return false;
    if (r.kind === "none") return true;
    if (r.kind === "picker") { this.host.say(PICKER_NOTE, cx); return true; }
    if (r.kind === "usage") { this.toggleUsage(r.tab, cx); return true; }
    if (r.kind === "swap") { this.swap(cx); return true; }
    if (r.kind === "exit") { this.exit = true; cx.notify(); return true; }
    // A command or a dialog command goes out the usual way. `delivered` says when it has, because a send can take seconds.
    return false;
  }

  // Called when the composer's send has gone through. A dialog command swaps to the terminal now. Any other / command
  // is watched, in case it opens a dialog. True means the transcript won't answer this message, so its bubble should go.
  delivered(text, cx) {
    const r = route(text);
    if (r.kind === "terminal") { this.swap(cx); return true; }
    if (r.kind === "command") this.watchForDialog(cx);
    return false;
  }

  // Only from a chat that's the focused pane: `pane.focus` would pull the window from another tab, and keys typed there would
  // land in the dialog.
  swap(cx) {
    const steps = terminalSteps(panes(), shared("chatpane.pairs") ?? {}, this.host.terminal);
    if (!steps) { this.host.say(AWAY_NOTE, cx); return; }
    for (const [name, args] of steps) run(name, args);
  }

  watchForDialog(cx) {
    const { terminal, threadEnd, session, own } = this.host;
    dialogNet({ threadEnd, session, own, screen: async () => (await hc(["read", terminal]).catch(() => null))?.stdout, swap: (cx) => this.swap(cx) },
      (ms, look) => cx.timer.after(ms, (cx) => cx.spawn(() => look(cx))));
  }

  // ---- the / list ----

  // Called as the composer's text changes.
  typing(text, cx) {
    if (!completing(text)) { if (this.slash) { this.slash = null; cx.notify(); } return; }
    if (!this.slash) {
      const slash = this.slash = { typed: "", index: 0, moved: false, entered: false, list: null, rows: [], flat: [] };
      cx.timer.after(ENTER_MS, (cx) => { if (this.slash === slash) { slash.entered = true; cx.notify(); } });
      const folder = this.folder();
      if (folder) cx.spawn(async (cx) => { await ensureList(folder, { exec, trusted: (f) => this.trusted(f) }); cx.notify(); });
    }
    if (this.slash.typed !== text) { this.slash.typed = text; this.slash.index = 0; this.slash.moved = false; }
    cx.notify();
  }

  // The rows are worked out when what was typed or the list changes, never on every render.
  refilter() {
    const slash = this.slash, folder = this.folder();
    const list = (folder && cachedList(folder)) || (fallback ??= fallbackList());
    if (slash.list === list && slash.shown === slash.typed) return;
    const f = filterList(list, slash.typed);
    slash.list = list; slash.shown = slash.typed; slash.rows = completionRows(f.sections); slash.flat = f.flat;
    slash.index = slash.moved ? Math.min(slash.index, Math.max(0, f.flat.length - 1)) : startRow(f.flat, slash.typed);
  }

  // Which keys the composer should take from the text. See `keysWanted`.
  keys() { return keysWanted(this); }

  // Up, Down, Tab and Escape from the composer's bindings, which only exist while `keys` says so.
  key(stroke, cx) {
    const slash = this.slash;
    if (slash?.flat.length) {
      if (stroke === "down" || stroke === "up") {
        slash.index = step(slash.index, stroke === "down" ? 1 : -1, slash.flat.length);
        slash.moved = true;
        this.scroll.scroll_to_item(rowNumber(slash.rows, slash.index), "center");
        cx.notify();
        return true;
      }
      if (stroke === "tab") {
        const { name } = slash.flat[slash.index], { input } = this.host;
        input.set_value(name);
        input.set_selected_range({ start: name.length, end: name.length });
        this.typing(name, cx);
        return true;
      }
    }
    if (stroke !== "escape") return false;
    if (slash) { this.slash = null; cx.notify(); return true; }
    if (this.exit) { this.exit = false; cx.notify(); return true; }
    if (this.usage && !this.usage.closing) { this.closeUsage(cx); return true; }
    return false;
  }

  // ---- the usage panel ----

  toggleUsage(tab, cx) {
    const u = this.usage;
    if (!u || u.closing) return this.openUsage(tab, cx);
    // /stats while the other tab shows moves to it. Anything else closes the panel.
    if (tab === "stats" && u.tab !== "stats") { u.tab = "stats"; this.fit(u); cx.notify(); } else this.closeUsage(cx);
  }

  openUsage(tab, cx) {
    const u = this.usage = { entered: false, closing: false, tab, range: "Last 24h", statsRange: "all", meters: [], detail: { status: "loading" }, stats: null, height: 0, token: 0 };
    this.fit(u);
    cx.timer.after(ENTER_MS, (cx) => { if (this.usage === u && !u.closing) { u.entered = true; this.report(u); cx.notify(); } });
    this.load(u, cx);
    cx.notify();
  }

  closeUsage(cx) {
    const u = this.usage;
    if (!u) return;
    u.closing = true; u.entered = false;
    this.report(u);
    cx.notify();
    cx.timer.after(CLOSE_MS, (cx) => { if (this.usage === u) { this.usage = null; cx.notify(); } });
  }

  // The panel's height has a target to spring to, so it's worked out from what it shows. Over 56 percent of the pane it scrolls.
  fit(u) {
    const max = Math.max(240, Math.floor(this.host.paneHeight() * 0.56));
    u.height = usageHeight({ tab: u.tab, detail: u.detail.data ?? null, range: u.range, statsFigures: u.stats?.[u.statsRange] ?? null }, max);
    this.report(u);
  }

  // Tells the pane where the panel is heading, so rows too short to fill the thread are held where they are until it reaches them.
  report(u) { this.host.moved?.(u.entered ? u.height + 8 : 0); }

  // The stats come from a file, so they show first. The headless read is slow, and it can fail, so it has its own state, and
  // the limits come with it. Each step is its own task with a pause between, because code that has just loaded gets only one
  // render limit for everything it does without one.
  load(u, cx) {
    const token = ++u.token, live = () => this.usage === u && u.token === token;
    cx.spawn(async (cx) => {
      const session = this.host.session();
      const cache = session ? parseStatsCache(await readTextFile(`${session.dir}/stats-cache.json`).catch(() => null)) : null;
      if (!live()) return;
      u.stats = cache ? await buildStats(cache, () => cx.sleep(0)) : null;
      this.fit(u); cx.notify();
      // The shorter ranges' longest session is a rescan of the transcripts, so it fills in when it's done.
      if (!cache) return;
      const found = await longestRanges({ exec }, `${appHome()}/mods/claude-chat/longest.py`, `${session.dir}/projects`, cache.lastComputedDate);
      if (!live() || !u.stats) return;
      u.stats = withLongest(u.stats, found);
      this.fit(u); cx.notify();
    });
    cx.spawn(async (cx) => {
      const folder = this.folder();
      u.detail = { status: "loading" };
      let next;
      try {
        next = !folder ? { status: "error", reason: "no folder" } : (await this.trusted(folder)) ? { status: "ready", data: await sharedDetail(exec, folder, true) } : { status: "untrusted" };
      } catch (e) { next = { status: "error", reason: e?.message, limits: e?.limits }; }
      if (!live()) return;
      u.detail = next;
      u.meters = limitMeters(next.data?.limits ?? next.limits);
      this.fit(u); cx.notify();
    });
  }

  // ---- drawing ----

  panel(t, width) {
    const parts = [];
    if (this.usage) parts.push(usagePanel(t, this.usage, {
      onTab: (id, cx) => { this.usage.tab = id; this.fit(this.usage); cx.notify(); },
      onRange: (label, cx) => { this.usage.range = label; this.fit(this.usage); cx.notify(); },
      onStatsRange: (key, cx) => { this.usage.statsRange = key; this.fit(this.usage); cx.notify(); },
      onRefresh: (cx) => this.load(this.usage, cx),
      onClose: (cx) => this.closeUsage(cx),
    }));
    if (this.exit) parts.push(exitCard(t, { onKeep: (cx) => { this.exit = false; cx.notify(); }, onEnd: (cx) => { this.exit = false; this.host.send("/exit", cx); cx.notify(); } }));
    if (this.slash) {
      this.refilter();
      if (this.slash.flat.length) parts.push(completionCard(t, { rows: this.slash.rows, index: this.slash.index, entered: this.slash.entered, scroll: this.scroll }, {
        onPick: (index, cx) => { const item = this.slash?.flat[index]; if (item) this.host.submit(item.name, cx); },
        onHover: (index, cx) => { if (this.slash && this.slash.index !== index) { this.slash.index = index; this.slash.moved = true; cx.notify(); } },
      }));
    }
    if (!parts.length) return null;
    return h_flex().id("panel-slot").flex_none().w_full().justify_center()
      .child(v_flex().w_full().max_w(width).px(SIDE).gap(GAP).children(parts));
  }

  // ---- for a private test ----

  // The same paths a press or a key takes. True when a step was one of these.
  testStep(step, cx) {
    if (step.do === "key") this.key(step.key, cx);
    else if (step.do === "usage-tab") { this.usage.tab = step.id; this.fit(this.usage); }
    else if (step.do === "usage-range") { this.usage.range = step.label; this.fit(this.usage); }
    else if (step.do === "usage-stats-range") { this.usage.statsRange = step.key; this.fit(this.usage); }
    else if (step.do === "usage-refresh") this.load(this.usage, cx);
    else if (step.do === "usage-close") this.closeUsage(cx);
    else if (step.do === "exit-end") { this.exit = false; this.host.send("/exit", cx); }
    else if (step.do === "exit-keep") this.exit = false;
    else if (step.do === "typing") this.typing(step.text, cx);
    else return false;
    cx.notify();
    return true;
  }

  dump() {
    const u = this.usage, s = this.slash;
    return {
      exit: this.exit,
      usage: u && { entered: u.entered, closing: u.closing, tab: u.tab, range: u.range, statsRange: u.statsRange, height: u.height, meters: u.meters.map((m) => [m.label, m.used]), detail: u.detail.status, ranges: u.detail.data?.ranges.length ?? 0, stats: Boolean(u.stats) },
      slash: s && { typed: s.typed, index: s.index, count: s.flat.length, selected: s.flat[s.index]?.name ?? null, entered: s.entered },
    };
  }
}
