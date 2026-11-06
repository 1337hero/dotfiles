// "N new": what landed in a chat while it wasn't showing. No Herdr imports, so `node --test` can load this file.
//
// The count is shared with every mod under UNSEEN_KEY, as { [terminal address]: count }, so a sidebar can read it too. A
// session with nothing unseen has no entry. The terminal address is the session's, the same one `chatpane.pairs` names.
export const UNSEEN_KEY = "chat.unseen";

// What counts is what Claude said or did: one for each block of text or code, however many rows it splits into, and one
// for each tool call. Your own messages, quiet lines and turn ends don't count.
const COUNTED = new Set(["text", "code", "tool"]);
export const newMessages = (rows) => new Set((rows ?? []).filter((row) => COUNTED.has(row.kind)).map((row) => row.block ?? row.id)).size;

// The shared map with this terminal's count set, or null when it already says that, because a write re-renders every mod.
export function withUnseen(map, terminal, count) {
  const now = map && typeof map === "object" && !Array.isArray(map) ? map : {};
  if (!terminal || (now[terminal] ?? 0) === count) return null;
  const next = { ...now };
  if (count > 0) next[terminal] = count;
  else delete next[terminal];
  return next;
}

// A terminal's count from the shared map, or 0.
export const unseenOf = (map, terminal) => {
  const count = map && typeof map === "object" ? map[terminal] : 0;
  return Number.isInteger(count) && count > 0 ? count : 0;
};

export const unseenLabel = (count) => (count > 0 ? `${count > 99 ? "99+" : count} new` : null);
