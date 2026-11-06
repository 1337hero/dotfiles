// Permission and question cards, drawn from what dialog.js read. Colours come from `theme()` only.
// Every word on a card is the screen's own, and nothing here answers anything by itself. The view functions only draw:
// `on` holds what a press does. `Cards` at the end holds the state and the reads, so main.js stays thin.
//   on.press(key, cx)   an option's number
//   on.cancel(cx)       Cancel, the same as Esc
//   on.terminal(cx)     swap to the terminal, for what needs typing
//   on.tab(index, cx)   a step's tab, in a card with several questions
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { hc, panes, run, settings, shared } from "herdr";
import { checkPress, follow, idle, parseDialog, pressed, stepKeys, terminalSteps } from "./dialog.js";
import { ease, spring } from "./motion.js";
import { settle } from "./reveal.js";
import { zoom } from "./thread.js";

const ARROW = "mods/claude-chat/arrow.svg";
const TICK = "mods/claude-chat/tick.svg";
const BODY_HEIGHT = 190;
const LABEL_WIDTH = 96;

// Theme has no well, so the darkest fill stands in for it, as the composer's bands do.
const well = (t) => t.canvas;

const frame = (t) => v_flex().w_full().flex_none().rounded(14).overflow_hidden().bg(t.surface).border_1().border_color(t.border);

const kbd = (t, text, fill = well(t)) => div().h(20).min_w(20).px(5).flex_none().flex().items_center().justify_center().rounded(6)
  .bg(fill).text_color(t.muted).font_medium().text_size(12).child(text);

function head(t, mono, { tag, title, note }) {
  return v_flex().px(14).pt(11).pb(10).flex_none()
    .when(Boolean(tag), (e) => e.child(div().mb(3).font_family(mono).font_medium().text_size(12).text_color(t.dim).child(tag)))
    .child(div().min_w(0).font_medium().text_size(14).line_height("20px").text_color(t.foreground).child(title))
    .when(Boolean(note), (e) => e.child(div().min_w(0).mt(1).text_size(13).text_color(t.muted).child(note)));
}

// The command or file, in a well. A long one scrolls, so all of it can be read before a press.
function body(id, t, mono, text) {
  return div().id(`${id}-body`).mx(14).mb(12).px(12).py(9).flex_none().max_h(BODY_HEIGHT).overflow_y_scroll().rounded(8)
    .bg(well(t)).border_1().border_color(t.border).font_family(mono).text_size(12.5).line_height("19px").text_color(t.foreground)
    .child(div().min_w(0).child(text));
}

function option(id, t, { key, label, note, first, chosen, busy }, on) {
  return h_flex().id(`${id}-${key}`).w_full().flex_none().gap(11).items_center().px(14).py(9).border_t(1).border_color(t.border)
    .when(!busy, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_, cx) => on.press(key, cx)))
    .child(kbd(t, key))
    .child(v_flex().flex_1().min_w(0).text_size(13.5).line_height("20px").text_color(t.foreground)
      .child(div().min_w(0).when(Boolean(first), (e) => e.font_medium()).child(label))
      .when(Boolean(note), (e) => e.child(div().min_w(0).text_size(12.5).line_height("18px").text_color(t.muted).child(note))))
    .child(svg(chosen ? TICK : ARROW).size(12).flex_none().text_color(t.dim));
}

const foot = (t) => h_flex().w_full().flex_none().gap(8).items_center().justify_end().px(10).py(8).border_t(1).border_color(t.border).bg(well(t));

function ghost(id, t, label, onClick) {
  return h_flex().id(id).h(26).px(10).flex_none().items_center().justify_center().rounded(13).cursor_pointer().whitespace_nowrap()
    .border_1().border_color(t.border).bg(t.surface).text_size(12.5).font_medium().text_color(t.foreground)
    .hover((s) => s.bg(t.raised)).on_click(onClick).child(label);
}

function solid(id, t, label, onClick) {
  return h_flex().id(id).h(26).px(10).flex_none().items_center().justify_center().rounded(13).cursor_pointer().whitespace_nowrap()
    .bg(t.solid).text_size(12.5).font_medium().text_color(t.solid_foreground).on_click(onClick).child(label);
}

