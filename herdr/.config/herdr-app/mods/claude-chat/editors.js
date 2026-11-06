// Which code rows get a coloured editor, and the colours they take. No Herdr imports, so `node --test` can load this file.
// Editor state is held by the app, so it's capped. The newest code rows get one. Past the cap a row draws as plain text.

// The code colours, made from the theme.
export const syntaxColours = (t) => ({
  keyword: t.ansi4, string: t.accent, comment: t.dim, function: t.foreground, type: t.ansi13, number: t.ansi13, constant: t.ansi13,
  variable: t.foreground, operator: t.muted, punctuation: t.muted, boolean: t.ansi13, "string.escape": t.ansi13,
});

// An editor's colours are fixed when it's made, so a change in this means every editor has to be made again.
export const paletteKey = (t) => JSON.stringify(syntaxColours(t ?? {}));

// What to make and what to let go. `codeIds` is every code row's id, oldest first. `have` is the ids that hold an editor,
// and `visible` the ids on screen now, which are never let go. Newest first, a row with no editor gets one while there's
// room. Once there isn't, the oldest editor off screen that's older than that row is let go to make room. An editor for a
// row that's no longer in the thread always goes.
export function planEditors({ codeIds, have, visible = new Set(), max }) {
  const age = new Map(codeIds.map((id, i) => [id, i]));
  const drop = [...have].filter((id) => !age.has(id));
  const kept = new Set([...have].filter((id) => age.has(id)));
  // Oldest first, so the front of this list is the next to go.
  const spare = [...kept].filter((id) => !visible.has(id)).sort((a, b) => age.get(a) - age.get(b));
  const make = [];
  for (let i = codeIds.length - 1; i >= 0; i--) {
    const id = codeIds[i];
    if (kept.has(id)) continue;
    if (kept.size >= max) {
      if (!spare.length || age.get(spare[0]) >= i) break;
      const old = spare.shift();
      kept.delete(old);
      drop.push(old);
    }
    kept.add(id);
    make.push(id);
  }
  return { make, drop };
}
