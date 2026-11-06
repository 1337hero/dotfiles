// How rows enter the thread: Sweep, the glide that follows it down, a row's fade and rise, a tool line springing open, the
// status text and the swap's fade. This holds the state and the timing. Pure, with no "herdr" or "gpui-kit" imports, so it
// runs under node --test. The drawing is in covers.js.
import { MOTION, Stages, glideFrom, sweepPlan } from "./motion.js";
import { LAYOUT, heightOf, sizeKey } from "./rows.js";

// A read's rows wait for their heights, so a block never shows half covered. This caps that wait.
const HOLD_MS = 500;
const END_MS = 60;
const FADE_MS = Math.max(MOTION.fade.duration, MOTION.rise.duration);
const SETTLE = 1.5;

// How many covers a list item takes. A code card takes the mockup's three: one on its band and two on its body.
export function linesOf(type, height, lineHeight) {
  if (type === "code-head") return 1;
  if (type === "code-body") return 2;
  return Math.max(1, Math.round(height / lineHeight));
}

// Sweep for one block. `parts` is [{ key, type, height }], in order. `reach` is how much of the block's end can be on
// screen: the rest is out of view, so it gets no covers, which keeps the element count down and spends the time where it
// shows. Returns the plan, and for each key its first line's number, its line count and its band height.
export function sweepOf(parts, { lineHeight, reach }) {
  const covered = new Set();
  let shown = 0;
  for (let i = parts.length - 1; i >= 0 && shown < reach; i -= 1) {
    covered.add(parts[i].key);
    shown += parts[i].height;
  }
  let count = 0;
  const lines = {};
  for (const part of parts) {
    const n = covered.has(part.key) ? linesOf(part.type, part.height, lineHeight) : 0;
    lines[part.key] = { first: count, n, height: n ? part.height / n : 0 };
    count += n;
  }
  return { plan: sweepPlan(count), lines };
}

// How far a list at its bottom moves when its rows go from `before` to `after` tall. Rows shorter than the view don't
// scroll at all.
export const jumpFor = (before, after, view) => Math.max(0, after - view) - Math.max(0, before - view);

// The height of a list's rows, with the last row's bottom gap.
export function listHeight(items, heights) {
  let sum = items.length ? LAYOUT.BOTTOM : 0;
  for (const item of items) sum += heightOf(item, heights) ?? 0;
  return sum;
}

// How far rows stay down while a panel `height` tall is open. The list's box rides up with the panel, so rows too short to
// fill the `view` would go out of sight. They hold still until the panel reaches them.
export const panelHold = (height, view, rows) => Math.min(height, Math.max(0, view - rows));

// Whether a pane can be seen: its tab is the one shown, in the space shown, with no other pane of the tab zoomed.
export function isShowing(pane, panes, spaces) {
  const me = panes.find((p) => p.pane === pane);
  if (!me) return false;
  if (panes.some((p) => p.tab === me.tab && p.zoomed && p.pane !== pane)) return false;
  return spaces.some((s) => s.active && s.tabs.some((tab) => tab.id === me.tab && tab.active));
}

export const settle = (name, slow) => MOTION[name].response * SETTLE * slow;

// `notify` asks for a render, `after(ms, f)` runs something later, and `bottom()` moves the list to its end.
export class ThreadMotion {
  constructor({ notify, after, bottom, overscan }) {
    this.notify = notify;
    this.after = after;
    this.bottom = bottom;
    this.overscan = overscan;
    this.stages = new Stages(notify);
    this.slow = 1;
    this.seen = false;
    this.showing = false;
    this.cover = null;
    this.covers = 0;
    this.status = { text: null, latest: null, fading: false };
    this.counts = { sweeps: 0, fades: 0, slides: 0 };
    this.batch = 0;
    this.holds = 0;
    this.clear();
  }

  // A new transcript. Steps still queued find nothing to act on.
  clear() {
    this.rows = new Map();
    this.block = null;
    this.sweep = null;
    this.slide = null;
    this.glide = { top: 0, on: false };
  }

  // New rows from a read. They stay out of the list until `begin` has all their heights. `sent` is a message you've just
  // sent, which rises from the composer rather than fading in.
  land(rows, { sent = false } = {}) {
    if (!rows.length) return;
    const hold = ++this.holds;
    for (const row of rows) this.rows.set(row.id, { phase: "held", hold, sent });
    for (const row of rows) if (row.block != null) this.block = row.block;
    this.after(HOLD_MS * this.slow, () => this.release(hold));
  }

  held(item) { return this.rows.get(item.row?.id)?.phase === "held"; }

  // Rows that never got a height show as they are, rather than never.
  release(hold) {
    for (const [id, state] of this.rows) if (state.phase === "held" && state.hold === hold) this.rows.delete(id);
    this.notify();
  }

  // Starts everything waiting, once it all has a height. `shown` is what the list holds now, and `view` the thread's height.
  begin(items, shown, heights, view) {
    const entering = items.filter((item) => this.held(item));
    if (!entering.length || entering.some((item) => heightOf(item, heights) == null)) return;
    const batch = ++this.batch;
    for (const item of entering) this.rows.set(item.row.id, { phase: "start", batch, sent: this.rows.get(item.row.id).sent });
    const swept = entering.filter((item) => item.row.block != null && item.row.block === this.block);
    this.block = null;
    this.counts.fades += entering.length - swept.length;
    if (swept.length) {
      const parts = swept.map((item) => ({ key: item.key, type: item.type, height: heightOf(item, heights) - item.top }));
      this.sweep = { batch, armed: false, ...sweepOf(parts, { lineHeight: LAYOUT.LINE, reach: view }) };
      this.counts.sweeps += 1;
      // What comes after the block waits for it, as a turn's closing line does in the mockup.
      const end = entering.indexOf(swept[swept.length - 1]);
      for (const item of entering.slice(end + 1)) this.rows.get(item.row.id).delay = this.sweep.plan.ms;
    }
    const after = listHeight([...shown, ...entering], heights);
    const top = glideFrom(jumpFor(listHeight(shown, heights), after, view), this.overscan);
    this.stages.next(() => {
      this.bottom();
      if (top) this.glide = { top, on: false };
    });
    this.stages.next(() => this.arm(batch, top));
  }

