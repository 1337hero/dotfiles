// A unified diff as rows to draw: file headers, metadata, hunk headers and
// numbered lines. Inside a hunk every line is content, whatever it starts
// with, so a removed "-- comment" is never taken for a "--- a/file" header.

/** @returns {{ kind: "file" | "meta" | "@" | "+" | "-" | " ", text: string, number?: number }[]} */
export function diffRows(text, { maxLines = 20000, maxWidth = 2000 } = {}) {
  let old = 0, next = 0, oldLeft = 0, newLeft = 0;
  const rows = [];
  for (const raw of String(text ?? "").split("\n").slice(0, maxLines)) {
    const line = raw.length > maxWidth ? `${raw.slice(0, maxWidth)}… (line truncated)` : raw;
    if (oldLeft > 0 || newLeft > 0) {
      const kind = line[0];
      if (kind === "-") { rows.push({ kind, number: old++, text: line.slice(1) || " " }); oldLeft--; continue; }
      if (kind === "+") { rows.push({ kind, number: next++, text: line.slice(1) || " " }); newLeft--; continue; }
      if (kind === " " || line === "") { old++; rows.push({ kind: " ", number: next++, text: line.slice(1) || " " }); oldLeft--; newLeft--; continue; }
      if (kind === "\\") { rows.push({ kind: "meta", text: line }); continue; }
      oldLeft = newLeft = 0;
    }
    if (line.startsWith("diff --git ")) { rows.push({ kind: "file", text: line.replace(/^diff --git a\/(.*) b\/.*$/, "$1") }); continue; }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      old = +hunk[1]; next = +hunk[3];
      oldLeft = hunk[2] === undefined ? 1 : +hunk[2];
      newLeft = hunk[4] === undefined ? 1 : +hunk[4];
      rows.push({ kind: "@", text: line });
      continue;
    }
    rows.push({ kind: "meta", text: line });
  }
  return rows;
}
