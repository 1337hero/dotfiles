// Draws the usage panel: a card between the last response and the composer. A view file, so it returns elements and
// holds no state. `s` is the state, `cb` the callbacks, and colours come from the theme `t` only.
//
//   s.entered     false on the first draw, so bars, height and fades draw once at their start and then change
//   s.height      the panel's height, from usageHeight() in usage-data.js
//   s.tab         "using" or "stats"
//   s.meters      limitMeters()
//   s.detail      { status: "loading" | "ready" | "error", data } for What's using it
//   s.range       the Last 24h or Last 7d label on What's using it
//   s.stats       { all, d7, d30 } from statsView(), or null when the cache is missing
//   s.statsRange  "all", "d7" or "d30"
//   cb            onTab(id), onRange(label), onStatsRange(key), onRefresh(), onClose()
import { div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { settings } from "herdr";
import { blend, compact, dayLabel, duration, heatColors, RANGES, topOf, TOPS_SHOWN, keptOn } from "./usage-data.js";

// These move to motion.js once step 4 is in. Only opacity, width, height, left and top can animate.
export const MOTION = {
  panel: { response: 320, damping: 0.92 },
  thumb: { response: 220, damping: 0.9 },
  fade: { duration: 180, easing: "ease-out" },
  bar: { duration: 520, easing: "ease-out" },
};

const mono = () => settings().font_family ?? "JetBrains Mono";
const TAB_ITEMS = [{ id: "using", label: "What's using it" }, { id: "stats", label: "Stats" }];
const STATS_ITEMS = Object.entries(RANGES).map(([id, label]) => ({ id, label }));
const DAYS = ["", "Mon", "", "Wed", "", "Fri", ""];

// A fade that starts from 0 on the first draw and settles after `delay`.
const fadeIn = (s, delay = 0) => (e) => e.opacity(s.entered ? 1 : 0).transition("opacity", { ...MOTION.fade, delay });

function iconButton(id, icon, label, onClick, t) {
  return h_flex().id(id).size(26).flex_none().items_center().justify_center().rounded(13).cursor_pointer()
    .text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground)).accessibility_label(label)
    .on_click((_e, cx) => onClick(cx)).child(svg(icon).size(14));
}

// A row of choices with a thumb that springs between them. Each choice has a width worked out from its label,
// so the thumb's place is known without measuring anything.
export function segmented({ id, items, value, onPick, t }) {
  const widths = items.map((i) => Math.round(i.label.length * 6.6 + 22));
  const at = Math.max(0, items.findIndex((i) => i.id === value));
  const left = widths.slice(0, at).reduce((a, b) => a + b, 0);
  return h_flex().relative().flex_none().h(30).p(3).rounded(15).bg(t.canvas)
    .child(div().absolute().top(3).left(3 + left).w(widths[at]).h(24).rounded(12).bg(t.raised).spring("left", MOTION.thumb).spring("width", MOTION.thumb))
    .child(h_flex().relative().children(items.map((item, i) => {
      const on = item.id === value;
      return h_flex().id(`${id}-${item.id}`).w(widths[i]).h(24).items_center().justify_center().rounded(12).cursor_pointer().text_size(12.5)
        .text_color(on ? t.foreground : t.muted).on_click((_e, cx) => onPick(item.id, cx)).child(item.label);
    })));
}

// ---- limits ----

function meter(m, i, t, s) {
  const color = t[m.tone] ?? t.done, delay = 120 + i * 50;
  return v_flex().flex_1().min_w(0)
    .child(h_flex().justify_between().gap(8).text_size(12.5).line_height("18px")
      .child(div().min_w(0).truncate().text_color(t.muted).child(m.label))
      .child(div().flex_none().font_semibold().text_color(t.foreground).child(`${Math.round(m.used)}%`)))
    .child(div().relative().h(8).mt(6).mb(5).rounded(2).bg(t.popover)
      .child(div().absolute().top(0).left(0).h(8).rounded(2).bg(color).w(s.entered ? `${Math.min(100, m.used)}%` : "0%").transition("width", { ...MOTION.bar, delay })))
    .child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(m.resets ? `↻ ${m.resets}` : ""));
}

function limits(t, s) {
  if (!s.meters.length) return s.detail.status === "loading" ? loadingLine(t) : div().flex_none().text_size(12.5).text_color(t.dim).child("Limits unavailable");
  return v_flex().flex_none()
    .child(h_flex().gap(20).children(s.meters.map((m, i) => meter(m, i, t, s).when(true, fadeIn(s, 40 + i * 40)))));
}

// ---- What's using it ----

const loadingLine = (t) => h_flex().gap(7).items_center().text_size(12.5).text_color(t.dim)
  .child(div().loop("opacity", { from: 0.4, to: 1, period: 900 }).child("·"));

