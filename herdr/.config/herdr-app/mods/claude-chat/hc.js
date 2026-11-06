// Gives picker.js its `hc` from a function that runs herdr-core, such as the `hc` the "herdr" module exports.
// `run(args)` resolves { code, stdout, stderr }. Kept apart from picker.js so that file needs no Herdr to test.
export function hcFrom(run) {
  const ok = async (args) => {
    const r = await run(args);
    if (r.code !== 0) throw new Error(`hc ${args[0]} failed: ${String(r.stderr || r.stdout).trim().slice(0, 200)}`);
    return r.stdout;
  };
  return {
    read: (t) => ok(["read", t]),
    keys: (t, keys) => ok(["keys", t, ...keys]),
    send: (t, text) => ok(["send", t, text]),
    // Times out quietly: a miss only means the text was not printed in time, and the caller reads the screen next.
    waitOutput: async (t, text, seconds) => { await run(["wait", t, "--output", text, "--timeout", String(seconds)]); },
    status: async (t) => {
      try { return JSON.parse(await ok(["get", t, "--json"])).status?.state ?? null; } catch { return null; }
    },
  };
}
