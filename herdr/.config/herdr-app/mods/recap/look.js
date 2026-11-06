// How recap draws an agent: its colours, its icons and the pieces of its card,
// in the app's theme. Colour is spent only on state: surfaces stay neutral,
// and a state shows on its icon, its time and a faint tint of its colour.

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";

// The mod's own icons, from the app's home folder, tinted with the text colour.
const ICONS = "mods/recap/icons";

// The faces: the app's own for words, mono for what you'd type (branches,
// machines, keys). JetBrains Mono ships with Herdr.
export const MONO = "JetBrains Mono";

// A colour at an alpha: the theme's colours are #rrggbb.
export const tint = (color, alpha) => (/^#[0-9a-f]{6}$/i.test(color ?? "") ? color + Math.round(alpha * 255).toString(16).padStart(2, "0") : color);

// Colour roles, from the theme's own names for them, so every theme (light or
// dark) reads: what needs you, what's at work, done, idle; a PR in review,
// merged; something broken; and the accent for links and focus. The ANSI
// ones are the theme's red, green, … the terminals use.
export function tones(t) {
  return {
    need: t.blocked ?? t.ansi1,
    work: t.working ?? t.ansi3,
    done: t.done ?? t.ansi6,
    idle: t.idle ?? t.dim,
    review: t.ansi2,
    merged: t.ansi5,
    fix: t.ansi1,
    accent: t.accent ?? t.ansi4,
    // Text: the title, the recap, what's quiet.
    fg: t.foreground,
    muted: t.muted,
    dim: t.dim,
    // Surfaces: the popup, a chosen card, chips and the inputs, lines.
    surface: t.popover,
    raised: t.raised ?? t.hover,
    sunk: t.input ?? t.background,
    line: t.border,
  };
}

// Where an agent's work has got to, which the list is grouped by: its status
// while that says something, and once it's idle, its pull request. In list
// order: whose move it is, yours first.
export const STAGES = [
  { id: "blocked", label: "Needs you", short: "Needs you", tone: "need" },
  { id: "done", label: "Done", short: "Done", tone: "done" },
  { id: "fixing", label: "Needs fixing", short: "Fixing", tone: "fix" },
  { id: "idle", label: "Idle", short: "Idle", tone: "idle" },
  { id: "working", label: "Working", short: "Working", tone: "work" },
  { id: "review", label: "In review", short: "In review", tone: "review" },
  { id: "merged", label: "Merged", short: "Merged", tone: "merged" },
];
export const ALL = { id: "all", label: "All", short: "All", tone: "accent" };

// stageOf, as herdr-recap's: a status that says something wins over the PR
// (an agent started on the next thing after a merge is at work, not merged),
// and so does new work in its worktree.
export function stageOf(r) {
  if (r.status === "blocked" || r.status === "done" || r.status === "working") return r.status;
  const pr = r.pr;
  if (pr?.state === "merged" || pr?.state === "closed") {
    return r.changes?.files > 0 || r.changes?.ahead > 0 ? "idle" : "merged";
  }
  if (pr?.state === "open" || pr?.state === "draft") {
    if (pr.checks === "✗" || pr.review === "changes requested" || pr.conflicts) return "fixing";
    if (pr.state === "open") return "review";
  }
  return "idle";
}

// One icon, `size` px square, in `color`.
export function icon(name, color, size = 16) {
  return svg(`${ICONS}/${name}.svg`).flex_none().w(size).h(size).text_color(color);
}

// An agent's icon, by its stage: told by shape as well as colour, so it reads
// in a colour-blind theme too. Working spins its arc; needs-you breathes. Both
// run natively, only while drawn.
export function stateIcon(o, r) {
  switch (r.stage) {
    case "blocked":
      return icon("need", o.need).loop("opacity", { from: 0.45, to: 1, period: 1800 });
    case "working":
      return div().relative().flex_none().w(16).h(16)
        .child(icon("work-track", tint(o.work, 0.25)).absolute().top(0).left(0))
        .child(icon("work", o.work).absolute().top(0).left(0).spin(1100));
    case "done":
      return icon("done", o.done);
    case "fixing":
      return icon("fix", o.fix);
    case "review":
      return icon("pr", o.review);
    case "merged":
      return r.pr?.state === "closed" ? icon("closed", o.fix) : icon("merged", o.merged);
  }
  return icon("idle", o.idle);
}

// A stage's own colour.
export const stageColor = (o, stage) => o[STAGES.find((s) => s.id === stage)?.tone ?? "idle"];

export function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// A pull request's colour and icon, by its state.
export function prLook(o, pr) {
  if (pr.state === "merged") return { color: o.merged, icon: "merged" };
  if (pr.state === "closed") return { color: o.fix, icon: "closed" };
  if (pr.state === "draft") return { color: o.work, icon: "draft" };
  if (pr.checks === "✗" || pr.conflicts || pr.review === "changes requested") return { color: o.fix, icon: "pr" };
  return { color: o.review, icon: "pr" };
}

// A Linear issue's icon, by its state: a ring that fills as it goes.
export function issueIcon(issue) {
  const s = (issue?.state ?? "").toLowerCase();
  if (/done|complete|merged|closed|cancel/.test(s)) return "lin-done";
  if (/review/.test(s)) return "lin-review";
  if (/progress|start|doing/.test(s)) return "lin-prog";
  return "lin-todo";
}

// A chip: a small rounded label, neutral unless it carries a state's colour
// (then tinted with it). `parts` are elements or strings; `click` makes it a
// link.
export function chip(o, id, parts, { color = null, mono = false, click = null } = {}) {
  return h_flex()
    .id(id)
    .flex_none()
    .h(22)
    .px(8)
    .gap(5)
    .items_center()
    .rounded(6)
    .bg(color ? tint(color, 0.12) : o.sunk)
    .text_size(mono ? 11 : 11.5)
    .text_color(color ?? o.muted)
    .when(!mono, (el) => el.font_medium())
    .when(mono, (el) => el.font_family(MONO))
    .when(Boolean(click), (el) =>
      el.cursor_pointer()
        .hover((s) => s.bg(color ? tint(color, 0.22) : o.raised))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          click(cx);
        }))
    .children(parts.filter((p) => p !== null && p !== undefined && p !== "").map((p) => (typeof p === "string" ? div().child(p) : p)));
}