function adviceRow(a, i, t, s) {
  return v_flex().py(4).child(h_flex().gap(8).items_start().text_size(12.5).line_height("18px")
    .child(div().w(32).flex_none().text_right().text_color(t.muted).child(`${a.pct}%`))
    .child(v_flex().flex_1().min_w(0)
      .child(div().text_color(t.foreground).child(a.text))
      .when(Boolean(a.note), (e) => e.child(div().text_size(12).line_height("16px").text_color(t.dim).child(a.note)))
      .child(div().relative().h(3).mt(4).rounded(2).bg(t.hover)
        .child(div().absolute().top(0).left(0).h(3).rounded(2).bg(t.accent).w(s.entered ? `${Math.min(100, a.pct)}%` : "0%").transition("width", { ...MOTION.bar, delay: 160 + i * 30 })))))
    .when(true, fadeIn(s, i * 22));
}

function topList(top, t, s) {
  const items = top.items.slice(0, TOPS_SHOWN), max = Math.max(1, ...items.map((x) => x.pct));
  if (!items.length) return null;
  return v_flex().gap(2).mt(9)
    .child(div().text_size(12).line_height("18px").font_medium().text_color(t.dim).mb(1).child(top.title))
    .children(items.map((x, i) => h_flex().gap(8).items_center().h(21).text_size(12.5)
      .child(div().relative().flex_1().min_w(0).h(21).rounded(4).overflow_hidden()
        .child(div().absolute().top(0).left(0).h(21).rounded(4).bg(t.hover).w(s.entered ? `${Math.round(x.pct / max * 100)}%` : "0%").transition("width", { ...MOTION.bar, delay: 200 + i * 18 }))
        .child(div().relative().px(6).h(21).flex().items_center().truncate().font_family(mono()).text_size(12).text_color(t.foreground).child(x.name)))
      .child(div().w(34).flex_none().text_right().text_color(t.muted).child(`${x.pct}%`))));
}

function using(t, s, cb) {
  const d = s.detail;
  if (d.status === "loading") return loadingLine(t);
  if (d.status === "untrusted") return div().text_size(12.5).text_color(t.foreground).child("Folder not trusted");
  if (d.status === "error") return div().text_size(12.5).text_color(t.foreground).child(d.reason ? `Couldn't read: ${d.reason}` : "Couldn't read");
  const ranges = d.data.ranges, r = ranges.find((x) => x.label === s.range) ?? ranges[0];
  const items = ranges.map((x) => ({ id: x.label, label: x.label }));
  return v_flex().gap(12)
    .child(h_flex().items_center().justify_between().gap(10).min_h(30)
      .child(div().text_size(12.5).text_color(t.dim).child(`${r.requests.toLocaleString("en-GB")} requests · ${r.sessions.toLocaleString("en-GB")} sessions`))
      .child(segmented({ id: "range", items, value: r.label, onPick: (id, cx) => cb.onRange(id, cx), t })))
    .child(h_flex().gap(22).items_start()
      .child(v_flex().flex_1().min_w(0).children(r.advice.map((a, i) => adviceRow(a, i, t, s))))
      .child(v_flex().flex_1().min_w(0).children([topList(topOf(r, "Top skills"), t, s), topList(topOf(r, "Top subagents"), t, s)].filter(Boolean))));
}

// ---- Stats ----

// The grid drawn as painted paths, one per fill, not an element per day. The 189 days as elements were stopped at the
// 55 ms render limit on 17 of 41 renders in the private window, and as paths on 1 of 28.
// `s.heatCell` is a cell's side in pixels.
function heat(v, t, s) {
  const colors = heatColors(t.done, t.canvas);
  const grid = v.heat, cell = s.heatCell ?? 13, gap = 2, pitch = cell + gap, cut = 1.5;
  // The panel draws again with the chat, so the paths are kept on the range they came from, and `v` is replaced by a refresh.
  const painted = keptOn(v, "heatPaths", `${t.done}|${t.canvas}|${cell}`, () => {
    const dim = colors.map((c) => blend(c, t.canvas, 0.32)), paths = new Map();
    grid.weeks.forEach((week, w) => week.forEach((c, d) => {
      if (c.future) return;
      const color = c.date >= v.from ? colors[c.level] : dim[c.level];
      let b = paths.get(color);
      if (!b) { b = PathBuilder.fill(); paths.set(color, b); }
      const x = w * pitch, y = d * pitch, r = x + cell, bt = y + cell;
      // A square with its corners cut, which reads as rounded at this size.
      b.add_polygon([[x + cut, y], [r - cut, y], [r, y + cut], [r, bt - cut], [r - cut, bt], [x + cut, bt], [x, bt - cut], [x, y + cut]], true);
    }));
    return [...paths].map(([color, b]) => [color, b.build()]);
  });
  const width = grid.weeks.length * pitch - gap, height = 7 * pitch - gap;
  return v_flex()
    .child(h_flex().gap(6)
      .child(div().w(30).flex_none())
      .child(div().relative().w(width).h(16).text_size(11.5).text_color(t.dim)
        .children(grid.months.map((m) => div().absolute().top(0).left(m.col * pitch).child(m.name)))))
    .child(h_flex().gap(6)
      .child(v_flex().w(30).flex_none().gap(gap).text_size(11.5).text_color(t.dim)
        .children(DAYS.map((d) => div().h(cell).flex().items_center().child(d))))
      .child(div().relative().w(width).h(height).flex_none()
        .opacity(s.entered ? 1 : 0).transition("opacity", { duration: 260, easing: "ease-out" })
        .children(painted.map(([color, path]) => window.paint_path(path, color).absolute().top(0).left(0).w(width).h(height)))));
}

