// A run's overview: one card per lane with its status, latest answer, changes
// and time, and the actions that end a run: keep one, fuse several, archive.
// It is a mod pane, the only pane of the run's "Arena · <title>" tab.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { terminals, agents, theme, props, run, openOverlay, notify, hc } from "herdr";
import { getRun, updateRun, updateMember, publishStatuses } from "./store.js";
import { resolveLaneStatus, isSettled, laneSig, needsRead, readSettled, LANE_STATUS_ORDER, LANE_STATUS_LABEL, CARD_BODY, statusCount, formatDuration } from "./lib/status.js";
import { laneLabel } from "./lib/names.js";
import { fusionModeFor } from "./lib/fusion.js";
import * as A from "./actions.js";
import { loadAgents, customAgent, agentList } from "./agents.js";
import { button, statusIcon, agentIcon, chip, unreadDot, checkbox } from "./ui.js";

const CARD_MIN = 280, GAP = 10, MAX_WIDTH = 1024;

export class Overview {
  init(cx) {
    this.runId = props()?.run;
    this.summaries = {}; // member id → { sig, reply, diff }
    this.loading = new Set();
    this.foreground = {}; // member id → the foreground program of a lane with no agent
    this.asking = new Set();
    this.bar = { kind: "idle" }; // | { kind: "keep", member } | { kind: "fuse", excluded: Set }
    this.busy = null; // "keep" | "fuse" | "archive" | "add" | "member"
    this.width = 900;
    this.expanded = new Set();
    this.renaming = false;
    this.renameInput = InputState.new({ placeholder: "Run title" });
    this.renameInput.on("submit", (_e, cx) => this.finishRename(cx));
    this.renameInput.on("blur", (_e, cx) => this.finishRename(cx));
    this.agents = [];
    this.picking = null; // { purpose: "add", variant } | { purpose: "judge" }
    this.command = InputState.new({ placeholder: "claude --model haiku" });
    this.commandFocused = false;
    this.command.on("focus", (_e, cx) => { this.commandFocused = true; cx.notify(); });
    this.command.on("blur", (_e, cx) => { this.commandFocused = false; cx.notify(); });
    this.command.on("submit", (_e, cx) => {
      const agent = customAgent(this.command.value(), this.agents);
      if (agent) { this.command.set_value(""); this.picked(agent, cx); }
    });
    cx.spawn(async (cx) => { this.agents = await loadAgents(); cx.notify(); });
    this.tick(cx);
    cx.timer.every(1000, (cx) => this.tick(cx));
  }

  get run() { return getRun(this.runId); }

  facts(member) {
    const terminal = terminals().find((t) => t.address === member.terminal) ?? null;
    const agent = agents().find((a) => a.address === member.terminal) ?? null;
    const summary = this.summaries[member.id];
    const sig = laneSig(terminal, agent);
    // A read from before this turn says nothing about it: until the new one
    // lands, the lane goes by its terminal alone.
    const reply = summary?.sig === sig ? summary.reply : undefined;
    // A terminal that was just asked for may not be listed yet.
    const young = !terminal && Date.now() - (member.created ?? 0) < 8000;
    const foreground = this.foreground[member.id] ?? null;
    return { terminal, agent, summary, sig, status: young ? "notStarted" : resolveLaneStatus({ terminal, agent, reply, foreground }) };
  }

  /**
   * Reads each lane's answer and changes once per turn: when its agent status,
   * turn count or terminal state moves. Records when a lane stopped working,
   * and starts automatic fusion once every lane has settled.
   */
  tick(cx) {
    const r = this.run;
    if (!r) return;
    let live = false;
    for (const member of r.members) {
      const { terminal, agent, status, sig } = this.facts(member);
      // Without an agent and a turn, the foreground program tells setup from a quit agent.
      if (!agent && terminal?.state === "live" && !(terminal.turn > 0)) this.askForeground(member, cx);
      else delete this.foreground[member.id];
      // A lane's time runs from its start to the end of its last turn.
      if (status === "working") {
        live = true;
        if (member.endedAt) updateMember(r.id, member.id, (m) => { m.endedAt = null; });
      } else if (isSettled(status) && !member.endedAt && ((terminal?.turn ?? 0) > 0 || status === "failed")) updateMember(r.id, member.id, (m) => { m.endedAt = Date.now(); });
      const last = this.summaries[member.id];
      if (status === "working" || this.loading.has(member.id) || !needsRead(last, sig, Date.now())) continue;
      this.loading.add(member.id);
      const tries = last?.sig === sig ? last.tries + 1 : 0;
      cx.spawn(async (cx) => {
        const [reply, diff] = await Promise.all([A.laneReply(r.id, member), A.laneChanges(member)]);
        this.summaries[member.id] = { sig, reply, diff, tries, at: Date.now() };
        this.loading.delete(member.id);
        cx.notify();
      });
    }
    this.publish(r);
    this.autoFuse(cx);
    if (live) cx.notify();
  }

