// Live Routing for Magpie, using the gateway's own trace and the original
// Routing page's geometry, palette, native easing and flight timings.
// Source: yetone/magpie v0.1.3471, internal/gui/assets/plugins/routing.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { layout, theme } from "herdr";
import { stage } from "./stage.js";
import { agentName, callerName, caption, hueOf, modeOf, normalize, routeStatus, sourceOf, stagedRoutes } from "./trace.js";

const TRACE = "http://127.0.0.1:3425/v1/magpie/trace";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function shown() {
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
  return Boolean(panel && !panel.hidden && body?.active === "routing");
}

function wait(cx, ms) {
  return new Promise((resolve) => cx.timer.after(ms, () => resolve()));
}

function clock(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default class Routing extends View {
  init(_props, cx) {
    this.routes = new Map();
    this.seq = 0;
    this.totals = { requests: 0, rerouted: 0, errors: 0 };
    this.hues = new Map();
    this.loaded = false;
    this.current = null;
    this.pinned = null;
    this.error = null;
    this.skew = 0;
    this.stageWidth = 0;
    cx.spawn((cx) => this.poll(cx));
  }

  async poll(cx) {
    for (;;) {
      const visible = shown();
      try {
        const query = `?after=${this.seq}${this.loaded && visible ? "&wait=1" : ""}`;
        const response = await fetch(TRACE + query);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const data = await response.json();
        if (data.object !== "trace" || !Array.isArray(data.routes)) throw new Error("Unexpected trace response");
        if (data.seq < this.seq) {
          this.routes.clear();
          this.current = null;
          this.pinned = null;
          this.loaded = false;
        }
        this.seq = data.seq;
        this.totals = data.totals || this.totals;
        this.skew = Date.parse(data.now) - Date.now();
        for (const route of data.routes) this.routes.set(route.id, normalize(route));
        if (Array.isArray(data.ids)) {
          const kept = new Set(data.ids);
          for (const [id, route] of this.routes) if (!route.done && !kept.has(id)) this.routes.delete(id);
        }
        for (const id of [...this.routes.keys()].sort((a, b) => a - b).slice(0, -60)) this.routes.delete(id);
        const newest = [...this.routes.values()].reduce((a, b) => !a || b.id > a.id ? b : a, null);
        if (this.pinned && !this.routes.has(this.pinned)) this.pinned = null;
        const current = this.current && this.routes.get(this.current.id);
        this.current = this.pinned ? this.routes.get(this.pinned) : current && !current.done ? current : newest;
        this.error = null;
        this.loaded = true;
        cx.notify();
      } catch (error) {
        this.error = "Cannot reach Magpie’s gateway at 127.0.0.1:3425.";
        cx.notify();
        await wait(cx, 3000);
        continue;
      }
      if (!visible) await wait(cx, 2000);
    }
  }

  stat(value, label) {
    const t = theme();
    return v_flex().min_w(54).gap(1)
      .child(div().text_size(19).font_semibold().text_color(t.foreground).child(String(value || 0)))
      .child(div().text_size(10.5).text_color(t.muted).child(label));
  }

  requestRow(r, t) {
    const active = this.current?.id === r.id;
    const failed = r.done && (r.status >= 400 || r.fail);
    const color = r.done ? failed ? t.ansi1 : t.ansi2 : this.hues.get(sourceOf(r)) || t.working;
    return h_flex().id(`route-${r.id}`).w_full().h(48).flex_none().px(10).gap(9).items_center().rounded(8)
      .bg(active ? t.selected : t.background).hover((s) => s.bg(t.hover)).cursor_pointer()
      .on_click((_e, cx) => { this.pinned = r.id; this.current = r; cx.notify(); })
      .child(div().size(7).flex_none().rounded_full().bg(color)
        .when(!r.done, (el) => el.loop("opacity", { from: .45, to: 1, period: 1800 })))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().min_w(0).gap(7).items_center()
          .child(div().min_w(0).flex_1().truncate().text_size(12).font_semibold().child(callerName(r)))
          .child(div().max_w(180).truncate().text_size(10.5).text_color(t.muted).child(r.model)))
        .child(div().truncate().text_size(11).text_color(failed ? t.ansi1 : t.muted).child(routeStatus(r))))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(clock(r.time)));
  }

  render(cx) {
    const t = theme();
    const current = this.current;
    const routes = current ? stagedRoutes(this.routes, current, Date.now() + this.skew) : [];
    for (const r of routes) hueOf(sourceOf(r), this.hues);
    const mode = current ? modeOf(current) : null;
    const recent = [...this.routes.values()].sort((a, b) => b.id - a.id).slice(0, 12);
    const live = [...this.routes.values()].some((r) => !r.done);
    return v_flex().id("routing").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border(1).border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/routing/routing.svg").size(16).text_color(t.muted))
        .child(div().font_semibold().child("Routing"))
        .child(div().size(6).rounded_full().bg(live ? t.working : t.dim)
          .when(live, (el) => el.loop("opacity", { from: .4, to: 1, period: 1800 })))
        .child(div().text_size(10.5).text_color(t.dim).child("live, as the gateway decides"))
        .child(div().flex_1())
        .when(Boolean(this.pinned), (el) => el.child(div().id("routing-live").px(7).py(2).rounded(5).text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover)).cursor_pointer()
          .on_click((_e, cx) => { this.pinned = null; this.current = [...this.routes.values()].reduce((a, b) => !a || b.id > a.id ? b : a, null); cx.notify(); }).child("Live ›"))))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(12)
        .child(v_flex().w_full().flex_none().rounded(14).border(1).border_color(t.border).bg(t.surface).p(14).gap(10)
          .child(v_flex().gap(3)
            .child(h_flex().gap(5).items_baseline()
              .child(div().font_semibold().child(current ? current.group?.name || mode.first?.name || current.provider || agentName(current.agent) : "Magpie routing"))
              .when(Boolean(current), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(`· ${current.order.filter((w) => !w.fallback).length} on`))))
            .child(div().text_size(11.5).text_color(t.muted).child(current ? mode.description : "Requests fly from each agent through magpie to the account routing put first.")))
          .when(Boolean(this.error), (el) => el.child(div().p(10).rounded(8).bg(t.raised).text_size(11.5).text_color(t.ansi1).child(this.error)))
          .when(!current && !this.error, (el) => el.child(v_flex().h(150).items_center().justify_center().gap(8).text_color(t.muted)
            .child(svg("mods/routing/magpie.svg").size(36).text_color(t.dim))
            .child(div().child("No request yet"))
            .child(div().text_size(11).text_color(t.dim).child("Send a request through Magpie to watch it route."))))
          .when(Boolean(current), (el) => el.child(stage(routes, current, this.stageWidth || 320, cx, t, this.hues, (width, cx) => { this.stageWidth = width; cx.notify(); })))
          .child(v_flex().gap(8).pt(10).border_t(1).border_color(t.border)
            .child(div().text_size(12).text_color(t.foreground).child(caption(current)))
            .child(h_flex().gap(18).flex_wrap()
              .child(this.stat(this.totals.requests, "requests"))
              .child(this.stat(this.totals.rerouted, "rerouted"))
              .child(this.stat(this.totals.errors, "errors your agent saw")))))
        .child(v_flex().w_full().flex_none().gap(6)
          .child(h_flex().px(2).items_center()
            .child(div().font_semibold().child("Requests"))
            .child(div().flex_1())
            .child(div().text_size(10.5).text_color(t.dim).child(`${this.totals.requests || 0} since the gateway started`)))
          .child(v_flex().gap(3).children(recent.map((r) => this.requestRow(r, t))))
          .when(!recent.length, (el) => el.child(div().p(10).text_size(11.5).text_color(t.dim).child("Requests kept by Magpie appear here.")))));
  }
}