const figure = (label, value, unit, first, t) => v_flex().flex_1().min_w(0).when(!first, (e) => e.pl(16).border_l(1).border_color(t.border))
  .child(div().text_size(12).line_height("16px").text_color(t.dim).child(label))
  .child(h_flex().items_baseline().gap(1).h(26).child(div().truncate().text_size(18).font_medium().text_color(t.foreground).child(value))
    .when(Boolean(unit), (e) => e.child(div().flex_none().text_size(12.5).text_color(t.dim).child(unit))));

function stats(t, s, cb) {
  if (!s.stats) return div().text_size(12.5).text_color(t.foreground).child("No stats");
  const v = s.stats[s.statsRange] ?? s.stats.all, f = v, n = (x) => x.toLocaleString("en-GB");
  return v_flex().gap(13)
    .child(h_flex().items_center().justify_between().gap(10).min_h(30)
      .child(div().text_size(12.5).text_color(t.dim).child(`Through ${dayLabel(f.to)}`))
      .child(segmented({ id: "stats-range", items: STATS_ITEMS, value: v.key, onPick: (id, cx) => cb.onStatsRange(id, cx), t })))
    .child(heat(v, t, s))
    .child(v_flex().gap(12)
      .child(h_flex().gap(0)
        .child(figure("Favourite model", f.favourite ?? "-", "", true, t)).child(figure("Total tokens", compact(f.tokens), "", false, t))
        .child(figure("Sessions", n(f.sessions), "", false, t)).child(figure("Longest session", f.longest === undefined ? "..." : f.longest ? duration(f.longest) : "-", "", false, t)))
      .child(h_flex().gap(0)
        .child(figure("Active days", String(f.activeDays), `/${f.span}`, true, t)).child(figure("Longest streak", String(f.longestStreak), " days", false, t))
        .child(figure("Current streak", String(f.currentStreak), " days", false, t)).child(figure("Most active day", dayLabel(f.topDay), "", false, t))))
    .child(div().text_size(12).text_color(t.dim).child(`Input ${compact(v.totals.input)} · Output ${compact(v.totals.output)} · Cache read ${compact(v.totals.cacheRead)} · Cache write ${compact(v.totals.cacheWrite)}`));
}

// ---- the panel ----

// The wrapper's height springs from 0 to the card's, and the card keeps its full height inside it, so nothing reflows
// while it opens. 8px under it is the gap above the composer.
export function usagePanel(t, s, cb) {
  const card = v_flex().w_full().h(s.height).flex_none().rounded(14).overflow_hidden().bg(t.background).border_1().border_color(t.border)
    .child(h_flex().h(41).flex_none().items_center().gap(8).pl(14).pr(8).border_b(1).border_color(t.border)
      .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child("Usage"))
      .child(div().flex_1())
      .child(iconButton("usage-refresh", "mods/claude-chat/refresh.svg", "Refresh usage", (cx) => cb.onRefresh(cx), t))
      .child(iconButton("usage-close", "mods/claude-chat/close.svg", "Close usage", (cx) => cb.onClose(cx), t)))
    .child(v_flex().id("usage-body").flex_1().min_h(0).overflow_y_scroll().px(14).pt(12).pb(14)
      .child(limits(t, s))
      .child(v_flex().flex_none().mt(13).pt(12).border_t(1).border_color(t.border).gap(12)
        .child(segmented({ id: "tab", items: TAB_ITEMS, value: s.tab, onPick: (id, cx) => cb.onTab(id, cx), t }))
        .child(s.tab === "stats" ? stats(t, s, cb) : using(t, s, cb))));
  return v_flex().w_full().flex_none().overflow_hidden().h(s.entered ? s.height + 8 : 0).spring("height", MOTION.panel).child(card);
}
