// Draws the composer. `s` is what to show and `on` what a press does, so main.js owns the state. Colours come from `theme()`.
import { div, PathBuilder } from "gpui-kit";
import { h_flex, v_flex, Textarea, TextareaState } from "gpui-base";
import { exec, hc, panes } from "herdr";
import { spring, transitionPolicy } from "./motion.js";
import { cleanText, sendMessage, serial, settleSent, stopTurn } from "./send.js";

const PLACEHOLDER = "Reply";
const MIN_ROWS = 1, MAX_ROWS = 10;

// A Textarea binds Enter itself. A binding of our own at the same depth wins, because it was added later, and this one
// handles only Enter: the arrows, Tab and Escape stay the textarea's.
const KEY_CONTEXT = "PiChatComposer";
const SEND_ACTION = "pi_chat_send";
export const keyBindings = () => [{ keystroke: "enter", action: SEND_ACTION, context: `${KEY_CONTEXT} > Input` }];

const stroke = (width, points) => {
  const path = PathBuilder.stroke(width).move_to(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) path.line_to(x, y);
  return path.build();
};

const glyph = (size, width, lines, colour) => lines.reduce((box, points) =>
  box.child(window.paint_path(stroke(width, points), colour).absolute().top(0).left(0).size(size)), div().relative().size(size).flex_none());

const ARROW = [[[7, 12], [7, 2]], [[2.8, 6.2], [7, 2], [11.2, 6.2]]];

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

// The bottom row, on one centre line.
const chin = (s, on, t) => h_flex().h(40).flex_none().gap(8).pl(14).pr(8).pb(8).items_center()
  .children(s.leading ?? []).child(div().flex_1()).children(s.trailing ?? []).child(sendButton(s, on, t));

// The text area. `s.textHeight` is its height, which springs, and the text inside reports what it wants. Null is before
// the first report.
function textBox(s, on, t) {
  const box = div().flex_none().mx(14).mt(12).mb(4);
  const sized = s.textHeight == null ? box : spring(box.id("composer-text-box").overflow_hidden(), "height", s.textHeight, "composer", { slow: s.slow });
  return sized.child(div().id("composer-text").w_full().on_size_change(on.textSize).child(Textarea.new(s.input).w_full().text_size(14).text_color(t.foreground)));
}

// `s`: { input, busy, canSend, note, textHeight, slow }. `on`: { send, stop, drop, textSize(size, cx) }.
export function composer(t, s, on) {
  return v_flex().flex_none().rounded(14).bg(t.surface).border_1().border_color(t.border)
    .key_context(KEY_CONTEXT).on_action(SEND_ACTION, on.send)
    .on_drop((event, cx) => on.drop(event.paths, cx))
    .child(textBox(s, on, t))
    .when(Boolean(s.note), (e) => e.child(div().flex_none().mx(14).mb(2).text_size(12).text_color(t.muted).child(s.note)))
    .child(chin(s, on, t));
}

// The retained text state. Call it from `init`, never from `render`. Shift+Enter stays a new line, and a paste that found
// no text is an image. If the Enter binding ever misses, `submit` here does the same job.
export function composerInput({ placeholder = PLACEHOLDER, onChange, onSend, onPasteImage }) {
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
    onSend?.(text, cx);
  });
  input.on("paste_other", (_e, cx) => onPasteImage?.(cx));
  return input;
}

// A press of Enter can add its newline before `submit` arrives. This takes that newline back out.
export function withoutEnter(before, now) {
  if (now.length !== before.length + 1) return now;
  for (let i = 0; i < now.length; i++) {
    if (now[i] !== before[i]) return now[i] === "\n" && now.slice(i + 1) === before.slice(i) ? before : now;
  }
  return now;
}