function tabs(id, t, dialog, on) {
  const step = dialog.kind === "review" ? dialog.tabs.length : dialog.step;
  const all = dialog.tabs.every((x) => x.answered);
  const cell = (key, label, index, dot, on_it, open) => h_flex().id(`${id}-tab-${key}`).h(28).flex_none().gap(6).items_center().px(10).rounded(14)
    .text_size(12.5).when(on_it, (e) => e.bg(t.raised)).text_color(on_it ? t.foreground : t.muted)
    .when(open, (e) => e.cursor_pointer().hover((s) => (on_it ? s : s.bg(t.hover))).on_click((_, cx) => on.tab(index, cx)))
    .when(dot !== null, (e) => e.child(div().size(6).flex_none().rounded_full().bg(dot)))
    .child(label);
  return h_flex().flex_wrap().flex_none().gap(4).items_center().px(10).pt(8)
    .children(dialog.tabs.map((tab, i) => cell(i, tab.label, i, tab.answered ? t.done : t.popover, i === step, true)))
    .child(cell("submit", "Submit", dialog.tabs.length, null, step === dialog.tabs.length, all));
}

export function permissionCard(id, { dialog, t, mono, busy = false }, on) {
  const note = dialog.why ?? dialog.target;
  return frame(t)
    .child(head(t, mono, { tag: dialog.tool, title: dialog.title, note }))
    .child(body(id, t, mono, dialog.body))
    .when(Boolean(dialog.reason), (e) => e.child(div().min_w(0).mx(14).mb(10).text_size(13).text_color(t.muted).child(dialog.reason)))
    .children(dialog.options.map((o, i) => option(id, t, { ...o, first: i === 0, busy }, on)))
    .child(foot(t).child(div().flex_1()).child(kbd(t, "Esc", t.surface)).child(ghost(`${id}-cancel`, t, "Cancel", (_, cx) => on.cancel(cx))));
}

// The two rows that need typing, as buttons. Both open the terminal.
function typingFoot(id, t, dialog, on) {
  return foot(t).child(div().flex_1())
    .children(dialog.typing.map((o) => ghost(`${id}-type-${o.key}`, t, o.label, (_, cx) => on.terminal(cx))));
}

export function questionCard(id, { dialog, t, mono, busy = false }, on) {
  const several = dialog.tabs !== null;
  return frame(t)
    .when(several, (e) => e.child(tabs(id, t, dialog, on)))
    .child(head(t, mono, { title: dialog.question }))
    .children(dialog.options.map((o) => option(id, t, { ...o, busy }, on)))
    .child(typingFoot(id, t, dialog, on));
}

export function reviewCard(id, { dialog, t, mono, busy = false }, on) {
  const submit = dialog.options.find((o) => o.label === "Submit answers");
  return frame(t)
    .child(tabs(id, t, dialog, on))
    .child(v_flex().px(14).pb(12).flex_none().gap(2).text_size(13.5)
      .children(dialog.answers.map((a) => h_flex().min_w(0).gap(14)
        .child(div().w(LABEL_WIDTH).flex_none().truncate().text_color(t.muted).child(a.tab))
        .child(div().min_w(0).font_medium().text_color(t.foreground).child(a.answer)))))
    .child(foot(t).child(div().flex_1())
      .child(ghost(`${id}-cancel`, t, "Cancel", (_, cx) => on.press(dialog.options.find((o) => o.label === "Cancel").key, cx)))
      .when(!busy, (e) => e.child(solid(`${id}-submit`, t, "Submit", (_, cx) => on.press(submit.key, cx)))));
}

// The right card for what dialog.js read, or null when it read no card.
export function dialogCard(id, state, on) {
  const kind = state.dialog?.kind;
  if (kind === "permission") return permissionCard(id, state, on);
  if (kind === "question") return questionCard(id, state, on);
  if (kind === "review") return reviewCard(id, state, on);
  return null;
}

const POLL_MS = 500;
// Lines of history for a dialog taller than the screen.
const HISTORY = 300;
// A card that has just opened ignores presses for this long, so a press or a keystroke meant for something else can't
// land on it.
const ARM_MS = 400;
// Room kept for the composer and the list when a tall card opens. The card scrolls inside what's left.
const KEEP_HEIGHT = 170;

