// Small pieces every Arena surface draws with.

import { div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * kind: "solid" (the primary action), "outline" or "ghost".
 * A disabled button is drawn dim and ignores clicks.
 */
export function button(t, id, label, onClick, { kind = "outline", disabled = false, small = false } = {}) {
  const solid = kind === "solid";
  return h_flex()
    .id(id)
    .flex_none()
    .h(small ? 24 : 30)
    .px(small ? 8 : 12)
    .gap(6)
    .items_center()
    .justify_center()
    .rounded(small ? 6 : 8)
    .text_size(small ? 11.5 : 12)
    .when(kind === "outline", (el) => el.border_1().border_color(t.border))
    .when(solid && !disabled, (el) => el.bg(t.solid).text_color(t.solid_foreground))
    .when(solid && disabled, (el) => el.bg(t.raised).text_color(t.dim))
    .when(!solid, (el) => el.text_color(disabled ? t.dim : t.foreground))
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => (solid ? s.opacity(0.9) : s.bg(t.hover))))
    .when(disabled, (el) => el.cursor_not_allowed())
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => { if (!disabled) onClick(e, cx); })
    .child(label);
}

/** A lane status as one glyph in its color. Working spins natively. */
export function statusIcon(t, status, size = 12) {
  const glyph = {
    waiting: ["!", t.blocked],
    failed: ["✕", t.ansi1],
    stopped: ["■", t.muted],
    notStarted: ["◷", t.muted],
    noReply: ["⚠", t.working],
    finished: ["✓", t.muted],
  }[status];
  const el = div().flex_none().w(size + 4).text_size(size).font_semibold().text_color(glyph?.[1] ?? t.working);
  return status === "working" ? el.frames(SPIN, 90) : el.child(glyph?.[0] ?? "·");
}

/** An agent's icon from the app's program table, or its first letter. */
export function agentIcon(t, agent, size = 14) {
  if (agent?.icon) return agent.tint ? svg(agent.icon).size(size).flex_none().text_color(t.foreground) : image(agent.icon).w(size).h(size).flex_none();
  return div().flex_none().size(size).rounded(3).bg(t.raised).text_size(size * 0.65).text_color(t.muted).flex().items_center().justify_center()
    .child((agent?.name ?? "?").slice(0, 1).toUpperCase());
}

/** A small bordered label: a variant, a mode. */
export const chip = (t, text, color) => div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10.5).text_color(color ?? t.muted).child(text);

/** The dot for an answer the person has not looked at yet. */
export const unreadDot = (t) => div().flex_none().size(7).rounded(4).bg(t.accent);

/** A checkbox drawn by hand (gpui-base's is unstyled). */
export const checkbox = (t, checked) => div().flex_none().size(16).rounded(4).border_1()
  .border_color(checked ? t.accent : t.input).when(checked, (el) => el.bg(t.accent).text_color(t.accent_foreground))
  .text_size(11).flex().items_center().justify_center().child(checked ? "✓" : "");

/** A radio row: a dot, a label and a hint under it. */
export function radio(t, id, selected, label, hint, onSelect, disabled = false) {
  return h_flex().id(id).w_full().h_full().gap(10).items_start().p(8).rounded(8).border_1().border_color(selected ? t.accent : t.border)
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onSelect(cx)))
    .when(disabled, (el) => el.opacity(0.5))
    .child(div().mt(2).flex_none().size(14).rounded(7).border_1().border_color(selected ? t.accent : t.input).flex().items_center().justify_center()
      .child(selected ? div().size(6).rounded(3).bg(t.accent) : ""))
    .child(div().flex_1().min_w(0)
      .child(div().text_size(12.5).text_color(t.foreground).child(label))
      .child(div().text_size(11.5).text_color(t.dim).child(hint)));
}
