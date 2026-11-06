// The composer's model and effort control, its pad, and the context gauge. This holds their state and does the reads, so
// main.js only has to hand it the session's status and ask for its parts. The pad's logic is in pad.js, the keys it
// presses on Claude Code's own picker in picker.js, and the drawing in pad-view.js.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { hcFrom } from "./hc.js";
import { sendAside } from "./draft.js";
import { EFFORT_LABEL, FALLBACK_MODELS, applyChoice, parseContext, parseStatus } from "./picker.js";
import { addChoice, afterApply, mergeCurrent, newPad, nextStep, padAt, padChoice, padClosed, padKey, routeModel, triedAfter } from "./pad.js";
import { gaugeView, padView } from "./pad-view.js";

const READ_MS = 15000;
// How long the session can go on reading as on a dialog after the picker shuts, because the session file lags it.
const SHUT_MS = 2000;

// Where the pad sits above the trigger, in pixels.
const PAD_LIFT = 38;

export class ModelControl {
  // `io` is { hc(args), pause(ms) }, `run` is the composer's one-at-a-time queue, so a send and a model change never
  // interleave, `refocus()` hands the keyboard back to the composer, and `changed(cx)` asks for a redraw.
  constructor(cx, { terminal, io, run, refocus, changed }) {
    this.terminal = terminal; this.io = io; this.run = run; this.refocus = refocus; this.changed = changed;
    this.hc = { ...hcFrom(io.hc), dialog: io.dialog, send: async (t, text) => {
      this.ownUntil = Infinity;
      const r = await sendAside(io, t, text);
      if (r?.code !== 0) throw new Error("hc send was refused");
    } };
    this.focus = cx.focus_handle();
    // The known rows. Opening the pad sends nothing, so the picker isn't read for them, and `applyChoice` checks the real one.
    this.models = FALLBACK_MODELS;
    this.current = null; this.percent = null; this.applied = null;
    this.open = false; this.pad = null; this.start = null; this.drag = false; this.outside = false;
    this.pending = null; this.applying = false; this.tried = null; this.note = null;
    this.state = null; this.readAt = 0; this.reading = false; this.ownUntil = 0;
  }

  // One go at Claude Code's picker. A flow's only send is `/model`, so `send` above marks when it opens.
  picker(step) {
    return this.run(async () => {
      try { return await step(); } finally { if (this.ownUntil === Infinity) this.ownUntil = Date.now() + SHUT_MS; }
    });
  }

  // Whether a dialog on the session is the pane's own picker.
  ownDialog() { return Date.now() < this.ownUntil; }

  // Called each render with the session's live status. Reads the status line when a turn has just ended, and applies a
  // waiting choice once the session is between turns.
  sync(state, cx) {
    const ended = this.state === "working" && state !== "working";
    const first = this.state === null;
    this.state = state;
    this.tried = triedAfter(this.tried, state);
    const read = first || ended || (this.open && Date.now() - this.readAt > READ_MS);
    const apply = nextStep({ pending: this.pending, applying: this.applying, state, tried: this.tried }) === "apply";
    if (!read && !apply) return;
    // Render must not start work, so it begins a moment later.
    if (apply) { this.applying = true; this.tried = state; }
    cx.timer.after(0, (c) => { if (read) this.readScreen(c); if (apply) this.apply(c); });
  }

