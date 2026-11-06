// Draws the / completion card: a card on the composer's own edges, commands in sections under full-width header
// bands, the typed part in the accent colour. A view file: elements out, no state.
//
//   s.rows      completionRows() of the filtered sections
//   s.index     the selected command, counted among commands
//   s.entered   false on the first draw, so the card fades in and rises a few pixels
//   s.scroll    a VirtualListScrollHandle, to follow the selection when the list is longer than the card
//   cb          onPick(index), onHover(index)
import { div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list } from "gpui-base";
import { settings } from "herdr";
import { nameParts, ROW, listHeight, contentHeight, selectedRow } from "./slash.js";

export const MOTION = {
  enter: { duration: 160, easing: "ease-out" },
  rise: 6,
  plate: { response: 200, damping: 0.9 },
  height: { response: 260, damping: 0.92 },
};

const mono = () => settings().font_family ?? "JetBrains Mono";

function header(row, t) {
  return v_flex().w_full().h(row.size).flex_none().justify_end()
    .child(h_flex().h(ROW.head).w_full().items_center().px(16).bg(t.canvas).border_b(1).border_color(t.border).when(!row.first, (e) => e.border_t(1))
      .text_size(12).font_semibold().text_color(t.foreground).child(row.title));
}

function commandRow(row, s, cb, t, plate) {
  const on = row.index === s.index, p = nameParts(row.item);
  return h_flex().id(`slash-${row.item.name}`).w_full().h(ROW.item).flex_none().items_center().gap(12).px(16).cursor_pointer()
    .when(on && !plate, (e) => e.bg(t.raised)).when(!on, (e) => e.hover((x) => x.bg(t.hover)))
    // A virtual list's row renderer can't register handlers: the list's own on_item_click takes presses there.
    .when(plate, (e) => e.on_mouse_move((_e, cx) => cb.onHover(row.index, cx)).on_click((_e, cx) => cb.onPick(row.index, cx)))
    .child(h_flex().flex_1().min_w(0).font_family(mono()).text_size(12.5).font_medium().text_color(t.foreground).truncate()
      .child(p.before).child(div().text_color(t.accent).child(p.match)).child(p.after))
    .child(div().w(20).flex_none().text_size(12).text_color(t.dim).opacity(on ? 1 : 0).child("↵"));
}

// When the list fits, the selection is a plate that springs between rows. When it scrolls, each row paints its own
// highlight, because the plate's place would depend on a scroll position the script doesn't hold, and a virtual list's
// rows can't take hover or click handlers, so the list reports presses by key and hover only tints the row.
export function completionCard(t, s, cb) {
  const rows = s.rows, fits = contentHeight(rows) <= ROW.max, h = listHeight(rows), sel = selectedRow(rows, s.index);
  const body = fits
    ? v_flex().relative().w_full().h(h)
      .when(Boolean(sel), (e) => e.child(div().absolute().left(6).right(6).top(sel.top).h(ROW.item).rounded(8).bg(t.raised).spring("top", MOTION.plate)))
      .children(rows.map((r) => (r.kind === "head" ? header(r, t) : commandRow(r, s, cb, t, true))))
    : v_virtual_list("slash-list", rows.length, rows.map((r) => r.size), (i) => (rows[i].kind === "head" ? `h:${rows[i].title}` : rows[i].item.name),
      (range) => rows.slice(range.start, range.end).map((r) => (r.kind === "head" ? header(r, t) : commandRow(r, s, cb, t, false)))).track_scroll(s.scroll).w_full().h(h)
      .on_item_click((key, cx) => { const r = rows.find((x) => x.kind === "item" && x.item.name === key); if (r) cb.onPick(r.index, cx); });
  return v_flex().w_full().flex_none().rounded(14).overflow_hidden().bg(t.background).border_1().border_color(t.border)
    .relative().top(s.entered ? 0 : MOTION.rise).opacity(s.entered ? 1 : 0)
    .transition("opacity", MOTION.enter).transition("top", MOTION.enter)
    .child(div().w_full().h(h).flex_none().overflow_hidden().spring("height", MOTION.height).child(body));
}

// /exit asks first, because it ends the session. It sits in the same slot as the other cards.
export function exitCard(t, cb) {
  const button = (id, label, solid, onClick) => h_flex().id(id).h(28).px(12).flex_none().items_center().justify_center().rounded(8).cursor_pointer().text_size(12.5).font_medium()
    .when(solid, (e) => e.bg(t.solid).text_color(t.solid_foreground)).when(!solid, (e) => e.border_1().border_color(t.border).text_color(t.foreground).hover((x) => x.bg(t.hover)))
    .on_click((_e, cx) => onClick(cx)).child(label);
  return v_flex().w_full().flex_none().rounded(14).overflow_hidden().bg(t.background).border_1().border_color(t.border)
    .child(v_flex().gap(3).px(14).pt(12).pb(10)
      .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child("End this session?")))
    .child(h_flex().gap(8).justify_end().px(10).pb(10).child(button("exit-keep", "Keep going", false, cb.onKeep)).child(button("exit-end", "End session", true, cb.onEnd)));
}
