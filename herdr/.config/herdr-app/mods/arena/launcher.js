// The launcher: one prompt (or several variants of it) for several agents at
// once. Opened with `mod.open:arena` as a dialog over the shown space.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { spaces, panes, focused, exec, theme, props, closeOverlay, run } from "herdr";
import { repoOf, branches } from "./lib/git.js";
import { titleFromPrompt, variantLabel, activeAfterRemoval } from "./lib/names.js";
import { launch, MAX_LANES } from "./actions.js";
import { loadAgents, customAgent, agentList } from "./agents.js";
import { lastChoices, saveChoices, runOfTab, memberOfTerminal } from "./store.js";
import { button, agentIcon, radio } from "./ui.js";

/** Where the shown space is now: its focused pane's folder, else where it was made. */
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { space, folder: pane?.cwd || f?.cwd || space?.folder || null };
}

export class Launcher {
  init(cx) {
    const { space, folder } = location();
    const last = lastChoices();
    this.space = space;
    this.folder = folder;
    this.remote = Boolean(space?.machine);
    this.repo = undefined; // undefined: looking, null: not in git
    this.branchList = [];
    this.base = null;
    this.detached = false;
    this.agents = [];
    this.handle = cx.focus_handle();
    this.title = InputState.new({ placeholder: "Parallel run" });
    this.variants = [this.variant(0, last?.agents ?? [])];
    this.active = 0;
    this.isolate = last?.isolate ?? true;
    this.setup = TextareaState.new({ placeholder: "e.g. npm ci", value: (last?.setup ?? []).join("\n"), rows: 3 });
    this.fusion = last?.fusion === "auto" ? "auto" : "off";
    this.judge = last?.judge ?? null;
    this.picking = null; // "lanes" | "judge" | "branch"
    this.command = InputState.new({ placeholder: "claude --model haiku" });
    this.commandFocused = false;
    this.command.on("focus", (_e, cx) => { this.commandFocused = true; cx.notify(); });
    this.command.on("blur", (_e, cx) => { this.commandFocused = false; cx.notify(); });
    this.command.on("submit", (_e, cx) => {
      const agent = customAgent(this.command.value(), this.agents);
      if (agent) { this.pick(agent); this.command.set_value(""); }
      cx.notify();
    });
    this.error = "";
    this.busy = false;
    this.variants[0].text.focus();
    cx.timer.after(150, () => this.variants[this.active]?.text.focus());

    // A lane's or an overview's tab: offer the run's overview, too.
    const f = focused();
    this.here = (f?.terminal && memberOfTerminal(f.terminal)?.run) || (f?.tab && runOfTab(f.tab)) || null;

    cx.spawn(async (cx) => {
      this.agents = await loadAgents();
      if (this.variants[0].agents.length === 0) {
        const first = this.agents.find((a) => a.installed);
        if (first) this.variants[0].agents = [first];
      }
      cx.notify();
      if (this.remote || !this.folder) { this.repo = null; cx.notify(); return; }
      const repo = await repoOf(exec, this.folder).catch(() => null);
      if (repo) {
        try {
          const b = await branches(exec, repo.top);
          this.branchList = b.names;
          this.detached = b.detached;
          this.base = b.current;
        } catch {
          // Without a branch list, start from what is checked out.
          this.branchList = ["HEAD"];
          this.base = "HEAD";
        }
      }
      this.repo = repo;
      if (!repo) this.isolate = false;
      cx.notify();
    });
  }

  variant(index, agents) {
    const text = TextareaState.new({ placeholder: "Describe the task. Every agent gets the same prompt.", rows: 6 });
    text.set_auto_grow(5, 14);
    return { label: variantLabel(index), text, agents: [...agents] };
  }

  close() { closeOverlay(props().overlay); }

  get lanes() { return this.variants.reduce((n, v) => n + v.agents.length, 0); }