// A small bar: how much of something is done.
export function bar(o, fraction, color) {
  const w = 34;
  return div().flex_none().w(w).h(4).rounded(2).bg(o.line).overflow_hidden()
    .child(div().h_full().w(Math.round(Math.max(0, Math.min(1, fraction)) * w)).bg(color));
}

// Words in a row, each in its colour: [text, color, onClick?], joined by
// dim dots between groups.
export function words(o, groups, idBase) {
  const out = [];
  groups.filter((g) => g.length).forEach((g, i) => {
    if (i > 0) out.push(div().text_color(o.dim).child("·"));
    g.forEach(([text, color, click, under], j) => {
      const w = div().text_color(color).child(text);
      if (!click) return out.push(w);
      out.push(
        div()
          .id(`${idBase}-${i}-${j}`)
          .text_color(color)
          .font_medium()
          .when(Boolean(under), (el) => el.underline())
          .cursor_pointer()
          .hover((s) => s.underline())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            click(cx);
          })
          .child(text),
      );
    });
  });
  return h_flex().gap(8).items_center().flex_wrap().children(out);
}

// What's drawn on a keycap: the keys with a symbol of their own as icons
// (enter as an arrow down and left, ⌃, ⌘, tab, the arrows), letters
// capitalised as on the key; "^g" or "ctrl-g" is ⌃G, "cmd-g" ⌘G.
const KEY_ICONS = {
  enter: "key-enter", "⏎": "key-enter", "↵": "key-enter",
  tab: "key-tab", "⇥": "key-tab",
  "↑": "key-up", up: "key-up", "↓": "key-down", down: "key-down",
  "←": "key-left", left: "key-left", "→": "key-right", right: "key-right",
  ctrl: "key-ctrl", "^": "key-ctrl", "⌃": "key-ctrl",
  cmd: "key-cmd", "⌘": "key-cmd",
};
function keyParts(k) {
  const m = /^(\^|ctrl[-+]|cmd[-+])(.+)$/i.exec(k);
  if (m) return [m[1][0] === "^" ? "ctrl" : m[1].slice(0, -1).toLowerCase(), ...keyParts(m[2])];
  return [KEY_ICONS[k.toLowerCase()] ? k.toLowerCase() : k.length === 1 ? k.toUpperCase() : k];
}

// One keycap.
export function cap(o, k) {
  return h_flex()
    .flex_none()
    .min_w(20)
    .h(20)
    .px(5)
    .gap(1)
    .items_center()
    .justify_center()
    .rounded(5)
    .border_1()
    .border_b_2()
    .border_color(o.line)
    .bg(o.surface)
    .font_family(MONO)
    .text_size(11)
    .text_color(o.muted)
    .children(keyParts(k).map((p) => (KEY_ICONS[p] ? icon(KEY_ICONS[p], o.muted, 11) : div().child(p))));
}

// A key in the footer: its keycaps and what it does. Clickable.
export function key(o, keys, label, click, id) {
  return h_flex()
    .id(id)
    .flex_none()
    .gap(6)
    .items_center()
    .cursor_pointer()
    .text_size(12)
    .text_color(o.dim)
    .hover((s) => s.text_color(o.fg))
    .on_click((_e, cx) => click(cx))
    .children(keys.map((k) => cap(o, k)))
    .child(div().child(label));
}

// A tab's count, in a pill wide enough for it from the start: "–" until
// it's known, so the tabs don't move when it comes.
export function countPill(o, n, on) {
  return div()
    .flex_none()
    .min_w(24)
    .h(18)
    .px(6)
    .flex()
    .items_center()
    .justify_center()
    .rounded(9)
    .bg(on ? o.sunk : tint(o.line, 0.6))
    .font_family(MONO)
    .text_size(11)
    .font_medium()
    .text_color(on ? o.fg : o.dim)
    .child(n == null || n === "" ? "–" : String(n));
}
