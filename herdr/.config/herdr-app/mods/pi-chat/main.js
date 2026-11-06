// The chat pane: a view on a live pi session, one press away from its terminal. This file holds the state, does the
// reads and composes the pane. Finding the session is in session.js, reading in pi-tail.py, the drawing in thread.js,
// with the row shapes at the top of that file. Sending is in composer.js and send.js. Everything read from a
// transcript is drawn as text.
import { View, div } from "gpui-kit";
import { h_flex, v_flex, VirtualListScrollHandle } from "gpui-base";
import { appHome, exec, hc, home, nextCommand, panes, props, readTextFile, run, setShared, shared, spaces, terminals, theme, watchFolder, writeTextFile } from "herdr";
import { PAIRS, isToggle } from "./swap.js";
import { Toggle } from "./toggle.js";
import { findSession, folderOf, latest, readLoop, sessionMoved, tail } from "./session.js";
import { paletteKey, planEditors } from "./editors.js";
import { PAGE, aimAbove, appendReply, emptyThread, heightOf, listItems, pendingItems, prependReply, shownItems, sizeKey, statusText } from "./rows.js";
import { chatWidth } from "./width.js";
import { OVERSCAN, SPACER, codeEditor, columnWidth, notice, threadView, zoom } from "./thread.js";
import { Composer } from "./composer.js";
import { ThreadMotion, isShowing, listHeight } from "./reveal.js";
import { entry, glideBox, swapCover } from "./covers.js";

const HELPER = () => `${appHome()}/mods/pi-chat/pi-tail.py`;
const RENDER_RETRY_MS = 1000;
const SESSION_MS = 5000;
const COPIED_MS = 1500;
const BATCH = 8;
const MAX_EDITORS = 64;
// `scroll_to_bottom` uses the sizes from the last render, so it has to come a frame after a row joins.
const NEXT_FRAME_MS = 40;
const AWAY_TICKS = 2;
const LOOKING = "…";
const LOST = "Transcript unreadable";
const BROKE = "Thread may be behind";
const MISSES = 3;
const WAITING = "Waiting for you";

// Writes a file in the app folder, replacing what was read for the check `writeTextFile` wants. A test's, only.
async function save(path, text) {
  const before = await readTextFile(path).catch(() => null);
  await writeTextFile(path, text, before).catch(() => null);
}
// Items either side of what the list drew whose editors are kept, so a row about to scroll in doesn't lose its colours.
const EDITOR_MARGIN = 4;
const FOOT_SIDE = 24, FOOT_BOTTOM = 14;
// The foot's height before it first reports one. It keeps the list's box the height of the thread.
const FOOT_START = 110;

