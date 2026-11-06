// Draws the composer. `s` is what to show and `on` what a press does, so main.js owns the state. Colours come from `theme()`.
// Later steps plug in here:
//   s.leading   elements at the left of the bottom row, such as the project and the context gauge
//   s.trailing  controls just before the send button, such as the model and effort
//   s.tray      replaces the queue rows above the text, such as the `/` menu's anchor
//   s.intercept in composerInput: gets the text first, and true means it was handled and nothing is sent
import { div, image, PathBuilder } from "gpui-kit";
import { h_flex, v_flex, Textarea, TextareaState } from "gpui-base";
import { appHome, exec, hc, home, panes, readTextFile } from "herdr";
import { clipboardImage, droppedImage, forgetImage, forgetImages, previewPath, pruneImages, splitDropped } from "./images.js";
import { spring, transitionPolicy } from "./motion.js";
import { waitingOnDialog } from "./route.js";
import { findSession } from "./session.js";
import { KEY_CONTEXT, LIST_KEYS, SEND_ACTION, keyAction, keyBindings } from "./slash.js";
import { NOTES, cleanText, plainQueued, pullQueue, removeQueued, sendMessage, sendNow, serial, settleSent, stopTurn, trayRows, withPaths, withoutEnter } from "./send.js";

const PLACEHOLDER = "Reply";
const MIN_ROWS = 1, MAX_ROWS = 10;
const THUMB = 44;

const stroke = (width, points) => {
  const path = PathBuilder.stroke(width).move_to(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) path.line_to(x, y);
  return path.build();
};

const glyph = (size, width, lines, colour) => lines.reduce((box, points) =>
  box.child(window.paint_path(stroke(width, points), colour).absolute().top(0).left(0).size(size)), div().relative().size(size).flex_none());

const ARROW = [[[7, 12], [7, 2]], [[2.8, 6.2], [7, 2], [11.2, 6.2]]];
const CROSS = [[[3.5, 3.5], [10.5, 10.5]], [[10.5, 3.5], [3.5, 10.5]]];
const PENCIL = [[[9.3, 2.8], [11.2, 4.7], [4.8, 11.1], [2.6, 11.4], [2.9, 9.2], [9.3, 2.8]]];

// These buttons act on mouse down, as the swap toggle does. A click also needs the release to land on the button, and
// the toggle logged a press whose mouse down arrived and whose click didn't. They're pressed during a turn, while
// the pane redraws and the tray moves.
function iconButton(id, label, lines, onClick, t) {
  return h_flex().id(id).size(26).flex_none().items_center().justify_center().rounded(13).cursor_pointer()
    .hover((e) => e.bg(t.hover)).tooltip(label).on_mouse_down("left", onClick).child(glyph(14, 1.4, lines, t.muted));
}

function sendNowButton(onClick, t) {
  return h_flex().id("composer-send-now").h(26).px(10).gap(6).flex_none().items_center().rounded(13).cursor_pointer()
    .bg(t.solid).text_color(t.solid_foreground).text_size(12.5).font_medium().hover((e) => e.opacity(0.88)).on_mouse_down("left", onClick)
    .child("Send now").child(div().text_size(11).opacity(0.7).child("⌃↵"));
}

