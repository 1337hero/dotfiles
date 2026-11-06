// Every duration and spring in the chat pane, and the sums behind them. No "herdr" or "gpui-kit" imports, so this runs
// under node --test. Only .transition, .spring, .loop and .frames animate here: cx.timer never does.

// The mockup's durations are for the browser's ease-out. Herdr's is a cubic ease-out, which arrives much sooner, and
// 1.5 times the duration is the closest match to the browser's curve.
const CUBIC = 1.5;
const eased = (ms) => Math.round((ms * CUBIC) / 10) * 10;

export const MOTION = {
  fade: { duration: eased(180), easing: "ease-out" },
  quick: { duration: eased(120), easing: "ease-out" },
  pop: { duration: eased(140), easing: "ease-out", px: 4 },
  rise: { duration: eased(220), easing: "ease-out", px: 6 },
  bar: { duration: eased(320), easing: "ease-out", stagger: 40 },
  status: { duration: eased(80), easing: "ease-out" },
  sweep: { line: 300, step: 120, total: 1200, edge: 56, tail: 60, easing: "linear" },
  thumb: { response: 240, damping: 0.86 },
  panel: { response: 340, damping: 0.9 },
  composer: { response: 200, damping: 0.95 },
  tool: { response: 260, damping: 0.92 },
  sent: { response: 300, damping: 0.92, px: 34 },
  pad: { response: 280, damping: 0.74 },
  glide: { response: 360, damping: 1 },
};

// A spring with a tolerance this wide lands in the frame its target changes. Moving an element with no motion has to be
// a spring like this, because Herdr starts a spring from the value it last animated, and a missing .spring() leaves that
// behind. A very short response isn't the same: it lands a frame late.
export const SNAP = { response: 300, damping: 1, epsilon: 100000 };

// Longer than a frame at the slowest native motion seen, about 28 frames a second.
export const FRAME_MS = 40;

// What Herdr can animate, and the style method that sets each.
const SETTERS = { opacity: "opacity", width: "w", height: "h", left: "left", top: "top" };

const setter = (prop) => {
  if (!SETTERS[prop]) throw new Error(`Herdr can't animate ${prop}`);
  return SETTERS[prop];
};

const scaled = (policy, slow) => {
  const out = { ...policy };
  for (const key of ["duration", "delay", "response"]) if (out[key] != null) out[key] *= slow;
  return out;
};

// `slow` stretches time, for looking at frames of a motion.
export function transitionPolicy(name, { delay = 0, slow = 1 } = {}) {
  const { duration, easing } = MOTION[name];
  return scaled({ duration, easing, ...(delay ? { delay } : {}) }, slow);
}

export function springPolicy(name, { slow = 1 } = {}) {
  const { response, damping } = MOTION[name];
  return scaled({ response, damping }, slow);
}

// Sets `prop` to `value` on `el`, and eases later changes of it.
export function ease(el, prop, value, name, opts) {
  return el[setter(prop)](value).transition(prop, transitionPolicy(name, opts));
}

// Sets `prop` to `value` on `el`, and springs later changes of it.
export function spring(el, prop, value, name, opts) {
  return el[setter(prop)](value).spring(prop, springPolicy(name, opts));
}

// Sets `prop` to `value` on `el` with no motion you can see, keeping the spring that later changes need.
export function snap(el, prop, value) {
  return el[setter(prop)](value).spring(prop, SNAP);
}

// Sweep's timing for a block of `lines` lines. A long block shortens the gap so it still ends within sweep.total.
export function sweepPlan(lines, { line, step, total } = MOTION.sweep) {
  const count = Math.max(1, Math.floor(lines));
  const gap = count > 1 ? Math.min(step, (total - line) / (count - 1)) : 0;
  return { count, line, gap, ms: (count - 1) * gap + line };
}

// How far a cover travels over text `width` wide. Its soft edge starts just off the left and it ends just off the right.
export function sweepTravel(width, { tail } = MOTION.sweep) {
  return { from: -tail, to: width + 4, width: width + tail };
}

// How far the rows sit below their place when the list jumps to the bottom, so they can glide up. The rows above can
// only fill that gap up to `overscan`, the list's extra height above the view.
export const glideFrom = (jump, overscan) => Math.max(0, Math.min(jump, overscan));

// Steps that need the frame before them on screen, which is every entrance: a transition animates a change of target,
// so an element has to be drawn once at its start value, then change. A timer alone can't do that, because timers that
// fall due during a slow frame all run together, with no frame between them.
//
//   stages.next(() => { row.entering = false; });    // in a handler
//   stages.drawn((ms, step) => this.cx.timer.after(ms, step));    // at the end of render
//
// Each step runs one frame after the render that followed the step before it. `next` asks for that render.
export class Stages {
  constructor(notify) {
    this.notify = notify;
    this.steps = [];
    this.waiting = false;
  }

  next(step) {
    this.steps.push(step);
    this.notify();
  }

  // The same, from a render, which can't ask for a render.
  queue(step) { this.steps.push(step); }

  // Call once at the end of every render, with something that runs a function after a delay.
  drawn(after) {
    if (this.waiting || !this.steps.length) return;
    this.waiting = true;
    after(FRAME_MS, () => {
      this.waiting = false;
      this.steps.shift()();
      this.notify();
    });
  }
}
