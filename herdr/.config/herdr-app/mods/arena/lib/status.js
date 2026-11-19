// What a lane is doing, from Herdr's live facts only:
//
// - `waiting`: the agent reports `blocked`, so the turn cannot move on until
//   the person answers it (a permission or a question; Herdr can't tell which);
// - `working`: the turn is live;
// - `failed` / `stopped`: the terminal ended (with an error / without one), or
//   the agent quit back to its shell before answering;
// - `notStarted`: no turn has ended and none is running;
// - `noReply`: the turn ended without any answer text;
// - `finished`: the turn ended. It says nothing about quality, so it is drawn
//   grey, never green.

/** @typedef {"waiting" | "working" | "failed" | "stopped" | "notStarted" | "noReply" | "finished"} LaneStatus */

const SHELLS = /(^|\/)-?(zsh|bash|fish|sh|dash|ksh|mksh|tcsh|csh|nu|xonsh|elvish|pwsh)$/;

/**
 * Whether a terminal's foreground program is a bare interactive shell: the
 * agent ran in `"$@"; exec "$0" -i`, so its shell coming back means it quit.
 * Setup commands run in `sh -c …`, and the agent's start in `zsh -ic …`; neither is this.
 * @param {{ argv?: string[] } | null | undefined} foreground
 */
export const shellIsBack = (foreground) => Boolean(foreground?.argv?.length) && SHELLS.test(foreground.argv[0])
  // `-c` or a cluster holding it (`-ic`, `-lc`): a shell running a command, not one waiting at its prompt.
  && !foreground.argv.slice(1).some((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));

/**
 * @param {{ terminal: any, agent: { status: string } | null | undefined, reply: { state: string, text?: string } | null | undefined, foreground?: { argv?: string[] } | null }} input
 * @returns {LaneStatus}
 */
export function resolveLaneStatus({ terminal, agent, reply, foreground = null }) {
  if (!terminal || (terminal.state && terminal.state !== "live")) {
    const code = terminal?.exit_code;
    return typeof code === "number" && code !== 0 ? "failed" : "stopped";
  }
  if (agent?.status === "blocked") return "waiting";
  if (agent?.status === "working") return "working";
  // A screen tail is not an answer: it is there whether the agent replied or not.
  const answered = reply?.state === "ready" && Boolean(reply.text) && !reply.screen;
  const turns = terminal.turn ?? 0;
  if (!agent) {
    if (answered) return "finished";
    if (turns > 0) return "noReply";
    // No agent and no turn: still in its setup commands or starting up,
    // unless its shell is back, which means the agent quit.
    return shellIsBack(foreground) ? "stopped" : "notStarted";
  }
  if (turns === 0 && !answered) return "notStarted";
  if (reply?.state === "ready" && !reply.screen && !reply.text) return "noReply";
  return "finished";
}

// ---- reading a lane, once per turn ----------------------------------------

/** What changes when a lane's turn moves: its terminal, its turn count, its agent's status. */
export const laneSig = (terminal, agent) => `${Boolean(terminal)}|${terminal?.state}|${terminal?.turn ?? 0}|${agent?.status ?? "-"}`;

// A read can land before the agent has written its last answer, or fail for a
// moment: read again a few times before taking "no answer" for the answer.
export const READ_RETRIES = 4;
export const READ_RETRY_MS = 3000;

/** A read whose result may still change on its own: no answer text yet, or an error. */
const unsure = (summary) => summary.reply?.state === "error" || summary.diff?.state === "error"
  || (summary.reply?.state === "ready" && !summary.reply.screen && !summary.reply.text);

/**
 * Whether to read a lane now: its turn moved since the last read, or the last
 * read was unsure and it's time to try again.
 * @param {{ sig: string, at: number, tries: number, reply?: any, diff?: any } | undefined} summary
 */
export function needsRead(summary, sig, now) {
  if (!summary || summary.sig !== sig) return true;
  return unsure(summary) && summary.tries < READ_RETRIES && now - summary.at >= READ_RETRY_MS;
}

/** Whether a lane's read is of its current turn and won't be retried: what automatic fusion waits for. */
export const readSettled = (summary, sig) => Boolean(summary) && summary.sig === sig && !(unsure(summary) && summary.tries < READ_RETRIES);

/** A lane that has stopped moving: what fusion and Keep may use. */
export const isSettled = (status) => status !== "working" && status !== "waiting" && status !== "notStarted";

/** Order of the overview's status summary: what needs the person comes first. */
export const LANE_STATUS_ORDER = ["waiting", "failed", "working", "noReply", "stopped", "notStarted", "finished"];

export const LANE_STATUS_LABEL = {
  waiting: "Waiting for you",
  working: "Working",
  failed: "Failed",
  stopped: "Stopped",
  notStarted: "Not started",
  noReply: "Finished without an answer",
  finished: "Finished",
};

/** "2 working", "1 waiting for you". */
export function statusCount(status, count) {
  const words = {
    waiting: "waiting for you",
    working: "working",
    failed: "failed",
    stopped: "stopped",
    notStarted: "not started",
    noReply: "without an answer",
    finished: "finished",
  };
  return `${count} ${words[status]}`;
}

/** What stands where a card's answer goes, when the answer itself can't. */
export const CARD_BODY = {
  waiting: "Waiting for you to go on. Open the chat to answer.",
  failed: "Failed. Open the chat for details.",
  notStarted: "Has not started yet.",
  stopped: "Stopped before answering.",
  working: "Working…",
  noReply: "No answer yet",
};

/** "42s", "3m 12s", "1h 4m". */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
