import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, machines, theme, window, exec, hc } from "herdr";
import { STATS_PROBE, parseStats, statsUsage } from "./stats.js";
import { pingArgs, parsePing, sshHostname } from "./ping.js";

export default class BottomBarStats extends View {
  init(_props, cx) {
    this.stats = null;
    this.statsOn = undefined;
    this.statsLoading = false;
    this.statsSeq = 0;
    this.ping = null;
    this.pingOn = undefined;
    this.pingLoading = false;
    this.pingSeq = 0;
    this.pingHosts = {};
    this.refreshStats(cx);
    this.refreshPing(cx);
    cx.timer.every(2000, (cx) => this.refreshStats(cx));
    cx.timer.every(5000, (cx) => this.refreshPing(cx));
  }

  activeMachine() {
    return spaces().find((s) => s.active)?.machine ?? null;
  }

  refreshStats(cx) {
    const machine = this.activeMachine();
    if (this.statsOn !== machine) {
      this.statsOn = machine;
      this.stats = null;
      this.statsLoading = false;
      this.statsSeq++;
    }
    if (this.statsLoading) return;
    const known = machines().find((m) => m.name === machine);
    if (known?.layout === "unavailable") {
      this.stats = { offline: true };
      cx.notify();
      return;
    }
    this.statsLoading = true;
    const seq = ++this.statsSeq;
    cx.spawn(async (cx) => {
      let next;
      try {
        const r = await exec("sh", ["-c", STATS_PROBE], { on: machine });
        if (seq !== this.statsSeq) return;
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim().split("\n")[0] || "Probe failed");
        next = statsUsage(parseStats(String(r.stdout ?? "")));
      } catch (e) {
        if (seq !== this.statsSeq) return;
        next = { error: String(e.message ?? e) };
      } finally {
        if (seq === this.statsSeq) {
          this.stats = next ?? { error: "No stats" };
          this.statsLoading = false;
          cx.notify();
        }
      }
    });
  }

  refreshPing(cx) {
    const machine = this.activeMachine();
    if (this.pingOn !== machine) {
      this.pingOn = machine;
      this.ping = null;
      this.pingLoading = false;
      this.pingSeq++;
    }
    if (this.pingLoading) return;
    const known = machines().find((m) => m.name === machine);
    if (known?.layout === "unavailable") {
      this.ping = { offline: true };
      cx.notify();
      return;
    }
    this.pingLoading = true;
    const seq = ++this.pingSeq;
    cx.spawn(async (cx) => {
      let next;
      try {
        const host = machine ? await this.pingHost(machine).catch(() => null) : "127.0.0.1";
        let ms = host ? await this.pingOnce(host) : null;
        if (ms === null) {
          const started = Date.now();
          await exec("sh", ["-c", ":"], { on: machine });
          ms = Date.now() - started;
        }
        next = { ms, host };
      } catch (e) {
        next = { error: String(e.message ?? e) };
      } finally {
        if (seq === this.pingSeq) {
          this.ping = next ?? { error: "No ping" };
          this.pingLoading = false;
          cx.notify();
        }
      }
    });
  }

  async pingHost(machine) {
    if (this.pingHosts[machine]) return this.pingHosts[machine];
    const r = await hc(["machine", "ls", "--json"]).catch(() => null);
    let entry = null;
    try {
      entry = r?.code === 0 ? (JSON.parse(r.stdout).machines ?? []).find((m) => m.name === machine) : null;
    } catch {}
    if (!entry || entry.via || !entry.target) return null;
    const g = await exec("ssh", ["-G", entry.target]).catch(() => null);
    const host = (g?.code === 0 ? sshHostname(g.stdout) : null) ?? entry.target;
    this.pingHosts[machine] = host;
    return host;
  }

  async pingOnce(host) {
    const r = await exec("ping", pingArgs(window()?.platform, host)).catch(() => null);
    if (!r || r.code !== 0) return null;
    return parsePing(r.stdout);
  }

  pctColor(t, pct) {
    return pct === null ? t.dim : pct >= 90 ? t.ansi1 : pct >= 75 ? t.blocked : t.foreground;
  }

  pingColor(t, ms) {
    return ms === null ? t.dim : ms >= 250 ? t.ansi1 : ms >= 100 ? t.blocked : t.foreground;
  }

  metric(t, label, value, color, tip) {
    return h_flex()
      .gap(5)
      .items_center()
      .child(div().text_size(10.4).text_color(t.dim).child(label))
      .child(div().text_color(color).child(value))
      .tooltip(tip);
  }

  render(cx) {
    const t = theme();
    const machine = this.activeMachine();
    if (machine !== this.statsOn) this.refreshStats(cx);
    if (machine !== this.pingOn) this.refreshPing(cx);
    const stats = this.statsOn === machine ? this.stats : null;
    const u = stats && !stats.offline && !stats.error ? stats : null;
    const ping = this.pingOn === machine ? this.ping : null;
    const ms = ping && Number.isFinite(ping.ms) ? ping.ms : null;
    const name = machine ?? "This computer";
    const statsTip = stats?.offline
      ? `${name} · offline`
      : stats?.error
        ? `${name} · ${stats.error}`
        : this.statsLoading
          ? `${name} · reading stats…`
          : `${name} · CPU, memory and disk, every 2s`;
    const pingTip = ping?.offline
      ? `${name} · offline`
      : ping?.error
        ? `${name} · ${ping.error}`
        : this.pingLoading
          ? `${name} · pinging…`
          : `${name} · network round-trip, every 5s`;
    return h_flex()
      .id("bottom-bar-stats")
      .size_full()
      .min_w(0)
      .items_center()
      .justify_center()
      .relative()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .child(
        h_flex()
          .gap(14)
          .items_center()
          .child(this.metric(t, "CPU", u?.cpu == null ? "–" : `${u.cpu}%`, this.pctColor(t, u?.cpu ?? null), statsTip))
          .child(this.metric(t, "MEM", u?.mem == null ? "–" : `${u.mem}%`, this.pctColor(t, u?.mem ?? null), statsTip))
          .child(this.metric(t, "DISK", u?.disk == null ? "–" : `${u.disk}%`, this.pctColor(t, u?.disk ?? null), statsTip))
          .child(this.metric(t, "PING", ms === null ? "–" : `${Math.round(ms)}ms`, this.pingColor(t, ms), pingTip)),
      );
  }
}