  // The model, effort and context from the status line. Nothing it can't read changes what's shown.
  readScreen(cx) {
    if (this.reading || !this.terminal) return;
    this.reading = true; this.readAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        const screen = await this.hc.read(this.terminal);
        this.current = mergeCurrent(this.current, parseStatus(screen), this.applied, Date.now());
        // A pad that opened before the first read, and hasn't been touched, starts again on the session's own values.
        if (this.open && !this.touched) this.startPad();
        const percent = parseContext(screen);
        if (percent !== null) this.percent = percent;
      } catch { /* The session may have just ended. */ }
      this.reading = false;
      cx.notify();
    });
  }

  show(cx, text) {
    this.note = text ?? null;
    if (!this.open) {
      this.open = true; this.drag = false; this.touched = false;
      this.startPad();
      cx.timer.after(0, () => this.focus.focus());
      this.readScreen(cx);
    }
    cx.notify();
  }

  // The pad starts on what the control shows, and closing compares with that cell.
  startPad() { this.start = this.pad = newPad(this.models, this.shown()); }

  // The model and effort the control shows: what's waiting, then what the session runs.
  shown() { return { model: this.pending?.choice.model ?? this.current?.model, effort: this.pending?.choice.effort ?? this.current?.effort }; }

  hide(cx) {
    if (!this.open) return;
    this.open = false; this.drag = false;
    this.refocus?.();
    cx.notify();
  }

  toggle(cx) { if (this.open) this.commit(cx); else this.show(cx); }

  // Closing is what applies the pad, and it applies once. Esc goes through `hide` and applies nothing.
  commit(cx) {
    if (!this.open) return;
    const outcome = padClosed(this.pad, this.start, this.current, Boolean(this.pending) && !this.applying);
    if (outcome === "apply") { const { choice, row } = padChoice(this.pad); this.choose(choice, row, cx); return; }
    if (outcome === "cancel") this.pending = null;
    this.hide(cx);
  }

  // A press outside comes first, in the capture phase. A press on the control is outside too, and the control then hears
  // the same press, so it's told not to open the pad again.
  pressedOutside(cx) {
    this.commit(cx);
    this.outside = true;
    cx.timer.after(0, () => { this.outside = false; });
  }

  // Keep the choice, close the pad, and apply it as soon as the session is between turns.
  choose(choice, row, cx) {
    this.pending = addChoice(this.pending, choice, row); this.tried = null; this.note = null;
    this.hide(cx);
    cx.notify();
    this.sync(this.state, cx);
  }

  apply(cx) {
    const taken = this.pending, { choice, row } = taken;
    this.applying = true; this.tried = this.state;
    cx.spawn(async (cx) => {
      const r = await this.picker(() => applyChoice(this.hc, this.terminal, choice, row).catch((e) => ({ ok: false, reason: "error", detail: String(e?.message ?? e) })));
      this.applying = false;
      // A busy answer stays waiting, shown by the dots on the control, and tries again when the state changes.
      const next = afterApply(r, this.current, this.applied, Date.now());
      this.current = next.current; this.applied = next.applied; this.note = next.note;
      // A choice made during the apply has replaced `taken`, and runs next.
      if (!next.pending && this.pending === taken) this.pending = null;
      if (next.read) this.readScreen(cx);
      cx.notify();
    });
  }

  // The composer's hook for typed `/model` and `/effort`. True means it was handled, and nothing is sent.
  route(text, cx) {
    const r = routeModel(text, this.models);
    if (!r) return false;
    if (r.choose) this.choose(r.choose, r.row, cx);
    else this.show(cx, r.note);
    return true;
  }

  press(keystroke, cx) {
    this.touched = true;
    const r = padKey(this.pad, keystroke);
    this.pad = r.pad;
    if (r.action === "close") this.hide(cx);
    else if (r.action === "apply") this.commit(cx);
    else cx.notify();
  }

  // Where a press or drag in the field lands. It only moves the puck.
  field(x, y, cx) { this.touched = true; this.pad = padAt(this.pad, x, y); cx.notify(); }
  release(cx) {
    if (!this.drag) return;
    this.drag = false;
    cx.notify();
  }

  // What the bottom row shows: the model and effort, and what's waiting.
  label() {
    const { model, effort } = this.shown();
    return { model: model ?? "Model", effort: effort ? EFFORT_LABEL[effort] : "", waiting: Boolean(this.pending) };
  }

  trigger(t, cx, opts) {
    const l = this.label();
    const trigger = h_flex().id("model-trigger").h(30).px(10).gap(7).flex_none().items_center().rounded(8).cursor_pointer().text_size(13)
      .bg(this.open ? t.selected : t.surface).hover((e) => e.bg(this.open ? t.selected : t.hover))
      .tooltip(l.waiting ? "Waiting for the turn to end" : "Model and effort, for this session")
      .on_mouse_down("left", (_e, c) => { if (!this.outside) this.toggle(c); })
      .child(div().font_medium().text_color(this.current || this.pending ? t.foreground : t.muted).child(l.model))
      .when(Boolean(l.effort), (e) => e.child(div().text_color(t.muted).child(l.effort)))
      .when(l.waiting, (e) => e.child(div().text_color(t.dim).child("…")));
    const cb = {
      focus: this.focus,
      onDown: (x, y) => { this.drag = true; this.field(x, y, cx); },
      onMove: (x, y) => this.field(x, y, cx),
      onUp: () => this.release(cx),
      onKey: (e) => this.press(e.key, cx),
    };
    return div().relative().flex_none()
      .child(trigger)
      .when(this.open && this.pad, (e) => e.child(div().absolute().bottom(PAD_LIFT).right(0)
        .on_mouse_down_out((_e, c) => this.pressedOutside(c)).child(padView(t, this.pad, cb, this.drag, opts))));
  }

  // What main.js hands the composer: the gauge at the left, the model control before send, and a note when there is one.
  parts(t, cx, opts = {}) {
    const tip = this.percent === null ? null : `${Math.round(this.percent)}% of the context window is used.`;
    return {
      leading: [gaugeView(t, this.percent, tip)],
      trailing: [this.trigger(t, cx, opts)],
      ...(this.note ? { note: this.note } : {}),
    };
  }

  // What a private test can drive, through the paths a press and a key take: { do: "pad" }, { do: "pad-key", key },
  // { do: "pad-at", x, y }, { do: "pad-release" } and { do: "pad-outside" }.
  testStep(step, cx) {
    if (step.do === "pad") this.toggle(cx);
    if (step.do === "pad-outside") this.pressedOutside(cx);
    if (this.pad && step.do === "pad-key") this.press(step.key, cx);
    if (this.pad && step.do === "pad-at") { this.drag = true; this.field(step.x, step.y, cx); }
    if (this.pad && step.do === "pad-release") this.release(cx);
  }

  dump() {
    return { open: this.open, pad: this.pad && { row: this.pad.row, col: this.pad.col }, current: this.current, percent: this.percent, pending: this.pending, applying: this.applying, note: this.note, models: this.models.map((m) => m.name) };
  }
}
