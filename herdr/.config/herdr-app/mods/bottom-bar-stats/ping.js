export function pingArgs(platform, host, timeoutMs = 1500) {
  if (platform === "windows") return ["-n", "1", "-w", String(timeoutMs), host];
  if (platform === "macos") return ["-c", "1", "-W", String(timeoutMs), host];
  return ["-c", "1", "-W", String(Math.max(1, Math.round(timeoutMs / 1000))), host];
}

export function parsePing(out) {
  const match = /[=<]\s*(\d+(?:[.,]\d+)?)\s*ms/i.exec(String(out ?? ""));
  if (!match) return null;
  const ms = Number(match[1].replace(",", "."));
  return Number.isFinite(ms) ? ms : null;
}

export function sshHostname(out) {
  const line = String(out ?? "").split("\n").find((l) => /^hostname\s+/i.test(l));
  return line ? line.replace(/^hostname\s+/i, "").trim() : null;
}
