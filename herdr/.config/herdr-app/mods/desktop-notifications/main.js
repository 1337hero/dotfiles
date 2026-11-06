import { View, div } from "gpui-kit";
import { agents, appHome, exec, nextCommand } from "herdr";

const escapeMarkup = text => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export default class DesktopNotifications extends View {
  init(_props, cx) {
    // Existing attention is the baseline, so reloads never replay old notifications.
    const current = agents();
    this.previous = new Map(current.map(a => [a.address, a.status]));
    this.running = new Set(current.filter(a => a.status === "working").map(a => a.address));
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "test") {
          const current = agents();
          const agent = current.find(a => a.focused) ?? current[0];
          await this.send("Herdr desktop notifications enabled", "You will be notified when an agent finishes or needs your attention.", "done", agent?.program?.icon);
        }
      }
    });
  }

  async send(title, body, status, icon) {
    try {
      const iconPath = icon ? (icon.startsWith("/") ? icon : `${appHome()}/${icon}`) : "dialog-information";
      const result = await exec("notify-send", [
        "--app-name=Herdr", `--icon=${iconPath}`,
        "--urgency=normal", "--expire-time=8000",
        `--category=${status === "blocked" ? "im.error" : "transfer.complete"}`,
        "--", title, escapeMarkup(body),
      ]);
      if (result.code !== 0) console.log("Desktop notification failed:", result.stderr);
    } catch (error) {
      console.log("Desktop notification failed:", String(error));
    }
  }

  render(cx) {
    const current = agents();
    const previous = this.previous;
    this.previous = new Map(current.map(a => [a.address, a.status]));
    for (const address of this.running) {
      if (!this.previous.has(address)) this.running.delete(address);
    }
    for (const agent of current) {
      if (agent.status === "working") {
        this.running.add(agent.address);
        continue;
      }
      if (agent.status === "idle") {
        this.running.delete(agent.address);
        continue;
      }
      if (previous.get(agent.address) === agent.status) continue;
      if (agent.status !== "done" && agent.status !== "blocked") continue;
      // History navigation and reconnects can expose old attention states.
      // Only notify after observing this agent actually working.
      if (!this.running.has(agent.address)) continue;
      if (agent.status === "done") this.running.delete(agent.address);
      const title = agent.status === "done" ? "Agent finished" : "Agent needs your attention";
      const body = `${agent.program?.name ?? agent.app ?? "Agent"} · ${agent.space_name} · ${agent.tab_name}`;
      cx.spawn(async cx => { await this.send(title, body, agent.status, agent.program?.icon); });
    }
    return div();
  }
}
