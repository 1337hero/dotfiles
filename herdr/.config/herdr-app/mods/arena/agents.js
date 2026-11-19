// The agents a lane can run: the app's own list (programs.json entries with
// `run`), plus any command the person types, such as `claude --model haiku`
// to put two models of one agent side by side.

import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { knownAgents } from "herdr";
import { splitCommand, slugify } from "./lib/names.js";
import { agentIcon } from "./ui.js";

/** A lane's agent as stored on the run. */
const asAgent = (a) => ({ key: a.key, name: a.name, run: a.run, icon: a.icon ?? null, tint: Boolean(a.tint) });

export async function loadAgents() {
  try { return (await knownAgents()).map((a) => ({ ...asAgent(a), installed: a.installed })); }
  catch { return []; }
}

/** `claude --model haiku` → an agent named after the whole command, keyed by it. */
export function customAgent(text, known) {
  const argv = splitCommand(text.trim());
  if (!argv.length) return null;
  const base = known.find((a) => a.run[0] === argv[0]);
  return {
    key: slugify(argv.join(" "), "custom"),
    name: argv.length > 1 ? `${base?.name ?? argv[0]} ${argv.slice(1).join(" ")}` : base?.name ?? argv[0],
    run: argv,
    icon: base?.icon ?? null,
    tint: base?.tint ?? false,
  };
}

/**
 * The list a picker shows: installed agents first, each a row, then a field
 * for a command. `input` is an InputState the owner made in init; Enter in it
 * calls `onCustom`.
 */
export function agentList(t, idPrefix, list, onPick, input, inputFocused) {
  const rows = list.filter((a) => a.installed !== false);
  const missing = list.filter((a) => a.installed === false);
  const row = (a, i, enabled) => h_flex().id(`${idPrefix}-${i}`).h(30).px(8).gap(8).items_center().rounded(6)
    .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onPick(a, cx)))
    .when(!enabled, (el) => el.opacity(0.45))
    .child(agentIcon(t, a, 14))
    .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(a.name))
    .child(div().flex_none().text_size(11).text_color(t.dim).child(enabled ? a.run.join(" ") : "not installed"));
  return v_flex().gap(2)
    .children(rows.map((a, i) => row(a, i, true)))
    .children(missing.map((a, i) => row(a, rows.length + i, false)))
    .when(list.length === 0, (el) => el.child(div().px(8).py(6).text_size(12).text_color(t.dim).child("No agents found in programs.json.")))
    .child(div().mt(4).px(8).text_size(10.5).text_color(t.dim).child("OR A COMMAND"))
    .child(div().id(`${idPrefix}-cmd`).mx(4).h(30).px(8).flex().items_center().rounded(6).border_1()
      .border_color(inputFocused ? t.accent : t.input).bg(t.background).text_size(12).text_color(t.foreground)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(input).h_full().w_full()));
}