// What's queued. Edit and Send now always act on the whole queue, so they sit on the first row only.
function trayRow(row, i, on, t) {
  const label = row.text?.split("\n")[0].replace(/\[Image #\d+\] ?/g, "[image] ") ?? "A queued message";
  return h_flex().id(`composer-queued-${i}`).min_h(38).gap(10).pl(14).pr(8).py(5).items_center().text_size(13)
    .when(i > 0, (e) => e.border_t(1).border_color(t.border))
    .child(div().w(48).flex_none().text_size(12.5).text_color(t.dim).child(i ? "" : "Queued"))
    .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(label))
    .when(i === 0, (e) => e.child(iconButton("composer-edit", "Edit queued messages", PENCIL, on.edit, t)))
    .child(iconButton(`composer-remove-${i}`, "Remove queued message", CROSS, (_e, cx) => on.remove(row, cx), t))
    .when(i === 0, (e) => e.child(sendNowButton(on.trayNow, t)));
}

const tray = (rows, on, t) => v_flex().flex_none().border_b(1).border_color(t.border)
  .children(rows.map((row, i) => trayRow(row, i, on, t)));

// A small picture of an image waiting to go, or the chip when it can't be drawn. Either has a remove button.
function imageChip(item, i, on, t) {
  const remove = h_flex().id(`composer-image-remove-${i}`).absolute().top(-5).right(-5).size(18).items_center().justify_center()
    .rounded(9).cursor_pointer().bg(t.raised).border_1().border_color(t.border).on_mouse_down("left", (_e, cx) => on.removeImage(item, cx))
    .child(glyph(14, 1.4, CROSS, t.foreground));
  const body = item.preview
    ? image(item.preview).size(THUMB).rounded(8).overflow_hidden().border_1().border_color(t.border)
    : h_flex().h(26).px(8).items_center().rounded(8).bg(t.raised).text_size(12).text_color(t.foreground).child("[image]");
  return div().relative().flex_none().child(body).child(remove);
}

const imageRow = (images, on, t) => h_flex().flex_none().flex_wrap().gap(10).px(14).pt(12)
  .children(images.map((item, i) => imageChip(item, i, on, t)));

function sendButton(s, on, t) {
  const stopping = s.busy && !s.canSend;
  const round = (id) => h_flex().id(id).absolute().top(0).left(0).size(30).items_center().justify_center().rounded(15)
    .bg(t.solid).text_color(t.solid_foreground).transition("opacity", transitionPolicy("quick"));
  return div().relative().size(30).flex_none()
    .child(round("composer-stop").opacity(stopping ? 1 : 0).when(stopping, (e) => e.cursor_pointer().tooltip("Stop the turn").on_mouse_down("left", on.stop))
      .child(div().size(10).rounded(2).bg(t.solid_foreground)))
    .child(round("composer-send").opacity(stopping ? 0 : s.canSend ? 1 : 0.35).when(!stopping && s.canSend, (e) => e.cursor_pointer().tooltip("Send").on_mouse_down("left", on.send))
      .child(glyph(14, 1.7, ARROW, t.solid_foreground)));
}

// The bottom row. Everything sits on one centre line.
const chin = (s, on, t) => h_flex().h(40).flex_none().gap(8).pl(14).pr(8).pb(8).items_center()
  .children(s.leading ?? []).child(div().flex_1()).children(s.trailing ?? []).child(sendButton(s, on, t));

// The text area. `s.textHeight` is its height, which springs, and the text inside reports what it wants. Null is before
// the first report.
function textBox(s, on, t) {
  const box = div().flex_none().mx(14).mt(12).mb(4);
  const sized = s.textHeight == null ? box : spring(box.id("composer-text-box").overflow_hidden(), "height", s.textHeight, "composer", { slow: s.slow });
  return sized.child(div().id("composer-text").w_full().on_size_change(on.textSize).child(Textarea.new(s.input).w_full().text_size(14).text_color(t.foreground)));
}

// `s`: { input, busy, canSend, rows, images, note, textHeight, slow, leading, trailing, tray, keys }. `keys` says what wants
// the keys above the text, as `keysWanted` in slash.js does.
// `on`: { send, stop, key(keystroke, cx), sendNow, trayNow, edit, remove(row, cx), removeImage(item, cx), drop(paths, cx), textSize(size, cx) }.
export function composer(t, s, on) {
  const above = s.tray ?? (s.rows?.length ? tray(s.rows, on, t) : null);
  const box = v_flex().flex_none().rounded(14).bg(t.surface).border_1().border_color(t.border)
    .key_context(KEY_CONTEXT[s.keys ?? "text"]).on_action(SEND_ACTION, on.send);
  return LIST_KEYS.reduce((e, key) => e.on_action(keyAction(key), (_e, cx) => on.key?.(key, cx)), box)
    .on_key_down((e, cx) => {
      if (e.keystroke !== "ctrl-enter") return;
      cx.stop_propagation();
      on.sendNow(e, cx);
    })
    .on_drop((event, cx) => on.drop(event.paths, cx))
    .when(Boolean(above), (e) => e.child(above))
    .when(Boolean(s.images?.length), (e) => e.child(imageRow(s.images, on, t)))
    .child(textBox(s, on, t))
    .when(Boolean(s.note), (e) => e.child(div().flex_none().mx(14).mb(2).text_size(12).text_color(t.muted).child(s.note)))
    .child(chin(s, on, t));
}

// The retained text state. Call it from `init`, never from `render`. `intercept(text, cx)` sees the text first, which
// is how `route` takes a `/` command, and `onSend(text, cx)` gets it otherwise. Shift+Enter stays a new line. An image
// on the clipboard fires `paste_other`, because a paste found no text. A secondary press acts as Ctrl+Enter.
export function composerInput({ placeholder = PLACEHOLDER, onChange, onSend, onSendNow, onPasteImage, intercept }) {
  const input = TextareaState.new({ placeholder, rows: MIN_ROWS });
  input.set_auto_grow(MIN_ROWS, MAX_ROWS);
  let before = "", now = "";
  input.on("change", (_e, cx) => {
    before = now;
    now = input.value();
    onChange?.(now, cx);
  });
  input.on("submit", (e, cx) => {
    if (e?.shift) return;
    const text = withoutEnter(before, now);
    if (text !== now) input.set_value(text);
    if (e?.secondary) { onSendNow?.(text, cx); return; }
    if (!intercept?.(text, cx)) onSend?.(text, cx);
  });
  input.on("paste_other", (_e, cx) => onPasteImage?.(cx));
  return input;
}

const fileName = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const NO_IMAGE = "No image on the clipboard";

// The composer's state and what its presses do, so main.js stays thin. `terminal` is the session's address, and
// `changed(cx)` is called when something the thread draws has changed. `intercept(text, cx)` is step 7's: it gets the
// text before anything is sent, and true means it was handled.
export class Composer {
  constructor(cx, { terminal, changed, intercept, typing, key, delivered }) {
    this.terminal = terminal;
    this.typing = typing; this.key = key; this.delivered = delivered;
    this.changed = changed;
    this.intercept = intercept;
    this.io = {
      hc, pause: (ms) => exec("sleep", [String(ms / 1000)]),
      dialog: async () => waitingOnDialog(await findSession({ hc, readTextFile, home }, terminal)),
    };
    this.run = serial();
    this.images = []; this.sent = []; this.note = null; this.ids = 0; this.focused = false;
    this.state = "idle"; this.queue = [];
    this.input = composerInput({
      onChange: (text, cx) => { this.note = null; this.typing?.(text, cx); cx.notify(); },
      onSend: (text, cx) => this.submit(text, cx),
      onSendNow: (text, cx) => this.pressSendNow(text, cx),
      onPasteImage: (cx) => this.pasteImage(cx),
    });
    cx.bind_keys(keyBindings());
    // A pane that closed with the window, or a crash, can leave images behind. Old ones go when a chat starts.
    this.discarding = pruneImages(exec, appHome());
  }

  // Set each render, from the session's live status and `thread.queue`.
  sync(state, queue) { this.state = state; this.queue = queue; }

  get busy() { return this.state === "working"; }
  get canSend() { return Boolean(this.input.value().trim()) || this.images.length > 0; }
  get waiting() { return this.sent.filter((item) => !item.queued); }
  get rows() { return trayRows(this.queue, this.state, this.sent.filter((item) => item.queued).map((item) => item.text)); }

  // The keyboard follows the pane, so a swap to the chat lands in the text.
  followFocus(cx, terminal, pairs) {
    const focused = panes().some((p) => p.focused && pairs[p.pane] === terminal);
    if (focused && !this.focused) cx.timer.after(0, () => this.input.focus());
    this.focused = focused;
  }

  say(note, cx) { this.note = note; cx.notify(); }

  // Sends text that didn't come from the composer, such as the `/exit` a card confirms.
  sendText(text, cx) { this.flow(cx, () => sendMessage(this.io, this.terminal, text)); }

  // Puts text back in the composer, under anything typed since.
  giveBack(text) {
    const typed = this.input.value();
    this.input.set_value(typed.trim() ? `${typed}\n${text}` : text);
  }

  // Text sent and not yet in the transcript, which takes hooks several seconds.
  track(text, images, queued) {
    this.ids += 1;
    const item = { id: `sent:${this.ids}`, text, images, queued, at: Date.now() };
    this.sent = [...this.sent, item];
    return item;
  }

  submit(raw, cx) {
    const text = cleanText(raw), images = this.images;
    if (!text && !images.length) return;
    if (text && this.intercept?.(text, cx)) { this.input.set_value(""); return; }
    const item = this.track(text, images.length, this.busy);
    this.images = []; this.note = null;
    this.input.set_value("");
    this.changed(cx);
    cx.spawn(async (cx) => {
      const r = await this.run(() => sendMessage(this.io, this.terminal, text, images.map((image) => image.path)));
      await this.after(item, images, r, cx);
    });
  }

  // A message that went has done with its files, because Claude Code read them as it landed. One that was refused comes
  // back. `stuck` is in the terminal's prompt, so a copy here would send it twice.
  async after(item, images, r, cx) {
    if (r.ok || r.reason === "stuck") for (const image of images) await forgetImage(exec, appHome(), image.path);
    if (r.ok && this.delivered?.(item.text, cx)) { this.sent = this.sent.filter((x) => x !== item); this.changed(cx); }
    if (!r.ok) {
      this.sent = this.sent.filter((x) => x !== item);
      if (r.reason !== "stuck") { this.giveBack(item.text); this.images = [...images, ...this.images]; }
      this.note = r.note;
      this.changed(cx);
    }
    cx.notify();
  }

  // Ctrl+Enter with text queues it first, and the key then takes everything.
  pressSendNow(raw, cx) {
    if (cleanText(raw) || this.images.length) this.submit(raw, cx);
    this.flow(cx, () => sendNow(this.io, this.terminal));
  }

  // The tray's button acts on the queue. A half-typed line in the composer isn't part of it.
  pressTrayNow(cx) { this.flow(cx, () => sendNow(this.io, this.terminal)); }

  // One press, one step at a time. A refusal or a queue that didn't move shows as a note.
  flow(cx, step) {
    cx.spawn(async (cx) => {
      const r = await this.run(step);
      if (r.note && r.reason !== "idle") this.say(r.note, cx);
      else cx.notify();
    });
  }

  stop(cx) { this.flow(cx, () => stopTurn(this.io, this.terminal)); }

  // The queue that's about to be pulled leaves the tray at once, or a row would show until the transcript caught up.
  dropQueued() { this.sent = this.sent.filter((item) => !item.queued); }

  edit(cx) {
    const known = this.rows;
    cx.spawn(async (cx) => {
      const r = await this.run(() => pullQueue(this.io, this.terminal, known));
      if (r.ok) this.dropQueued();
      // Text that wouldn't clear is still in the terminal's prompt, so a copy here would send it twice.
      if (r.ok && r.cleared) { this.giveBack(plainQueued(r.text)); this.input.focus(); }
      this.say(r.ok ? (r.cleared ? null : NOTES.terminal) : r.note, cx);
    });
  }

  remove(row, cx) {
    const known = this.rows;
    cx.spawn(async (cx) => {
      const r = await this.run(() => removeQueued(this.io, this.terminal, known, row));
      if (r.ok || r.text || r.reason === "terminal") this.dropQueued();
      if (r.text) this.giveBack(r.text);
      for (const text of r.again ?? []) this.track(text, 0, true);
      this.say(r.ok ? null : r.note, cx);
    });
  }

  addImage(path) {
    this.images = [...this.images, { path, preview: previewPath(appHome(), path) }];
  }

  // `board` is a private pasteboard, for a test.
  pasteImage(cx, board) {
    cx.spawn(async (cx) => {
      const path = await clipboardImage(exec, appHome(), fileName(), board);
      if (path) this.addImage(path);
      this.say(path ? null : NO_IMAGE, cx);
    });
  }

  removeImage(item, cx) {
    this.images = this.images.filter((image) => image !== item);
    cx.spawn(async (cx) => { await forgetImage(exec, appHome(), item.path); cx.notify(); });
  }

  // The pane is closing, or its session has ended, so images still waiting will never go. `discarding` settles once
  // they're deleted. Only files this pane made are deleted.
  discardImages() {
    const images = this.images;
    this.images = [];
    if (images.length) this.discarding = forgetImages(exec, appHome(), images.map((image) => image.path));
  }

  drop(paths, cx) {
    const { images, others } = splitDropped(paths);
    if (others.length) this.input.set_value(withPaths(this.input.value(), others));
    cx.spawn(async (cx) => {
      for (const path of images) this.addImage(await droppedImage(exec, appHome(), path, fileName()));
      cx.notify();
    });
  }

  // New rows have landed. Answers the rows that took over from a sent message.
  settle(rows, queue, now) {
    const { left, settled } = settleSent(this.sent, rows, queue, now);
    this.sent = left;
    return settled;
  }

  // A new transcript can't hold what was sent to the old one.
  forget() { this.sent = []; }

  element(t, parts = {}) {
    const s = { input: this.input, busy: this.busy, canSend: this.canSend, rows: this.rows, images: this.images, note: this.note, textHeight: this.textHeight, ...parts };
    return composer(t, s, {
      send: (_e, cx) => this.submit(this.input.value(), cx),
      stop: (_e, cx) => this.stop(cx),
      key: (keystroke, cx) => this.key?.(keystroke, cx),
      sendNow: (_e, cx) => this.pressSendNow(this.input.value(), cx),
      trayNow: (_e, cx) => this.pressTrayNow(cx),
      edit: (_e, cx) => this.edit(cx),
      remove: (row, cx) => this.remove(row, cx),
      removeImage: (item, cx) => this.removeImage(item, cx),
      drop: (paths, cx) => this.drop(paths, cx),
      textSize: (size, cx) => this.textSized?.(size, cx),
    });
  }

  // What a private test can drive, through the same paths a press takes.
  testStep(step, cx) {
    if (step.do === "type") this.input.set_value(step.text);
    if (step.do === "send") this.submit(this.input.value(), cx);
    if (step.do === "send-now") this.pressSendNow(this.input.value(), cx);
    if (step.do === "tray-now") this.pressTrayNow(cx);
    // An action down the focus path, as a bound key dispatches it. The key's own binding isn't part of this.
    if (step.do === "action") { this.input.focus(); cx.timer.after(50, () => window.dispatch_action(step.name)); }
    if (step.do === "stop") this.stop(cx);
    if (step.do === "edit") this.edit(cx);
    if (step.do === "remove") this.remove(this.rows[step.index], cx);
    if (step.do === "paste") this.pasteImage(cx, step.board);
    if (step.do === "drop") this.drop(step.paths, cx);
    if (step.do === "remove-image") this.removeImage(this.images[step.index], cx);
  }

  dump() {
    return { value: this.input.value(), note: this.note, state: this.state, rows: this.rows, sent: this.sent, images: this.images, canSend: this.canSend };
  }
}