  askForeground(member, cx) {
    if (this.asking.has(member.id)) return;
    this.asking.add(member.id);
    cx.spawn(async (cx) => {
      try {
        const got = await hc(["get", member.terminal, "--json"]);
        this.foreground[member.id] = JSON.parse(got.stdout || "{}")?.foreground ?? null;
      } catch { /* asked again on the next tick */ }
      this.asking.delete(member.id);
      cx.notify();
    });
  }

  /**
   * Lane statuses for the side-by-side heads, which can't read answers
   * themselves. Written only when one changes.
   */
  publish(r) {
    publishStatuses(r.id, Object.fromEntries(r.members.map((m) => [m.id, this.facts(m).status])));
  }

  /**
   * Automatic fusion starts once every lane has settled and its last read is
   * of its current turn and final, so no lane is left out on a stale read.
   * With fewer than two finished lanes there is nothing to fuse: it says so
   * once, and stops promising.
   */
  autoFuse(cx) {
    const r = this.run;
    if (!r?.autoFusion || r.autoFused || r.launching || this.busy) return;
    const lanes = r.members.filter((m) => m.role === "run");
    // Fewer than two lanes started: nothing to compare, and nothing to promise.
    if (lanes.length < 2) {
      A.skipAutoFusion(r.id, lanes.length === 1 ? "only one run started." : "no run started.");
      return;
    }
    const facts = lanes.map((m) => this.facts(m));
    if (facts.some((f, i) => !isSettled(f.status) || this.loading.has(lanes[i].id) || !readSettled(f.summary, f.sig))) return;
    const finished = lanes.filter((_, i) => facts[i].status === "finished").map((m) => m.id);
    if (finished.length < 2) {
      // Name what the lanes ended as, so the person sees why: "1 finished, 2 failed".
      const counts = new Map();
      for (const f of facts) counts.set(f.status, (counts.get(f.status) ?? 0) + 1);
      const seen = LANE_STATUS_ORDER.filter((st) => counts.get(st)).map((st) => statusCount(st, counts.get(st))).join(", ");
      A.skipAutoFusion(r.id, `${finished.length === 1 ? "only one run" : "no run"} finished with an answer (${seen}).`);
      return;
    }
    if (!A.claimAutoFusion(r.id)) return;
    this.startFusion(finished, r.autoFusion, cx);
  }