// A card's life. `terminal` is the session's address, `motion` the thread's, and `moved(height)` is told where the
// panel's height is heading.
export class Cards {
  constructor(cx, { terminal, composer, motion, moved }) {
    this.terminal = terminal; this.composer = composer; this.motion = motion; this.moved = moved;
    this.state = idle; this.status = null; this.owed = false; this.at = null;
    this.serial = 0; this.armedAt = 0; this.reading = false; this.pressing = false; this.hadFocus = false;
    this.height = 0; this.measured = null; this.visible = false; this.closing = null;
    this.focus = cx.focus_handle();
    this.on = {
      press: (key, cx) => this.press(key, cx),
      cancel: (cx) => this.press("esc", cx),
      terminal: (cx) => { this.owed = true; this.showTerminal(); cx.notify(); },
      tab: (index, cx) => this.step(index, cx),
    };
    cx.timer.every(POLL_MS, (cx) => this.poll(cx));
  }

  // The status line while the session is blocked.
  waiting() { return this.state.phase === "terminal" ? "Waiting for you in the terminal" : "Waiting for you"; }

  // Set each render, from the session's live status.
  sync(status) { this.status = status; }

  // The status and the screen, read together. The report says what kind of dialog to expect.
  async look() {
    const [got, screen] = await Promise.all([hc(["get", this.terminal, "--json"]).catch(() => null), hc(["read", this.terminal]).catch(() => null)]);
    let report = null;
    try { report = JSON.parse(got?.stdout ?? "null")?.status ?? null; } catch { /* no report reads as no dialog */ }
    const parsed = (result) => (result?.code === 0 ? parseDialog(result.stdout, report) : null);
    let read = parsed(screen);
    if (read?.reason === "cut off") read = parsed(await hc(["read", this.terminal, "--lines", String(HISTORY)]).catch(() => null));
    return { status: report?.state ?? null, read };
  }

  poll(cx) {
    this.showTerminal();
    if (this.reading || this.pressing) return;
    if (this.status !== "blocked") {
      if (this.state.phase !== "idle") this.apply({ status: this.status, read: null }, cx);
      return;
    }
    this.reading = true;
    cx.spawn(async (cx) => {
      const seen = await this.look();
      this.reading = false;
      // A hidden pane doesn't render, so `sync` won't say the dialog has gone, and this would read on every poll until shown.
      this.status = seen.status;
      if (!this.pressing) this.apply(seen, cx);
    });
  }

  apply(seen, cx) {
    const { state, swap } = follow(this.state, seen, Date.now());
    if (state === this.state) return;
    this.set(state, cx);
    if (swap) this.owed = true;
    this.showTerminal();
  }

  set(state, cx) {
    const before = this.state.card;
    this.state = state;
    if (state.phase === "idle") { this.owed = false; this.at = null; }
    // The same dialog drawn again after it went is a new card, with its own wait before a press and its own step.
    if (state.card && before && state.card !== before && state.card.key === before.key) this.at = null;
    if (state.card && state.card !== before) {
      this.serial += 1;
      this.armedAt = Date.now() + ARM_MS;
      this.closing = null;
    }
    if (!state.card && before) this.close(before, cx);
    cx.notify();
  }

  // The card it was stays drawn while its height springs shut.
  close(card, cx) {
    this.giveFocusBack();
    this.closing = card; this.visible = false; this.measured = null;
    this.spring(0);
    cx.timer.after(settle("panel", this.motion.slow), (cx) => {
      if (this.closing !== card) return;
      this.closing = null;
      cx.notify();
    });
  }

  spring(height) {
    this.height = height;
    this.moved(height);
  }

  // A new card has drawn at nothing and reported its height, so the spring has somewhere to start from. It's also how a
  // card grows or shrinks from one step to the next.
  fit(size) {
    const height = size.height / zoom();
    if (height === this.measured || !this.state.card) return;
    this.measured = height;
    this.motion.stages.next(() => {
      if (!this.state.card || this.measured !== height) return;
      this.visible = true;
      this.spring(height);
    });
  }

  // The keyboard goes to the card only when the composer has nothing in it, so a sentence being typed can't answer a
  // dialog that opens under it. With text in the composer, the card takes presses and keys stay typing.
  takeFocus(cx) {
    const focused = this.composer.focused;
    if (focused && !this.hadFocus && !this.composer.input.value()) cx.timer.after(0, () => this.focus.focus());
    this.hadFocus = focused;
  }

