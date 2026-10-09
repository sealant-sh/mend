# Hot sessions

Hot sessions keep standby workspaces ready so a new session attaches at once instead of waiting for
a container to build and boot. A project's count (0 to 8) applies per person: Mend keeps that many
ready for each person who started a session in the project in the last seven days, up to four
people. A new session in a new or existing eligible worktree claims one of its owner's matching
standbys and binds the worktree at claim (ADR 0001). The pool drains and rewarms when the image,
variables, secrets, references, mounts, folders or dotfiles change. The user sets the count on the
project's Setup tab and reads their own standbys' state there: `ready`, `warming`, `failed`, with
the last failure verbatim.

## Sub-features

- `hot-count` raises or lowers the project's count with `Keep one more workspace ready` and
  `Keep one fewer workspace ready`, bounded 0 to 8.
- `hot-status` reports the caller's own standbys: `off`, `none ready yet`, `<n> ready`,
  `<n> warming`, `<n> failed`, and `warming failed · <error>`.
- `hot-claim` lets a new session in an eligible new or existing worktree start on a ready standby.
- `hot-rewarm` drains and rewarms standbys when a launch input changes.

## How to get to it (user POV)

- Web: a project's Setup tab, section `Hot sessions` (anchor `#hot-sessions`), for the project's
  creator and organization owners. The status refreshes every five seconds.
- CLI, TUI, desktop, mobile: a new session started there claims a standby the same way; none of them
  shows the pool.
- VS Code: `Mend: New Session…` and `Mend: New session in this worktree…` launch through the same
  provisioning path; neither shows the pool.
- Slack: `@mend project=<project> <prompt>` starts a session through that path; Slack has no pool
  editor or count.

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
  The count reads `1`. Poll the status until `1 ready`; record any sampled `none ready yet` or
  `1 warming` states. The five-second refresh can miss transitions; a first build can take minutes.
- **Claim it.** Run `time mend run --project <project> -- sh -c 'printf "hot\n" > HOT.txt'`. Exit
  code `0`, and the run reaches `✓ recording` without a build line. Poll the pool while it launches
  and record any sample below `1 ready`, any `1 warming` sample and the return to `1 ready`.
  Replacement warming starts asynchronously; a missed drop or warming state is inconclusive about
  the claim.
- **Compare with cold.** Lower the count to `0` with `Keep one fewer workspace ready` (status `off`)
  and run the same `mend run` again. Record both wall-clock times from `time`; report them as
  observed, not as a speed claim.
- **Rewarm on a change.** Raise the count to `1` and wait for `1 ready`. Add a variable on the same
  page (see [Project environment](./project-environment.md)). Record sampled transitions and wait
  for `1 ready` again. A missed `warming` state is inconclusive about rewarming.
- **Upper bound.** Choose `Keep one more workspace ready` until the count reads `8`. The button is
  then disabled. Lower it back to `0` before cleanup: each ready standby is a live container.
- **VS Code launch.** `not drivable yet`: the verify stack has no VS Code driver. The entry points
  are `Mend: New Session…` and `Mend: New session in this worktree…`; choose `Claude agent` or
  `Codex agent` and give a prompt. The session appears in Mend and the workspace opens in VS Code.
  Pool readback is on the web as above.
- **Slack launch.** `not drivable yet`: the verify stack has no Slack driver. From a linked Slack
  account, mention `@mend project=<project> List the files and change nothing.` in a new thread. The
  thread reports the created session and its status; pool readback is on the web.
- **Proof.** ARIA snapshots and screenshots of `section("Hot sessions")` at `off`, `1 ready`, after
  the claim and at any sampled `1 warming` state, plus both timed `mend run` transcripts. Report
  missed claim or rewarming transitions as inconclusive.

## Gotchas

- The status is the signed-in person's own standbys only. Another person's pool, and their failures,
  never show. A count above `0` with no session started by this person in the last week stays
  `none ready yet`.
- The count is a plain number between the buttons, with no label or live region
  (`apps/web/src/components/project-setup.tsx:308-310`); the status line is plain text, not a
  `status` role. Read both by text, scoped to the section.
- A new session can claim a standby for a new or existing worktree, including one with captures. It
  needs a ready standby for that owner matching the current launch inputs, and the owner must still
  have permission to run in the project. Another person's standby is never used. In capture mode, a
  worktree held by another executor takes the holder path instead of spending a standby.
- Layout eligibility also applies. With per-person homes active or layout records present, an
  already assigned layout or an explicit per-person request prevents a standby claim. A capture
  holding `people/` also prevents a person standby claim. Otherwise the standby must match the
  predicted launch layout; a person standby needs the launcher to be the change's owner or the first
  owner of a new worktree (see [Per-person homes](./per-person-homes.md)).
- A resume can reuse a retained workspace. It does not establish a standby claim or a cold start.
  Compare new session launches with fresh worktrees in the timing recipe above.
- Nothing on the session page or in the CLI says a launch claimed a standby. The evidence is the
  sampled pool count dropping and a launch without a build or boot wait. A launch with no build line
  alone does not establish a claim; a cached image can also start cold without a build.
- `warming failed · <error>` shows the latest failure verbatim. A pool that keeps failing keeps
  rebuilding; set the count to `0` and report the error.
- Setting the count, and every change that rewarms, starts real containers on the machine. Return
  the count to its starting value at cleanup.