  startFusion(sourceIds, judge, cx) {
    this.busy = "fuse";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { member } = await A.fuse(this.runId, sourceIds, judge);
        this.bar = { kind: "idle" };
        // The fused answer is what the person waits for: show it at once.
        if (member?.tab) run("tab.select", { id: member.tab });
      } catch (e) {
        notify({ title: "Arena", body: e instanceof A.NoFusionOutputsError ? "No answers found to fuse." : `Failed to start fusion. ${e?.message ?? e}`, level: "error" });
      }
      this.busy = null;
      cx.notify();
    });
  }

  act(kind, work, cx) {
    if (this.busy) return;
    this.busy = kind;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await work(); } catch (e) { notify({ title: "Arena", body: String(e?.message ?? e), level: "error" }); }
      this.busy = null;
      cx.notify();
    });
  }

  picked(agent, cx) {
    const p = this.picking;
    this.picking = null;
    if (p?.purpose === "judge") {
      // The choice is kept on the run, so the next fusion offers it again.
      const r = this.run;
      if (r) updateRun(r.id, (next) => { next.judge = agent; });
      cx.notify();
      return;
    }
    if (p?.purpose === "add") this.act("add", () => A.addLane(this.runId, p.variant, agent), cx);
  }

  finishRename(cx) {
    if (!this.renaming) return;
    this.renaming = false;
    const title = this.renameInput.value().trim();
    if (title && title !== this.run?.title) A.rename(this.runId, title);
    cx.notify();
  }

  openChat(member) {
    if (member.tab) run("tab.select", { id: member.tab });
    if (member.terminal) run("pane.focus", { terminal: member.terminal });
  }

  sideBySide(r) {
    const alive = new Set(terminals().map((t) => t.address));
    const lanes = r.members.filter((m) => alive.has(m.terminal));
    if (!lanes.length) return;
    openOverlay({
      kind: "dialog",
      width: 0.96,
      height: 0.92,
      layout: {
        type: "column",
        children: [
          { type: "block", size: { px: 40 }, content: { mod: "arena", props: { bar: r.id } } },
          {
            type: "row",
            gap: 6,
            padding: [0, 6],
            children: lanes.map((m) => ({
              type: "column",
              children: [
                { type: "block", size: { px: 28 }, content: { mod: "arena", props: { head: { run: r.id, member: m.id } } } },
                { type: "block", content: { terminal: m.terminal } },
              ],
            })),
          },
        ],
      },
    });
  }

  // ---- drawing ------------------------------------------------------------

  card(t, r, member, width) {
    const { agent, summary, status } = this.facts(member);
    const fusion = member.role === "fusion";
    const reply = summary?.reply, diff = summary?.diff;
    const fuseBar = this.bar.kind === "fuse" ? this.bar : null;
    const selectable = fuseBar && !fusion && status === "finished";
    const checked = Boolean(selectable && !fuseBar.excluded.has(member.id));
    const busy = status === "working";
    const unread = agent?.status === "done";

    // `screen`: the body is a terminal's screen tail, drawn in the terminal's font.
    let body, bodyColor = t.foreground, screen = false;
    if (status === "waiting" || status === "failed" || status === "notStarted") { body = CARD_BODY[status]; bodyColor = status === "failed" ? t.ansi1 : status === "waiting" ? t.foreground : t.muted; }
    else if (busy) { screen = reply?.state === "ready" && Boolean(reply.screen); body = screen ? reply.text : CARD_BODY.working; bodyColor = t.muted; }
    else if (!reply) { body = "…"; bodyColor = t.muted; }
    else if (reply.state === "error") { body = "Answer unavailable"; bodyColor = t.muted; }
    else if (!reply.text) { body = status === "stopped" ? CARD_BODY.stopped : CARD_BODY.noReply; bodyColor = t.muted; }
    else { screen = Boolean(reply.screen); body = reply.text.length > 900 ? `${reply.text.slice(0, 900)}…` : reply.text; }

    let changes = null;
    if (diff?.state === "ready") {
      changes = diff.stat.files === 0 ? div().child("No file changes") : h_flex().gap(4)
        .child(div().text_color(t.ansi2).child(`+${diff.stat.insertions}`))
        .child(div().text_color(t.ansi1).child(`−${diff.stat.deletions}`))
        .child(div().child(`· ${diff.stat.files === 1 ? "1 file" : `${diff.stat.files} files`}`));
    } else if (diff?.state === "error") changes = div().child("Changes unavailable");
    const end = busy ? Date.now() : member.endedAt;
    const duration = member.created && end ? div().child(`◷ ${formatDuration(end - member.created)}`) : null;

    const canKeep = Boolean(member.worktree) && (status === "finished" || status === "noReply" || status === "stopped");
    const canDiff = Boolean(member.worktree) && diff?.state === "ready" && diff.stat.files > 0;
    const disabled = Boolean(this.busy);
    const icon = (id, glyph, hint, onClick) => div().id(id).flex_none().size(24).rounded(6).flex().items_center().justify_center()
      .text_size(12).text_color(disabled ? t.dim : t.muted).tooltip(hint)
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick)).child(glyph);

    return v_flex().id(`card-${member.id}`).w(width).flex_none().min_h(fusion ? 0 : 184).gap(8).p(12).rounded(12).border_1()
      .bg(t.raised)
      .border_color(checked ? t.accent : fusion ? t.accent + "66" : t.border)
      .when(!fuseBar, (el) => el.hover((s) => s.border_color(t.input)))
      .when(Boolean(fuseBar) && !checked, (el) => el.opacity(selectable ? 0.6 : 0.4))
      .when(Boolean(selectable), (el) => el.cursor_pointer().on_click((_e, cx) => {
        if (fuseBar.excluded.has(member.id)) fuseBar.excluded.delete(member.id); else fuseBar.excluded.add(member.id);
        cx.notify();
      }))
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(agentIcon(t, member.agent, 15))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(laneLabel(member, r.variants.length)))
        .when(Boolean(member.branch), (el) => el.child(div().flex_none().max_w(160).truncate().text_size(10.5).text_color(t.dim).child(`⎇ ${member.branch.split("/").pop()}`)))
        .child(fuseBar
          ? (selectable ? checkbox(t, checked) : div())
          : h_flex().gap(6).items_center().when(unread && !busy, (el) => el.child(unreadDot(t))).child(statusIcon(t, status)).tooltip(LANE_STATUS_LABEL[status])))
      .child(div().w_full().when(!fusion, (el) => el.flex_1()).max_h(fusion ? 72 : 96).overflow_hidden()
        .child(div().w_full().text_size(12).text_color(bodyColor)
          .when(screen, (el) => el.font_family("JetBrains Mono").text_size(10.5))
          .child(body)))
      .child(h_flex().flex_wrap().gap(12).text_size(11).text_color(t.muted)
        .when(Boolean(changes), (el) => el.child(changes))
        .when(Boolean(duration), (el) => el.child(duration))
        .when(screen && !busy, (el) => el.child(div().text_color(t.dim).child("screen"))))
      .when(!fuseBar, (el) => el.child(h_flex().gap(6).items_center()
        .child(button(t, `chat-${member.id}`, "Open chat", () => this.openChat(member), { small: true }))
        .when(canKeep, (e) => e.child(button(t, `keep-${member.id}`, "✓ Keep this", (_e, cx) => { this.bar = { kind: "keep", member: member.id }; cx.notify(); }, { small: true, disabled })))
        .when(canDiff, (e) => e.child(button(t, `diff-${member.id}`, "⇄ Diff", () => openOverlay({ mod: "arena", props: { diff: { run: r.id, member: member.id } }, kind: "dialog", width: 0.85, height: 0.85 }), { kind: "ghost", small: true })))
        .child(div().flex_1())
        .child(icon(`detach-${member.id}`, "↗", "Leave this run and continue as an ordinary tab", (_e, cx) => { A.detach(r.id, member.id); cx.notify(); }))
        .child(icon(`archive-${member.id}`, "⌫", "Archive this run: its work is saved to a git ref, its worktree removed", (_e, cx) => this.act("member", () => A.archiveMember(r.id, member.id), cx)))));
  }

  grid(t, cards) {
    const inner = Math.min(this.width, MAX_WIDTH) - 48;
    const cols = Math.max(1, Math.floor((inner + GAP) / (CARD_MIN + GAP)));
    const width = Math.floor((inner - (cols - 1) * GAP) / cols);
    const rows = [];
    for (let i = 0; i < cards.length; i += cols) rows.push(cards.slice(i, i + cols));
    return v_flex().gap(GAP).children(rows.map((row) => h_flex().gap(GAP).items_stretch().children(row.map((make) => make(width)))));
  }

  promptCaption(t, label, prompt) {
    const open = this.expanded.has(label);
    const long = prompt.length > 120 || prompt.includes("\n");
    return v_flex().flex_1().min_w(0).gap(2)
      .child(open
        ? div().id(`prompt-${label}`).max_h(180).overflow_y_scrollbar().p(8).rounded(8).bg(t.raised).text_size(12).text_color(t.muted).child(prompt)
        : div().truncate().text_size(12).text_color(t.muted).child(prompt.split("\n")[0]))
      .when(long, (el) => el.child(div().id(`expand-${label}`).text_size(11).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { if (open) this.expanded.delete(label); else this.expanded.add(label); cx.notify(); })
        .child(open ? "Show less" : "Show all")));
  }

  pickerPanel(t) {
    const p = this.picking;
    const panel = v_flex().w(340).max_h(360).id("picker").overflow_y_scrollbar().p(6).rounded(10).border_1().border_color(t.input).bg(t.popover).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().px(8).py(4).text_size(11).text_color(t.dim).child(p.purpose === "judge" ? "Fuse with" : `Run variant ${p.variant} on one more agent`))
      .child(agentList(t, "ov-pick", this.agents, (agent, cx) => this.picked(agent, cx), this.command, this.commandFocused));
    return p.purpose === "judge"
      ? div().absolute().bottom(70).left(0).right(0).flex().justify_center().child(panel)
      : div().absolute().top(64).right(24).child(panel);
  }

  bottomBar(t, r, counts, lanes) {
    const waiting = counts.get("waiting") ?? 0;
    const working = counts.get("working") ?? 0;
    const finished = lanes.filter((m) => this.facts(m).status === "finished");
    const bar = this.bar;
    const disabled = Boolean(this.busy);
    let content;
    if (bar.kind === "keep") {
      const kept = r.members.find((m) => m.id === bar.member);
      const others = r.members.length - 1;
      content = [
        div().text_color(t.muted).child("⎇"),
        div().flex_1().min_w(0).text_size(12).text_color(t.foreground).child(others === 1
          ? `Keep ${kept ? laneLabel(kept, r.variants.length) : ""}? The other run is archived and its worktree removed. Its work stays recoverable.`
          : `Keep ${kept ? laneLabel(kept, r.variants.length) : ""}? The other ${others} runs are archived and their worktrees removed. Their work stays recoverable.`),
        button(t, "keep-cancel", "Cancel", (_e, cx) => { this.bar = { kind: "idle" }; cx.notify(); }, { kind: "ghost", disabled }),
        button(t, "keep-go", this.busy === "keep" ? "Cleaning up…" : "Keep and clean up", (_e, cx) => this.act("keep", () => A.keep(r.id, bar.member), cx), { kind: "solid", disabled }),
      ];
    } else if (bar.kind === "fuse") {
      const chosen = finished.filter((m) => !bar.excluded.has(m.id));
      const mode = fusionModeFor(chosen.map((m) => ({ hasWorktree: Boolean(m.worktree), diff: this.summaries[m.id]?.diff?.stat ?? null })));
      const judge = r.judge;
      content = [
        div().text_color(t.accent).child("✦"),
        div().text_size(12).text_color(t.foreground).child("Fuse with"),
        button(t, "judge", judge ? judge.name : "Agent", (_e, cx) => { this.picking = this.picking ? null : { purpose: "judge" }; cx.notify(); }, { small: true }),
        div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(mode === "code" ? "Works in its own worktree and reads each run with git" : "Combines the final answers"),
        div().text_size(11).text_color(t.dim).child(`${chosen.length} of ${finished.length} selected`),
        button(t, "fuse-cancel", "Cancel", (_e, cx) => { this.bar = { kind: "idle" }; this.picking = null; cx.notify(); }, { kind: "ghost", disabled }),
        button(t, "fuse-go", this.busy === "fuse" ? "Starting…" : "Start fusion", (_e, cx) => this.startFusion(chosen.map((m) => m.id), judge, cx), { kind: "solid", disabled: disabled || chosen.length < 2 || !judge }),
      ];
    } else {
      content = [
        div().flex_1().min_w(0).truncate().text_size(12).text_color(waiting ? t.foreground : t.muted).child(
          waiting ? `Runs waiting for you: ${waiting}. The run can't finish until you answer them.`
            : working ? `${lanes.length - working} of ${lanes.length} finished`
              : this.busy === "fuse" ? "Starting fusion…" : "Fuse the answers into one result"),
        button(t, "fuse", "✦ Fuse results", (_e, cx) => { this.bar = { kind: "fuse", excluded: new Set() }; cx.notify(); }, { kind: "solid", disabled: disabled || finished.length < 2 }),
      ];
    }
    return div().absolute().bottom(16).left(0).right(0).flex().justify_center().px(24)
      .child(h_flex().id("bar").w_full().max_w(896).gap(8).items_center().px(12).py(8).rounded(12).border_1().border_color(t.input).bg(t.popover).shadow_lg()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .children(content));
  }

  render(cx) {
    const t = theme();
    const r = this.run;
    const root = div().id("overview").relative().size_full().bg(t.background).text_color(t.foreground)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } });
    if (!r) {
      return root.flex().flex_col().items_center().justify_center().gap(10)
        .child(div().text_size(13).text_color(t.muted).child("This run is no longer available."))
        .child(button(t, "close-tab", "Close tab", () => run("tab.close", { confirmed: true }), { small: true }));
    }
    const lanes = r.members.filter((m) => m.role === "run");
    const fusions = r.members.filter((m) => m.role === "fusion");
    const counts = new Map();
    for (const m of lanes) { const s = this.facts(m).status; counts.set(s, (counts.get(s) ?? 0) + 1); }

    const title = this.renaming
      ? div().id("rename").h(32).px(8).flex().items_center().rounded(6).border_1().border_color(t.accent).text_size(17)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.renameInput).w_full())
      : div().id("title").max_w_full().truncate().text_size(17).font_semibold().cursor_pointer().hover((s) => s.text_color(t.accent)).tooltip("Rename run")
        .on_click((_e, cx) => { this.renaming = true; this.renameInput.set_value(r.title); this.renameInput.focus(); cx.notify(); }).child(r.title);

    const meta = h_flex().flex_wrap().gap(12).items_center().text_size(11.5).text_color(t.muted)
      .child(div().child(`${lanes.length === 1 ? "1 run" : `${lanes.length} runs`}${r.variants.length > 1 ? ` · ${r.variants.length} prompt variants` : ""}`))
      .child(div().child(`⎇ ${r.isolate ? `Separate worktrees from ${r.base}` : "Shared directory"}`))
      .children(LANE_STATUS_ORDER.filter((s) => counts.get(s)).map((s) => h_flex().gap(4).items_center().child(statusIcon(t, s, 11)).child(statusCount(s, counts.get(s)))))
      .when(Boolean(r.autoFusion) && !r.autoFused, (el) => el.child(div().text_color(t.foreground).child(`✦ Fuses with ${r.autoFusion.name} when all finish`)))
      .when(Boolean(r.autoSkipped), (el) => el.child(div().text_color(t.muted).child(`✦ Automatic fusion skipped: ${r.autoSkipped}`)));

    const addModel = (variant) => button(t, `add-${variant}`, this.busy === "add" ? "Adding…" : "+ Add a model", (_e, cx) => {
      this.picking = this.picking?.purpose === "add" && this.picking.variant === variant ? null : { purpose: "add", variant };
      cx.notify();
    }, { small: true, disabled: Boolean(this.busy) });

    const header = h_flex().gap(8).items_start()
      .child(v_flex().flex_1().min_w(0).gap(4).child(title).child(meta))
      .when(r.variants.length === 1, (el) => el.child(addModel(r.variants[0].label)))
      .child(button(t, "side", "▥ Side by side", () => this.sideBySide(r), { kind: "ghost", small: true }))
      .child(button(t, "archive-run", this.busy === "archive" ? "Archiving…" : "Archive run", (_e, cx) => this.act("archive", () => A.archiveRun(r.id), cx), { kind: "ghost", small: true, disabled: Boolean(this.busy) }));

    const content = v_flex().w_full().max_w(MAX_WIDTH).px(24).pt(20).pb(120).gap(24)
      .child(header)
      .when(fusions.length > 0, (el) => el.child(v_flex().gap(8)
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child("✦ Fused result"))
        .children(fusions.map((m) => this.card(t, r, m, Math.min(this.width, MAX_WIDTH) - 48)))))
      .children(r.variants.map((variant) => {
        const members = lanes.filter((m) => m.variant === variant.label);
        return v_flex().gap(8)
          .child(h_flex().gap(8).items_start()
            .when(r.variants.length > 1, (el) => el.child(chip(t, variant.label, t.foreground)))
            .child(this.promptCaption(t, variant.label, variant.prompt))
            .when(r.variants.length > 1, (el) => el.child(addModel(variant.label))))
          .child(this.grid(t, members.map((m) => (width) => this.card(t, r, m, width))))
          .when(members.length === 0, (el) => el.child(div().text_size(12).text_color(t.dim).child("No runs left on this variant.")));
      }));

    return root
      .child(div().id("overview-scroll").size_full().overflow_y_scrollbar().child(h_flex().w_full().justify_center().child(content)))
      .child(this.bottomBar(t, r, counts, lanes))
      .when(Boolean(this.picking), (el) => el.child(this.pickerPanel(t)));
  }
}
