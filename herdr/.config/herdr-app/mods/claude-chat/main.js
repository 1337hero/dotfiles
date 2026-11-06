// The chat pane: a view on a live Claude Code session, one press away from its terminal. This file holds the state, does
// the reads and composes the pane. Finding the session is in session.js, reading in tail.py, the model in rows.js and the
// drawing in thread.js, with the row shapes at the top of that file. Sending is in composer.js and send.js. Everything
// read from a transcript is drawn as text.
import { View, div } from "gpui-kit";
import { h_flex, v_flex, VirtualListScrollHandle } from "gpui-base";
import { appHome, exec, hc, home, nextCommand, panes, props, readTextFile, run, setShared, shared, spaces, terminals, theme, watchFolder, writeTextFile } from "herdr";
import { isToggle } from "./swap.js";
import { Toggle } from "./toggle.js";
import { findSession, folderOf, latest, locateTranscript, readLoop, sessionMoved, tail, wakesSession, wakesTranscript } from "./session.js";
import { paletteKey, planEditors } from "./editors.js";
import { UNSEEN_KEY, newMessages, unseenOf, withUnseen } from "./unseen.js";
import { PAGE, aimAbove, appendReply, emptyThread, heightOf, listItems, pendingItems, prependReply, shownItems, sizeKey, statusText } from "./rows.js";
import { chatWidth } from "./width.js";
import { OVERSCAN, SPACER, codeEditor, columnWidth, notice, threadView, zoom } from "./thread.js";
import { Composer } from "./composer.js";
import { Commands } from "./commands.js";
import { Cards } from "./cards.js";
import { ThreadMotion, isShowing, listHeight, panelHold } from "./reveal.js";
import { entry, glideBox, swapCover } from "./covers.js";
import { ModelControl } from "./model-control.js";
import { testScript, testTranscript, testing } from "./test-hook.js";

const HELPER = () => `${appHome()}/mods/claude-chat/tail.py`;
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
// Items either side of what the list drew whose editors are kept, so a row about to scroll in doesn't lose its colours.
const EDITOR_MARGIN = 4;

// SLOT, step 7 and 8: the panel area. The permission and question cards, the usage panel, the / list and the /exit card open
// here, between the thread and the foot. Their height springs, which shrinks the thread, and the list's bottom-anchored box
// keeps the last message right above it with no render. Null draws nothing.
const panelSlot = (chat, t, cx) => {
  const parts = [chat.cards.element(t, { room: chat.paneHeight, width: chatWidth(chat.paneWidth), side: FOOT_SIDE }, cx), chat.commands.panel(t, chatWidth(chat.paneWidth))].filter(Boolean);
  return parts.length ? v_flex().w_full().flex_none().children(parts) : null;
};
// SLOT, step 7: `route`. It gets what was typed before anything is sent, and true means it was handled. A row picked in the
// / list comes first. Then `/model` and `/effort` go to the model control, because typed with a value they would save a
// default for new sessions.
const route = (text, cx, chat) => chat.commands.chosen(text, cx) || chat.model.route(text, cx) || chat.commands.handle(text, cx);
const FOOT_SIDE = 24, FOOT_BOTTOM = 14;
// The foot's height before it first reports one. It keeps the list's box the height of the thread with no panel open.
const FOOT_START = 110;

