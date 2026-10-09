# Hot sessions

Hot sessions keep standby workspaces ready so a new session attaches at once instead of waiting for
a container to build and boot. A project's count (0 to 8) applies per person: Mend keeps that many
ready for each person who started a session in the project in the last seven days, up to four
people. A new session in a new worktree claims one of its owner's standbys and binds the worktree
at claim (ADR 0001). The pool drains and rewarms when the image, variables, secrets, references,
mounts, folders or dotfiles change. The user sets the count on the project's Setup tab and reads
their own standbys' state there: `ready`, `warming`, `failed`, with the last failure verbatim.

## Sub-features

- `hot-count` raises or lowers the project's count with `Keep one more workspace ready` and
  `Keep one fewer workspace ready`, bounded 0 to 8.
- `hot-status` reports the caller's own standbys: `off`, `none ready yet`, `<n> ready`,
  `<n> warming`, `<n> failed`, and `warming failed · <error>`.
- `hot-claim` lets a new session in a new worktree start on a ready standby.
- `hot-rewarm` drains and rewarms standbys when a launch input changes.

## How to get to it (user POV)

- Web: a project's Setup tab, section `Hot sessions` (anchor `#hot-sessions`), for the project's
  creator and organization owners. The status refreshes every five seconds.
- CLI, TUI, desktop, mobile: a new session started there claims a standby the same way; none of
  them shows the pool.
- VS Code, Slack: no surface.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, signed in as the creator of `<project>` or an owner.
- The signed-in person started a session in `<project>` in the last seven days (for example the
  `mend run` below, run once first). Standbys are kept only for such people.
- The project's count is `0`: `section("Hot sessions")` reads `off`.
- `const section = (name) => page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) })`.

- **Read the section.** Open `<project>`'s Setup tab. `section("Hot sessions")` reads `off`, the
  count reads `0`, `Keep one fewer workspace ready` is disabled and `Keep one more workspace ready`
  is enabled.
- **Raise the count.** Run
  `await section("Hot sessions").getByRole("button", { name: "Keep one more workspace ready" }).click()`.
  The count reads `1` and the status reads `none ready yet`, then `1 warming`, then `1 ready` as
  the standby boots (poll the text; a first build can take minutes).
- **Claim it.** Run
  `time mend run --project <project> -- sh -c 'printf "hot\n" > HOT.txt'`. Exit code `0`, and the
  run reaches `✓ recording` without a build line. Within five seconds the status drops from
  `1 ready` and then warms a replacement (`1 warming`, then `1 ready`).
- **Compare with cold.** Lower the count to `0` with `Keep one fewer workspace ready` (status
  `off`) and run the same `mend run` again. Record both wall-clock times from `time`; report them
  as observed, not as a speed claim.
- **Rewarm on a change.** Raise the count to `1` and wait for `1 ready`. Add a variable on the same
  page (see [Project environment](./project-environment.md)). Within a few polls the status shows
  `warming` again, then `1 ready`.
- **Upper bound.** Choose `Keep one more workspace ready` until the count reads `8`. The button is
  then disabled. Lower it back to `0` before cleanup: each ready standby is a live container.
- **Proof.** ARIA snapshots and screenshots of `section("Hot sessions")` at `off`, `1 warming`,
  `1 ready` and after the claim, and both timed `mend run` transcripts.

## Gotchas

- The status is the signed-in person's own standbys only. Another person's pool, and their
  failures, never show. A count above `0` with no session started by this person in the last week
  stays `none ready yet`.
- The count is a plain number between the buttons, with no label or live region
  (`apps/web/src/components/project-setup.tsx:308-310`); the status line is plain text, not a
  `status` role. Read both by text, scoped to the section.
- A standby serves a new worktree only. A session joining an existing worktree that holds captures,
  a resume and a rejoin start cold. Another person's session never claims your standby.
- With per-person homes, a standby starts in its owner's layout and serves only a launch decided in
  that same layout; anything else starts cold (see
  [Per-person homes](./per-person-homes.md)).
- This map did not confirm from source that a `mend run` session claims a standby the way a
  harness session does. If the count does not drop after the claim step, repeat it with
  `mend claude "List the files and change nothing." --name verify-hot --project <project> --detach`
  (needs `mend connect claude`) and report which entry point claimed.
- Nothing on the session page or in the CLI says a launch claimed a standby. The evidence is the
  pool count dropping and a launch without a build or boot wait.
- `warming failed · <error>` shows the latest failure verbatim. A pool that keeps failing keeps
  rebuilding; set the count to `0` and report the error.
- Setting the count, and every change that rewarms, starts real containers on the machine. Return
  the count to its starting value at cleanup.
