# Mend verification map

This directory is the maintained source for verifying Mend's user-facing behavior: the core loop of
adopting a project, running a session in a recorded worktree, reviewing its change, sending review
back, landing, and Services. Read this index before driving Mend, then use the matching feature file
as the recipe. The map was written from source (the web routes and components in `apps/web/src`, the
command catalog in `apps/cli/src/help.ts`, and the CLI in `apps/cli/src`). It has not been driven
live yet. The first live pass happens when the `verify` skill's Launch section exists, which waits
on the 0.36 feature "Verify Mend in Mend".

## Baseline preconditions

- The stack under test comes from the `verify` skill's Launch section, which is pending "Verify Mend
  in Mend": the full stack from source, inside a Mend session. Until that section exists, no recipe
  here has a supported launch, and a run reports every feature as unreachable with that reason.
- The instance has at least one account, and the web app answers at the URL Launch names (written
  `<web>` below; the CLI's own default is `http://localhost:3105`).
- The `mend` CLI under test is on `PATH` and signed in to that instance: `mend login --url <web>`,
  then `mend doctor` prints one line per fact with nothing left unfinished that the recipe needs.
- Launch supplies a disposable Git repository the server can clone (written `<repo-url>`), and a
  project name for it (written `<project>`). Adoption takes network Git URLs only: local paths and
  `file://` URLs are refused.
- Recipes that run `mend claude` or `mend codex` need that provider connected
  (`mend connect claude`, `mend connect codex`). Recipes that need no inference use `mend run`.
- Landing needs a GitHub origin and `mend connect github` to open a pull request. With any other
  origin the push happens and the pull request is reported as unavailable.
- Never drive an instance this verification run did not start. Never drive the owner's own Mend.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Web steps use Playwright through ARIA roles and accessible names:
  `page.getByRole(role, { name })`. Prefer roles and names over CSS selectors, text matches or DOM
  position. Where a control has no stable accessible name, its feature file says so in Gotchas; that
  is a finding to fix in the product, not a reason to invent a selector. A name that comes only from
  a placeholder is one Playwright finds, but it is listed in Gotchas as a missing label.
- Never wait for `networkidle`. Every workbench page holds an open SSE stream (`/api/events`,
  `apps/web/src/lib/workbench-events.ts`), so the network never goes idle. Wait for the role, name
  or text the step names.
- CLI steps are exact `mend` commands. Treat every command as literal; keep quoted names and flags
  unchanged. Angle-bracketed words are values the run fills in.
- `mend codex`, `mend claude`, `mend attach`, `mend continue`, `mend service connect` and
  `mend service logs` hold the terminal. Run them in their own PTY (tmux or similar); a harness
  launch may pass `--detach` instead. Never run them in a plain pipe.
- Web sign-in goes through `/login`: the textbox `Email`, the password field labelled `Password`,
  and the button `Sign in`. Sign-in calls outside a browser must carry an `Origin` header naming the
  instance's own origin: the auth layer rejects requests from origins outside its trusted list
  (`packages/auth/src/auth.ts`, `trustedOrigins`).
- Stop only what the run started, by the PID or session id it recorded. `pkill -f` with an
  unbracketed pattern matches the shell running it and kills that shell; if a pattern is
  unavoidable, bracket one character (`pkill -f '[m]end server'`).
- Restore seeded state after a mutation. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Proof follows Mend's language contract: write what was observed, never a verdict. "Completed ·
  observed", "pushed", "pull request #12 · open · observed" are facts; "works", "safe to merge" and
  "ready to merge" are not proof and never appear in a report.
- Capture the user action and the resulting state, not only the final screen.
- Web proof includes an ARIA snapshot (`await page.locator("body").ariaSnapshot()`) and a screenshot
  with the page heading visible.
- CLI proof includes the command, stdout, stderr and exit code.
- Mutation proof includes a second, read-only view of the stored result: a reload of the page, or a
  listing command such as `mend projects`, `mend sessions --all --json` or `mend worktrees --json`.
- Record the feature file, sub-feature ID and entry point (web or CLI) with every artifact, under
  the evidence directory the `verify` skill's Evidence section names (pending with Launch).
- Report an unreachable path with the attempted step and the unmet precondition, for example
  "provider not connected" or "origin is not on GitHub".
- Do not report an entry point as verified through a different one. A change landed with `mend land`
  does not prove the web `Push and open pull request` button.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It
then uses exactly four H2 sections, in this order.

1. `Sub-features` lists short IDs, one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point, including the mobile, desktop and VS
   Code ones. Only web and CLI are driven.
3. `Driving it with verify` starts with `Preconditions:` and uses labelled bullets that pair each
   user action with an exact Playwright call or `mend` command and the result a user can observe.
4. `Gotchas` lists traps that can waste or invalidate a run, and every control the recipe needs that
   has no stable accessible name.

Keep implementation details out of the map. Name only user paths, stable handles, required state,
commands and observable proof.

## Features

- [Adopt a project](./adopt-project.md) covers adoption from the web Projects page and `mend adopt`,
  the project page, and the CLI listing.
- [Start a session](./start-session.md) covers the Now page composer, a worktree's `New session`
  menu, and `mend codex`, `mend claude` and `mend run`.
- [Review the change](./review-change.md) covers the review page's diff, files, inline and
  change-level comments, checkpoints, the pinned slice, and the CLI review screen.
- [Send review back to the session](./send-review-back.md) covers `Send review to session`, the
  pending follow-up, and `mend continue`.
- [Land a change](./land-change.md) covers the review page's Land panel, the session page's landing
  line, and `mend land`.
- [Services](./services.md) covers the session page's Services card and `mend service run`, `list`,
  `connect`, `logs`, `restart` and `stop`.
