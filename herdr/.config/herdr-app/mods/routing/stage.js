import { PathBuilder, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { accountName, accountState, activeTry, callerName, hueOf, modeOf, seat, sourceOf, triedSeat } from "./trace.js";

const NODE = 94;
const SMALL_NODE = 78;
const ROW = 61;
const GAP = 7;

function geometry(routes, width) {
  const w = Math.max(300, width || 300);
  const narrow = w < 600;
  const agents = [...new Set(routes.map(sourceOf))];
  const accounts = [], seen = new Set();
  for (const r of routes) {
    for (const account of [...r.order, ...r.left]) {
      const id = seat(account);
      if (seen.has(id)) continue;
      seen.add(id);
      accounts.push({ account, route: r, id });
    }
  }
  const nodeH = agents.length > 1 ? SMALL_NODE : NODE;
  const sourcesH = agents.length * nodeH + Math.max(0, agents.length - 1) * 10;
  const accountsH = accounts.length * ROW + Math.max(0, accounts.length - 1) * GAP;
  const sources = new Map(), seats = new Map();
  let hub, height;
  if (narrow) {
    const nodeW = (w - 28) / 2;
    agents.forEach((id, i) => sources.set(id, { x: 0, y: 16 + i * (nodeH + 10), w: nodeW, h: nodeH }));
    hub = { x: nodeW + 28, y: 16 + Math.max(0, sourcesH - NODE) / 2, w: nodeW, h: NODE };
    const top = 16 + Math.max(sourcesH, NODE) + 26;
    accounts.forEach((a, i) => seats.set(a.id, { x: 22, y: top + i * (ROW + GAP), w: w - 22, h: ROW }));
    height = top + accountsH + 16;
  } else {
    const sourceW = Math.max(124, Math.min(180, w * .15));
    const hubW = Math.max(124, Math.min(180, w * .15));
    const hubX = sourceW + 56, accountX = hubX + hubW + 56;
    const contentH = Math.max(sourcesH, NODE, accountsH);
    agents.forEach((id, i) => sources.set(id, { x: 0, y: 22 + (contentH - sourcesH) / 2 + i * (nodeH + 10), w: sourceW, h: nodeH }));
    hub = { x: hubX, y: 22 + (contentH - NODE) / 2, w: hubW, h: NODE };
    accounts.forEach((a, i) => seats.set(a.id, { x: accountX, y: 22 + (contentH - accountsH) / 2 + i * (ROW + GAP), w: w - accountX, h: ROW }));
    height = contentH + 44;
  }
  return { w, narrow, agents, accounts, sources, seats, hub, height: Math.max(148, height) };
}

function curve(path, from, to, horizontal = true) {
  const x0 = horizontal ? from.x + from.w : from.x + from.w / 2;
  const y0 = horizontal ? from.y + from.h / 2 : from.y + from.h;
  const x3 = to.x, y3 = to.y + to.h / 2;
  path.move_to(x0, y0);
  if (horizontal) {
    const mx = (x0 + x3) / 2;
    path.cubic_bezier_to(x3, y3, mx, y0, mx, y3);
  } else {
    const x = x3 - 12, y = Math.max(y0, from.y + from.h + 2);
    path.line_to(x0, y).cubic_bezier_to(x, y + 24, x0, y + 22, x, y + 2)
      .line_to(x, y3 - 10).curve_to(x3, y3, x, y3);
  }
  return path;
}

function wire(cx, from, to, narrow, color, live, id) {
  const path = PathBuilder.stroke(1.5);
  if (live) path.dash_array([3, 5]);
  curve(path, from, to, !narrow);
  let el = window.paint_path(path.build(), color).id(`wire-${id}`).absolute().left(0).top(0).size_full();
  if (live) el = el.loop("opacity", { from: .45, to: 1, period: 1200 });
  return el;
}

function agentCard(id, route, box, color, t) {
  return v_flex().id(`agent-${id}`).absolute().left(box.x).top(box.y).w(box.w).h(box.h).px(8).py(9).gap(2).items_center().justify_center()
    .rounded(12).border(1).border_color(t.border).bg(t.surface)
    .child(svg("mods/routing/agent.svg").size(26).text_color(t.foreground))
    .child(h_flex().max_w_full().items_center().gap(6)
      .child(div().size(7).flex_none().rounded_full().bg(color))
      .child(div().min_w(0).truncate().text_size(13).font_semibold().child(callerName(route))))
    .child(div().max_w_full().truncate().text_size(11).text_color(t.muted).child(route.model));
}

function hubCard(box, route, t) {
  const mode = modeOf(route);
  const count = route.group?.members?.length || route.order.filter((w) => !w.fallback).length;
  return v_flex().id("routing-hub").absolute().left(box.x).top(box.y).w(box.w).h(box.h).px(8).py(9).gap(2).items_center().justify_center()
    .rounded(12).border(1).border_color(t.foreground).bg(t.surface).shadow_sm()
    .child(svg("mods/routing/magpie.svg").size(26).text_color(t.foreground))
    .child(div().text_size(13).font_semibold().child("magpie"))
    .child(div().text_size(11).text_color(t.muted).child("127.0.0.1:3425"))
    .when(count > 0, (el) => el.child(div().mt(4).px(8).py(1).rounded_full().bg(t.foreground).text_color(t.surface).text_size(10.5).child(mode.name)));
}

function accountCard(entry, box, color, t) {
  const { account: w, route: r, id } = entry;
  const state = accountState(r, w);
  const on = state.active || state.answered;
  const title = accountName(w);
  const model = `${w.model || ""}${w.fixed ? `:${w.fixed}` : ""}`;
  return v_flex().id(`account-${id}`).absolute().left(box.x).top(box.y).w(box.w).h(box.h).px(11).py(7).gap(3).justify_center()
    .rounded(10).border(1).border_color(state.failed ? t.ansi1 : on ? t.foreground : t.border).bg(t.surface)
    .child(h_flex().min_w(0).gap(9).items_center()
      .child(div().size(8).flex_none().rounded_full().border(1).border_color(on ? t.foreground : t.muted).bg(on ? t.foreground : t.surface)
        .when(state.active, (el) => el.loop("opacity", { from: .45, to: 1, period: 1800 })))
      .child(div().min_w(0).flex_1().truncate().text_size(13).font_semibold().child(title))
      .when(Boolean(w.plan), (el) => el.child(div().max_w(90).truncate().text_size(11).text_color(t.muted).child(w.plan)))
      .child(div().max_w(150).flex_none().truncate().px(5).rounded(5).bg(t.raised).text_size(10.5).text_color(t.muted).child(model)))
    .child(div().pl(17).truncate().text_size(11).text_color(state.failed ? t.ansi1 : on ? t.foreground : t.muted).child(state.status))
    .when(w.known && !w.free && w.balance == null, (el) => el.child(div().absolute().left(39).right(11).bottom(5).h(2).rounded(1).bg(t.raised)
      .child(div().h_full().rounded(1).bg(on ? t.foreground : t.muted).w(`${Math.max(0, Math.min(100, w.used || 0))}%`).transition("width", { duration: 400 }))));
}

function flight(id, from, to, narrow, color, t, period) {
  const x0 = narrow ? from.x + from.w / 2 : from.x + from.w;
  const y0 = narrow ? from.y + from.h : from.y + from.h / 2;
  const x3 = to.x, y3 = to.y + to.h / 2;
  return div().id(`flight-${id}`).absolute().left(x0 - 22).top(y0 - 13).w(44).h(30)
    .loop("left", { from: x0 - 22, to: x3 - 22, period, easing: "ease-in-out" })
    .loop("top", { from: y0 - 13, to: y3 - 13, period, easing: "ease-in-out" })
    .child(svg("mods/routing/flier.svg").size(34).text_color(t.foreground))
    .child(div().absolute().right(3).top(10).size(9).rounded_full().bg(color));
}

export function stage(routes, current, width, cx, t, hues, onSize) {
  const g = geometry(routes, width);
  const liveSeats = new Set(), answeredSeats = new Set();
  for (const r of routes) {
    for (const tr of r.tries) {
      const id = triedSeat(r, tr);
      if (!tr.done) liveSeats.add(id);
      else if (tr.status < 400 && !tr.fail) answeredSeats.add(id);
    }
  }
  const root = div().id("routing-stage").relative().w_full().h(g.height).flex_none()
    .on_size_change((size, cx) => onSize(size.width, cx));
  const sourceRoutes = new Map(g.agents.map((id) => [id, [...routes].reverse().find((r) => sourceOf(r) === id)]));
  for (const [id, from] of g.sources) {
    const r = sourceRoutes.get(id), color = hues.get(id) || hueOf(id, hues);
    root.child(wire(cx, from, g.hub, false, r.done && !r.tries.some((tr) => !tr.done) ? t.border : color, !r.done, `agent-${id}`));
  }
  for (const entry of g.accounts) {
    const to = g.seats.get(entry.id), color = hues.get(sourceOf(entry.route)) || t.muted;
    root.child(wire(cx, g.hub, to, g.narrow, liveSeats.has(entry.id) || answeredSeats.has(entry.id) ? color : t.border, liveSeats.has(entry.id), entry.id));
  }
  for (const [id, box] of g.sources) {
    const color = hues.get(id) || hueOf(id, hues);
    root.child(agentCard(id, sourceRoutes.get(id), box, color, t));
  }
  root.child(hubCard(g.hub, current, t));
  for (const entry of g.accounts) root.child(accountCard(entry, g.seats.get(entry.id), hues.get(sourceOf(entry.route)), t));
  for (const r of routes) {
    if (r.done) continue;
    const from = g.sources.get(sourceOf(r));
    if (!from) continue;
    const tr = activeTry(r), color = hues.get(sourceOf(r)) || t.muted;
    if (!tr) root.child(flight(r.id, from, g.hub, false, color, t, 1240));
    else {
      const to = g.seats.get(triedSeat(r, tr));
      if (to) {
        root.child(flight(r.id, g.hub, to, g.narrow, color, t, 1800));
        root.child(div().id(`held-${r.id}`).absolute().left(to.x - 4).top(to.y + to.h / 2 - 4).size(8).rounded_full().bg(color)
          .loop("opacity", { from: .45, to: 1, period: 1200 }));
      }
    }
  }
  return root;
}
