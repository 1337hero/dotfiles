// Every agent on every machine in one list, grouped by whose move it is, each
// with a recap of where it got to and everything around it: what it's asking,
// its branch, what's not committed or pushed, its tasks, its Linear issue and
// its pull request. Type to filter, ←/→ for the stage, ↑/↓ and Enter (or a
// click) to go to the agent on whichever machine it runs, Tab to reply.
//
// What's known of an agent comes from herdr-recap (`sessions`), run on the
// machine the agent runs on; its pull request from herdr-github (`prs`) and its
// issue from herdr-linear (`issues`), run wherever they're signed in.

import { View, div } from "gpui-kit";
import * as fs from "fs/promises";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, machines, spaces, run, exec, hc, theme, appHome, props, closeOverlay, openOverlay, nextCommand, window } from "herdr";
import { demoRows } from "./demo.js";
import { tones, tint, countPill, STAGES, ALL, stageOf, stateIcon, stageColor, icon, prLook, issueIcon, chip, bar, duration, words, key, MONO } from "./look.js";

// While it's open, recaps written meanwhile come in this often; pull requests
// and issues (which the plugins cache for a minute) less often.
const REREAD_MS = 5000;
const LOOKUP_MS = 20000;
// The list's height at most; the popup's own height caps it too.
const LIST_MAX = 680;

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// An agent on another machine (`ax42/t1`) says which.
const machineOf = (address) => (address.includes("/") ? address.split("/")[0] : null);

// Branches that are a repo's own default, not work of an agent's.
const DEFAULT_BRANCHES = new Set(["main", "master", "trunk", "develop"]);

// A ticket's key in a title, as herdr-recap finds one in a branch.
const TICKET = /(?:^|[^a-z0-9])([a-z][a-z0-9]{1,9})-([1-9][0-9]{0,5})(?=[^a-z0-9]|$)/gi;
const NOT_TICKETS = new Set(("phase step part pr v version release issue fix bug test try attempt wave stage sprint " +
  "week day round batch task milestone iteration option plan draft rev").split(" "));
function ticketKey(s) {
  for (const m of (s ?? "").matchAll(TICKET)) {
    if (!NOT_TICKETS.has(m[1].toLowerCase())) return `${m[1].toUpperCase()}-${m[2]}`;
  }
  return null;
}

// The herdr-recap this mod is part of (its release; the repo's tests hold it
// to herdr-plugin.toml's version). It does the work on each machine with
// agents: their sessions, recaps and titles, with the TUI plugin's cache.
export const RECAP_VERSION = "0.12.11";

// Puts that release on a machine, once: into a folder of its own version, so
// it never touches a herdr-recap installed for the TUI. The archive for the
// machine's system is checked against the release's checksums before it's
// used. Prints the binary's path.
const PROVISION = String.raw`
v=$1
dest="$HOME/.local/share/herdr-recap/app/$v"
bin="$dest/herdr-recap"
[ -x "$bin" ] && { printf '%s' "$bin"; exit 0; }
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "no herdr-recap for $(uname -s)" >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) echo "no herdr-recap for $(uname -m)" >&2; exit 1 ;; esac
name="herdr-recap_$v""_$os""_$arch.tar.gz"
url="https://github.com/mrolafsson/herdr-recap/releases/download/v$v"
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url/$name" -o "$tmp/$name" && curl -fsSL "$url/checksums.txt" -o "$tmp/sums" || { echo "couldn't download herdr-recap $v" >&2; exit 1; }
want=$(grep " $name\$" "$tmp/sums" | cut -d' ' -f1)
if command -v sha256sum >/dev/null 2>&1; then have=$(sha256sum "$tmp/$name" | cut -d' ' -f1); else have=$(shasum -a 256 "$tmp/$name" | cut -d' ' -f1); fi
[ -n "$want" ] && [ "$want" = "$have" ] || { echo "herdr-recap $v didn't match its checksum" >&2; exit 1; }
tar -xzf "$tmp/$name" -C "$tmp" herdr-recap || exit 1
mkdir -p "$dest" && mv "$tmp/herdr-recap" "$bin.new" && chmod 755 "$bin.new" && mv "$bin.new" "$bin" || exit 1
printf '%s' "$bin"
`;

// The path of herdr-recap on a machine (null: this one), put there first if
// it isn't: asked once per machine while the mod runs.
const binaries = new Map();
function recapBinary(machine) {
  const key = machine ?? "";
  if (!binaries.has(key)) {
    const p = exec("sh", ["-c", PROVISION, "sh", RECAP_VERSION], { on: machine }).then((r) => {
      if (r.code !== 0 || !r.stdout.trim()) throw new Error(r.stderr.trim().split("\n").pop() || `herdr-recap: exit ${r.code}`);
      return r.stdout.trim();
    });
    // A failure is tried again next time (offline, say), not remembered.
    p.catch(() => binaries.delete(key));
    binaries.set(key, p);
  }
  return binaries.get(key);
}

// Runs a program on a machine (null: this one): herdr-recap, the mod's own;
// herdr-github and herdr-linear, where they're installed.
async function tool(name, args, machine) {
  if (name === "herdr-recap") {
    const path = await recapBinary(machine);
    const r = await exec("sh", ["-c", 'exec "$0" "$@"', path, ...args], { on: machine });
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `${name}: exit ${r.code}`);
    return JSON.parse(r.stdout);
  }
  // herdr-github and herdr-linear: the copy their app mod fetched (the newest),
  // else the one installed for the TUI.
  const find = `for b in $(ls -d "$HOME/.local/share/${name}/app/"*/${name} 2>/dev/null | sort -V -r) "$HOME/.local/bin/${name}"; do [ -x "$b" ] && exec "$b" "$@"; done; echo "${name} isn't installed" >&2; exit 127`;
  const r = await exec("sh", ["-c", find, "sh", ...args], { on: machine });
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `${name}: exit ${r.code}`);
  return JSON.parse(r.stdout);
}

