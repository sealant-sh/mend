# Land a change

Landing publishes a change: Mend takes a checkpoint, commits what the agent left uncommitted on top
of the agent's own commits, pushes that to origin fast-forward only, and on GitHub opens or updates
a pull request whose description carries Mend's review summary. Only the change's owner lands it.
Mend never force-pushes, never merges and never moves the session's branch, and it reports what it
observed: what was pushed, and the pull request with its state as GitHub last said it.

## Sub-features

- `land-web` lands from the review page's Land panel, with an optional pull request title and
  description.
- `land-preview` previews the pull request description before landing.
- `land-cli` lands with `mend land`, with `--branch`, `--no-pr` and `--title`.
- `land-again` lands again after more work: new commits on the same branch, the same pull request
  updated, or nothing pushed when nothing is new.
- `land-refused` reports a refused push in the remote's own words and exits `1`, pushing nothing.
- `land-check` looks on GitHub for a pull request opened outside Mend and records it
  (`Check GitHub`, `mend land --check`).
- `land-observe` re-reads origin and the pull request on request (`Check origin`,
  `Refresh pull request`).
- `land-session-line` shows the latest landing fact on the session page, with the way to the Land
  panel.
- `land-automatic` decides per session whether Mend lands after a completed turn
  (`Land when a turn completes`, `--land`, `--no-land`).

## How to get to it (user POV)

- Web: on the review page (`/changes/<id>`), the region `Land`, also reachable as
  `/changes/<id>#land`.
- Web: on the session page, the landing line (`not landed`, or the latest fact) with the link
  `Land →` for the owner, `Landing →` for everyone else.
- Web: in the Now page composer's settings menu, the group `Land when a turn completes`.
- CLI: `mend land <session> [--branch <name>] [--no-pr] [--title <text>] [--project <p>]` and
  `mend land <session> --check [--project <p>]`. `<session>` is a prefix of the session id or the
  worktree's name.
- CLI: `mend codex|claude … --land|--no-land` for one session; `mend pull <session>` fetches the
  change into a local clone without pushing.
- Mobile: a session's pull request card. Desktop: the `Land this change` panel and
  `Open the Land panel`. Not driven by this map.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, signed in as the owner of the worktree's first session.
- `<project>`'s origin is a disposable GitHub repository the run may push to, and
  `mend connect github` has been run. With any other origin the push steps hold and the pull request
  steps report `unavailable`.
- A settled session in `<project>` holds a change, from
  `mend run --project <project> -- sh -c 'printf "verified\n" > VERIFY.md'`. Note its session id
  `<id>` and worktree name `<worktree>` from the `✓ worktree` line.

- **See the landing line.** Go to `<web>/sessions/<id>`. The line reads `not landed` and the link
  `Land →` is present (`page.getByRole("link", { name: "Land →" })`).
- **Open the Land panel.** Choose `Land →`. The review page opens at `#land`, and the region `Land`
  is visible (`page.getByRole("region", { name: "Land" })`). It reads
  `push <branch> to origin · pull request into <base>` and
  `not landed · nothing pushed from Mend yet`.
- **Title and preview.** Run
  `await page.getByRole("textbox", { name: "Pull request title" }).fill("verify: landing from the review page")`,
  then `await page.getByRole("button", { name: "Preview description" }).click()`. The description
  preview appears, the button reads `Hide description preview`, and its `aria-expanded` is `true`.
- **Land.** Run `await page.getByRole("button", { name: "Push and open pull request" }).click()`.
  The button reads `Landing…`, then a status line appears (`page.getByRole("status")`) reading
  `pushed · <remote branch> · <sha> · pull request #<n> · opened`, and the link
  `Open #<n> on GitHub ↗` appears.
- **Observe again.** Run `await page.getByRole("button", { name: "Refresh pull request" }).click()`.
  The button reads `Asking GitHub…`, then the facts list states the pull request's state as
  observed. Run `await page.getByRole("button", { name: "Check origin" }).click()`. The panel states
  when origin was last checked, or why it could not be.