export default class Chat extends View {
  init(_props, cx) {
    // A layout block with `props: { role: "toggle" }` is the toggle, and it owns the swap. Everything else is a chat pane.
    if (isToggle(props())) { this.toggle = new Toggle(cx); return; }
    this.terminal = props()?.terminal ?? null;
    this.cx = cx;
    this.session = null; this.path = null; this.problem = null; this.loaded = false; this.paneWidth = 0; this.paneHeight = 0;
    this.handle = VirtualListScrollHandle.new();
    this.motion = new ThreadMotion({
      notify: () => this.cx.notify(), after: (ms, f) => this.cx.timer.after(ms, () => f()), bottom: () => this.handle.scroll_to_bottom(), overscan: OVERSCAN,
    });
    this.editors = new Map(); this.watched = new Set(); this.sessionRead = latest(); this.misses = 0;
    this.foot = FOOT_START;
    this.composer = new Composer(cx, {
      terminal: this.terminal, intercept: (text, cx) => route(text, cx, this), changed: (cx) => this.composerChanged(cx),
      // Step 7: `typing` and `key` drive the / list and the panels, and `delivered` starts the dialog safety net.
      typing: (text, cx) => this.commands.typing(text, cx), key: (key, cx) => this.commands.key(key, cx), delivered: (text, cx) => this.commands.delivered(text, cx),
    });
    this.model = new ModelControl(cx, { terminal: this.terminal, io: this.composer.io, run: this.composer.run, refocus: () => this.composer.input.focus(), changed: (cx) => cx.notify() });
    this.commands = new Commands(cx, {
      terminal: this.terminal, input: this.composer.input, session: () => this.session, threadEnd: () => this.thread.end, own: () => this.model.ownDialog(), paneHeight: () => this.paneHeight,
      submit: (text, cx) => this.composer.submit(text, cx), send: (text, cx) => this.composer.sendText(text, cx), say: (note, cx) => this.composer.say(note, cx),
      moved: (height) => this.panelMoved(height),
    });
    this.composer.textSized = (size, cx) => this.textSized(size, cx);
    this.risen = new Set();
    this.cards = new Cards(cx, { terminal: this.terminal, composer: this.composer, motion: this.motion, moved: (height) => this.panelMoved(height) });
    this.results = {}; this.open = new Set(); this.copied = null; this.copiedPart = false;
    // `close` clears "N new", and that includes the window quitting. A count still in `shared` here was left by a copy that
    // never got to close, and those rows are still unseen.
    this.unseen = unseenOf(shared(UNSEEN_KEY), this.terminal);
    this.resetView();
    this.stats = { started: Date.now(), firstPaint: null, renders: 0, slowest: 0, rowCalls: 0, slowestRows: 0, reads: 0 };
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
        if (testing(appHome())) await this.testCommand(command, cx);
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

  // The session file says which transcript is live. `/clear` and `/resume` change it.
  refreshSession(cx) {
    if (!this.terminal) return;
    const newest = this.sessionRead();
    cx.spawn(async (cx) => {
      const forced = await testTranscript(appHome(), readTextFile);
      const session = await findSession({ hc, readTextFile, home }, this.terminal);
      if (!newest()) return;
      if (!session) { if (!this.session && !forced) cx.notify(); return; }
      const moved = sessionMoved(this.session, session);
      this.session = session;
      this.watch(`${session.dir}/sessions`, cx);
      if (moved) this.resetView();
      if (moved || !this.path) this.startTranscript(forced ?? session.transcript, cx);
      else this.retryTranscript(cx);
      cx.notify();
    });
  }

  startTranscript(path, cx) {
    this.path = path;
    this.watch(folderOf(path), cx);
    this.read(cx);
  }

  // A fresh session has no transcript, and maybe no folder, until its first message.
  retryTranscript(cx) {
    this.watch(folderOf(this.path), cx);
    if (!this.loaded) this.read(cx);
  }

  // One watcher per folder, for as long as the pane lives. A session can move to another project's folder.
  watch(folder, cx) {
    if (this.watched.has(folder)) return;
    this.watched.add(folder);
    cx.spawn(async (cx) => {
      for (;;) {
        const paths = await watchFolder(folder).catch(() => null);
        if (!paths) { this.watched.delete(folder); return; }
        if (this.session && wakesSession(paths, this.session)) this.refreshSession(cx);
        if (wakesTranscript(paths, this.path)) this.read(cx);
      }
    });
  }

  // One read at a time. A wake during a read asks for another straight after it. A read that throws lets go, says so at
  // the composer, and the next change to the file reads again.
  read(cx) {
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
          console.error(`claude-chat: a read failed: ${error?.stack ?? error}`);
          this.composer.say(BROKE, cx);
        },
      });
      if (current()) cx.notify();
    });
  }

  land(reply, first, cx) {
    this.stats.reads++;
    if (reply.missing) { this.absent = true; this.findMissing(cx); return; }
    if (reply.error) { this.problem = LOST; return; }
    if (reply.reset) { const path = this.path; this.resetView(); this.startTranscript(path, cx); return; }
    this.problem = null; this.loaded = true;
    // Only new rows on a pane you're watching move. History and anything that landed behind the terminal appear at once.
    this.updateShowing();
    const moves = !first && this.landed && this.pinned && this.showing && reply.start === this.thread.end;
    if (!first && !this.showing) this.addUnseen(newMessages(reply.rows));
    this.thread = first ? prependReply(this.thread, reply) : appendReply(this.thread, reply);
    const settled = this.composer.settle(reply.rows, this.thread.queue, Date.now());
    for (const [item, row] of settled) this.heights[row.id] = this.heights[item.id];
    // A row that took over from a sent message is already there.
    const taken = new Set(settled.map(([, row]) => row.id));
    if (moves) this.motion.land(reply.rows.filter((row) => row.kind !== "result" && row.kind !== "queue" && !taken.has(row.id)));
    this.changed();
    this.enter();
    if (reply.partial) this.dirty = true;
  }

  enter() { this.motion.begin(this.items, this.shown, this.heights, this.paneHeight - this.foot); }

  // The file isn't where its folder's name says. A fresh session hasn't written one yet, and `/resume` can name another.
  findMissing(cx) {
    if (!this.session) return;
    const generation = this.generation;
    cx.spawn(async (cx) => {
      const found = await locateTranscript({ exec }, this.session);
      if (generation !== this.generation) return;
      if (found && found !== this.path) this.startTranscript(found, cx);
      this.loaded = false;
      cx.notify();
    });
  }

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

  rebuild() { this.items = listItems(this.thread, this.open, this.working, this.composer.waiting); }

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

  // Rows too short to fill the thread would ride up out of sight with the box, so they're held where they are until a
  // panel reaches them. `height` is where the panel is heading, and this springs with it.
  panelMoved(height) {
    const top = panelHold(height, this.paneHeight - this.foot, listHeight(this.shown, this.heights));
    this.motion.glide = { top, on: true, name: "panel" };
  }

  footView(t, status) {
    this.composer.sync(status, this.thread.queue);
    this.model.sync(status, this.cx);
    this.cards.sync(status);
    return h_flex().id("foot").flex_none().w_full().justify_center().on_size_change((size, cx) => this.setFoot(size, cx))
      .child(v_flex().w_full().max_w(chatWidth(this.paneWidth)).px(FOOT_SIDE).pb(FOOT_BOTTOM).child(this.composer.element(t, { ...this.model.parts(t, this.cx, { slow: this.motion.slow }), slow: this.motion.slow, keys: this.commands.keys() })));
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
    this.release();
    const pairs = shared("chatpane.pairs") ?? {};
    const pane = Object.keys(pairs).find((p) => pairs[p] === this.terminal);
    if (pane && panes().some((p) => p.pane === pane)) run("pane.close", { pane });
  }

  // What outlives the pane unless it's let go: images waiting in the composer, and this session's "N new".
  release() {
    this.composer.discardImages();
    this.unseen = 0;
    this.publishUnseen();
  }

  // The host calls this once when the pane closes.
  async close() {
    if (this.toggle) return;
    this.release();
    await this.composer.discarding;
  }

  addUnseen(count) {
    if (!count) return;
    this.unseen += count;
    this.publishUnseen();
  }

  publishUnseen() {
    const next = withUnseen(shared(UNSEEN_KEY), this.terminal, this.unseen);
    if (next) setShared(UNSEEN_KEY, next);
  }

  // The session's live state, from the same list the rest of the app draws from.
  liveState(session) {
    const blocked = session?.status === "blocked";
    const working = session?.status === "working" || blocked;
    if (working && !this.workingSince) this.workingSince = Date.now();
    if (!working) this.workingSince = null;
    if (working !== Boolean(this.working)) { this.working = working; this.rebuild(); this.follow = this.pinned; }
    if (blocked) return { ...this.motion.statusText(this.cards.waiting()), time: "" };
    return { ...this.motion.statusText(statusText(session?.report)), time: working ? `${Math.floor((Date.now() - this.workingSince) / 1000)}s` : "" };
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
    this.stats.rowCalls++;
    this.stats.slowestRows = Math.max(this.stats.slowestRows, ms);
  }

  // The thread stays hidden until it's at its newest message, so it never opens on its first.
  showThread(cx) {
    this.landed = true;
    if (this.stats.firstPaint === null) this.stats.firstPaint = Date.now() - this.stats.started;
    cx.notify();
  }

  // A chat pane is the one its pair names. A pane with no pair yet, in the first moments after a split, counts as hidden.
  // A hidden pane doesn't render, so the one-second timer reads this too, or the pane wouldn't know it had gone.
  // "N new" goes once the chat is showing and focused, so a chat side by side keeps its count in the header until you
  // go to it.
  updateShowing() {
    const pairs = shared("chatpane.pairs") ?? {};
    const pane = Object.keys(pairs).find((p) => pairs[p] === this.terminal);
    const all = panes();
    this.showing = Boolean(pane) && isShowing(pane, all, spaces());
    this.motion.shown(this.showing);
    if (this.unseen && this.showing && all.some((p) => p.pane === pane && p.focused)) { this.unseen = 0; this.publishUnseen(); }
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
    this.drawing = true;
    const begun = Date.now();
    const t = theme();
    const all = terminals();
    const live = all.find((x) => x.address === this.terminal);
    this.closeIfEnded(live, all);
    this.checkPalette();
    const state = this.liveState(live);
    this.updateShowing();
    this.composer.followFocus(this.cx, this.terminal, shared("chatpane.pairs") ?? {});
    const view = v_flex().id("chat").relative().size_full().min_h(0).bg(t.canvas).text_color(t.foreground).text_size(14)
      .on_size_change((size, cx) => this.setPane(size, cx))
      // A drag on the pad can let go anywhere.
      .on_mouse_up("left", (_e, cx) => this.model.release(cx))
      .child(this.view(t, state))
      .children([panelSlot(this, t, this.cx), this.footView(t, live?.status), swapCover(this.motion, t)].filter(Boolean));
    this.afterRender();
    this.motion.drawn();
    this.stats.renders++;
    this.stats.slowest = Math.max(this.stats.slowest, Date.now() - begun);
    this.drawing = false;
    return view;
  }

  // Driven by `herdr-app do claude-chat.<command>` in a private Herdr only. These run the same paths a press and a scroll do.
  async testCommand(command, cx) {
    if (command === "top") { this.pinned = false; this.handle.scroll_to_item(0, "top"); }
    if (command === "bottom") { this.pinned = true; this.follow = true; }
    if (command.startsWith("card-")) this.cards.testCommand(command.slice(5), cx);
    if (command === "older") this.loadOlder(cx);
    if (/^slow\d+$/.test(command)) this.motion.slow = Number(command.slice(4));
    if (command === "script") for (const step of await testScript(appHome(), readTextFile)) { if (this.commands.testStep(step, cx)) continue; this.composer.testStep(step, cx); this.model.testStep(step, cx); }
    if (command === "open-tool") {
      const item = [...this.shown].reverse().find((x) => x.type === "tool" && x.line != null);
      if (item) this.press(item.key, cx);
    }
    if (command === "dump") {
      const state = {
        stats: this.stats, zoom: zoom(), paneWidth: this.paneWidth, paneHeight: this.paneHeight, path: this.path, session: this.session?.sessionId, rows: this.thread.rows.length, items: this.items.length, shown: this.shown.length, pending: this.pendingCount, start: this.thread.start,
        end: this.thread.end, more: this.thread.more, range: this.range, pinned: this.pinned, measured: Object.keys(this.heights).length,
        editors: this.editors.size, open: [...this.open], results: Object.keys(this.results).length, working: this.working, copied: this.copied,
        showing: this.showing, motion: this.motion.counts, glide: this.motion.glide,
        kinds: this.thread.rows.slice(-8).map((r) => [r.kind, r.text?.slice(0, 40) ?? r.name ?? r.lang ?? r.ms]),
        queue: this.thread.queue, foot: this.foot, composer: this.composer.dump(), model: this.model.dump(), cards: this.cards.dump(), commands: this.commands.dump(),
      };
      await writeTextFile(`${appHome()}/chat-state-${Date.now()}.json`, JSON.stringify(state, null, 1), null);
    }
  }
}