export default class Chat extends View {
  init(_props, cx) {
    // A layout block with `props: { role: "toggle" }` is the toggle, and it owns the swap. Everything else is a chat pane.
    if (isToggle(props())) { this.toggle = new Toggle(cx); return; }
    this.terminal = props()?.terminal ?? null;
    this.cx = cx;
    // The props are the pane's, so a copy that has none has no pane: a pane the person closed can leave its copy
    // running for a moment, and that copy must not draw, read or send into anything.
    if (!this.terminal) { this.idle = true; return; }
    this.session = null; this.problem = null; this.loaded = false; this.paneWidth = 0; this.paneHeight = 0;
    this.handle = VirtualListScrollHandle.new();
    this.motion = new ThreadMotion({
      notify: () => this.cx.notify(), after: (ms, f) => this.cx.timer.after(ms, () => f()), bottom: () => this.handle.scroll_to_bottom(), overscan: OVERSCAN,
    });
    this.editors = new Map(); this.watched = new Set(); this.sessionRead = latest(); this.misses = 0;
    this.foot = FOOT_START;
    this.composer = new Composer(cx, { terminal: this.terminal, changed: (cx) => this.composerChanged(cx) });
    this.composer.textSized = (size, cx) => this.textSized(size, cx);
    this.risen = new Set();
    this.results = {}; this.open = new Set(); this.copied = null; this.copiedPart = false;
    this.resetView();
    this.refreshSession(cx);
    cx.timer.every(SESSION_MS, (cx) => this.refreshSession(cx));
    // Herdr stops a render at about 55 ms and keeps the last frame under a banner, and code that has just loaded runs far
    // slower than that. Nothing would ask for another render, so ask each second until one finishes. A running turn's
    // clock needs the same tick.
    cx.timer.every(RENDER_RETRY_MS, (cx) => {
      this.settleScroll(cx);
      const cover = this.motion.cover;
      this.updateShowing();
      if (this.drawing || this.working || this.motion.cover !== cover) cx.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        await this.testCommand(command, cx);
        cx.notify();
      }
    });
  }

  resetView() {
    this.thread = emptyThread(); this.items = []; this.shown = []; this.heights = {}; this.fresh = new Set();
    this.range = { start: 0, end: 0 }; this.rangeCount = 0; this.pendingCount = 0;
    this.pinned = true; this.follow = false; this.landed = false; this.owed = false; this.away = 0; this.anchor = null; this.generation = (this.generation ?? 0) + 1;
    this.reading = false; this.dirty = false; this.older = false; this.loaded = false; this.absent = false;
    this.results = {}; this.open = new Set();
    this.motion.clear();
    this.composer?.forget();
    for (const editor of this.editors?.values() ?? []) editor.release();
    this.editors = new Map();
  }

  // The session file the terminal is on. It moves with `/new` and `/resume`, and a pane it isn't in yet runs the
  // terminal's session, so this is also where a swap's new pane finds its thread.
  refreshSession(cx) {
    if (!this.terminal) return;
    const newest = this.sessionRead();
    cx.spawn(async (cx) => {
      const session = await findSession({ hc, exec, home }, this.terminal, this.session?.path ?? null);
      if (!newest()) return;
      if (!session) { if (!this.session) cx.notify(); return; }
      const moved = sessionMoved(this.session, session);
      this.session = session;
      this.watch(session.dir, cx);
      if (moved) this.resetView();
      if (moved || !this.path) this.startTranscript(session.path, cx);
      else this.read(cx);
      cx.notify();
    });
  }

  startTranscript(path, cx) {
    this.path = path;
    this.watch(folderOf(path), cx);
    this.read(cx);
  }

  // One watcher per folder, for as long as the pane lives. pi appends to the file as it goes, and a new session is a new
  // file in the same folder, so every change here is worth a look.
  watch(folder, cx) {
    if (this.watched.has(folder)) return;
    this.watched.add(folder);
    cx.spawn(async (cx) => {
      for (;;) {
        const paths = await watchFolder(folder).catch(() => null);
        if (!paths) { this.watched.delete(folder); return; }
        this.refreshSession(cx);
      }
    });
  }

  // One read at a time. A wake during a read asks for another straight after it. A read that throws lets go, says so at
  // the composer, and the next change to the file reads again.
  read(cx) {
    if (!this.path) return;
    if (this.reading) { this.dirty = true; return; }
    this.reading = true;
    const generation = this.generation;
    const current = () => generation === this.generation;
    cx.spawn(async (cx) => {
      await readLoop(this, {
        current,
        once: async () => {
          const first = !this.loaded;
          const reply = await tail({ exec }, HELPER(), this.path, ...(first ? ["--last", PAGE] : ["--from", this.thread.end]));
          if (!current()) return;
          if (reply) { this.misses = 0; this.land(reply, first, cx); }
          else if (first) this.problem = LOST;
          // With rows on screen the pane's own message can't show, so a thread that has stopped says so at the composer.
          else if (++this.misses === MISSES) { this.problem = LOST; this.composer.say(LOST, cx); }
        },
        failed: (error) => {
          console.error(`pi-chat: a read failed: ${error?.stack ?? error}`);
          this.composer.say(BROKE, cx);
        },
      });
      if (current()) cx.notify();
    });
  }

  land(reply, first, cx) {
    if (reply.missing) { this.absent = true; return; }
    if (reply.error) { this.problem = LOST; return; }
    if (reply.reset) { const path = this.path; this.resetView(); this.startTranscript(path, cx); return; }
    this.problem = null; this.loaded = true;
    // Only new rows on a pane you're watching move. History and anything that landed behind the terminal appear at once.
    this.updateShowing();
    const moves = !first && this.landed && this.pinned && this.showing && reply.start === this.thread.end;
    this.thread = first ? prependReply(this.thread, reply) : appendReply(this.thread, reply);
    const settled = this.composer.settle(reply.rows, Date.now());
    for (const [item, row] of settled) this.heights[row.id] = this.heights[item.id];
    // A row that took over from a sent message is already there.
    const taken = new Set(settled.map(([, row]) => row.id));
    if (moves) this.motion.land(reply.rows.filter((row) => row.kind !== "result" && !taken.has(row.id)));
    this.changed();
    this.enter();
    if (reply.partial) this.dirty = true;
  }

  enter() { this.motion.begin(this.items, this.shown, this.heights, this.paneHeight - this.foot); }

  // Scrolling to the top asks for the page before.
  loadOlder(cx) {
    if (this.older || !this.thread.more || !this.loaded) return;
    this.older = true;
    const generation = this.generation;
    cx.spawn(async (cx) => {
      const reply = await tail({ exec }, HELPER(), this.path, "--last", PAGE, "--before", this.thread.start);
      if (generation !== this.generation) return;
      this.older = false;
      if (!reply) return;
      this.anchor = this.shown[0]?.key ?? null;
      this.thread = prependReply(this.thread, reply);
      this.pinned = false;
      this.changed();
      cx.notify();
    });
  }

  changed() {
    this.rebuild();
    this.makeEditors();
    this.follow = this.pinned;
  }

  rebuild() { this.items = listItems(this.thread, this.open, this.working); }

  composerChanged(cx) {
    const fresh = this.composer.waiting.filter((item) => !this.risen.has(item.id));
    for (const item of fresh) this.risen.add(item.id);
    if (this.landed && this.pinned && this.showing) this.motion.land(fresh, { sent: true });
    this.rebuild();
    this.follow = this.pinned;
    this.enter();
    cx.notify();
  }

  setFoot(size, cx) {
    const height = size.height / zoom();
    this.footSeen = height;
    if (height === this.foot || this.footMoving) return;
    this.foot = height;
    this.follow = this.pinned;
    cx.notify();
  }

  // The text in the composer changed height. The first report only sets where it starts.
  textSized(size, cx) {
    const c = this.composer, height = size.height / zoom();
    if (c.textHeight == null) { c.textHeight = height; c.textTarget = height; cx.notify(); return; }
    const delta = height - c.textTarget;
    if (!delta) return;
    c.textTarget = height;
    const view = this.paneHeight - this.foot;
    this.foot += delta;
    this.footMoving = true;
    const settled = () => {
      if (c.textTarget !== height) return;
      this.footMoving = false;
      if (this.footSeen != null && this.footSeen !== this.foot) this.setFoot({ height: this.footSeen * zoom() }, this.cx);
    };
    this.motion.footMoved(delta, listHeight(this.shown, this.heights), view, this.pinned, () => { c.textHeight = height; }, settled);
    cx.notify();
  }

  footView(t, status) {
    this.composer.sync(status);
    return h_flex().id("foot").flex_none().w_full().justify_center().on_size_change((size, cx) => this.setFoot(size, cx))
      .child(v_flex().w_full().max_w(chatWidth(this.paneWidth)).px(FOOT_SIDE).pb(FOOT_BOTTOM).child(this.composer.element(t, { slow: this.motion.slow })));
  }

  // Newest code rows get a coloured editor. Past the cap a row draws as plain text. Editor state is held by the app, so
  // it's capped and released with the thread. Once the cap is reached, the oldest editors off screen make room for new
  // rows. An editor keeps the colours it was made with, so a theme with other code colours makes them all again.
  makeEditors() {
    const t = theme(), palette = paletteKey(t);
    if (palette !== this.palette) {
      for (const editor of this.editors.values()) editor.release();
      this.editors = new Map();
      this.palette = palette;
    }
    const rows = this.thread.rows, codeRows = new Map(rows.filter((row) => row.kind === "code").map((row) => [row.id, row]));
    const { start, end } = this.range;
    const visible = new Set(this.shown.slice(Math.max(0, start - EDITOR_MARGIN), end + EDITOR_MARGIN).filter((item) => item.type === "code-body").map((item) => item.row.id));
    const { make, drop } = planEditors({ codeIds: [...codeRows.keys()], have: new Set(this.editors.keys()), visible, max: MAX_EDITORS });
    for (const id of drop) { this.editors.get(id)?.release(); this.editors.delete(id); }
    for (const id of make) this.editors.set(id, codeEditor(codeRows.get(id), t));
  }

  // Editor state can't be made in a render, so a theme change seen there is put right just after it.
  checkPalette() {
    if (paletteKey(theme()) === this.palette || this.paletteOwed) return;
    this.paletteOwed = true;
    this.cx.timer.after(0, (cx) => { this.paletteOwed = false; this.makeEditors(); cx.notify(); });
  }

  // A list keeps its scroll in pixels, so rows added above would slide what you're reading down. Put it back.
  keepPlace() {
    const index = this.anchor ? this.shown.findIndex((item) => item.key === this.anchor) : -1;
    if (index >= 0) this.handle.scroll_to_item(aimAbove(this.shown, this.heights, index, OVERSCAN) + SPACER, "top");
  }

  // What the list just drew tells us where it is. It reports nothing else. `owed` is a move to the bottom that may not
  // have landed: a frame was too slow for it, or the pane was hidden when rows came. Until it lands the list isn't
  // scrolled up, only behind. With nothing owed, a list that stays short of the end has been scrolled up.
  settleScroll(cx) {
    const { range, rangeCount, shown } = this;
    if (rangeCount !== shown.length || !shown.length || this.pendingCount) return;
    const atEnd = range.end >= shown.length;
    if (this.pinned && this.owed) {
      this.handle.scroll_to_bottom();
      this.owed = !atEnd; this.away = 0;
    } else if (atEnd) {
      this.pinned = true; this.away = 0;
    } else if (this.pinned && !this.anchor && ++this.away >= AWAY_TICKS) {
      this.pinned = false;
    }
    if (range.start === 0 && !this.anchor) this.loadOlder(cx);
  }

  measure(item, pixels, cx) {
    const key = sizeKey(item), height = pixels / zoom(), from = heightOf(item, this.heights);
    this.fresh.add(key);
    if (this.heights[key] !== height) this.heights[key] = height;
    if (item.type === "tool" && this.showing) this.slide(item.key, from, heightOf(item, this.heights));
    else if (this.pinned) this.follow = true;
    this.enter();
    cx.notify();
  }

  slide(key, from, to) {
    this.motion.slideTool(this.items, key, from, to, this.heights, this.paneHeight - this.foot, this.pinned);
  }

  // A new width changes where text wraps, so every row measures again. Old heights draw until then.
  setPane(size, cx) {
    const scale = zoom(), width = size.width / scale, height = size.height / scale;
    if (width === this.paneWidth && height === this.paneHeight) return;
    if (width !== this.paneWidth) this.fresh = new Set();
    this.paneWidth = width; this.paneHeight = height;
    cx.notify();
  }

  press(key, cx) {
    if (key.startsWith("tool:")) this.toggleTool(key.slice(5), cx);
    else if (key.endsWith(":head")) this.copyCode(key.slice(0, -5), cx);
  }

  toggleTool(tool, cx) {
    if (this.open.has(tool)) this.setOpen(tool, false, cx);
    else this.fetchResult(tool, cx);
  }

  setOpen(tool, opened, cx) {
    const open = new Set(this.open), key = `tool:${tool}`;
    const height = () => heightOf(this.items.find((item) => item.key === key), this.heights);
    const from = height();
    if (opened) open.add(tool);
    else open.delete(tool);
    this.open = open;
    this.rebuild();
    if (this.showing) this.slide(key, from, height());
    cx.notify();
  }

  // A line opens once it has its result, so it springs to its real height in one move.
  fetchResult(tool, cx) {
    const line = this.thread.results[tool]?.line;
    if (line == null || this.results[tool]) { this.setOpen(tool, true, cx); return; }
    const generation = this.generation;
    cx.spawn(async (cx) => {
      const result = await tail({ exec }, HELPER(), this.path, "--result", line, "--tool", tool);
      if (generation !== this.generation) return;
      this.results = { ...this.results, [tool]: result ?? { missing: true } };
      this.setOpen(tool, true, cx);
    });
  }

  // A code row cut to fit a reply is read whole from the transcript first. If that fails, the cut goes on the clipboard
  // and the card says "Copied part", never a plain "Copied".
  copyCode(id, cx) {
    const row = this.thread.rows.find((r) => r.id === id);
    if (!row) return;
    if (!row.clipped) { this.copy(id, row.code, false, cx); return; }
    const generation = this.generation;
    cx.spawn(async (cx) => {
      // A row's id starts with the byte offset of its transcript line.
      const full = await tail({ exec }, HELPER(), this.path, "--code", id.split(".")[0], "--id", id);
      if (generation !== this.generation) return;
      const whole = typeof full?.code === "string";
      this.copy(id, whole ? full.code : row.code, !whole || Boolean(full.clipped), cx);
    });
  }

  copy(id, text, part, cx) {
    cx.write_to_clipboard(text);
    this.copied = id; this.copiedPart = part;
    cx.notify();
    cx.timer.after(COPIED_MS, (cx) => { if (this.copied === id) { this.copied = null; this.copiedPart = false; cx.notify(); } });
  }

  // The chat closes itself when its terminal ends. A window that has just started reads no terminals at all, and that
  // proves nothing, so an empty list only counts once this copy has seen its terminal live.
  closeIfEnded(live, all) {
    if (!this.terminal) return;
    if (live?.state === "live") { this.seenLive = true; return; }
    if (!this.seenLive && !all.length) return;
    const pairs = shared(PAIRS) ?? {};
    const pane = Object.keys(pairs).find((p) => pairs[p] === this.terminal);
    if (pane && panes().some((p) => p.pane === pane)) run("pane.close", { pane });
  }

  // The session's live state, from the same list the rest of the app draws from. pi reports its own words: the session's
  // name while it works, and an open dialog's title while it waits.
  liveState(session) {
    const blocked = session?.status === "blocked";
    const working = session?.status === "working" || blocked;
    if (working && !this.workingSince) this.workingSince = Date.now();
    if (!working) this.workingSince = null;
    if (working !== Boolean(this.working)) { this.working = working; this.rebuild(); this.follow = this.pinned; }
    const report = session?.report;
    const said = typeof report === "string" ? report : report?.message ?? report?.msg;
    if (blocked && said) this.composer.say(said);
    const text = blocked ? WAITING : statusText(report);
    return { ...this.motion.statusText(text), time: working ? `${Math.floor((Date.now() - this.workingSince) / 1000)}s` : "" };
  }

  view(t, live) {
    const items = this.items;
    if (!items.length) {
      if (this.problem) return notice(this.problem, t);
      // An empty thread still fills its room, so the composer sits at the foot from the start.
      return this.session && (this.loaded || this.absent) ? v_flex().flex_1().min_h(0) : notice(LOOKING, t);
    }
    const pending = pendingItems(items, this.fresh, BATCH);
    this.pendingCount = pending.length;
    this.shown = shownItems(items, this.heights).filter((item) => !this.motion.held(item));
    const drawn = { motion: this.motion, t, width: columnWidth(this.paneWidth) };
    const opts = {
      results: this.results, editors: this.editors, live, working: this.working, copied: this.copied, copiedPart: this.copiedPart,
      entry: (item, element) => entry(item, element, drawn), glide: (element) => glideBox(element, this.motion),
      sliding: this.motion.reaching, tail: this.motion.slide?.tail ?? 0, closing: this.motion.slide?.grow === false ? this.motion.slide.key : null,
    };
    return threadView({
      items: this.shown, heights: this.motion.sizes(this.heights), width: this.paneWidth, height: this.paneHeight - this.foot, pending, handle: this.handle, landed: this.landed, opts,
      onDrawing: () => { this.drawing = true; },
      onRange: (start, end, count, ms) => this.drew(start, end, count, ms),
      onPress: (key, cx) => this.press(key, cx),
      onMeasure: (item, pixels, cx) => this.measure(item, pixels, cx),
      onWheel: (e, cx) => { if (e.delta?.y > 0) this.pinned = false; this.settleScroll(cx); },
    }, t);
  }

  drew(start, end, count, ms) {
    this.range = { start, end }; this.rangeCount = count; this.drawing = false;
    this.stats = this.stats ?? { rowCalls: 0, slowestRows: 0 };
    this.stats.rowCalls++;
    this.stats.slowestRows = Math.max(this.stats.slowestRows, ms);
  }

  // The thread stays hidden until it's at its newest message, so it never opens on its first.
  showThread(cx) {
    this.landed = true;
    cx.notify();
  }

  // A chat pane is the one its pair names. A pane with no pair yet, in the first moments after a split, counts as hidden.
  // A hidden pane doesn't render, so the one-second timer reads this too, or the pane wouldn't know it had gone.
  updateShowing() {
    const pairs = shared(PAIRS) ?? {};
    const pane = Object.keys(pairs).find((p) => pairs[p] === this.terminal);
    this.showing = Boolean(pane) && isShowing(pane, panes(), spaces());
    this.motion.shown(this.showing);
  }

  // Runs after the render, so the list has the new sizes when it moves.
  afterRender() {
    if (this.follow) {
      this.follow = false; this.away = 0; this.owed = true;
      this.cx.timer.after(NEXT_FRAME_MS, (cx) => {
        this.handle.scroll_to_bottom();
        if (!this.landed && !this.pendingCount) this.showThread(cx);
      });
    } else if (this.anchor) {
      if (!this.pendingCount) this.cx.timer.after(NEXT_FRAME_MS, () => { this.keepPlace(); this.anchor = null; });
      else this.cx.timer.after(NEXT_FRAME_MS, () => this.keepPlace());
    }
  }

  render() {
    if (this.toggle) return this.toggle.render();
    if (this.idle) return v_flex().size_full().items_center().justify_center().text_size(12.5).text_color(theme().dim).child("A chat view needs a pane's terminal");
    this.drawing = true;
    const t = theme();
    const all = terminals();
    const live = all.find((x) => x.address === this.terminal);
    this.closeIfEnded(live, all);
    this.checkPalette();
    const state = this.liveState(live);
    this.updateShowing();
    this.composer.followFocus(this.cx, this.terminal, shared(PAIRS) ?? {});
    const view = v_flex().id("chat").relative().size_full().min_h(0).bg(t.canvas).text_color(t.foreground).text_size(14)
      .on_size_change((size, cx) => this.setPane(size, cx))
      .child(this.view(t, state))
      .children([this.footView(t, live?.status), swapCover(this.motion, t)].filter(Boolean));
    this.afterRender();
    this.motion.drawn();
    this.drawing = false;
    return view;
  }

  // `herdr-app do pi-chat.<command>` runs these against a shown copy, along the paths a press and a scroll take. The
  // steps wait in `chat-script.json` in this folder, because a command can't carry arguments, and with no file there is
  // nothing to do. This is how the pane is driven in a test window; nothing else reads it.
  async testCommand(command, cx) {
    if (!command || this.idle) return;
    if (command !== "script") return;
    const raw = await readTextFile(`${appHome()}/chat-script.json`).catch(() => null);
    if (!raw) return;
    let steps = [];
    try { steps = JSON.parse(raw); } catch { return; }
    for (const step of Array.isArray(steps) ? steps : []) {
      if (step.do === "type") this.composer.input.set_value(String(step.text ?? ""));
      if (step.do === "send") this.composer.submit(this.composer.input.value(), cx);
      if (step.do === "top") { this.pinned = false; this.handle.scroll_to_item(0, "top"); }
      if (step.do === "bottom") { this.pinned = true; this.follow = true; }
      if (step.do === "older") this.loadOlder(cx);
      if (step.do === "open-tool") {
        const item = [...this.shown].reverse().find((x) => x.type === "tool");
        if (item) this.press(item.key, cx);
      }
      if (step.do === "dump") {
        const state = {
          terminal: this.terminal, path: this.path, rows: this.thread.rows.length, items: this.items.length, shown: this.shown.length,
          pending: this.pendingCount, start: this.thread.start, end: this.thread.end, more: this.thread.more, range: this.range,
          pinned: this.pinned, measured: Object.keys(this.heights).length, editors: this.editors.size, open: [...this.open],
          results: Object.keys(this.results).length, working: this.working, showing: this.showing, landed: this.landed, problem: this.problem,
          composer: { value: this.composer.input.value(), note: this.composer.note, sent: this.composer.waiting.length },
          kinds: this.thread.rows.slice(-10).map((r) => [r.kind, r.text?.slice(0, 40) ?? r.name ?? r.lang ?? r.ms]),
        };
        await save(`${appHome()}/pi-chat-state.json`, JSON.stringify(state, null, 1));
      }
    }
  }
}
