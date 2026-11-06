// Draws the thread's motion: Sweep's covers, a row's fade and rise, a tool line's spring, the glide and the swap's fade.
// The state and timing are in reveal.js.
import { Background, PathBuilder, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { MOTION, ease, snap, spring, sweepTravel, transitionPolicy } from "./motion.js";

// A hex colour with no opacity.
const clear = (colour) => colour.slice(0, 7) + "00";

// The path and gradient are native and can be reused, and building one per cover per frame is what a first sweep pays for.
let rect = null;
const gradients = new Map();

function softEdge(ground) {
  rect ??= PathBuilder.fill().move_to("0%", "0%").line_to("100%", "0%").line_to("100%", "100%").line_to("0%", "100%").close().build();
  if (!gradients.has(ground)) gradients.set(ground, Background.linear_gradient(90, clear(ground), ground));
  return window.paint_path(rect, gradients.get(ground)).absolute().top(0).left(0).size_full();
}

// One band per line, in the thread's ground colour, each with a soft leading edge, each sliding off the right of its row.
// `armed` is false for the first frame, with every cover in place over its line.
function covers({ id, lines, plan, width, ground, armed, slow }) {
  const travel = sweepTravel(width);
  const { edge, easing } = MOTION.sweep;
  return Array.from({ length: lines.n }, (_, i) => h_flex().id(`${id}-cover-${i}`).absolute().top(i * lines.height).h(lines.height + 1).w(travel.width)
    .left(armed ? travel.to : travel.from)
    .transition("left", { duration: plan.line * slow, delay: (lines.first + i) * plan.gap * slow, easing })
    .child(div().relative().w(edge).h_full().flex_none().child(softEdge(ground)))
    .child(div().flex_1().h_full().bg(ground)));
}

// A tool line changing height, or a row below it being carried along.
function sliding(item, element, slide, slow) {
  const { key, from, to, grow, armed } = slide;
  const move = (box, prop, start, end) => (armed ? spring(box, prop, end, "tool", { slow }) : snap(box, prop, start));
  const box = div().id(`slide-${item.key}`).relative().w_full();
  if (item.key === key) return move(box.overflow_hidden(), "height", from - item.top, to - item.top).child(element);
  if (!slide.below.has(item.key)) return element;
  return (grow ? move(box, "top", 0, to - from) : move(box, "top", from - to, 0)).child(element);
}

// What a row needs as it's drawn. A row with nothing happening stays exactly as it was.
export function entry(item, element, drawn) {
  const { motion } = drawn;
  const entered = entering(item, element, drawn);
  return motion.slide ? sliding(item, entered, motion.slide, motion.slow) : entered;
}

function entering(item, element, { motion, t, width }) {
  const state = motion.rows.get(item.row?.id);
  if (!state) return element;
  const slow = motion.slow;
  const lines = motion.sweep?.lines[item.key];
  if (lines) {
    if (!lines.n) return element;
    const { plan, armed } = motion.sweep;
    return div().id(`enter-${item.key}`).relative().w_full().overflow_hidden().child(element)
      .children(covers({ id: item.key, lines, plan, width, ground: t.canvas, armed, slow }));
  }
  const go = state.phase === "go";
  const box = div().id(`enter-${item.key}`).relative().w_full();
  if (state.sent) return (go ? spring(box, "top", 0, "sent", { slow }) : snap(box, "top", MOTION.sent.px)).child(element);
  const opts = { slow, delay: state.delay ?? 0 };
  return ease(ease(box, "opacity", go ? 1 : 0, "fade", opts), "top", go ? 0 : MOTION.rise.px, "rise", opts).child(element);
}

// The list follows a reveal down with one jump, and this takes the jump up.
export function glideBox(element, motion) {
  const { top, on, name = "glide" } = motion.glide;
  return on ? spring(element, "top", top, name, { slow: motion.slow }) : snap(element, "top", top);
}

// The chat's fade on a swap. The pane comes back under a cover in its own ground colour, which fades away.
export function swapCover(motion, t) {
  const cover = motion.cover;
  if (!cover) return null;
  return div().id(`swap-cover-${cover.id}`).absolute().inset_0().bg(t.canvas).opacity(cover.armed ? 0 : 1).transition("opacity", transitionPolicy("fade", { slow: motion.slow }));
}