- **Session line after landing.** Go back to `<web>/sessions/<id>`. The landing line now states the
  latest fact instead of `not landed`.
- **Land again with nothing new.** Run `mend land <worktree> --project <project>`. Stdout starts
  with `  landing <branch> · <project> · session <id8> · checkpoint · commit · push · pull request`.
  Nothing is pushed: exit code `1` and stderr reads
  `mend: landing not started · nothing new since the last landing`.
- **Land again after more work.** Add more work in the same worktree: run
  `mend claude "Append the line again to VERIFY.md." --worktree <worktree> --project <project> --detach`,
  watch its page until the agent has answered, then `mend stop` it by its id. An interactive harness
  session settles only when its process exits. Then run `mend land <worktree> --project <project>`.
  Stdout shows `✓ pushed · <remote branch> · <sha> · pull request #<n> · updated`,
  `  checkpoint <sha>`, `  commit <sha> · Mend's, for the work left uncommitted` (only when the
  agent left work uncommitted), `  pull request <url>`, and an `  observed` block. Exit code `0`.
  The pull request number is the same as before.
- **Push only.** Add more work in the worktree first, as in the previous step: with nothing new, a
  landing is refused even to another branch. Then run
  `mend land <worktree> --project <project> --no-pr --branch verify/push-only`. Stdout's first `✓`
  line reads `pushed · verify/push-only · <sha>` with no pull request. Exit code `0`.
- **Check GitHub.** Run `mend land <worktree> --project <project> --check`. Stdout reads
  `✓ pull request #<n> already recorded · <state> · observed`, then the `  observed` facts. Nothing
  is pushed.
- **Refused push.** Add more unlanded work in the worktree (as above), push a commit to the landing
  branch on origin from outside Mend, then run `mend land <worktree> --project <project>`. Stdout
  reads `· push refused · <remote branch> · <remote's words>`; exit code `1`; origin is unchanged.
- **Second view.** On GitHub, the pull request's head branch has the pushed commits and its
  description holds Mend's section. In Mend, the session's worktree branch, files, index and `HEAD`
  are unchanged.
- **Proof.** Capture the Land panel before and after landing
  (`await page.getByRole("region", { name: "Land" }).ariaSnapshot()` and a screenshot of it), and
  keep every `mend land` transcript with its exit code.

## Gotchas

- `mend land` and the Land panel report what was observed, GitHub's own state included:
  `merged · observed` is a fact Mend can print. A report goes no further: no "ready to merge", no
  claim that the change is safe.
- The land button's name depends on the state: `Push and open pull request`,
  `Push and update pull request` while the recorded pull request is open and its head is on origin
  (a closed or merged one brings back `Push and open pull request`), `Push to origin` when no pull
  request is possible (not GitHub, or the open pull request is from a fork). Ask for the name the
  state implies.
- Only the change's owner sees the land controls. Anyone else reads
  `only the change's owner lands it` once something has landed, and the session page link reads
  `Landing →`.
- `Check GitHub` appears only for the owner when a pull request is possible; `Check origin` once any
  landing is recorded, a refused or failed one included; `Refresh pull request` only for the owner,
  once a pull request is recorded.
- The `Your description` textarea is named by its wrapping label; it starts empty and its
  placeholder says whether text people wrote on GitHub is kept.
- `--land` on a launch is overruled by a project whose `Land when a turn completes` is off. Mend
  lands automatically only after turns it runs itself; an agent attached to a terminal lands on its
  own only once the session is picked up on the phone.
- "Land again after more work" needs `mend connect claude`; the other steps need no provider.
- A landing with nothing new is refused by the server, not reported as a landing: the CLI exits `1`.
  Do not read that exit code as a failed push.
- A disposable origin is required: landing really pushes and really opens a pull request, as the
  person whose GitHub login is connected.
