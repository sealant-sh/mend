# The sidebar — t3code map and what Mend took

Studied at `~/Developer/refs/t3code` nightly **v0.0.34-nightly.20260821.1150** (MIT). The full
file:line map lives in the session notes; this is the decision record. Mechanics and information
architecture were copied; styling comes from `docs/design-evidence-review.md`.

## What t3 does (the nightly, not older notes)

- **One flat list is live**; the per-project tree is an opt-in legacy setting. Projects are a
  **scope filter in a menu** above the list, never headers.
- **Static creation order, newest first. Activity never reorders a row.** A row only moves by
  changing section: pin, snooze, settle.
- Sections, one flat keyboard order: pinned · active · snoozed (collapsed shelf, count in header) ·
  settled (expanded shelf, ordered by when work ended, 10-then-25 paging). The route-active row
  always renders, even behind a collapsed shelf or below the paging cut.
- **Unseen** = completed after the last visit; never-visited counts as read; the visit is stamped at
  the completion time, not `now`.
- **Prominence is inverted**: working / approval / input rows recede; only done-unseen, failed, and
  freshly woken rows are prominent.
- **Snooze** is a visibility overlay (never touches the agent): 1h · 3h · this evening (only while
  > 1h before 18:00) · tomorrow 09:00 · next Monday 09:00 (a full week out on a Monday); a precise
  > wake timer; hand-raise wakes on input, a fresh error, or a completion after the snooze; Undo
  > toast because the row disappears. `Sidebar.snooze.test.ts` is the spec.
- **Hover**: one slot at the right edge — status word at rest, the row's one action on hover or
  `focus-visible` (not `focus-within`). Everything else in one shared context-menu builder.
- **Keyboard**: mod+1..9 jump the rendered rows (hints only while the exact modifier is held),
  prev/next are clamped, the sidebar toggle is a capture-phase window listener.
- **Width**: pure functions — min 208, default 256, max = viewport − 640 main-content floor;
  persisted number; double-click the rail resets.

## What Mend adopts

- Two faces behind **Ctrl+Shift+B** (`lib/sidebar-view.ts`, persisted): the **tree** (projects →
  sessions → the harness process, every live shell, Services — a real place tree, so a shell is
  never hidden behind a closed tab) and the **inbox** (t3's flat list).
- Inbox mechanics verbatim: static order, `[active, snoozed, settled]`, shelves and paging
  (`lib/inbox-shelves.ts`), never-visited-is-read (`lib/seen.ts`), recede inversion, focused row
  always rendered, scope filter that never re-ranks (`scopeInbox`).
- Snooze, client-local (`lib/snooze.ts`, tests mirror t3's): presets, hand-raise, precise wake,
  inline Undo (no toaster is mounted in the desktop; an inline line is honest).
- Hover slot + `focus-visible` twins; one `rowMenu` builder; confirm delete, not snooze.
- Jump pills and J/K walk `visibleInboxRows`, the same list the rail renders — on either face.
- Width contract as pure functions (`lib/sidebar-width.ts`), drag rail, double-click reset.
- The twist t3 does not have: scoping the inbox to one project reveals **Inbox · Services · PRs ·
  Files** behind a compact switcher. Services reuses `serviceGlance`; PRs read through the host's
  `gh` (honest states for no origin, not GitHub, gh missing/signed out, rate limit); Files root at
  the **focused session's worktree** when it belongs to the project (what the agent is editing,
  untracked files included), else the default branch's tree in the bare store — the store has no
  checkout to read.

## What Mend skips

- Pin (server field + fractional order keys + drag) — no server state for it yet; add when a pinned
  list exists.
- Auto-settle rules — Mend's sessions settle by lifecycle (the engine), not by inactivity.
- Multi-select and bulk actions, inline rename, title search — not yet.
- Environment/remote scoping, the stage artwork, the legacy/new dual sidebar.
