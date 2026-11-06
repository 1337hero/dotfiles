// What a test in a private Herdr can ask of the pane. Only a home under /.config/hd/ counts, so none of this can run in
// the real window.
export const testing = (appHome) => appHome.includes("/.config/hd/");

// `chat-test.json` in a private home can point the pane at a transcript, such as a copy of the 55 MB one.
export async function testTranscript(appHome, readTextFile) {
  if (!testing(appHome)) return null;
  try { return JSON.parse(await readTextFile(`${appHome}/chat-test.json`))?.transcript ?? null; } catch { return null; }
}

// `chat-script.json` in a private home is a list of steps for `herdr-app do claude-chat.script`, such as
// [{ "do": "type", "text": "hello" }, { "do": "send" }]. A command can't carry arguments, so they wait in this file.
export async function testScript(appHome, readTextFile) {
  if (!testing(appHome)) return [];
  try {
    const steps = JSON.parse(await readTextFile(`${appHome}/chat-script.json`));
    return Array.isArray(steps) ? steps : [];
  } catch { return []; }
}