  pick(agent) {
    if (this.picking === "judge") { this.judge = agent; this.picking = null; return; }
    if (this.lanes >= MAX_LANES) return;
    this.variants[this.active].agents.push(agent);
  }

  /** Same agent, one more or one fewer time on the shown variant. */
  step(key, delta) {
    const list = this.variants[this.active].agents;
    if (delta > 0) {
      const agent = list.find((a) => a.key === key);
      if (agent && this.lanes < MAX_LANES) list.push(agent);
    } else {
      const at = list.map((a) => a.key).lastIndexOf(key);
      if (at >= 0) list.splice(at, 1);
    }
  }

  addVariant() {
    if (this.variants.length >= 4) return;
    const from = this.variants[this.active];
    const next = this.variant(this.variants.length, from.agents);
    next.text.set_value(from.text.value());
    this.variants.push(next);
    this.active = this.variants.length - 1;
    next.text.focus();
  }

  removeVariant(index) {
    if (this.variants.length < 2) return;
    this.variants.splice(index, 1);
    this.variants.forEach((v, i) => { v.label = variantLabel(i); });
    this.active = activeAfterRemoval(this.active, index, this.variants.length);
  }

  /** Why the run can't start yet, or null. The Run button and ⌘↵ both ask. */
  blocked() {
    if (this.busy) return "busy";
    if (this.remote) return "Arena runs on this computer only; this space is on another machine.";
    if (!this.space || !this.folder) return "Open a folder in a space first.";
    if (this.repo === undefined) return "Looking for a git repository…";
    if (this.lanes === 0) return "Add at least one agent.";
    return null;
  }