const prKey = (i) => `${i.remote}\u0000${i.branch}`;

// Where what's known is kept between openings: a file, as a shared value
// redraws every mod each time it's set.
const CACHE = `${appHome()}/recap-cache.json`;

export default class Recap extends View {
  init(_props, cx) {
    this.filter = "";
    this.tab = null;
    this.at = 0;
    // The agent being replied to: its address and name.
    this.replying = null;
    // Renames asked for, by address: typed in once the agent's between turns.
    this.renaming = {};
    // Renames done, by address: the new title, shown until the agent's own
    // catches up (Claude Code sets the terminal's title at its next turn).
    this.renamed = {};
    // Better titles asked for on demand (ctrl+r with none suggested), by
    // address: when, so the card can say so until one comes.
    this.asking = {};
    this.typing = new Set();
    // What herdr-recap said of each agent, by address; pull requests by remote
    // and branch; issues by key; and what couldn't be done, with why.
    // What was known when it last closed shows at once, until the machines
    // answer: they can take a moment, over ssh.
    this.info = {};
    this.prs = {};
    this.issues = {};
    this.kept = "";
    cx.spawn(async (cx) => {
      const kept = JSON.parse((await fs.readFile(CACHE, "utf8").catch(() => null)) ?? "{}");
      // Only what hasn't been answered for meanwhile.
      this.info = { ...kept.info, ...this.info };
      this.prs = { ...kept.prs, ...this.prs };
      this.issues = { ...kept.issues, ...this.issues };
      cx.notify();
    });
    this.unasked = {};
    this.lookedUp = 0;
    // With herdr-teleport's mod installed, ctrl+t moves the chosen agent to
    // another machine (in Teleport's popup, which comes back here on esc).
    this.teleportable = false;
    // With herdr-github's mod installed, a pull request opens there (on its
    // screen, esc coming back here) rather than in the browser.
    this.github = false;
    this.linear = false;
    cx.spawn(async (cx) => {
      const has = async (mod) => (await fs.readFile(`${appHome()}/mods/${mod}/main.js`, "utf8").catch(() => null)) !== null;
      this.teleportable = await has("teleport");
      this.github = await has("github");
      this.linear = await has("linear");
      cx.notify();
    });
    // Each agent's terminal as the core describes it (its Claude process, its
    // folder, when its status changed, Claude's own word), by address: asked
    // for with `hc get` off the UI thread rather than terminals() on every draw.
    this.core = new Map();
    this.width = 900;
    // When each agent's status last changed, for agents the core gives no time for.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    // The demo's made-up agents in place of the real ones (recap.demo): for
    // this opening only, never kept, so the popup always opens on your own.
    this.demo = Boolean(props()?.demo);
    localStorage.removeItem("demo");

    this.input = InputState.new({ placeholder: "Type to filter…  ← → to change tabs" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      cx.notify();
    });
    this.input.on("submit", () => this.go(this.shown?.[this.at]));
    // The popup's keys (arrows, Enter, Tab, Esc) arrive only while the
    // keyboard is in it, so the filter takes it back whenever it loses it: a
    // click elsewhere in the popup, the window coming back. Not when it went
    // to the reply box (Tab), nor as the popup closes.
    this.input.on("focus", () => (this.closing = false));
    this.input.on("blur", (_e, cx) => {
      cx.timer.after(40, () => {
        if (!this.replying && !this.closing) this.input.focus();
      });
    });
    // Tab never reaches a key handler or keys.json here: the window takes it
    // first, to move the keyboard to the next box. So the reply box is that
    // next box, always drawn (out of sight until there's a reply to write),
    // and the keyboard arriving in it starts a reply to the chosen agent.
    this.reply = InputState.new({ placeholder: "Your reply…" });
    this.reply.on("submit", (_e, cx) => this.send(cx));
    this.reply.on("focus", (_e, cx) => {
      if (this.replying) return;
      const sel = this.shown?.[this.at];
      if (sel) this.startReply(sel, cx);
      else cx.timer.after(0, () => this.input.focus());
    });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());