  giveFocusBack() {
    if (this.focus.is_focused()) this.composer.input.focus();
    this.hadFocus = false;
  }

  // Waits for the chat to be the focused pane, so a chat in a tab that isn't shown never moves the window.
  showTerminal() {
    if (!this.owed) return;
    const steps = terminalSteps(panes(), shared("chatpane.pairs") ?? {}, this.terminal);
    if (!steps) return;
    this.owed = false;
    for (const [name, args] of steps) run(name, args);
  }

  // Reads again, then sends, or lets the card go. One at a time, so a double press can't send twice.
  act(press, keys, cx) {
    const card = this.state.card;
    if (!card || this.pressing || this.state.phase !== "card" || Date.now() < this.armedAt) return false;
    this.pressing = true;
    cx.spawn(async (cx) => {
      try {
        const seen = await this.look();
        const { send } = checkPress(card, seen.read, seen.status, press);
        if (send) {
          await hc(["keys", this.terminal, ...keys]).catch(() => null);
          this.set(pressed(card, Date.now()), cx);
        } else {
          this.set(idle, cx);
          this.apply(seen, cx);
        }
      } finally {
        this.pressing = false;
        cx.notify();
      }
    });
    return true;
  }

  stepNow() {
    const card = this.state.card;
    if (card?.kind === "review") return card.tabs.length;
    return this.at ?? card?.step ?? 0;
  }

  press(key, cx) {
    const from = this.stepNow(), card = this.state.card;
    if (this.act(key, [key], cx) && card?.tabs) this.at = key === "esc" ? null : from + 1;
  }

  step(index, cx) {
    const keys = stepKeys(this.stepNow(), index);
    if (keys.length && this.act(keys[0], keys, cx)) this.at = index;
  }

  key(event, cx) {
    const press = event.keystroke === "escape" ? "esc" : event.keystroke;
    if (press !== "esc" && !/^[1-9]$/.test(press)) return;
    cx.stop_propagation();
    if (press === "esc") { if (this.state.card?.kind !== "review") this.press("esc", cx); return; }
    if (this.state.card?.options.some((o) => o.key === press)) this.press(press, cx);
    else if (this.state.card?.typing?.some((o) => o.key === press)) this.on.terminal(cx);
  }

  // Draws between the thread and the foot, as wide as the foot. `room` is the pane's height.
  element(t, { room, width, side }, cx) {
    const card = this.state.card ?? this.closing;
    if (!card) return null;
    if (this.state.card) this.takeFocus(cx);
    const slow = this.motion.slow;
    const dialog = card.tabs && card.kind !== "review" ? { ...card, step: this.stepNow() } : card;
    const state = { dialog, t, mono: settings().font_family ?? "JetBrains Mono", busy: this.state.phase !== "card" };
    const column = v_flex().id(`card-slot-${this.serial}`).w_full().max_w(width).px(side).pb(8).when(room > KEEP_HEIGHT, (e) => e.max_h(room - KEEP_HEIGHT))
      .overflow_y_scroll().track_focus(this.focus).on_key_down((event, cx) => this.key(event, cx))
      .child(dialogCard(`card-${this.serial}`, state, this.on));
    return spring(div().id("card-panel").relative().flex_none().w_full().overflow_hidden(), "height", this.height, "panel", { slow })
      .child(ease(h_flex().id("card-measure").absolute().top(0).left(0).right(0).justify_center().on_size_change((size) => this.fit(size)), "opacity", this.visible ? 1 : 0, this.visible ? "fade" : "quick", { slow })
        .child(column));
  }

  // Driven by `herdr-app do claude-chat.card-<press>` in a private Herdr only. These run the same paths a press does.
  testCommand(press, cx) {
    if (press === "cancel") this.on.cancel(cx);
    else if (press === "terminal") this.on.terminal(cx);
    else if (press.startsWith("tab")) this.step(Number(press.slice(3)), cx);
    else this.key({ keystroke: press === "esc" ? "escape" : press }, cx);
  }

  dump() {
    const { phase, card, reason } = this.state;
    return { phase, reason, owed: this.owed, height: this.height, kind: card?.kind ?? null, title: card?.title ?? card?.question ?? null, options: card?.options.map((o) => o.label) ?? null, step: this.stepNow(), focused: this.focus.is_focused() };
  }
}
