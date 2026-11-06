// The demo: Halcyon, a made-up notes-app company, and its agents on two
// machines, one at each stage. Nothing is real: in the demo the popup asks no
// machine and no plugin anything, and a reply or a rename only says what it
// would have done. It's how the README's screenshots are made, so no real
// agent, branch or ticket can end up in them. `herdr-app do recap.demo`
// turns it on and off.

const min = 60000;

// Rows as rows() makes them, with their stage already worked out.
export function demoRows(now) {
  const row = (r) => ({
    status: "idle", space: "notes-app", machine: null, info: {}, branch: null, changes: null, pr: null,
    ticket: null, issue: null, recap: null, note: null, pending: null, suggested: null, renaming: null,
    program: { name: "Claude Code" }, ...r,
  });
  return [
    row({
      address: "demo/1", name: "Offline Sync Conflicts", status: "blocked", stage: "blocked", since: now - 4 * min,
      pending: "Keep both versions when a line changed on both sides, or prefer the server's?",
      recap: "Wrote the three-way merge in SyncEngine and the conflict markers. The proposal endpoint now carries the base revision; two edge-case tests left before it's ready for review.",
      branch: "sam/hal-212-offline-conflicts", changes: { files: 3, added: 214, deleted: 38, ahead: 2 },
      info: { tasks_done: 3, tasks_total: 5, last_prompt: "keep both edits when they clash, and mark them", model: "opus 5.5", mode: "auto" },
      ticket: "HAL-212", issue: { state: "In Review", url: "https://linear.app/halcyon/issue/HAL-212" },
    }),
    row({
      address: "build-1/t2", machine: "build-1", name: "Search Drops Accents", status: "working", stage: "working", since: now - 12 * min,
      recap: "Folding titles to ASCII at index time, as bodies already are. Running the search suite against the accented fixtures now.",
      branch: "sam/hal-231-search-accents", changes: { files: 2, added: 41, deleted: 12 },
      info: { prompt_at: new Date(now - 12 * min).toISOString(), model: "opus 5.5", mode: "auto" },
      ticket: "HAL-231", issue: { state: "In Progress", url: "https://linear.app/halcyon/issue/HAL-231" },
      pr: { number: 479, url: "https://github.com/halcyon/notes-app/pull/479", state: "open", checks: "✗", review: "", conflicts: false, badge: "#479 ✗" },
    }),
    row({
      address: "build-1/t3", machine: "build-1", name: "Rate-Limit The Share Endpoint", status: "working", stage: "working", since: now - 2 * min,
      info: { prompt_at: new Date(now - 2 * min).toISOString() }, note: null,
    }),
    row({
      address: "demo/4", name: "Export Keeps Inline Images", status: "done", stage: "done", since: now - 9 * min,
      recap: "Images are copied next to the exported Markdown and linked relatively; the export tests pass. Ready for you to look over before a pull request.",
      branch: "sam/hal-240-export-images", changes: { files: 4, added: 133, deleted: 27, ahead: 3 },
      ticket: "HAL-240", issue: { state: "In Progress", url: "https://linear.app/halcyon/issue/HAL-240" },
      suggested: "Export Copies Inline Images",
    }),
    row({
      address: "build-1/t5", machine: "build-1", name: "Push Retries", status: "idle", stage: "review", since: now - 65 * min, space: "sync-server",
      recap: "Approved by Jonas; it's in sync-server's merge queue, its checks running there.",
      branch: "sam/push-backoff",
      pr: { number: 121, url: "https://github.com/halcyon/sync-server/pull/121", state: "open", checks: "✓", review: "approved", conflicts: false, badge: "#121 ✓ approved queued" },
    }),
    row({
      address: "demo/6", name: "CRDT Notes Spike", status: "idle", stage: "merged", since: now - 2 * 24 * 60 * min,
      recap: "Measured a CRDT-backed library at 10k notes: 18% more memory, merges free. Written up in the PR; merged as an experiment behind a flag.",
      pr: { number: 476, url: "https://github.com/halcyon/notes-app/pull/476", state: "merged", checks: "✓", review: "approved", conflicts: false, badge: "#476 merged" },
    }),
  ];
}
