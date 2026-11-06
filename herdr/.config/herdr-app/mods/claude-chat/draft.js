// Setting a half-typed line aside before text goes into a Claude Code session. No Herdr imports, so `node --test`
// can load this file. `io` needs `hc`.
export const SET_ASIDE = "ctrl+s";
export const STASH_HELD = /›[ \t]*stashed[ \t]*$/m;

// True when a half-typed line may have gone aside. Claude Code puts it back after the next submit. Ctrl+S does nothing on an
// empty prompt, but it brings a held stash back, and a line typed over one replaces it, so it isn't pressed while one is held.
// A shell left after Claude Code exits would freeze on it.
async function setDraftAside(io, terminal) {
  try {
    const { foreground } = JSON.parse((await io.hc(["get", "--json", terminal])).stdout);
    if (!foreground?.name?.startsWith("claude") || STASH_HELD.test((await io.hc(["read", terminal])).stdout)) return false;
    await io.hc(["keys", terminal, SET_ASIDE]);
    return true;
  } catch { return false; }
}

// `hc send` adds to whatever is unsent in the prompt and presses Enter, which would send a half-typed line with the text.
// Answers `hc send`'s result, or null if it threw. A send that fails brings the line back.
export async function sendAside(io, terminal, text) {
  const aside = await setDraftAside(io, terminal);
  const sent = await io.hc(["send", terminal, ...(text.startsWith("-") ? ["--"] : []), text]).catch(() => null);
  if (aside && sent?.code !== 0) await io.hc(["keys", terminal, SET_ASIDE]).catch(() => null);
  return sent;
}