// Dropped files as text for the composer, each escaped the way a terminal escapes a dropped path.
export function withPaths(text, paths) {
  const list = paths.map((path) => path.replace(/([\\\s"'$`])/g, "\\$1")).join(" ");
  if (!list) return text;
  return !text || /\s$/.test(text) ? `${text}${list} ` : `${text} ${list} `;
}

// The composer's state and what its presses do, so main.js stays thin. `terminal` is the session's address, and
// `changed(cx)` is called when something the thread draws has changed.
export class Composer {
  constructor(cx, { terminal, changed }) {
    this.terminal = terminal;
    this.changed = changed;
    this.io = { hc, pause: (ms) => exec("sleep", [String(ms / 1000)]) };
    this.run = serial();
    this.sent = []; this.note = null; this.ids = 0; this.focused = false;
    this.state = "idle";
    this.input = composerInput({
      onChange: (_text, cx) => { this.note = null; cx.notify(); },
      onSend: (text, cx) => this.submit(text, cx),
      onPasteImage: (cx) => this.say("Images aren't in this version yet", cx),
    });
    cx.bind_keys(keyBindings());
  }

  // Set each render, from the session's live status.
  sync(state) { this.state = state; }

  get busy() { return this.state === "working"; }
  get canSend() { return Boolean(this.input.value().trim()); }
  // Text sent and not yet in the transcript. pi takes a message while it works, so there is no queue to draw.
  get waiting() { return this.sent; }

  // The keyboard follows the pane, so a swap to the chat lands in the text.
  followFocus(cx, terminal, pairs) {
    const focused = panes().some((p) => p.focused && pairs[p.pane] === terminal);
    if (focused && !this.focused) cx.timer.after(0, () => this.input.focus());
    this.focused = focused;
  }

  say(note, cx) { this.note = note; cx.notify(); }

  // Sends text that didn't come from the composer.
  sendText(text, cx) { this.flow(cx, () => sendMessage(this.io, this.terminal, text)); }

  // Puts text back in the composer, under anything typed since.
  giveBack(text) {
    const typed = this.input.value();
    this.input.set_value(typed.trim() ? `${typed}\n${text}` : text);
  }

  track(text) {
    this.ids += 1;
    const item = { id: `sent:${this.ids}`, text, at: Date.now() };
    this.sent = [...this.sent, item];
    return item;
  }

  submit(raw, cx) {
    const text = cleanText(raw);
    if (!text) return;
    const item = this.track(text);
    this.note = null;
    this.input.set_value("");
    this.changed(cx);
    cx.spawn(async (cx) => {
      const r = await this.run(() => sendMessage(this.io, this.terminal, text));
      this.after(item, r, cx);
    });
  }

  // A message that went stays on screen dim until its own row takes over. One that was refused comes back.
  after(item, r, cx) {
    if (!r.ok) {
      this.sent = this.sent.filter((x) => x !== item);
      this.giveBack(item.text);
      this.note = r.note;
      this.changed(cx);
    }
    cx.notify();
  }

  // A dropped file goes in as its path, the way a terminal takes one.
  drop(paths, cx) {
    if (!paths?.length) return;
    this.input.set_value(withPaths(this.input.value(), paths));
    cx.notify();
  }

  flow(cx, step) {
    cx.spawn(async (cx) => {
      const r = await this.run(step);
      if (r.note && r.reason !== "idle") this.say(r.note, cx);
      else cx.notify();
    });
  }

  stop(cx) { this.flow(cx, () => stopTurn(this.io, this.terminal)); }

  // New rows have landed. Answers the rows that took over from a sent message.
  settle(rows, now) {
    const { left, settled } = settleSent(this.sent, rows, now);
    this.sent = left;
    return settled;
  }

  // A new transcript can't hold what was sent to the old one.
  forget() { this.sent = []; }

  element(t, parts = {}) {
    const s = { input: this.input, busy: this.busy, canSend: this.canSend, note: this.note, textHeight: this.textHeight, ...parts };
    return composer(t, s, {
      send: (_e, cx) => this.submit(this.input.value(), cx),
      stop: (_e, cx) => this.stop(cx),
      drop: (paths, cx) => this.drop(paths, cx),
      textSize: (size, cx) => this.textSized?.(size, cx),
    });
  }
}
