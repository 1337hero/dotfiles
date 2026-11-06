// The chat and terminal toggle, for a layout block with `props: { role: "toggle" }`, and the swap it runs. This copy owns the
// swap and the `swap` key command. A key reaches every shown copy of the mod, and the chat panes ignore it. A chat pane behind
// a zoom gets nothing, so the swap can't live in a pane. The toggle's block is in the tab row, which a zoom never hides.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { nextCommand, panes, run, setShared, shared, theme } from "herdr";
import { CHAT, splitPending, swapState, swapSteps, tidyPairs } from "./swap.js";

const PAIRS = "pi-chat.pairs";

export class Toggle {
  constructor(cx) {
    cx.spawn(async () => {
      for (;;) if ((await nextCommand()) === "swap") this.swap();
    });
  }

  // A first press splits, and the new pane only exists on a later render, so finish the swap there.
  settle(list) {
    const wait = this.waiting;
    if (!wait) return;
    const fresh = list.find((p) => p.mod === CHAT && p.tab === wait.tab && !wait.known.includes(p.pane));
    if (!fresh) return;
    this.waiting = null;
    setShared(PAIRS, { ...tidyPairs(shared(PAIRS), list), [fresh.pane]: wait.terminal });
    run("pane.zoom", { pane: fresh.pane });
    run("pane.focus", { pane: fresh.pane });
  }

  swap(target) {
    const list = panes();
    const state = swapState(list, shared(PAIRS) ?? {});
    if (!state) return;
    const to = target ?? (state.showing === "chat" ? "terminal" : "chat");
    if (to === state.showing) return;
    if (to === "chat" && !state.chatPane) {
      if (splitPending(this.waiting, state.tab, Date.now())) return;
      this.waiting = { tab: state.tab, terminal: state.terminal, known: list.map((p) => p.pane), at: Date.now() };
    }
    for (const [name, args] of swapSteps(state, to, list)) run(name, args);
  }

  pill(t, state) {
    const on = (side) => state.showing === side;
    // Mouse down, not on_click: in testing a press's mouse down arrived where its click didn't.
    const press = (side) => (_e, cx) => { cx.stop_propagation(); this.swap(side); };
    const cell = (side, icon, label) => h_flex().id(`swap-${side}`).w(30).h(24).flex_none().items_center().justify_center().rounded(12).relative()
      .accessibility_label(label).on_mouse_down("left", press(side))
      .child(svg(icon).size(14).text_color(on(side) ? t.background : t.muted));
    return h_flex().ml(6).p(2).h(30).flex_none().items_center().rounded(15).relative().bg(t.surface).border(1).border_color(t.border)
      .child(div().absolute().top(2).h(24).w(30).rounded(12).bg(t.solid ?? t.foreground)
        .left(state.showing === "terminal" ? 32 : 2).spring("left", { response: 240, damping: 0.86 }))
      .child(cell("chat", "mods/pi-chat/chat.svg", "Chat"))
      .child(cell("terminal", "mods/pi-chat/terminal.svg", "Terminal"));
  }

  render() {
    const list = panes();
    this.settle(list);
    const state = swapState(list, shared(PAIRS) ?? {});
    const t = theme();
    return h_flex().size_full().min_w(0).pr(10).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      .when(Boolean(state), (e) => e.child(this.pill(t, state)));
  }
}
