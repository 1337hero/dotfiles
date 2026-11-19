// Arena: one task, several agents at once, each in its own worktree. Compare
// what each one built, keep the best, or fuse the strongest parts.
//
// One mod, several shapes, chosen by its props:
// - (none, as a dialog)         the launcher, `mod.open:arena`
// - { run }                     a run's overview, the pane of its "Arena · <title>" tab
// - { diff: { run, member } }   a lane's diff, as a dialog
// - { bar: run }                the side-by-side view's bar
// - { head: { run, member } }   a column head in the side-by-side view

import { View } from "gpui-kit";
import { props } from "herdr";
import { Launcher } from "./launcher.js";
import { Overview } from "./overview.js";
import { DiffPanel, CompareBar, LaneHead } from "./panels.js";

function shape(p) {
  if (p?.run) return new Overview();
  if (p?.diff) return new DiffPanel();
  if (p?.bar) return new CompareBar();
  if (p?.head) return new LaneHead();
  return new Launcher();
}

export default class Arena extends View {
  init(_props, cx) {
    this.part = shape(props());
    this.part.init(cx);
  }

  render(cx) {
    return this.part.render(cx);
  }
}
