// What the chat and terminal toggle can do. No Herdr imports, so `node --test` can load this file.
// panes() doesn't give a mod pane's props, so `pairs` maps a chat pane to its terminal.
export const CHAT = "pi-chat";
export const PAIRS = "pi-chat.pairs";
const APP = "pi";

// A block that draws the toggle says so in its props. A chat pane's props name its terminal.
export const isToggle = (props) => props?.role === "toggle";

export const isLocal = (address) => Boolean(address) && !address.includes("/");

const isSession = (p) => p?.app === APP && isLocal(p.terminal);

function chatFor(panes, pairs, terminal) {
  const chats = panes.filter((p) => p.mod === CHAT && p.tab === terminal.tab);
  const paired = chats.find((p) => pairs[p.pane] === terminal.terminal);
  if (paired) return paired;
  const sessions = panes.filter((p) => isSession(p) && p.tab === terminal.tab);
  return sessions.length === 1 && chats.length === 1 && !pairs[chats[0].pane] ? chats[0] : null;
}

function terminalFor(panes, pairs, chat) {
  const paired = panes.find((p) => p.terminal && p.terminal === pairs[chat.pane]);
  if (paired) return paired;
  const sessions = panes.filter((p) => isSession(p) && p.tab === chat.tab);
  return sessions.length === 1 ? sessions[0] : null;
}

// A first press splits, and the new pane only exists on a later render. A second press in that gap would split again and
// leave a chat nobody tracks. A split that never showed lets go after `SPLIT_MS`.
export const SPLIT_MS = 3000;
export const splitPending = (waiting, tab, now) => Boolean(waiting) && waiting.tab === tab && now - waiting.at < SPLIT_MS;

export function swapState(panes, pairs) {
  const here = panes.find((p) => p.focused);
  if (!here) return null;
  if (here.mod === CHAT) {
    const terminal = terminalFor(panes, pairs, here);
    return terminal ? { tab: here.tab, terminal: terminal.terminal, terminalPane: terminal.pane, chatPane: here.pane, showing: "chat" } : null;
  }
  if (!isSession(here)) return null;
  const chat = chatFor(panes, pairs, here);
  return { tab: here.tab, terminal: here.terminal, terminalPane: here.pane, chatPane: chat?.pane ?? null, showing: "terminal" };
}

export function swapSteps(state, target, panes) {
  if (target === "chat" && !state.chatPane) {
    return [["pane.split", { direction: "right", pane: state.terminalPane, mod: CHAT, props: { terminal: state.terminal } }]];
  }
  const pane = target === "chat" ? state.chatPane : state.terminalPane;
  const zoomed = panes.find((p) => p.pane === pane)?.zoomed;
  return [...(zoomed ? [] : [["pane.zoom", { pane }]]), ["pane.focus", { pane }]];
}

export function tidyPairs(pairs, panes) {
  const live = new Set(panes.filter((p) => p.mod === CHAT).map((p) => p.pane));
  return Object.fromEntries(Object.entries(pairs ?? {}).filter(([pane]) => live.has(pane)));
}