  arm(batch, glided) {
    for (const state of this.rows.values()) if (state.batch === batch) state.phase = "go";
    const sweep = this.sweep?.batch === batch ? this.sweep : null;
    if (sweep) sweep.armed = true;
    if (glided) this.glide = { top: 0, on: true };
    const ms = (sweep?.plan.ms ?? 0) + FADE_MS;
    this.after(ms * this.slow + END_MS, () => this.finish(batch));
  }

  finish(batch) {
    for (const [id, state] of this.rows) if (state.batch === batch) this.rows.delete(id);
    if (this.sweep?.batch === batch) this.sweep = null;
    this.notify();
  }

  // A tool line changes from `from` to `to` tall. A list row can't move what's below it, and rows pushed past the list's
  // end aren't drawn, so the list's sizes and the motion have to take turns.
  //
  // Growing, the line keeps its old slot while it springs and reaches out of it, the rows below spring down by the same
  // amount, and the slot takes the new size at the end, when nothing moves. At the bottom of the list, room is added under
  // the last row first, the list moves into it with the glide taking that up, and then what's above rises as the line opens.
  //
  // Shrinking, the slot takes the new size at once, and the rows below start from where they were. At the bottom of the
  // list the same room holds them, what's above falls with the glide, and the room goes at the end as the glide ends.
  slideTool(items, key, from, to, heights, view, pinned) {
    const index = items.findIndex((item) => item.key === key);
    if (index < 0 || from === to) return;
    this.counts.slides += 1;
    const item = items[index], grow = to > from;
    const now = listHeight(items.filter((x) => !this.held(x)), heights);
    const jump = pinned ? jumpFor(now - (to - from), now, view) : 0;
    const slide = {
      key, top: item.top, from, to, grow, armed: false, heightKey: sizeKey(item), tail: jump ? Math.abs(to - from) : 0,
      below: new Set(items.slice(index + 1).map((x) => x.key)),
    };
    this.slide = slide;
    if (jump > 0) {
      this.stages.next(() => {
        this.bottom();
        this.glide = { top: glideFrom(jump, this.overscan), on: false };
      });
    }
    this.stages.next(() => {
      slide.armed = true;
      if (jump) this.glide = { top: jump < 0 ? glideFrom(-jump, this.overscan) : 0, on: true, name: "tool" };
      this.after(settle("tool", this.slow), () => {
        if (this.slide === slide) {
          this.slide = null;
          if (jump < 0) this.glide = { top: 0, on: false };
        }
        this.notify();
      });
    });
  }

  // Whether a row needs to reach out of its slot now, which a list row's clip would otherwise cut off.
  get reaching() { return Boolean(this.slide) || [...this.rows.values()].some((state) => state.sent && state.phase !== "held"); }

  // The composer's text wants to be `delta` taller, so the thread gets that much shorter. `height` is the list's rows, and
  // `view` the thread's height before this. The thread's box takes its new size now, in a frame where nothing can be seen
  // to move, and then `spring` runs, which starts the composer's own spring. The list sits on the thread's bottom edge, so
  // it rides that spring. Rows too few to fill the view would ride it too, and they shouldn't move, so the glide takes it
  // out, in step with it.
  footMoved(delta, height, view, pinned, spring, done) {
    const overflow = (v) => Math.max(0, height - v);
    const rest = pinned ? delta - (overflow(view - delta) - overflow(view)) : delta;
    const held = rest ? -rest : 0;
    this.glide = { top: delta > 0 ? -delta : held, on: false };
    if (delta > 0) {
      this.stages.next(() => {
        if (pinned) this.bottom();
        this.glide = { top: held, on: false };
      });
    }
    this.stages.next(() => {
      spring();
      if (rest) this.glide = { top: 0, on: true, name: "composer" };
      this.after(settle("composer", this.slow), done);
    });
  }

  // The heights the list uses. A growing tool line keeps its old slot until it's done.
  sizes(heights) {
    const slide = this.slide;
    return slide?.grow ? { ...heights, [slide.heightKey]: slide.from - slide.top } : heights;
  }

  // The status text fades out, changes, and fades back. Called from render, which can't notify, but a timer can.
  statusText(text) {
    const s = this.status;
    if (s.text === null) s.text = text;
    s.latest = text;
    if (text !== s.text && !s.fading) {
      s.fading = true;
      this.after(MOTION.status.duration * this.slow, () => {
        s.text = s.latest;
        s.fading = false;
        this.notify();
      });
    }
    return { text: s.text, opacity: s.fading ? 0 : 1 };
  }

  // Called from render with whether the pane can be seen. Coming back into view puts a ground-coloured cover over the
  // pane, which fades away. A new cover has a new id, so it draws solid at once, whatever came before.
  shown(showing) {
    if (showing && !this.showing && this.seen) {
      const cover = { id: ++this.covers, armed: false };
      this.cover = cover;
      this.stages.queue(() => {
        cover.armed = true;
        this.after(MOTION.fade.duration * this.slow + END_MS, () => {
          if (this.cover === cover) this.cover = null;
          this.notify();
        });
      });
    }
    this.showing = showing;
    if (showing) this.seen = true;
  }

  // Call once at the end of every render.
  drawn() { this.stages.drawn(this.after); }
}
