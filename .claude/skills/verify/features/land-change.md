# Land a change

Landing publishes a change: Mend takes a checkpoint, commits what the agent left uncommitted on top
of the agent's own commits, pushes that to origin fast-forward only, and on GitHub opens or updates
a pull request whose description carries Mend's review summary. Only the change's owner lands it.
Mend never force-pushes, never merges and never moves the session's branch, and it reports what it
observed: what was pushed, and the pull request with its state as GitHub last said it. The desktop
lands from the same Land panel as a side sheet; the phone shows the pull request and refreshes it
but does not land; Slack lands automatically or from a button in the thread.

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
- `land-desktop` lands from the desktop's Land sheet, opened from a session tab or the Pinned
  Review.
- `land-mobile-observe` shows the change's pull request on the phone, opens it on GitHub and asks
  GitHub again (`Refresh`).
- `land-slack` lands a Slack session automatically, or from the thread's
  `Push and open pull request` button.

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
- TUI: none. The dashboard has no landing; use `mend land`.
- Desktop: a session tab's header button `land` (the owner) or `landing` (everyone else, once
  something landed) opens the side sheet `Land the change`. Once something landed, the line under the
  header states the latest fact and opens the same sheet. The Pinned Review's header has `Land` (or
  `Landing`). The composer's settings menu has `Land when a turn completes` for a session run as a
  conversation.
- Mobile: no landing. A session's conversation shows a `pull request` card with `Open on GitHub`
  and, for the owner, `Refresh`. The Review screen and session rows carry the link
  `Open pull request <n> on GitHub`.
- VS Code: none.
- Slack: a session started from Slack lands when a turn that asked for a change completes, unless
  `autopr=false`, the Slack app's `Land automatically` or the project turns it off. Otherwise the
  thread offers `Push and open pull request` (`Push and update pull request` once one is open), and
  the status message gains a line such as `pushed · <branch> · pull request #<n> · opened` (ADR
  0006, ADR 0007).

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, signed in as the owner of the worktree's first session.
- `<project>`'s origin is a disposable GitHub repository the run may push to, and
  `mend connect github` has been run. With any other origin the push steps hold and the pull request
  steps report `unavailable`.
- A settled session in `<project>` holds a change, from
  `mend run --project <project> -- sh -c 'printf "verified\n" > VERIFY.md'`. Note its session id
  `<id>` and worktree name `<worktree>` from the `✓ worktree` line.
- Desktop steps: the desktop harness from [Start a session](./start-session.md), and a second settled
  change of its own: run the same `mend run` again and note its worktree `<worktree-2>`. A change
  landed on the web has nothing new for the desktop to push.
- Mobile steps: the Expo web build at `<mobile-web>`, paired and allowed, as in
  [Adopt a project](./adopt-project.md), after the web landing.

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
- **Desktop: open the Land sheet.** Click the second change's session row in the sidebar (named
  `<harness> · <label or branch>`), then run
  `await page.getByRole("button", { name: "land", exact: true }).click()`. The side sheet
  `Land the change` opens
  (`const sheet = page.getByRole("complementary", { name: "Land the change" })`), headed
  `Land` with the session's label or branch. It reads
  `push <branch> to origin · pull request into <base>`; the region `What Mend observed` reads
  `not landed · nothing pushed from Mend yet`; the region `Land this change` holds the textboxes
  `Pull request title` and `Your description`, the button `Push and open pull request`, and
  `checkpoints the worktree, commits what the agent left uncommitted, fast-forward only · merging stays on GitHub`.
- **Desktop: land.** Run
  `await sheet.getByRole("textbox", { name: "Pull request title" }).fill("verify: landing from the desktop")`,
  then `await sheet.getByRole("button", { name: "Push and open pull request" }).click()`. The button
  reads `Landing…`, then a status line (`sheet.getByRole("status")`) reads
  `pushed · <remote branch> · <sha> · pull request #<n> · opened`, the button
  `Open #<n> on GitHub ↗` appears, and the region `Landings` lists the landing. A refused push reads
  `push refused · <remote branch> · <remote's words>` in that status line; a call the server refuses
  (such as nothing new to land) shows an alert (`sheet.getByRole("alert")`) in its words.