  go(cx) {
    const why = this.blocked();
    if (why) { if (why !== "busy") { this.error = why; cx.notify(); } return; }
    const variants = this.variants.map((v) => ({ label: v.label, prompt: v.text.value().trim(), agents: v.agents }));
    if (variants.some((v) => !v.prompt || v.agents.length === 0)) { this.error = "Every prompt variant needs text and at least one agent."; cx.notify(); return; }
    if (this.lanes > MAX_LANES) { this.error = `At most ${MAX_LANES} runs at once.`; cx.notify(); return; }
    if (this.fusion === "auto" && !this.judge) { this.error = "Choose the agent that fuses the results."; cx.notify(); return; }
    const isolate = Boolean(this.repo) && this.isolate;
    const spec = {
      title: this.title.value().trim() || titleFromPrompt(variants[0].prompt),
      space: this.space.id,
      folder: this.folder,
      repo: this.repo,
      isolate,
      base: this.base,
      setup: this.setup.value().split("\n").map((l) => l.trim()).filter(Boolean),
      autoFusion: this.fusion === "auto" ? this.judge : null,
      variants,
    };
    saveChoices({ agents: variants[0].agents, isolate: this.isolate, setup: spec.setup, fusion: this.fusion, judge: this.judge });
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await launch(spec);
        this.close();
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.busy = false;
      }
      cx.notify();
    });
  }

  key(e, cx) {
    if (e.key === "escape") {
      if (this.picking) { this.picking = null; cx.stop_propagation(); return cx.notify(); }
      return this.close();
    }
    if (e.key === "enter" && (e.modifiers.platform || e.modifiers.control)) { cx.stop_propagation(); this.go(cx); }
  }

  section(t, title, ...children) {
    return v_flex().gap(6).child(div().text_size(10.5).text_color(t.dim).child(title)).children(children.filter(Boolean));
  }

  agentChips(t) {
    const list = this.variants[this.active].agents;
    const groups = [];
    for (const a of list) {
      const g = groups.find((x) => x.agent.key === a.key);
      if (g) g.count++; else groups.push({ agent: a, count: 1 });
    }
    const full = this.lanes >= MAX_LANES;
    const stepper = (id, glyph, enabled, onClick) => div().id(id).flex_none().w(18).h(18).rounded(4).flex().items_center().justify_center()
      .text_size(12).text_color(enabled ? t.foreground : t.dim)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick)).child(glyph);
    return h_flex().flex_wrap().gap(6).items_center()
      .children(groups.map(({ agent, count }, i) => h_flex().id(`chip-${i}`).h(28).pl(8).pr(4).gap(6).items_center().rounded(8).border_1().border_color(t.border)
        .child(agentIcon(t, agent, 14))
        .child(div().max_w(200).truncate().text_size(12).text_color(t.foreground).child(agent.name))
        .child(stepper(`dec-${i}`, "−", true, (_e, cx) => { this.step(agent.key, -1); cx.notify(); }))
        .child(div().text_size(12).text_color(t.muted).child(String(count)))
        .child(stepper(`inc-${i}`, "+", !full, (_e, cx) => { this.step(agent.key, 1); cx.notify(); }))))
      .child(button(t, "add-agent", full ? `${MAX_LANES} runs at most` : "+ Add agent", (_e, cx) => { this.picking = this.picking === "lanes" ? null : "lanes"; cx.notify(); }, { kind: "ghost", disabled: full, small: true }));
  }

  picker(t, purpose) {
    return div().p(6).rounded(8).border_1().border_color(t.border).bg(t.background)
      .child(agentList(t, `pick-${purpose}`, this.agents, (agent, cx) => { this.pick(agent); if (purpose === "lanes" && this.lanes >= MAX_LANES) this.picking = null; cx.notify(); }, this.command, this.commandFocused));
  }

  render(cx) {
    const t = theme();
    const repo = this.repo;
    const v = this.variants[this.active];
    const n = this.lanes;
    const isolate = Boolean(repo) && this.isolate;
    const baseName = (b) => (b === "HEAD" && this.detached ? "HEAD (detached)" : b);
    const where = this.remote ? "Arena runs on this computer only; this space is on another machine." : this.folder ?? "No folder";

    const header = h_flex().gap(10).items_center()
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Run in parallel"))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(repo ? `${repo.name} · ${where}` : where))
      .when(Boolean(this.here), (el) => el.child(button(t, "open-run", "Open this run", () => {
        this.close();
        if (this.here.overviewTab) run("tab.select", { id: this.here.overviewTab });
      }, { kind: "ghost", small: true })));

    const tabs = h_flex().gap(4).items_center()
      .when(this.variants.length > 1, (el) => el.children(this.variants.map((x, i) => h_flex().id(`variant-${i}`).h(26).px(8).gap(6).items_center().rounded(6)
        .cursor_pointer().when(i === this.active, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.active = i; this.picking = null; this.variants[i].text.focus(); cx.notify(); })
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child(x.label))
        .child(div().text_size(11).text_color(t.dim).child(x.agents.length === 1 ? "1 run" : `${x.agents.length} runs`))
        .child(div().id(`variant-x-${i}`).text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.removeVariant(i); cx.notify(); }).child("×")))))
      .child(div().flex_1())
      .child(button(t, "add-variant", "+ Prompt variant", () => { this.addVariant(); }, { kind: "ghost", small: true, disabled: this.variants.length >= 4 }));

    const prompt = div().id("prompt").p(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Textarea.new(v.text).w_full());

    const whereSection = this.section(t, "WHERE THE RUNS WORK",
      h_flex().gap(8)
        .child(div().flex_1().min_w(0).child(radio(t, "where-wt", isolate, "Separate worktrees", "Each run gets its own branch, so code changes never collide. Keep the best one.", (cx) => { this.isolate = true; cx.notify(); }, !repo)))
        .child(div().flex_1().min_w(0).child(radio(t, "where-shared", !isolate, "Project directory", "All runs work in your checkout. Best for questions and research.", (cx) => { this.isolate = false; cx.notify(); }))),
      repo ? null : div().text_size(11.5).text_color(t.dim).child(repo === undefined ? "Looking for a git repository…" : "Not a git repository: runs share the folder."));

    const branchSection = isolate ? this.section(t, "BASE BRANCH",
      h_flex().gap(8).items_center()
        .child(button(t, "base", `⎇ ${this.base ? baseName(this.base) : "…"}`, (_e, cx) => { this.picking = this.picking === "branch" ? null : "branch"; cx.notify(); }, { small: true }))
        .child(div().text_size(11.5).text_color(t.dim).child(this.base === "HEAD" ? "Every run starts from the commit checked out now." : "Every run starts from this branch's latest commit.")),
      this.picking === "branch" ? v_flex().id("branches").max_h(180).overflow_y_scrollbar().p(4).rounded(8).border_1().border_color(t.border).bg(t.background)
        .children(this.branchList.map((b, i) => div().id(`branch-${i}`).h(26).px(8).flex().items_center().rounded(6).cursor_pointer().text_size(12)
          .text_color(b === this.base ? t.accent : t.foreground).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.base = b; this.picking = null; cx.notify(); }).child(baseName(b)))) : null) : null;

    const setupSection = isolate ? this.section(t, "SETUP COMMANDS",
      div().text_size(11.5).text_color(t.dim).child("Run in every new worktree before its agent starts, one per line."),
      div().id("setup").p(8).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Textarea.new(this.setup).w_full())) : null;

    const fusionSection = this.section(t, "FUSION",
      h_flex().gap(8)
        .child(div().flex_1().min_w(0).child(radio(t, "fuse-off", this.fusion === "off", "Off", "Compare the results yourself.", (cx) => { this.fusion = "off"; cx.notify(); })))
        .child(div().flex_1().min_w(0).child(radio(t, "fuse-auto", this.fusion === "auto", "Automatic", "Fuse the results as soon as every run finishes.", (cx) => { this.fusion = "auto"; cx.notify(); }))),
      this.fusion === "auto" ? h_flex().gap(8).items_center()
        .child(div().text_size(12).text_color(t.muted).child("Fuse with"))
        .child(button(t, "judge", this.judge ? this.judge.name : "Choose an agent", (_e, cx) => { this.picking = this.picking === "judge" ? null : "judge"; cx.notify(); }, { small: true })) : null,
      this.picking === "judge" ? this.picker(t, "judge") : null);

    const ready = !this.blocked();
    const footer = h_flex().gap(8).items_center().pt(10).border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(this.error ? t.ansi1 : t.dim)
        .child(this.error || `${n === 1 ? "1 run" : `${n} runs`} · ${isolate ? "Separate worktrees" : "Shared directory"}${this.fusion === "auto" && this.judge ? ` · fuses with ${this.judge.name}` : ""}`))
      .child(div().text_size(11).text_color(t.dim).child("⌘↵"))
      .child(button(t, "cancel", "Cancel", () => this.close(), { kind: "ghost" }))
      .child(button(t, "go", this.busy ? "Starting…" : `Run (${n})`, (_e, cx) => this.go(cx), { kind: "solid", disabled: !ready }));

    return v_flex().id("launcher").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().p(18).gap(12).bg(t.popover).text_color(t.foreground)
      .child(header)
      .child(v_flex().id("launcher-body").flex_1().min_h(0).overflow_y_scrollbar().gap(14).pr(4)
        .child(div().id("title").h(32).px(10).flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.background).text_size(13)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.title).w_full()))
        .child(v_flex().gap(6).child(tabs).child(prompt))
        .child(this.section(t, this.variants.length > 1 ? `AGENTS FOR VARIANT ${v.label}` : "AGENTS", this.agentChips(t), this.picking === "lanes" ? this.picker(t, "lanes") : null))
        .child(whereSection)
        .when(Boolean(branchSection), (el) => el.child(branchSection))
        .when(Boolean(setupSection), (el) => el.child(setupSection))
        .child(fusionSection))
      .child(footer);
  }
}

