// Draws the model and effort pad and the context gauge. View only: state and logic are in pad.js, and
// the key presses on Claude Code's picker are in picker.js. Colours come from `theme()` through `t`.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { EFFORTS, EFFORT_LABEL } from "./picker.js";
import { ease, spring } from "./motion.js";
import { FIELD, GAUGE_TICKS, gaugeLabel, gaugeLit, gaugeTone, padPoint, padReadout, padRowLabels } from "./pad.js";

// The pad card. `cb` has onDown(x, y), onMove(x, y), onUp(), onKey(event), and `focus`, the view's FocusHandle.
// x and y are pixels from the field's top left. `opts.slow` stretches the motion, for looking at frames. `drag` is whether a press is held, so a move only counts then.
export function padView(t, pad, cb, drag = false, opts = {}) {
  const read = padReadout(pad);
  const labels = padRowLabels(pad);
  const rows = pad.models.length;
  const rowH = FIELD.height / rows;
  const colW = FIELD.width / EFFORTS.length;
  const at = padPoint(pad.row, pad.col, rows);
  const local = (e) => ({ x: (e.local_position?.x ?? 0) - 1, y: (e.local_position?.y ?? 0) - 1 });

  const dots = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < EFFORTS.length; c++) {
      const p = padPoint(r, c, rows);
      dots.push(div().absolute().left(p.x - 2).top(p.y - 2).size(4).rounded_full().bg(t.dim));
    }
  }

  const field = div().relative().w(FIELD.width + 2).h(FIELD.height + 2).flex_none().overflow_hidden().rounded(10)
    .bg(t.background).border_1().border_color(t.border).cursor_crosshair()
    .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); const p = local(e); cb.onDown(p.x, p.y); })
    .on_mouse_move((e) => { if (drag) { const p = local(e); cb.onMove(p.x, p.y); } })
    .on_mouse_up("left", (_e, cx) => { cx.stop_propagation(); cb.onUp(); })
    .children(dots)
    .child(ease(div().absolute().top(0).w(1).h(FIELD.height).bg(t.border), "left", at.x, "quick", opts))
    .child(ease(div().absolute().left(0).h(1).w(FIELD.width).bg(t.border), "top", at.y, "quick", opts))
    .child(spring(spring(div().absolute().size(22).rounded_full().bg(t.solid).border_1().border_color(t.border), "left", at.x - 11, "pad", opts), "top", at.y - 11, "pad", opts)
      .child(div().absolute().left(6).top(5).size(8).rounded_full().bg(t.accent)));

  const yLabels = v_flex().w(FIELD.labelWidth).flex_none().pt(1)
    .children(labels.map((name, i) => h_flex().h(rowH).items_center().justify_end().text_size(12.5)
      .text_color(i === pad.row ? t.foreground : t.muted).when(i === pad.row, (e) => e.font_medium()).child(name)));

  const xLabels = h_flex().mt(6).w(FIELD.width).children(EFFORTS.map((level, i) => h_flex().w(colW).justify_center().text_size(11.5)
    .text_color(i === pad.col ? t.foreground : t.muted).when(i === pad.col, (e) => e.font_medium()).child(EFFORT_LABEL[level])));

  return v_flex().id("model-pad").w(FIELD.cardWidth).px(12).pt(12).pb(10).rounded(14).bg(t.popover).border_1().border_color(t.border).shadow_lg()
    .track_focus(cb.focus).on_key_down((e, cx) => { cx.stop_propagation(); cb.onKey(e); }).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(h_flex().items_baseline().justify_between().gap(12).mb(10)
      .child(div().text_size(16).font_medium().text_color(t.foreground).child(read.model))
      .child(div().text_size(13).font_medium().text_color(t.accent).child(read.effort)))
    .child(h_flex().gap(8).items_start().child(yLabels).child(v_flex().child(field).child(xLabels)));
}

// The context gauge: 13 ticks, lit from the left as context fills, then the percent. `tip` is the hover text.
export function gaugeView(t, percent, tip) {
  const lit = gaugeLit(percent);
  const color = t[gaugeTone(percent)] ?? t.dim;
  const ticks = [];
  for (let i = 0; i < GAUGE_TICKS; i++) ticks.push(div().w(1.5).h(10).flex_none().bg(i < lit ? color : t.border));
  return h_flex().id("context-gauge").h(30).px(6).gap(7).items_center().rounded(8).flex_none()
    .hover((s) => s.bg(t.hover)).when(Boolean(tip), (e) => e.tooltip(tip))
    .child(h_flex().gap(2).h(10).items_center().children(ticks))
    .child(div().text_size(12.5).font_medium().text_color(t.muted).child(gaugeLabel(percent)));
}
