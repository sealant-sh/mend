# mend handoff: working notes (held 2026-10-17)

Status: held by the orchestrator before any design or code. The build resumes after the T3 Code
nightly work, mend#684 and the verify inner-CLI fix (thread mcp:06101671) have merged.

## The feature

The person brings the work they have locally into Mend. Their current branch, uncommitted changes
included, is adopted as a session, so an agent (or the person, from another device) carries on
exactly where they were. 0.36 roadmap item, asked for by Yiannis on 2026-10-17.

## What I learned so far

These come from the plan, `AGENTS.md` and the workstream notes. The code read had just started
when the hold arrived, so nothing below is checked against the source yet.

- "Handoff" already names two things. The product noun is the editable end-of-session summary
  promoted into context (plan §5.5, §7.1, M3). The plan's decision log also has the 2026-08-31
  "mode handoff", the cross-mode pickup at `POST /sessions/:id/handoff {to}` that `mend attach`
  and the dashboard use to take a protocol session back as a PTY (mend#190). A third meaning
  would collide with both.
- "Takeover" is taken as well. It names the `mend attach`/dashboard pickup (mend#190) and the
  VS Code editor takeover (mend#222: shell, stop, then `claude --resume`/`codex resume` in a
  remote terminal).
- The worktree is the durable container. Launching with an existing worktree name joins it, and
  a conflicting base is refused. One change per worktree, computed as the worktree versus its
  base. Checkpoint ordinal 0 anchors review.
- Sessions record a `baseRef` (migration 0042). Bases freshen from origin at provision, and
  resolution prefers `refs/remotes/origin/<ref>`, because local heads freeze at adoption. So a
  branch that exists only on the person's machine has no path into the store today (to check).
- Shallow repositories are refused at adopt and at session start (mend#654,
  `unsupportedRepositoryReason`). SHA-256 and reftable repositories are refused at adoption.
- The no-loss rule covers everything, git-ignored bulk such as `node_modules` included: pack it,
  never reinstall on resume. That argues for ignored files travelling, with a size refusal that
  says plainly what stayed behind rather than a silent drop.
- Harness home is per session (`packages/sessions/src/harness-state.ts`). Agent memory travels
  per user and project (ADR 0009, mend#461, `mend memory import`). Transcripts are opt-in only,
  because they hold pasted secrets. Native resume needs path re-keying, since Claude keys
  transcripts by cwd and the agent's cwd in Mend is `/workspace/repo`.
- `mend memory import` is a precedent for the CLI uploading local files to the server.

## Open decisions (each for Yiannis, recommendation still to write)

1. The name and copy, given the collision above. Candidates to weigh: `mend bring`, `mend send`,
   `mend move`, or stretching "handoff". Leaning away from "handoff" and "takeover".
2. Entry points: the CLI from inside a checkout first, then the VS Code placeholder from the
   redesign (thread mcp:420f694a). Web and mobile cannot read a local checkout.
3. What travels: commits ahead of origin, staged, unstaged and untracked files, stashes, ignored
   files, and a running local claude/codex conversation.
4. What happens to the local copy afterwards.
5. Which base the worktree starts from, and what happens when the project is not adopted yet.
6. Refusals, in plain status words.

## Next step

Resume the `how` pass with its four explorer angles. Two were running and were stopped by the
hold:

1. Adoption and the central store. How a store is created, whether the CLI can ship git objects
   to a remote server (a bundle), how cwd maps to a project, and the refusal copy.
2. Session and worktree provisioning. Whether a worktree can start from an arbitrary sha, how
   pre-existing uncommitted content would show in review, and any hook that writes files into a
   worktree before launch.
3. Capture (not started). How a worktree's state, untracked and ignored bulk included, is packed
   and restored, and whether that path can seed a new worktree from a client-side tarball.
4. Takeover and resume (not started). `mend attach`, `handoff {to:"pty"}`, the VS Code takeover,
   and native transcript backfill as a route for a local conversation.

Then draft the decision list with a recommendation for each item and send it to the orchestrator
(thread ec2e5833, mode queue) before building beyond a spike.
