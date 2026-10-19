# VS Code extension: user stories

- **Release:** 0.36
- **Status:** approved by Yiannis on 2026-10-17; his four answers are under
  [Decided](#decided-yiannis-2026-10-17). The Figma storyboards follow these stories.
- **Replaces:** the screen-first design in `vscode-extension-redesign.md`. Yiannis rejected it on
  2026-10-17. That spec's as-built map, bug trace and API gap list still hold.
- **Written:** 2026-10-17, against mend main `637009289`.

## Who and why

The person: **Dana**, a developer who uses coding agents heavily and spends her day in VS Code. Mend
runs her agents in workspaces on a Mend server (a Mac mini at home, or the team's box). She wants VS
Code to be her agent interface: start work, answer the agent, read what it did, review it, send the
review back, and drive by hand when she has to. She never wants to leave VS Code for a browser.

The second person: **Ana**, Dana's teammate on the same Mend server. Ana appears only in edge cases.

Every story says, at each step:

- what Dana does;
- what VS Code shows;
- what Mend does behind it;
- what she sees next.

API calls are named so the build can check them against `packages/api-contracts`. Gaps are numbered
G1–G11; they are listed at the end.

## a. Start a session and keep working

_Dana is fixing a bug in `newsroom-api` and wants an agent to add rate limiting in parallel._

1. **Starting.** Her VS Code window is her own local checkout of `newsroom-api`.
   - She opens the command palette, runs **Mend: New session**, and types "add rate limiting to the
     login route".
   - VS Code shows one quick input. Its title is `New session · newsroom-api`. Below the prompt sits
     one dim line, `claude · default model · from main`, and that line has a **Change…** button.
   - Behind it, Mend matched the window to the project by its origin URL, so she is not asked which
     project.
2. **It runs.** She presses Enter.
   - Mend creates the session (`POST /projects/:id/sessions`) and launches claude on her prompt as a
     **terminal agent**: the claude TUI in the session's terminal (`POST /sessions/:id/launch`, PTY
     mode). Dana is a TUI person, and this is the agent she would run herself.
   - A row appears at once in the Mend view: `add-rate-limit · starting · building image`. Ten
     seconds later it reads `running · reading src/auth`.
   - No toast. No window opens.
3. **She keeps working.** She goes back to her bug in her own files. The status bar item reads
   `Mend · 1 running`.
4. **It finishes.** An hour later the agent completes a turn.
   - The row reads `idle · claude finished its turn`. A finished turn asks nothing of her: no
     **Needs you**, no badge, no toast (decided 2026-10-19).
   - When the session ends, the row reads `completed · observed · 4 files`, and a toast appears only
     if her window is focused and she is not already looking at that session:
     `add-rate-limit finished · 4 files changed` with [Review] [Open].

**Edge cases**

- **Base not in the store.** Her current branch has commits Mend has never seen, so Mend starts from
  `main`. The dim line said so before she pressed Enter:
  `from main · your branch fix/login isn't pushed`. If she wants her local commits in, that is story
  g.
- **Offline.** **New session** is disabled and its tooltip reads `Mend is offline · retrying`. Her
  prompt is kept if she typed one before the connection dropped.
- **Launch fails.** The row reads `failed · <the launch line>`, and an error toast offers [Retry].
- **No project matched the window.** The quick input's first step lists projects instead
  (`newsroom-api`, `mend`, …), with **Adopt this repository** at the top when the window's origin
  URL is not adopted.
- **Change….** It opens the options in the same quick input: harness, model, thinking, permissions
  and base. Each step has a step counter and Back, and is remembered per project. This replaces
  today's six separate prompts.

## b. The agent needs Dana; she answers without leaving VS Code

_The agent, running in its terminal, stops to ask whether it may run a database migration. Dana is
in her own window, working on her bug._

1. **She is told.** Sessions started from VS Code are terminal agents (story a), so the question is
   on claude's TUI, not a structured request.
   - **With G4** (a terminal agent reports that it waits, and why): Mend writes claude's
     `Notification` hook and codex's `notify` into the session's harness home, and they post to
     Mend. The row moves into **Needs you**:
     `add-rate-limit · waiting · claude needs your permission to use Bash`. The Mend icon gets badge
     `1`. Her window is focused and isn't showing that session, so one toast appears:
     `add-rate-limit is waiting · claude needs your permission to use Bash` with [Answer].
   - **Without G4 (today):** Mend can't tell. A session reads `waiting` only for a conversation's
     pending request (packages/sessions/src/engine.ts `reconcileSession`), so a terminal agent that
     asks still reads `running`. No **Needs you** row, no badge, no toast: she finds out only by
     looking at its terminal. **This story needs G4.**
2. **She answers.** She clicks **Answer** on the toast or on the row.
   - The agent's terminal attaches in her **current** window's panel, `claude · add-rate-limit`,
     over `/api/tty`. No workspace window opens; her own files stay where they were.
   - The TUI shows as it is now, with the question on screen. She presses `1` (yes) and Enter, as
     she would in her own terminal.
3. **It continues.** The row reads `running · pnpm db:migrate`, and the badge clears. She closes the
   terminal tab, which only detaches; the agent keeps running (today's banner says so).

**Edge cases**

- **She is in another VS Code window.** Only the focused window toasts. The others show the badge
  and nothing else, so one question never makes three toasts. If no VS Code window is focused, there
  is no toast; the badge waits.
- **A conversation** (started from her phone, the web or Slack). Mend has the structured request
  (`GET /sessions/:id/requests?pending=true`), so the toast carries the answer:
  `add-rate-limit asks: run pnpm db:migrate?` with [Allow] [Deny] [More…], sent with
  `POST /requests/:id/respond`. **More…** opens a quick pick with the question's options and a typed
  answer. No terminal is needed.
- **Someone else's session.** She sees it only if it is shared with her. Typing in its terminal
  needs shared control; without it the terminal is read-only (`read-only · Ana's session`), and the
  row says `waiting · Ana's session`.
- **Answered elsewhere** (her phone, after picking the session up). The row and badge update, and an
  open toast closes. No error.
- **Offline.** Rows keep their last state with `· last seen 2 min ago`; **Answer** is disabled with
  `Mend is offline`.

## c. Dana opens a running session to work in its workspace

_The agent is mid-task; Dana wants to look at the code it is writing and run the tests herself._

1. **The gesture.** She clicks the session row's **Open** button (a window icon). Opening is always
   that button. A click on the row itself only selects it and shows its change (story d).
2. **The window becomes the workspace.**
   - VS Code follows her own `window.openFoldersInNewWindow` setting. The default reuses this
     window; `on` opens a new one. There is no question.
   - The context menu also has **Open in New Window**, which opens a new one. It does not ask
     either. VS Code keeps one window per folder: when a window already holds the session's
     workspace, both gestures focus that window and show the session's agent.
   - Behind it, Mend opens the session's workspace over Remote-SSH
     (`vscode-remote://ssh-remote+…/workspace/repo`).
   - The window title becomes `add-rate-limit — newsroom-api`.
3. **What she sees in that window:**
   - **Explorer:** the worktree's files.
   - **Terminal panel:** the agent's terminal is attached and focused, `claude · add-rate-limit`
     (the session's live agent over `/api/tty`). Any integrated terminal she opens runs inside the
     workspace.
   - **Mend view:** this session only, with no project list.
     - status line: `running · editing src/auth/limit.ts`;
     - **Needs you**, when this session waits;
     - **Change**: its files, comments and checkpoints (story d).
     - One quiet line at the bottom, `2 other sessions · 1 needs you`, opens the session picker for
       the rest.
   - **Status bar:** `● add-rate-limit · running`. Clicking it opens the same session picker.
4. **She works.** She edits a file and runs `pnpm test` in a workspace terminal. The agent sees her
   edits (same worktree), and Mend records everything in the change.

**Edge cases**

- **The session has stopped.** **Open** still opens it. Mend resumes a workspace held by a shell
  (`POST /sessions/:id/resume {harness:"shell"}`). The status bar reads
  `starting add-rate-limit's workspace · 20 s`, and then the window becomes the workspace. No
  question: she asked to open it.
- **Ana launched the workspace.** Remote-SSH admits only the person who launched it. So the **Open**
  button is not offered on Ana's session row. In its place is **Review** (story d), plus **Watch
  terminal** when Ana has shared control on. The row's tooltip says why.
- **First open on this machine.** Remote-SSH is missing, or workspace SSH has no key yet. Both were
  set up in first run (story h). If they are missing anyway, the open runs the missing step as part
  of its progress (`setting up workspace SSH`). The one-time consent was given in first run, so
  nothing asks here.
- **Offline.** **Open** is disabled with `Mend is offline`.
- **The window is already that workspace.** Opening it again focuses the agent's terminal and does
  nothing else. If another window already has it, VS Code focuses that window.
- **Double-click on the row.** It selects the row and shows the change. It never opens a window.
  This is today's double-open bug (traced in `vscode-extension-redesign.md`, Divergences).

## d. Dana reviews what the agent changed, entirely in VS Code

_The agent says it is done. Dana wants to read the change, comment, and send it back._

1. **Opening the review.** She selects the session row in any window: her local one, or the
   session's workspace window. The **Change** section shows:
   - the header line `main → now · 4 files · +120 −18 · observed · 40 s ago`;
   - one row per file, with A, M and D marks;
   - `Comments · 1 Mend draft`;
   - `Checkpoints · 6`.

   Behind it: `POST /changes/:id/reviews/open` pins a slice, and `GET …/reviews/:sliceId/diff` reads
   it. No workspace window is needed to review.

2. **Reading the diff.** She clicks `src/auth/limit.ts`.
   - VS Code's own diff editor opens: base on the left, the pinned checkpoint on the right. It reads
     through a read-only `mend-change:` content provider (`GET /worktrees/:id/contents?path&at`).
   - **Open all changes** in the section title opens every file in one multi-diff editor
     (`vscode.changes`).
3. **Mend's draft comments.** She runs **Read this change** (`POST /changes/:id/read`).
   - The section reads `Mend is reading · 10:42`. When it finishes, draft threads appear in the
     diff, authored `Mend · draft`.
   - Each draft shows its evidence inline: the record excerpt it carries, for example
     `seq 214 · pnpm test auth · never ran`. **Show record** opens the session's transcript at that
     point in a read-only editor (`GET /sessions/:id/transcript`, G9).
   - Each draft has [Accept] [Dismiss]. Accepting makes it hers.
4. **Her own comments.** She hovers line 12, clicks `+` and writes "Use the shared limiter from
   guard.ts".
   - The comment is **pending**: held by the extension, like a pending review in GitHub Pull
     Requests, and not sent yet.
   - The Comments panel lists pending and accepted comments together.
5. **Choosing what to review.** The header line is a picker: `main → now` ▾. Its choices:
   - **since my last review**: from the checkpoint her last sent review was pinned to;
   - **last turn**: from the checkpoint the agent's last turn started at;
   - **between two checkpoints…**: two quick picks over the checkpoint list.

   The files and diffs switch to that slice. Viewing works today
   (`GET /worktrees/:id/diff?from&to`), but commenting on a slice other than `base → now` needs G10.

6. **Sending it back.** She clicks **Send review (2)** in the section title.
   - An editor opens with the instruction Mend will send: her comments in order, each with its file
     and line. She can edit the text. The editor title has **Send to session**.
   - She sends it. Mend records the follow-up with the slice, checkpoints, comment ids and her text
     (`POST /sessions/:id/follow-up/deliver`, idempotent).
   - **With G12** (deliver into a live terminal agent): Mend types the instruction into the agent's
     terminal as the owner and records it as delivered. Each thread reads `sent to session`, and the
     row reads `running · addressing review`.
   - **Without G12 (today):** while a terminal agent is live, the follow-up is held `pending` until
     that agent exits (packages/sessions/src/follow-up-delivery.ts:341-345). A TUI claude stays open
     between turns, so the review would wait. Until G12 lands, **Send to session** also attaches the
     agent's terminal in her panel and pastes the instruction there for her to press Enter. The
     threads read `follow-up pending · in claude's terminal`.
7. **Watching it address the comments.** When the turn ends, the row reads `completed · observed`.
   The Change section offers **since my last review · 2 files**.
   - She opens it. Each sent comment sits at its anchor over the new diff.
   - She marks each **Addressed** or **Reopen** (`POST /changes/:id/comments/:id/state`).
   - Mend never says the comment was addressed; she decides.

**Edge cases**

- **Offline.** The diff stays readable from the last fetch. Pending comments stay pending (they are
  local). **Send review** is disabled with `Mend is offline; your comments are kept`.
- **The session stopped.** Review works the same way; it needs no live workspace. Sending a review
  to a stopped session resumes it with the review as its prompt (the follow-up route already does
  this).
- **Ana's session.** Dana can read the change and comment if the project is shared. **Send review**
  is offered only to the session's owner, or to anyone while shared control is on.
- **Delivery fails.** The threads read `delivery failed · retryable`, and **Retry delivery** sends
  the same idempotency key.
- **The worktree moved on while she reviewed.** Her slice stays pinned. The header adds
  `worktree changed since this review · 3 new files`, with **Review the newer change**.
- **Edits after sending.** Today's API cannot edit or delete a sent comment (G1). Pending comments
  can be edited freely until **Send**, so most editing happens before it matters.

## e. Dana wants to drive by hand

_"Open" and "take over" were two commands. Yiannis asked what the difference is. From Dana's side
there is only one thing she wants: **to type to the agent herself, in her editor**. So there is one
gesture: **Open**._

1. **The gesture.** She clicks **Open** (story c). The window becomes the workspace, and the agent's
   terminal is already attached and focused in the panel.
2. **She types.** Sessions she starts from VS Code are terminal agents (story a), so this is the
   default path: she types into claude's TUI. Same agent, same conversation, her keystrokes (the
   owner's only). Nothing ends and nothing restarts. That is all "driving by hand" means.
3. **A conversation started elsewhere** (her phone, the web or Slack) has no TUI to type into.
   - The agent's terminal tab shows one line,
     `claude is running as a conversation (from your phone) · Continue here to type to it`, with a
     **Continue here** button.
   - Clicking it moves the same conversation into a terminal
     (`POST /sessions/:id/handoff {to:"pty"}`, Mend's existing mode handoff: one agent process at a
     time, the conversation kept). The TUI attaches, and she types.
   - Her phone, if open, now shows `continuing in a terminal`.
4. **Going back.** She closes the window; the agent keeps running in its terminal. Her phone can
   pick it up as a conversation (`handoff {to:"protocol"}`), as it can today.

So "take over" disappears as a command. Typing into the attached terminal covers the common case,
and **Continue here** covers the one case with no terminal yet, appearing only there.

**Edge cases**

- **The harness isn't claude or codex.** Mode handoff refuses (`HandoffUnsupported`). The line reads
  `opencode can't continue in a terminal yet · open the terminal to watch`.
- **Not her session.** She can type only with shared control. Otherwise the terminal tab reads
  `read-only · Ana's session` (today's behaviour).
- **The terminal dropped.** The tab reattaches (`reattaching (2/5)`, today's behaviour); the agent
  never notices.
- **Today's client-side takeover goes.** That is: open a shell, stop the agent, run
  `claude --resume` by hand in a new window. Mend's own mode handoff does the same job without
  stopping the workspace or guessing the resume command.

## f. Dana comes back the next morning

_She opens VS Code at 9:00. Two sessions ran overnight._

1. **She opens VS Code.**
   - Behind it: the extension reads her sessions and their landings (`GET /projects`,
     `GET /projects/:id`, `GET /sessions/:id/landings`). It compares them with the time she last
     looked, which it stores per server in `globalState`.
   - The Mend icon has badge `1`. The status bar reads `Mend · 1 needs you · 2 finished`.
2. **The Mend view shows, in this order:**
   - **Needs you:** `migrate-orders · waiting · approve schema change? · since 02:14`.
   - **Since you last looked:**
     - `add-rate-limit · completed · observed · 4 files · not reviewed`;
     - `flaky-auth-test · failed · exit 1 at 03:40`;
     - `docs-typos · landed · pull request #412 · open · observed`.
   - **Running:** nothing.
   - **Projects:** collapsed.
3. **She works through it.**
   - She answers the approval (story b).
   - She reviews the finished session (story d).
   - She opens the failed one to read why: selecting it shows its change, and its terminal is the
     record's last output.
   - Once she has looked at a session, it leaves **Since you last looked**.

**Edge cases**

- **The server was unreachable overnight.** The view reads `last heard from Mend at 23:10`. Nothing
  is guessed.
- **A session finished and was then landed by Ana.** The row shows the landing as observed
  (`pull request #415 · merged · observed`) and who landed it.
- **Many sessions.** **Since you last looked** groups by project after 8 rows.

## g. mend handoff: Dana's local branch becomes a session

_Dana has been fixing the login bug by hand on `fix/login`: 2 commits not pushed and 3 files
uncommitted. She has to leave and wants an agent (or herself, from her laptop at home) to carry on
from exactly here._

1. **Starting it.** In the Source Control view, the **⋯** menu has **Hand off to Mend…**. The same
   command is in the palette, and in the Mend view's title. One quick input:
   - title: `Hand off fix/login to Mend · newsroom-api`;
   - a fact line: `2 commits ahead of main · 3 uncommitted files · 1 untracked`;
   - an optional prompt, `Continue with: ________`. Empty means no agent: a workspace held for her.
   - The detail line reads
     `Copies your branch and uncommitted files into a new session. Your checkout stays as it is.`
2. **It runs.** She presses Enter.
   - Behind it, the extension bundles the 2 commits (`git bundle`) and the uncommitted and untracked
     files (a patch plus file contents, gitignored files excluded), and uploads them (G6). Mend
     creates a session whose worktree is her branch with those files applied.
   - A progress notification shows the steps: `bundling 2 commits · 3 files` → `uploading 1.2 MB` →
     `creating worktree` → `ready`.
   - The row appears as `idle · handed off from dana-mbp` (or `running`, if she gave a prompt).
3. **Done.** One toast: `Handed off as fix-login. Your checkout is unchanged.` with [Open] [Review].
   **Open** follows story c.
   - The Change section shows exactly the diff she had locally: base = the merge base with `main`.

**Edge cases**

- **Not adopted yet.** The quick input's first line reads
  `Adopt github.com/acme/newsroom-api and hand off`.
- **Detached HEAD or no commits.** It hands off the uncommitted files on top of HEAD's commit, and
  says so.
- **Origin isn't the project's.** Refused: `This checkout's origin isn't newsroom-api's`.
- **Too large, or secrets.** Files over the size limit are named and left out. Files matching
  `.env*` are left out by default, and the fact line says `.env left out`.
- **Offline, or a server without handoff.** The command is disabled:
  `This Mend server doesn't take handoffs yet` or `Mend is offline`.
- **The checkout changes during the upload.** The bundle was cut at the start. The toast says what
  was taken: `as of 10:42:05`.

## h. First run

_Dana installs the extension for the first time. Her Mend server is the Mac mini at
`http://mend-mini.local:3105`._

1. **Installing.** She installs **Mend by Sealant** from the Marketplace. The Mend icon appears in
   the activity bar, and the Mend view shows a welcome: `Connect VS Code to your Mend server.`
   [Connect].
   - If the Mend CLI on this machine is already signed in, the welcome reads instead:
     `Mend at mend-mini.local:3105 · signed in as dana@… (from the Mend CLI)` [Use it]. One click
     and she is done.
2. **Connecting.** She clicks **Connect**.
   - One input asks for the server URL, prefilled from the CLI's config if there is one.
   - Behind it: the browser opens Mend's approve page. VS Code shows one cancellable progress
     notification, `Approve in the browser if it shows ABCD-EFGH`, and the code stays in the status
     bar.
   - She approves, and one toast confirms: `Signed in to mend-mini.local as dana@…`.
   - The account appears in VS Code's Accounts menu, like her GitHub account.
3. **Getting ready to open workspaces.** The welcome's next step is
   `Open sessions in VS Code: needs Remote-SSH and an SSH key for Mend` [Set up].
   - One click installs Remote-SSH (if it is missing), registers a key, writes one `Host` block to
     `~/.ssh/config`, and seeds Remote-SSH's platform for that host.
   - This is the only consent in the product, asked once. It is never asked again at open time.
4. **Her first project.**
   - **Window is a repository Mend knows:** the view shows its sessions.
   - **Repository not adopted:** `Adopt newsroom-api from github.com/acme/newsroom-api` [Adopt], one
     click (`POST /projects`).
   - **Empty window:** [Adopt a repository…] asks for a clone URL.
5. **Her first session:** story a.

**Edge cases**

- **Plain-http server on a network she doesn't control.** The URL input warns,
  `Plain http: anyone on this network can read the token`, before anything is sent.
- **Denied, expired or unreachable.** The progress notification ends in one error toast with the
  reason and [Try again].
- **She skips SSH setup.** Everything except **Open** works: review, answer, terminal, start.
  **Open** then shows its setup step as part of its own progress, the one place the deferred consent
  appears, worded `Set up workspace SSH to open sessions (one Host block in ~/.ssh/config)` [Set
  up].

## Interaction rules (derived from the stories)

### Open

1. **An explicit button never asks.** **Open** follows VS Code's `window.openFoldersInNewWindow`.
   **Open in New Window** opens a new window, except that VS Code focuses a window already on the
   session's workspace, which then shows that session's agent. There is no question panel: no story
   needed one, and the old one is removed.
2. **A row click selects; it never opens a window.** Selecting shows the session's change. Opening
   is only the button, so single and double clicks cannot open twice.
3. **One open in flight per session.** A second gesture while one is running focuses the first.
4. **Preconditions are set up once, in first run:** Remote-SSH, the SSH key, the `Host` block and
   the platform seed. At open time a missing one is a progress step, never a dialog. The only
   exception is the deferred consent when first-run setup was skipped (story h).
5. **What can't be opened isn't offered.** For a workspace Ana launched, the **Open** button is
   replaced by what Dana can do: **Review**, and **Watch terminal** when shared control is on. The
   reason is in the tooltip.
6. **A stopped session opens.** Resuming as a shell is part of the open's progress. No question.

### Open, take over, answer

7. **One gesture: Open.** Sessions started from VS Code are terminal agents, so driving by hand is
   typing into the agent's terminal, attached when the window opens. A conversation started on the
   phone, the web or Slack gets **Continue here** (the mode handoff), shown only in its terminal
   tab. "Take over" is no longer a command.
8. **Answer means: attach the agent's terminal here.** **Answer** on a waiting terminal agent opens
   its terminal in the current window's panel and never opens a workspace window. Only a
   conversation's structured request is answered in a toast or quick pick.

### Where Mend lives

9. **Any window that isn't a session's workspace:**
   - the Mend view: **Needs you**, **Since you last looked**, **Running**, then **Projects**;
   - the status bar: one item, `Mend · 1 needs you · 2 finished`.
10. **A session's workspace window:**
    - the Mend view: that session only (status, needs-you, **Change**) and one line for the other
      sessions, `2 other sessions · 1 needs you`;
    - the status bar: `● session · status`;
    - the panel: the agent's terminal, attached;
    - no project list.
11. **Review lives where the code is.** The Change section, diff editors, comment threads and the
    Comments panel work the same from any window. Nothing opens the web app; **Open in Mend (web)**
    stays only in the overflow menu.

### Notifications

12. **Toast only when Dana is needed and isn't already looking:** a session waits for her, or a
    session she started finishes, and the focused window isn't showing that session. Only the
    focused VS Code window toasts.
    - A terminal agent's toast says what it waits for and offers [Answer]. It needs G4: without G4 a
      terminal agent's question makes no toast at all.
    - A conversation's toast carries the answer ([Allow] [Deny]).
13. **Never toast for something she is watching, or did herself.** No "starting…", no "connected",
    no "copied". Progress shows in the row or the status bar.
14. **Errors toast once, with the one action that helps** ([Retry], [Try again], [Set up]).
15. **The badge counts only what needs her** (waiting sessions she can answer), not running ones.

### Words

16. **Status reads `<word> · <fact>`, as observed:**
    `waiting · claude needs your permission to use Bash`, `running · pnpm test`,
    `completed · observed · 4 files`, `landed · pull request #412 · open · observed`. Never a
    verdict.

## What it rests on

- **Claude Code for VS Code.** One agent conversation per editor tab. When a session is open
  somewhere else, it offers to open it "here" rather than starting a second one. This is the
  precedent for **Continue here**.
- **Copilot agent sessions.** Sessions are listed with status. A finished session leads into its
  changes. Needs-you is shown by count, not by toasts for every change.
- **GitHub Pull Requests.**
  - Reviewing happens in VS Code's own diff editor through a content provider.
  - Comments use the Comments API, with **pending** comments until "Submit review".
  - The Comments panel lists the threads.

  Story d is the same shape, with Mend's slices in place of commits.

- **Remote-SSH.** Opening a host follows `window.openFoldersInNewWindow` and has an explicit "in New
  Window" action. Nothing asks.
- **VS Code's API limits, checked against VS Code's source:**
  - A tree item's command runs on the click and again on the double-click. That is why the row click
    only selects (rule 2).
  - `vscode.openFolder` with no flag follows the user's setting.
  - The Comments API (threads, state, custom actions) and `vscode.changes` (multi-diff) are stable.
  - Comment draft state is still proposed, so pending comments are held by the extension.

## API: what the stories need

Exists today:

- create, launch and resume;
- requests and respond (protocol sessions);
- `/api/tty` terminals;
- mode handoff (`POST /sessions/:id/handoff`, claude and codex);
- open review, slice diff, worktree diff and contents;
- comments and comment state;
- read and suggest;
- follow-up deliver (idempotent);
- landings;
- the session transcript;
- workspace SSH keys;
- the device sign-in.

Gaps, numbered as in `vscode-extension-redesign.md`:

| Gap       | What the story needs                                                                                                                      | Story              | Without it                                                                                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1        | Edit or delete a sent comment                                                                                                             | d                  | Pending comments are edited before **Send**; after that, Dismiss and write a new one                                                                                         |
| G4        | A terminal agent reports that it waits, and why (harness `Notification` / `notify` hooks posting to Mend, so the session reads `waiting`) | b, f               | Built 2026-10-19: claude's and codex's hooks run `mend hook`, and the session reads `waiting · <what it waits for>`; a finished turn reads `idle · claude finished its turn` |
| G6        | Hand off a branch with a git bundle plus uncommitted files                                                                                | g                  | Story g can't ship                                                                                                                                                           |
| G8        | VS Code extensions and machine settings in workspaces                                                                                     | (separate feature) | —                                                                                                                                                                            |
| G9        | Open the record at a sequence                                                                                                             | d                  | The comment's excerpt shows inline; **Show record** opens the full transcript, not the exact line                                                                            |
| G10 (new) | Open a review slice between any two checkpoints (today `reviews/open` is always base → now)                                               | d                  | "Since my last review", "last turn" and "between two checkpoints" can be viewed but not commented on                                                                         |
| G11 (new) | Mend's proposed checks as data (a command to run, with its observed result)                                                               | d                  | Drafts carry evidence links but no runnable check                                                                                                                            |
| G12 (new) | Deliver a review follow-up into a live terminal agent (typed as the owner, recorded as delivered)                                         | d                  | The follow-up waits `pending` until the agent exits; the extension pastes the instruction into the attached terminal for her to press Enter                                  |

G5 (a server takeover verb) is no longer needed: the mode handoff covers story e.

## Decided (Yiannis, 2026-10-17)

1. **Sessions started from VS Code launch as terminal agents** ("it's fair to assume they are TUI
   people"). Stories a, b, d and e follow from it; G4 and G12 are what it costs.
2. **The workspace window shows one line for the other sessions:** `2 other sessions · 1 needs you`.
3. **"Since you last looked" means since you last viewed it:** per session, the last time this VS
   Code showed that session selected or its window focused. The extension stores it per server and
   per machine.
4. **Handoff leaves out `.env*` by default.** The fact line says `.env left out`, and a button
   includes them.
