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

## Decided (2026-10-17, Yiannis's review of `docs/specs/vscode-stories.md` story g)

The stories live on branch `vscode/redesign-study`.

- Handoff copies. It never touches the local checkout.
- `.env*` files are left out by default, and the fact line says so.
- What travels is the commits ahead, plus the uncommitted and untracked files. Gitignored files
  are left out. An optional prompt; empty means a workspace held for the person, with no agent.
- The CLI comes first (from a checkout). The VS Code entry comes with the extension rebuild.
- Story g's copy: fact line `2 commits ahead of main · 3 uncommitted files · 1 untracked`, the
  detail line
  `Copies your branch and uncommitted files into a new session. Your checkout stays as it is.`,
  the row `idle · handed off from dana-mbp`, and the change's base is the merge base with `main`.
  Edge cases include not adopted (adopt and hand off), detached HEAD, a foreign origin (refused),
  files over the size limit (named and left out), and a server without the endpoint.

## Still open, for Yiannis

1. The name. Findings so far:
   - `mend pull <session>` already exists. It fetches a session's change into a local clone as a
     git bundle (`packages/api-contracts/src/landing.ts`, `ChangeBundleBytes`, raw body via
     `HttpApiSchema.asUint8Array`, budget `MEND_BUDGET_BUNDLE_BYTES`). It matches the clone's
     remotes to the project's origin by host and path, with `--force` to skip. This feature is
     its reverse, and can reuse the origin match and the bundle budget.
   - `mend push` would mirror `pull` and `folder push` (which uploads a local directory). But
     landing reports say "pushed" for origin, so a row reading `pushed from dana-mbp` collides.
   - `mend send` uses Yiannis's own words ("send current state of things over"): `sent from
     dana-mbp`, `Sent as fix-login. Your checkout is unchanged.` It only brushes against the
     review comments' **Send** button. Current leaning.
   - `mend continue` is taken (resume with the pending review follow-up).
   - "handoff" also names the mode handoff, `POST /sessions/:id/handoff {to}`, in
     `packages/sessions/src/engine.ts` and `packages/api-contracts/src/sessions.ts`.
2. G6, the upload API. Shapes to weigh: one raw-body request carrying a tar (bundle, file
   contents, a JSON manifest with branch, head, merge base, deleted paths, prompt, machine and cut
   time), against a two-step content-addressed upload and then a create that names it. File
   contents rather than a patch: contents always apply, binary included; the index (staged versus
   unstaged) is not kept, which review does not show anyway.

## Original open list

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

The branch is rebased on origin/main (after #1047). Resume the `how` pass. Three explorers ran on
the second start and were stopped by the second hold, before they reported:

1. Adoption and the central store. How a store is created, whether the CLI can ship git objects
   to a remote server (a bundle), how cwd maps to a project, and the refusal copy.
2. Session and worktree provisioning. Whether a worktree can start from an arbitrary sha, how
   pre-existing uncommitted content would show in review, and any hook that writes files into a
   worktree before launch, and a no-agent held workspace.
3. Uploads and capture. Upload precedents (image paste, `mend memory import`, folder push),
   HttpApi raw and multipart bodies, size limits, and how a worktree's state is packed and
   restored, so files the server writes reach the workspace in both deployment shapes.

A local agent conversation does not travel (it is not in the decided list), so the takeover angle
is dropped. Then send the two open decisions (name, G6) with a recommendation to the orchestrator
(thread ec2e5833, mode queue) before building beyond a spike. `pnpm install` was interrupted by
the hold; rerun it first.
