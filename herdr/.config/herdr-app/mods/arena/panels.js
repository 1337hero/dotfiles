// The smaller surfaces: a lane's diff (a dialog), and the side-by-side view's
// bar and column heads (blocks in an overlay layout of live terminals).

import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { terminals, agents, theme, props, closeOverlay, settings, run } from "herdr";
import { getRun, laneStatuses } from "./store.js";
import { resolveLaneStatus, LANE_STATUS_LABEL } from "./lib/status.js";
import { laneLabel } from "./lib/names.js";
import { diffRows } from "./lib/diff.js";
import { laneDiffText } from "./actions.js";
import { button, statusIcon, agentIcon } from "./ui.js";

export class DiffPanel {
  init(cx) {
    const { run: runId, member: memberId } = props().diff;
    this.runId = runId;
    this.member = getRun(runId)?.members.find((m) => m.id === memberId) ?? null;
    this.rows = [];
    this.error = null;
    this.loading = true;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      try {
        const text = this.member ? await laneDiffText(this.member) : "";
        this.rows = diffRows(text);
        this.files = this.rows.filter((r) => r.kind === "file").length;
      } catch (e) { this.error = String(e?.message ?? e); }
      this.loading = false;
      cx.notify();
    });
  }

  row({ kind, number, text }, t) {
    if (kind === "file") return div().w_full().h(26).flex_none().px(12).flex().items_center().bg(t.raised).border_t(1).border_color(t.border).font_semibold().text_color(t.foreground).truncate().child(text);
    if (kind === "meta") return div().w_full().h(20).flex_none().px(12).truncate().text_color(t.dim).child(text);
    if (kind === "@") return div().w_full().h(20).flex_none().px(12).truncate().bg(t.hover).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10)
      .when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(40).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(10).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind === " " ? "" : kind))
      .child(div().flex_1().min_w(0).whitespace_nowrap().child(text));
  }

  render() {
    const t = theme();
    const r = getRun(this.runId);
    const m = this.member;
    return v_flex().id("diff").track_focus(this.handle)
      .on_key_down((e) => { if (e.key === "escape" || e.key === "q") closeOverlay(props().overlay); })
      .size_full().bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().h(44).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
        .child(agentIcon(t, m?.agent, 15))
        .child(div().font_semibold().child(m && r ? laneLabel(m, r.variants.length) : "Diff"))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(m?.branch ? `⎇ ${m.branch} · since ${String(m.start).slice(0, 8)}` : ""))
        .child(div().text_size(11.5).text_color(t.dim).child(this.loading ? "Reading…" : (this.files === 1 ? "1 file" : `${this.files ?? 0} files`)))
        .child(button(t, "diff-close", "Esc", () => closeOverlay(props().overlay), { kind: "ghost", small: true })))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5)
        .when(Boolean(this.error), (el) => el.child(div().p(14).text_color(t.ansi1).child(this.error)))
        .when(!this.error, (el) => el
          .child(v_virtual_list("diff-rows", this.rows.length, this.rows.map((r) => (r.kind === "file" ? 26 : 20)), (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.row(row, t))).size_full())
          .child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0())));
  }
}

/** The side-by-side view's top bar: the run, its lanes' states, and a way out (Esc goes to the terminals). */
export class CompareBar {
  init() {}
  render() {
    const t = theme();
    const r = getRun(props().bar);
    const close = () => closeOverlay(props().overlay);
    return h_flex().id("compare-bar").size_full().px(14).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border).text_color(t.foreground)
      .child(div().text_size(13).font_semibold().child(`Arena · ${r?.title ?? "Run"}`))
      .child(div().flex_1().text_size(11.5).text_color(t.dim).child("Live terminals, side by side. Type into any of them."))
      .when(Boolean(r?.overviewTab), (el) => el.child(button(t, "to-overview", "Overview", () => { close(); run("tab.select", { id: r.overviewTab }); }, { kind: "ghost", small: true })))
      .child(button(t, "compare-close", "✕ Close", close, { small: true }));
  }
}

/** One column's head in the side-by-side view. */
export class LaneHead {
  init() {}
  render() {
    const t = theme();
    const { run: runId, member: memberId } = props().head;
    const r = getRun(runId);
    const m = r?.members.find((x) => x.id === memberId);
    if (!m) return div().size_full().bg(t.chrome);
    const terminal = terminals().find((x) => x.address === m.terminal) ?? null;
    const agent = agents().find((a) => a.address === m.terminal) ?? null;
    // The overview reads answers; its status is the one to show. Without an overview, the terminal alone.
    const published = laneStatuses()[runId]?.[memberId];
    const status = published ?? resolveLaneStatus({ terminal, agent, reply: null });
    return h_flex().id("lane-head").size_full().px(10).gap(8).items_center().bg(t.chrome).text_size(12).text_color(t.foreground)
      .child(agentIcon(t, m.agent, 13))
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(laneLabel(m, r.variants.length)))
      .child(statusIcon(t, status, 11).tooltip(LANE_STATUS_LABEL[status]));
  }
}