- **Desktop: observe.** `Refresh pull request` reads `Asking GitHub…`; `Check origin` reads
  `Checking origin…`, then a line states what origin held; `Check GitHub` reads `Checking GitHub…`,
  then a status line states what it found. Close the sheet with its `Close`.
- **Desktop: the landing line.** Under the tab's header, a button now reads the latest fact
  (`page.getByRole("button", { name: /^pushed · / })`). Click it; the sheet opens again.
- **Desktop: from the Pinned Review.** Open the change's review (`review the change`). Its header
  has `Land` (`page.getByRole("button", { name: "Land", exact: true })`) with `aria-pressed="false"`.
  Click it: `aria-pressed` becomes `true` and the same sheet opens beside the review.
- **Mobile: the pull request card.** Run `await page.goto("<mobile-web>/session/<id>")` for the web
  step's session. Its conversation shows a card reading `pull request`, the state (`open`),
  `#<n>`, the title, the branch, where it came from and `observed <when>`, with `Open on GitHub` and,
  for the owner, `Refresh`. Tap `Refresh` (`page.getByText("Refresh", { exact: true })`); it reads
  `Asking GitHub…`, then the observed line updates.
- **Mobile: the links.** On the Review screen (`/review/<change id>`), the link
  `Open pull request <n> on GitHub` (`page.getByRole("link", { name: "Open pull request <n> on GitHub" })`)
  heads the screen with the state and `observed <when>`. The Now tab's row for the session carries a
  link of the same name.
- **Slack.** `not drivable yet`: it needs a Slack workspace with the organization's Slack app
  connected, and a GitHub origin. The end state is the status message's landing line
  (`pushed · <branch> · pull request #<n> · opened`) and the pull request on GitHub.
- **Second view.** On GitHub, the pull request's head branch has the pushed commits and its
  description holds Mend's section. In Mend, the session's worktree branch, files, index and `HEAD`
  are unchanged.
- **Proof.** Capture the Land panel before and after landing
  (`await page.getByRole("region", { name: "Land" }).ariaSnapshot()` and a screenshot of it), and
  keep every `mend land` transcript with its exit code. On the desktop, capture the sheet
  (`page.getByRole("complementary", { name: "Land the change" }).ariaSnapshot()`) before and after.
  On the phone, capture the card and the Review screen's link.

## Gotchas

- `mend land` and the Land panel report what was observed, GitHub's own state included:
  `merged · observed` is a fact Mend can print. A report goes no further: no "ready to merge", no
  claim that the change is safe.
- The land button's name depends on the state: `Push and open pull request`,
  `Push and update pull request` while the recorded pull request is open and its head is on origin
  (a closed or merged one brings back `Push and open pull request`), `Push to origin` when no pull
  request is possible (not GitHub, or the open pull request is from a fork). Ask for the name the
  state implies. The desktop's button follows the same rule.
- Only the change's owner sees the land controls. Anyone else reads
  `only the change's owner lands it` once something has landed, and the session page link reads
  `Landing →`.
- `Check GitHub` appears only for the owner when a pull request is possible; `Check origin` once any
  landing is recorded, a refused or failed one included; `Refresh pull request` only for the owner,
  once a pull request is recorded. The desktop shows them under the same conditions.
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
- The desktop's Land sheet has no description preview; `Preview description` exists on the web
  only. That is a product gap.
- The desktop's header button reads `land` in lower case and the Pinned Review's reads `Land`.
  Playwright's name match is case-insensitive without `exact: true`, so pass it. `land` appears only
  once the change exists and its landing record has been read; for anyone but the owner, `landing`
  appears only once something landed.
- The desktop's landing line is a button named by the fact it shows. Its title,
  `Open the Land panel`, is a description, not its name.
- The Land sheet's `Close` shares its name with the Services sheet's `Close`. Scope it to the
  `Land the change` sheet.
- The phone cannot land: it has no land control on any screen. That is a product gap. Picking a
  terminal session up on the phone (it continues as a conversation) is what lets automatic landing
  run for it.
- The phone's `Open on GitHub` and `Refresh` are pressables with no role
  (`apps/mobile/src/components/pull-request-card.tsx:133`); drive them by text. That is a finding.
  The two links named `Open pull request <n> on GitHub` do carry a role and a name.
- `Open on GitHub` and `Open #<n> on GitHub ↗` open GitHub outside the app: a new browser tab on the
  phone's web build, the system browser from the desktop.