    // Out-of-date recaps are written once, on opening; the ones written
    // meanwhile are read in while it's open.
    this.ask(cx, true);
    cx.timer.every(REREAD_MS, (cx) => this.ask(cx, false));
    // Key bindings and `herdr-app do`: recap.next, recap.prev, recap.reply,
    // recap.rename, recap.ignore, or a tab (recap.all, recap.blocked, …).
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const sel = this.shown?.[this.at];
        // Esc (keys.json binds it here, over the app's own): out of a reply
        // first, and only then out of the popup.
        if (c === "demo") {
          this.demo = !this.demo;
          this.at = 0;
        } else if (c === "escape") this.replying ? this.endReply(cx) : this.dismiss();
        else if (c === "reply") this.startReply(sel, cx);
        else if (c === "rename") sel && this.rename(sel, cx);
        else if (c === "ignore") sel && this.ignore(sel, cx);
        else if (c === "teleport") this.teleport(sel, cx);
        else if (c === "next" || c === "prev") (this.step(c === "next" ? 1 : -1), (this.at = 0));
        else if ([ALL, ...STAGES].some((s) => s.id === c)) (this.tab = c), (this.at = 0);
        cx.notify();
      }
    });
  }

  dismiss() {
    this.closing = true;
    closeOverlay(props().overlay);
  }

  go(r) {
    if (!r) return;
    this.dismiss();
    if (this.demo) return;
    run("agent.focus", { terminal: r.address });
  }

  // Teleport's popup on this agent, in place of this one; esc there comes back.
  // In the demo, Teleport's demo: its made-up machines, nothing touched.
  teleport(r, cx) {
    if (!r || !this.teleportable) return;
    this.dismiss();
    openOverlay({ mod: "teleport", kind: "dialog", width: 640, height: 460, props: { address: r.address, back: "recap", demo: this.demo || undefined } });
  }

  // A pull request: on its screen in the GitHub mod when that's installed,
  // else in the browser.
  openPR(pr) {
    const m = /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(pr?.url ?? "");
    if (!this.github || !m) return this.open(pr?.url);
    this.dismiss();
    // The demo's pull requests are the GitHub mod's demo's: it opens on them there.
    openOverlay({ mod: "github", kind: "dialog", width: 0.8, height: 0.8, props: { pr: { host: m[1], repo: m[2], number: Number(m[3]) }, back: "recap", demo: this.demo || undefined } });
  }

  // A Linear issue: on its screen in the Linear mod when that's installed,
  // else in the browser.
  openIssue(r) {
    const url = r?.issue?.url;
    const m = /^https:\/\/linear\.app\/([^/]+)\/issue\/([A-Za-z][A-Za-z0-9_]*-\d+)/.exec(url ?? "");
    if (!this.linear || !m) return this.open(url);
    this.dismiss();
    openOverlay({ mod: "linear", kind: "dialog", width: 0.8, height: 0.8, props: { issue: { key: m[2], workspaceKey: m[1] }, back: "recap", demo: this.demo || undefined } });
  }

  open(url) {
    if (url) exec(window()?.platform === "macos" ? "open" : "xdg-open", [url]).catch(() => {});
  }

  // The keyboard moves on a moment later: after this key, and once the reply
  // box has been drawn where it can be seen.
  startReply(r, cx, kind = "reply") {
    if (!r) return;
    this.replying = { address: r.address, name: r.name || r.address, kind };
    cx.notify();
    cx.timer.after(30, (cx) => {
      // A rename starts from the title it has, to edit.
      this.reply.set_value(kind === "title" ? r.name || "" : "");
      this.reply.focus();
      cx.notify();
    });
  }

  endReply(cx) {
    this.replying = null;
    cx.notify();
    cx.timer.after(30, () => this.input.focus());
  }

  // Types the reply into the agent and enters it, wherever it runs.
  send(cx) {
    const text = this.reply.value().trim();
    const to = this.replying;
    if (!text || !to) return;
    this.endReply(cx);
    if (to.kind === "title") return this.retitle(to.address, text, cx);
    if (this.demo) {
      this.unasked.reply = `Demo: "${text}" would go to ${to.name}.`;
      return cx.notify();
    }
    cx.spawn(async (cx) => {
      const r = await hc(["send", to.address, text]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) this.unasked.reply = `Couldn't send it to ${to.name}: ${r.stderr.trim()}`;
      else delete this.unasked.reply;
      cx.notify();
    });
  }

  // Takes the suggested title: /rename once the agent's between turns, then
  // it isn't offered again.
  rename(r, cx) {
    if (!r.suggested) return this.askTitle(r, cx);
    if (this.demo) {
      this.unasked.reply = `Demo: it would be renamed to ${r.suggested}.`;
      return cx.notify();
    }
    this.renaming[r.address] = r.suggested;
    this.giveTitles(cx);
    cx.notify();
  }

  // A title you typed (a click on the chosen card's title): /rename once the agent's between turns, and
  // a suggestion, if any, isn't offered again.
  retitle(address, title, cx) {
    if (this.demo) {
      this.unasked.reply = `Demo: it would be renamed to ${title}.`;
      return cx.notify();
    }
    this.renaming[address] = title;
    this.giveTitles(cx);
    cx.notify();
  }

  // A better title asked for now, as the TUI's ctrl+r does on an agent with
  // none suggested: herdr-recap asks Claude in the background, and the
  // suggestion comes with a later look, for you to take or ignore.
  askTitle(r, cx) {
    if (!r || this.asking[r.address]) return;
    if (this.demo) {
      this.unasked.reply = `Demo: a better title for ${r.name} would be asked for now.`;
      return cx.notify();
    }
    const t = this.core.get(r.address);
    const pid = t?.foreground?.pid;
    if (!pid) {
      this.unasked.title = `Couldn't ask for a title for ${r.name}: it isn't running Claude Code.`;
      return cx.notify();
    }
    this.asking[r.address] = Date.now();
    delete this.unasked.title;
    cx.notify();
    const ask = [{ pid, cwd: t.foreground?.cwd ?? t.cwd, title: clean(r.name) }];
    cx.spawn(async (cx) => {
      try {
        await tool("herdr-recap", ["title", JSON.stringify(ask)], machineOf(r.address));
      } catch (e) {
        delete this.asking[r.address];
        this.unasked.title = `Couldn't ask for a title for ${r.name}: ${e?.message ?? e}`;
      }
      cx.notify();
    });
  }

  // A space takes its agent's new title, as the TUI's does, when nobody named
  // it and the agent is the only one in it: its name was only a stand-in.
  nameSpace(a, title) {
    const space = spaces().find((s) => s.id === a.space);
    if (!space || space.named || agents().filter((x) => x.space === a.space).length !== 1) return;
    run("space.rename", { id: a.space, name: title });
  }

  // Types in the renames asked for, for agents between turns.
  giveTitles(cx) {
    for (const a of agents()) {
      const title = this.renaming[a.address];
      if (!title || a.status === "working" || this.typing.has(a.address)) continue;
      this.typing.add(a.address);
      cx.spawn(async (cx) => {
        const r = await hc(["send", a.address, `/rename ${title}`]).catch((e) => ({ code: 1, stderr: String(e) }));
        if (r.code !== 0) this.unasked.rename = `Couldn't rename it: ${r.stderr.trim()}`;
        else {
          delete this.unasked.rename;
          await this.settle(a.address);
          this.renamed[a.address] = { title, from: clean(a.title) };
          this.nameSpace(a, title);
        }
        delete this.renaming[a.address];
        this.typing.delete(a.address);
        cx.notify();
      });
    }
  }

  // Turns the suggested title down.
  ignore(r, cx) {
    delete this.renaming[r.address];
    cx.spawn(async (cx) => {
      await this.settle(r.address);
      cx.notify();
    });
  }

  async settle(address) {
    const info = this.info[address];
    if (!info?.session) return;
    info.title = null;
    const machine = machineOf(address);
    const bin = await recapBinary(machine).catch(() => null);
    if (bin) await exec("sh", ["-c", 'exec "$1" settle "$2"', "sh", bin, info.session], { on: machine }).catch(() => {});
  }

  // Keeps what's known for the next opening, when it's changed; says whether
  // it had (or what couldn't be done has), which is when to redraw.
  keep() {
    if (this.changedDirty) {
      this.changedDirty = false;
      localStorage.setItem("changed", JSON.stringify(this.changed));
    }
    const trouble = JSON.stringify(this.unasked);
    const troubled = trouble !== this.trouble;
    this.trouble = trouble;
    const now = JSON.stringify({ info: this.info, prs: this.prs, issues: this.issues });
    if (now === this.kept) return troubled;
    this.kept = now;
    fs.writeFile(CACHE, now).catch(() => {});
    return true;
  }

  step(d) {
    const tabs = this.tabs ?? [ALL, ...STAGES];
    const i = Math.max(0, tabs.findIndex((s) => s.id === this.tab));
    this.tab = tabs[(i + d + tabs.length) % tabs.length].id;
  }

  // Asks herdr-recap on each machine about its Claude agents; write: and to
  // write the recaps out of date, for agents not working.
  ask(cx, write) {
    // The demo asks no machine anything.
    if (this.demo) return;
    cx.spawn(async (cx) => {
      const list = agents();
      const got = await Promise.all(list.map((a) => hc(["get", "--json", a.address]).then((r) => (r.code === 0 ? JSON.parse(r.stdout) : null)).catch(() => null)));
      const core = new Map(list.map((a, i) => [a.address, got[i]]).filter(([, t]) => t));
      // What's drawn of it: only a change there is worth a redraw.
      const seen = JSON.stringify([...core].map(([k, t]) => [k, t.status_ms, t.status?.msg]));
      this.core = core;
      this.askEach(cx, write);
      if (seen !== this.seenCore) {
        this.seenCore = seen;
        cx.notify();
      }
    });
  }

  askEach(cx, write) {
    const core = this.core;
    const byMachine = new Map();
    for (const a of agents()) {
      const t = core.get(a.address);
      const pid = t?.foreground?.pid;
      if (!pid || (a.app ?? t.status?.app) !== "claude-code") continue;
      const m = machineOf(a.address);
      if (!byMachine.has(m)) byMachine.set(m, []);
      byMachine.get(m).push({ a, pid, cwd: t.foreground?.cwd ?? t.cwd });
    }
    for (const [machine, list] of byMachine) {
      const args = [JSON.stringify(list.map(({ a, pid, cwd }) => ({ pid, cwd, title: clean(a.title) })))];
      if (write && list.some(({ a }) => a.status !== "working")) args.unshift("--write");
      cx.spawn(async (cx) => {
        try {
          const said = new Map((await tool("herdr-recap", ["sessions", ...args], machine)).map((s) => [s.pid, s]));
          for (const { a, pid } of list) if (said.has(pid)) this.info[a.address] = said.get(pid);
          delete this.unasked[machine ?? ""];
        } catch (e) {
          this.unasked[machine ?? ""] = `No recaps from ${machine ?? "this computer"}: ${e?.message ?? e}`;
        }
        if (Date.now() - this.lookedUp > LOOKUP_MS) this.lookUp(cx);
        this.giveTitles(cx);
        // Herdr's script engine is slow to draw: only when something changed.
        if (this.keep()) cx.notify();
      });
    }
  }

  // Where herdr-github and herdr-linear are signed in: the machine that
  // answered last, else this one, else each connected one in turn.
  async where(name, args) {
    const tried = new Set();
    const order = [localStorage.getItem(`on.${name}`), "", ...machines().filter((m) => m.name).map((m) => m.name)];
    let last;
    for (const m of order) {
      if (m == null || tried.has(m)) continue;
      tried.add(m);
      try {
        const out = await tool(name, args, m || null);
        localStorage.setItem(`on.${name}`, m);
        return out;
      } catch (e) {
        last = e;
      }
    }
    throw last ?? new Error(`${name} isn't installed`);
  }

  lookUp(cx) {
    this.lookedUp = Date.now();
    const prAsks = new Map();
    for (const i of Object.values(this.info)) if (i.remote && i.branch) prAsks.set(prKey(i), { remote: i.remote, branch: i.branch, head: i.head ?? "" });
    const keys = new Set();
    for (const a of agents()) {
      const k = this.info[a.address]?.ticket ?? ticketKey(clean(a.title));
      if (k) keys.add(k);
    }
    if (prAsks.size) {
      cx.spawn(async (cx) => {
        try {
          for (const p of await this.where("herdr-github", ["prs", JSON.stringify([...prAsks.values()])])) this.prs[prKey(p)] = p.pr;
          delete this.unasked.github;
        } catch (e) {
          this.unasked.github = `No pull requests: ${e?.message ?? e}`;
        }
        if (this.keep()) cx.notify();
      });
    }
    if (keys.size) {
      cx.spawn(async (cx) => {
        try {
          for (const i of await this.where("herdr-linear", ["issues", JSON.stringify([...keys])])) this.issues[i.key] = i.issue;
          delete this.unasked.linear;
        } catch (e) {
          this.unasked.linear = `No Linear issues: ${e?.message ?? e}`;
        }
        if (this.keep()) cx.notify();
      });
    }
  }

  since(a, core, now) {
    const at = core.get(a.address)?.status_ms;
    if (at) return at;
    const s = this.changed[a.address];
    if (s?.status === a.status) return s.at;
    this.changed[a.address] = { status: a.status, at: now };
    this.changedDirty = true;
    return now;
  }

  rows(now) {
    if (this.demo) return demoRows(now);
    const core = this.core;
    return agents().map((a) => {
      const i = this.info[a.address] ?? {};
      // A rename just made, until the terminal's title says so itself.
      const done = this.renamed[a.address];
      if (done && clean(a.title) !== done.from) delete this.renamed[a.address];
      const title = this.renamed[a.address]?.title ?? clean(a.title);
      const ticket = i.ticket ?? ticketKey(title);
      const r = {
        ...a,
        name: title && title !== a.program?.name ? title : a.tab_name,
        space: a.space_name,
        machine: machineOf(a.address),
        info: i,
        branch: i.branch ?? null,
        changes: i.changes,
        pr: i.remote && i.branch ? this.prs[prKey(i)] ?? null : null,
        ticket,
        issue: ticket ? this.issues[ticket] ?? null : null,
        recap: i.recap ?? null,
        // Claude's own word on where it is, until there's a recap.
        note: core.get(a.address)?.status?.msg ?? null,
        pending: a.status === "blocked" ? i.pending ?? null : null,
        suggested: i.title ?? null,
        renaming: this.renaming[a.address] ?? null,
        asking: Boolean(this.asking[a.address]) && !i.title && now - this.asking[a.address] < 180000,
        since: this.since(a, core, now),
      };
      if (this.asking[a.address] && !r.asking) delete this.asking[a.address];
      r.stage = stageOf(r);
      return r;
    });
  }

  matches(r) {
    const f = this.filter.toLowerCase();
    if (!f) return true;
    const stage = STAGES.find((s) => s.id === r.stage);
    return [r.name, r.space, r.branch, r.machine, r.ticket, r.issue?.title, r.issue?.state, r.recap, r.note, r.pending,
      r.pr ? `#${r.pr.number}` : "", stage?.label, r.program?.name]
      .join(" ").toLowerCase().includes(f);
  }

  // The time beside an agent: how long it's been waiting, done or at work.
  when(r, now) {
    const d = duration(now - r.since);
    switch (r.status) {
      case "blocked":
        return `waiting ${d}`;
      case "done":
        return `done ${d}`;
      case "working":
        return `working ${duration(now - (Date.parse(r.info.prompt_at) || r.since))}`;
    }
    return `for ${d}`;
  }

  // What an agent's card says: its recap; else Claude's own word on where it
  // is; else, for one at work with neither yet, what it was asked (its last
  // prompt), or its Linear issue.
  said(r) {
    if (r.recap) return r.recap;
    if (r.note) return r.note;
    if (r.info?.last_prompt) return `› ${r.info.last_prompt}`;
    if (r.ticket && r.issue?.title) return `${r.ticket}: ${r.issue.title}`;
    return null;
  }

  // About how tall an agent's card is, for the list's height: lines of the
  // recap at the popup's width, and a line each for what else it shows.
  height(r) {
    const perLine = Math.max(40, Math.floor((this.width - 120) / 6.6));
    const said = this.said(r) ?? "Nothing to recap yet.";
    // Padding and the title line; the recap's lines; the callout, the rename
    // line and the chips, each with its gap.
    let h = 23 + 22 + Math.ceil(said.length / perLine) * 19.5;
    if (r.pending) h += 46;
    if (r.suggested || r.renaming) h += 25;
    if (r.branch || r.ticket || r.pr || r.info.tasks_total) h += 28;
    return h + 4;
  }

  // What's around an agent, as chips: its branch (in mono), what's not
  // committed or pushed, its tasks as a small bar, its Linear issue and its
  // pull request in their own colours (a click opens them).
  details(o, r) {
    const c = r.changes ?? {};
    const pr = r.pr;
    const id = (k) => `${k}-${r.address}`;
    const out = [];
    // A default branch says nothing: only a branch of its own gets a chip.
    if (r.branch && !DEFAULT_BRANCHES.has(r.branch)) out.push(chip(o, id("br"), [icon("branch", o.dim, 13), r.branch], { mono: true }));
    if (c.files || c.ahead) {
      out.push(chip(o, id("ch"), [
        c.files ? div().text_color(o.fg).child(`${c.files} file${c.files > 1 ? "s" : ""}`) : null,
        c.added ? div().text_color(o.review).child(`+${c.added}`) : null,
        c.deleted ? div().text_color(o.fix).child(`−${c.deleted}`) : null,
        c.ahead ? `· ${c.ahead} ahead` : null,
      ]));
    }
    const total = r.info.tasks_total;
    if (total) out.push(chip(o, id("tk"), [icon("tasks", o.dim, 13), bar(o, r.info.tasks_done / total, o.done), `${r.info.tasks_done}/${total}`]));
    if (r.ticket) {
      const url = r.issue?.url;
      out.push(chip(o, id("is"), [icon(issueIcon(r.issue), o.accent, 13), div().font_semibold().child(r.ticket), r.issue?.state ?? null],
        { color: o.accent, click: url ? () => this.openIssue(r) : null }));
    }
    if (pr) {
      const look = prLook(o, pr);
      const what = pr.state === "draft" || pr.state === "merged" || pr.state === "closed" ? pr.state
        : pr.conflicts ? "conflicts" : pr.review === "changes requested" ? "changes" : pr.review === "approved" ? "approved" : null;
      out.push(chip(o, id("pr"), [icon(look.icon, look.color, 13), div().font_semibold().child(`#${pr.number}`), pr.checks ?? null, what],
        { color: look.color, click: pr.url ? () => this.openPR(pr) : null }));
      if (/\bqueued\b/.test(pr.badge ?? "")) out.push(chip(o, id("q"), [icon("queue", o.accent, 13), "queued"], { color: o.accent }));
    }
    return out;
  }


  // An agent's card: its icon (spinning while it works, breathing while it
  // needs you), its title, machine and time; then what it's asking, a better
  // title, the recap, and the chips around it. The chosen one lifts: a raised
  // surface, a shadow, an edge in its stage's colour. One that needs you is
  // tinted with it.
  card(t, o, r, sel, now) {
    const tone = stageColor(o, r.stage);
    const on = r === sel;
    const need = r.stage === "blocked";
    const details = this.details(o, r);
    const said = this.said(r);
    const quiet = r.status === "idle" || r.stage === "merged";
    return h_flex()
      .id(`rc-${r.address}`)
      .flex_none()
      .items_stretch()
      .rounded(10)
      .overflow_hidden()
      .when(need, (el) => el.bg(tint(o.need, 0.07)))
      .when(on, (el) => el.bg(need ? tint(o.need, 0.12) : o.raised).shadow_md())
      .when(!on, (el) => el.hover((el) => el.bg(o.raised)))
      .cursor_pointer()
      .on_click((_e, cx) => {
        if (on) return this.go(r);
        this.at = this.shown.indexOf(r);
        cx.notify();
      })
      // The chosen one's mark, in its stage's colour: a bar set a little in
      // from the card's edge, inside its background.
      .child(v_flex().w(3).ml(12).flex_none().pt(12).pb(12).child(div().flex_1().min_h(16).rounded(2).when(on, (el) => el.bg(tone))))
      .child(
        h_flex().flex_1().min_w(0).items_start().gap(10).pl(8).pr(14).pt(11).pb(12)
          .child(div().flex_none().pt(1).child(stateIcon(o, r)))
          .child(
            v_flex().flex_1().min_w(0).gap(6)
              .child(
                h_flex().gap(8).items_center()
                  // The chosen card's title: a click renames it (no key: a click it is).
                  .child(div().id(`ti-${r.address}`).min_w(0).truncate().text_size(14.5).font_semibold().text_color(o.fg)
                    .when(on, (el) => el.cursor_text().hover((s) => s.underline()).on_click((_e, cx) => {
                      cx.stop_propagation();
                      this.startReply(r, cx, "title");
                    }))
                    .child(r.name || r.address))
                  // Its machine, every card: another by name, this one as the app calls it.
                  .child(
                    h_flex().flex_none().h(18).px(6).gap(4).items_center().rounded(5).border_1().border_color(o.line).bg(o.sunk)
                      .font_family(MONO).text_size(10.5).text_color(o.fg)
                      .child(icon(r.machine ? "server" : "laptop", o.muted, 11))
                      .child(div().child(r.machine ?? "this computer")))
                  .when(Boolean(r.space), (el) => el.child(div().flex_none().text_size(12).text_color(o.dim).child(r.space)))
                  .child(div().flex_1())
                  .child(div().flex_none().text_size(12).when(!quiet, (el) => el.font_medium()).text_color(quiet ? o.dim : tone).child(this.when(r, now))),
              )
              // A question waiting for you: a callout with its own Reply.
              .when(Boolean(r.pending), (el) =>
                el.child(
                  h_flex().gap(10).items_center().px(10).py(8).rounded(8).bg(tint(o.need, 0.14))
                    .child(div().flex_none().font_bold().text_color(o.need).child("?"))
                    .child(div().flex_1().min_w(0).font_medium().text_color(o.fg).child(r.pending))
                    .child(
                      h_flex().id(`ask-${r.address}`).flex_none().h(24).px(9).gap(6).items_center().rounded(6).bg(o.need)
                        .cursor_pointer().hover((s) => s.opacity(0.85))
                        .on_click((_e, cx) => {
                          cx.stop_propagation();
                          this.at = this.shown.indexOf(r);
                          this.startReply(r, cx);
                        })
                        .child(icon("reply", o.surface, 12))
                        .child(div().text_size(11.5).font_semibold().text_color(o.surface).child("Reply")))))
              .when(Boolean(r.asking), (el) =>
                el.child(div().truncate().text_size(12.5).italic().text_color(o.dim).child("Asking for a better title…")))
              .when(Boolean(r.renaming), (el) =>
                el.child(div().truncate().text_size(12.5).text_color(o.dim).child(`Renaming to ${r.renaming}${r.status === "working" ? " once it's finished" : "…"}`)))
              .when(Boolean(r.suggested && !r.renaming), (el) =>
                el.child(
                  h_flex().gap(8).items_center().text_size(12.5)
                    .child(icon("edit", o.dim, 13))
                    .child(div().flex_none().text_color(o.muted).child("Rename to"))
                    .child(div().min_w(0).truncate().font_medium().text_color(o.fg).child(r.suggested))
                    .child(words(o, [[["Rename", o.accent, (cx) => this.rename(r, cx)]], [["Ignore", o.dim, (cx) => this.ignore(r, cx)]]], `sg-${r.address}`)),
                ))
              .child(div().text_size(13).line_height(1.5).text_color(said && r.recap ? o.muted : o.dim).when(!r.recap, (el) => el.italic()).child(said || "Nothing to recap yet."))
              .when(details.length > 0, (el) => el.child(h_flex().gap(6).flex_wrap().items_center().children(details))),
          ),
      );
  }

  render() {
    const t = theme();
    const o = tones(t);
    const now = Date.now();
    const all = this.rows(now);
    const listed = all.filter((r) => this.matches(r));
    const order = (r) => STAGES.findIndex((s) => s.id === r.stage);
    listed.sort((x, y) => order(x) - order(y) || y.since - x.since);
    const count = (id) => (id === "all" ? listed.length : listed.filter((r) => r.stage === id).length);
    // Tabs for the stages anyone's at; All first.
    this.tabs = [ALL, ...STAGES.filter((s) => count(s.id))];
    if (!this.tab || !this.tabs.some((s) => s.id === this.tab)) this.tab = "all";
    this.shown = this.tab === "all" ? listed : listed.filter((r) => r.stage === this.tab);
    this.at = Math.max(0, Math.min(this.at, this.shown.length - 1));
    const sel = this.shown[this.at];

    // A segmented control: each stage with its colour's dot and its count;
    // the chosen one raised.
    const tab = (s) => {
      const on = s.id === this.tab;
      return h_flex()
        .id(`tab-${s.id}`)
        .flex_none()
        .h(28)
        .px(10)
        .gap(7)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .text_size(12.5)
        .when(on, (el) => el.bg(o.raised).shadow_sm())
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => {
          this.tab = s.id;
          this.at = 0;
          cx.notify();
        })
        .child(div().flex_none().w(7).h(7).rounded_full().bg(o[s.tone]))
        .child(div().when(on, (el) => el.font_semibold()).when(!on, (el) => el.font_medium()).text_color(on ? o.fg : o.muted).child(s.short))
        .child(countPill(o, count(s.id), on));
    };

    // The list starts at the agent that keeps the chosen one in sight (its
    // cards have buttons of their own, so a list that scrolls itself isn't
    // for them): up to the chosen one when it's above, and on from the top
    // while what's between doesn't fit.
    const headed = (i) => this.tab === "all" && (i === 0 || this.shown[i].stage !== this.shown[i - 1].stage);
    const est = (i) => this.height(this.shown[i]) + (headed(i) ? 32 : 0);
    this.first = Math.max(0, Math.min(this.first ?? 0, this.at));
    while (this.first < this.at) {
      let h = 32; // the first one's heading
      for (let i = this.first; i <= this.at; i++) h += est(i);
      if (h <= LIST_MAX) break;
      this.first++;
    }

    // Under All, a heading for each stage, and above the first one shown.
    const items = [];
    let last = null;
    let headings = 0;
    if (this.first > 0) {
      items.push(div().flex_none().px(10).text_size(11).text_color(o.dim).child(`↑ ${this.first} more`));
    }
    for (const r of this.shown.slice(this.first)) {
      if (this.tab === "all" && r.stage !== last) {
        const s = STAGES.find((s) => s.id === r.stage);
        // Small capitals in the stage's colour, its count, a rule.
        items.push(
          h_flex().flex_none().px(10).pt(headings ? 12 : 4).pb(4).gap(8).items_center().text_size(10.5)
            .child(div().font_semibold().text_color(o[s.tone]).child(s.label.toUpperCase()))
            .child(div().font_medium().text_color(o.dim).child(String(count(s.id))))
            .child(div().flex_1().h(1).bg(o.line)),
        );
        headings++;
        last = r.stage;
      }
      items.push(this.card(t, o, r, sel, now));
    }

    // The popup is as tall as what's in it, up to its height, so the list says
    // how tall it'd like to be, and shrinks (and scrolls) when that's too tall.
    const listH = this.shown.length
      ? Math.min(LIST_MAX, headings * 32 + this.shown.reduce((h, r) => h + this.height(r), 0))
      : 44;
    const empty = this.filter ? "No agent matches." : "No agents yet. Agents started in Herdr show up here, from every machine.";
    const info = sel?.info ?? {};
    const trouble = Object.values(this.unasked);
    const machineCount = new Set(all.map((r) => r.machine ?? "here")).size;
    const summary = this.demo
      ? "Demo · made-up agents"
      : `${all.length} agent${all.length === 1 ? "" : "s"}${machineCount > 1 ? ` · ${machineCount} machines` : ""}`;
    const replying = this.replying;

    return v_flex()
      .id("recap")
      .w_full()
      .min_h(0)
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 20) {
          this.width = size.width;
          cx.notify();
        }
      })
      .on_key_down((e, cx) => {
        const k = e.keystroke;
        if (replying) {
          if (k !== "escape") return;
          this.endReply(cx);
          return cx.stop_propagation();
        }
        if (k === "escape") return this.dismiss();
        if (k === "down" && this.shown.length) this.at = Math.min(this.shown.length - 1, this.at + 1);
        else if (k === "up" && this.shown.length) this.at = Math.max(0, this.at - 1);
        // The cursor keeps ←/→ while there's a filter to move through.
        else if (k === "right" && !this.filter) (this.step(1), (this.at = 0));
        else if (k === "left" && !this.filter) (this.step(-1), (this.at = 0));
        else if (k === "tab") this.startReply(sel, cx);
        else if (k === "ctrl-g") this.openPR(sel?.pr);
        else if (k === "ctrl-l") this.openIssue(sel);
        else if (k === "ctrl-t") this.teleport(sel, cx);
        else if (k === "ctrl-r" && sel) this.rename(sel, cx);
        else if (k === "ctrl-x" && sel?.suggested) this.ignore(sel, cx);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex().h(36).flex_none().px(12).gap(10).items_center().rounded(9).border_1().border_color(o.line).bg(o.sunk)
          .child(icon("search", o.dim, 15))
          .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(o.fg))
          .child(div().flex_none().text_size(12).text_color(o.muted).child(summary)),
      )
      .child(h_flex().flex_none().gap(4).flex_wrap().children(this.tabs.map(tab)))
      .child(
        v_flex()
          .id("rc-list")
          .h(listH)
          .min_h(0)
          .flex_shrink(1)
          .gap(2)
          .overflow_hidden()
          // The wheel moves through the agents, as ↑ ↓ do.
          .on_scroll_wheel((e, cx) => {
            this.wheel = (this.wheel ?? 0) + (e.delta_lines ? e.delta_lines.y * 40 : e.delta.y);
            const n = this.shown.length;
            while (Math.abs(this.wheel) >= 40 && n) {
              this.at = Math.max(0, Math.min(n - 1, this.at + (this.wheel < 0 ? 1 : -1)));
              this.wheel -= Math.sign(this.wheel) * 40;
            }
            cx.notify();
          })
          .when(!this.shown.length, (el) => el.child(div().px(14).py(10).text_size(12.8).text_color(o.dim).child(empty)))
          .children(items),
      )
      .when(trouble.length > 0, (el) => el.children(trouble.map((why) => div().flex_none().text_size(11).text_color(o.dim).truncate().child(why))))
      // Replying: who to, and the box, where the footer was.
      .when(Boolean(replying), (el) =>
        el.child(
          h_flex().flex_none().gap(8).items_center().text_size(12.5)
            .child(icon("reply", o.need, 13))
            .child(div().font_medium().text_color(o.fg).child(replying.kind === "title" ? `Rename ${replying.name} to` : `Reply to ${replying.name}`))
            .child(div().text_color(o.dim).child(machineOf(replying.address) ?? "")),
        ))
      .child(
        h_flex().flex_none().gap(8).items_center().rounded(9).bg(o.sunk).px(12)
          .when(Boolean(replying), (el) => el.h(36).border_1().border_color(o.need))
          .when(!replying, (el) => el.h(0).overflow_hidden())
          .child(div().text_color(o.need).child("›"))
          .child(Input.new(this.reply).flex_1().h_full().text_size(13).text_color(o.fg)),
      )
      .when(!replying, (el) =>
        el.child(
          h_flex().flex_none().gap(10).items_center().text_size(12)
            .child(div().flex_1().min_w(0).truncate().italic().text_color(o.dim).child(info.last_prompt ? `› ${info.last_prompt}` : ""))
            .when(Boolean(info.model), (el) => el.child(div().flex_none().font_medium().text_color(o.accent).child(info.model)))
            .when(Boolean(info.model && info.mode), (el) => el.child(div().flex_none().text_color(o.dim).child("·")))
            .when(Boolean(info.mode), (el) => el.child(div().flex_none().font_medium().text_color(o.work).child(info.mode))),
        ))
      // The keys, as keycaps: what each does, clickable.
      .child(
        h_flex().flex_none().gap(14).flex_wrap().items_center().pt(8).border_t_1().border_color(o.line)
          .when(Boolean(replying), (el) =>
            el.child(key(o, ["⏎"], replying?.kind === "title" ? "rename" : "send", (cx) => this.send(cx), "h-send"))
              .child(key(o, ["esc"], "cancel", (cx) => this.endReply(cx), "h-cancel")))
          .when(!replying, (el) =>
            el.child(key(o, ["↑", "↓"], "move", (cx) => ((this.at = (this.at + 1) % Math.max(1, this.shown.length)), cx.notify()), "h-move"))
              .child(key(o, ["⏎"], "go to it", () => this.go(sel), "h-go"))
              .child(key(o, ["⇥"], "reply", (cx) => this.startReply(sel, cx), "h-reply"))
              .when(Boolean(sel?.suggested && !sel?.renaming), (el) =>
                el.child(key(o, ["^r"], "rename", (cx) => this.rename(sel, cx), "h-rename"))
                  .child(key(o, ["^x"], "ignore", (cx) => this.ignore(sel, cx), "h-ignore")))
              .when(Boolean(sel && !sel.suggested && !sel.renaming && !sel.asking), (el) =>
                el.child(key(o, ["^r"], "suggest a title", (cx) => this.rename(sel, cx), "h-suggest")))
              .when(Boolean(sel), (el) => el.child(key(o, [], "rename", (cx) => this.startReply(sel, cx, "title"), "h-retitle")))
              .when(Boolean(sel?.pr?.url), (el) => el.child(key(o, ["^g"], "pull request", () => this.openPR(sel.pr), "h-pr")))
              .when(Boolean(sel?.issue?.url), (el) => el.child(key(o, ["^l"], "issue", () => this.openIssue(sel), "h-issue")))
              .when(Boolean(sel && this.teleportable && (this.demo || machines().length > 1)), (el) => el.child(key(o, ["^t"], "teleport", (cx) => this.teleport(sel, cx), "h-teleport")))
              .child(key(o, ["←", "→"], "stage", (cx) => (this.step(1), cx.notify()), "h-stage"))
              .child(key(o, ["esc"], "close", () => this.dismiss(), "h-close"))),
      );
  }
}
