# VS Code extension, every flow redone

- **Release:** 0.36
- **Status:** designed. The Figma design waits for Yiannis's sign-off; nothing is built.
- **PRs:** this spec; the build PRs are listed under [Build sequence](#build-sequence).
- **Decision records:** none yet. Decisions D1–D8 below need Yiannis.
- **Figma:** file `JSdDTmRfO3b2YdtN4v8J1l`, pages `VS Code as-built (2026-10)`,
  `VS Code pattern study (2026-10)` and `VS Code extension redesign (2026-10)`. The node ids are in
  the [screen inventory](#screen-inventory).
- **Written:** 2026-10-17, against mend main `637009289` (extension `sealant-sh.mend` 0.36.1).

## Why it exists

Today the extension is a tree, 17 palette commands and a chain of native prompts (as-built map on
the Figma page `VS Code as-built (2026-10)`). Three things make it hard to trust:

- **Opening a session goes wrong.** It opens two windows, ignores the choice between this window and
  a new one, and asks twice while ignoring both answers. The cause is traced under
  [Divergences](#divergences-found-while-writing).
- **Review leaves the editor.** `Mend: Review change` opens the browser, so the person reviews an
  agent's change everywhere except the editor they write code in.
- **Starting a session takes up to six separate prompts.** There is no step counter and no Back, and
  each answer is lost if one prompt is dismissed.

Two 0.36 features also need a home in the editor: `mend handoff` (bring local work into Mend) and
settings and extensions in Remote-SSH workspaces.

## What it does

Principles that hold on every screen:

1. **Native surfaces only.** TreeView, QuickPick (multi-step), Comments API, the diff and multi-diff
   editors, Pseudoterminal, status bar, walkthrough, AuthenticationProvider and welcome views. No
   webview ships in 0.36: the web app stays the rich surface (tour, evidence drawer, landing), and
   every screen links to it.
2. **One question per intent, asked once.** No modal repeats a choice the person already made.
3. **A click never opens a window.** Windows open only from an explicit **Open…** action, and that
   action allows one run per session at a time.
4. **Status is a dot, a word and a fact, as observed.** For example `waiting · approval`,
   `running · pnpm test`, `completed · observed`. Never a verdict (AGENTS.md product language;
   DESIGN.md status rule; plan §16.4).
5. **A toast is only for something the person isn't already watching.** That means errors, a session
   that starts waiting while the window shows something else, and a finished handoff.
6. **Mend's look comes through words and dots.** Native chrome takes the person's theme. Mend
   contributes theme colours (`mend.status.waiting`, `.live`, `.observed`, `.failed`, `.settled`)
   whose defaults are DESIGN.md's amber, cobalt, green, red and hollow ring, plus the activity-bar
   mark.

**In scope.**

- Every screen of the inventory below, with its empty, loading, error and offline states.
- The open flow rebuilt around one question.
- In-editor review: files, diffs, comment threads and sending the review to the session.
- Answering a waiting protocol session.
- The two placeholders, designed and not built: handoff, and settings and extensions.

**Out of scope.**

- Webviews.
- Landing (push and pull request) from the editor: **Open in Mend** covers it.
- Editing checkpoints.
- The desktop app. It is not shipping in 0.36.

## Screen inventory

Surface key: `native` = a built-in VS Code surface driven by the extension API. No screen uses a
webview. The node ids are each screen's default frame, light / dark, on page
`VS Code extension redesign (2026-10)` (`147:5`); every state's frame is listed under
[Figma frames by state](#figma-frames-by-state). Open the page at **Start here** (`165:1586`).

| #   | Screen                                              | Surface                                                                    | Figma (light / dark)                       |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| S0  | Activity bar mark and badge                         | native · `viewsContainers.activitybar`, `TreeView.badge`                   | `165:13971` / `169:19983` (R1 `165:2161`)  |
| S1  | Sessions tree (Needs you · this project · projects) | native · TreeView `mend.sessions`                                          | `165:13971` / `169:19983` (R1 `165:2161`)  |
| S2  | Change view (header, files, comments, checkpoints)  | native · TreeView `mend.change`                                            | `166:16849` / `169:21134` (R1)             |
| S3  | Diff with review threads                            | native · `vscode.diff` / `vscode.changes` + CommentController              | `165:12725` / `165:13304` (R3 `165:12600`) |
| S4  | Send review to the session                          | native · virtual document `mend-review:` + editor title action             | `165:43644` / `165:43993` (R3)             |
| S5  | Session terminal                                    | native · Pseudoterminal                                                    | `167:21839` / `167:22185` (R3)             |
| S6  | Status bar item                                     | native · StatusBarItem                                                     | `169:15727` / `169:22016` (R1)             |
| S7  | New session (multi-step)                            | native · `createQuickPick` with steps and Back                             | `165:2252` / `165:28808` (R4 `165:86`)     |
| S8  | Open (the one question)                             | native · `createQuickPick`                                                 | `165:15313` / `165:15500` (R2 `163:2`)     |
| S9  | First run and sign-in                               | native · viewsWelcome, walkthrough, AuthenticationProvider, progress toast | `165:19765` / `165:30831` (R4)             |
| S10 | Remote workspace window                             | native · status bar, Change view, terminal profile                         | `169:17357` / `169:22230` (R1)             |
| S11 | Takeover                                            | native · progress toast + terminal                                         | `165:27890` / `165:28070` (R2)             |
| S12 | Answer a waiting session                            | native · `createQuickPick`                                                 | `166:18891` / `166:19354` (R3)             |
| P1  | Placeholder: mend handoff                           | native · SCM title menu, QuickPick, progress toast                         | `165:14516` / `165:14664` (R5 `165:1585`)  |
| P2  | Placeholder: settings and extensions in workspaces  | native · Settings, walkthrough step, status bar, output channel            | `166:14154` / `166:14564` (R5)             |
| D   | Decisions for Yiannis                               | —                                                                          | `166:20789` (R5)                           |

### S1 Sessions tree

- **Groups:**
  - `Needs you`: waiting sessions the viewer may answer (their own, or shared control on).
  - `<project>`: shown when the window is a project.
  - `Projects`: collapsed while scoped. **Toggle scope** in the view title switches it.
- **Session row:**
  - Icon: a status dot from
    `ThemeIcon('circle-filled' | 'circle-outline', ThemeColor('mend.status.*'))`.
  - Label: the session label.
  - Description: `<status> · <fact>`. The fact is the waiting reason, the observed process
    (`claude (observed)`), the change size (`4 files`) or the launch line
    (`building image · step 2/5`).
  - Tooltip: the full lines (who is live, workspace line, retirement), resolved on hover as today
    (tree.ts:200-226).
- **Click:** selects the row and reveals its change in S2. It is idempotent, so a double-click only
  refocuses. The row has no `command` that opens a window.
- **Inline actions** (the Remote Explorer pattern; each one carries its answer, so no question
  follows):
  - **Open in this window** (`$(window)`)
  - **Open in new window** (`$(empty-window)`)
  - **Terminal** (`$(terminal)`)
  - **Answer…** (`$(comment-discussion)`, only on waiting protocol sessions)
- **Context menu:** Open in this window, Open in new window, Terminal, Review change, New session in
  this worktree, Take over…, Stop, Copy worktree path, Open in Mend. The groups run general, then
  lifecycle, then destructive, filtered by `contextValue`.
- **View title:** New session (`+`), Hand off local work (P1), Refresh, Toggle scope, and `⋯` with
  Adopt a project, Set up workspace SSH, Sign out.
- **States:**
  - Not connected: a welcome view, "Connect to a Mend server to see your projects and sessions."
    [Connect to a server…].
  - Signed out after a 401: a welcome view, "Mend refused this editor's sign-in." [Sign in again].
  - No projects: a welcome view, "Nothing adopted yet." [Adopt a project…].
  - Loading: the view's progress bar via `withProgress({ location: { viewId } })`, with the last
    rows kept.
  - Error: one message row with the error words and a Retry action.
  - Offline: rows kept with the description suffix `· last seen 2 min ago`, and the view title
    message `offline · retrying`.
- **VS Code API:**
  - `createTreeView` with `badge`, `message` and `description`.
  - `TreeItem.contextValue` for menus.
  - `resolveTreeItem` for tooltips.
  - `contributes.colors` for `mend.status.*`.
- **Mend API:**
  - GET `/projects`, GET `/projects/:id` (sessions, annotations, worktrees), SSE GET `/api/events`.
  - Hover reads: GET `/sessions/:id/waiting`, GET `/sessions/:id/workspace-retirement`, GET
    `/organization/members`.
  - Waiting reason for protocol sessions: GET `/sessions/:id/requests?pending=true`.

### S2 Change view and S3 diff with threads

- **Header row:** `3f2a… → 91bd… · 4 files · +120 −18`, with the description
  `observed · capture 12 · 40 s ago`.
- **Files:** one row per file with a `FileDecoration` (A, M, D, R), from the slice diff. A click
  opens `vscode.diff(mend-change:/…?at=<base>, mend-change:/…?at=<head>)`. The title action **Open
  all changes** opens the multi-diff editor (`vscode.changes`).
- **Comments group:** `Comments · 2 open · 1 Mend draft`. Its rows jump to their threads.
- **Checkpoints group:** pick two checkpoints to review a slice.
- **Title actions:** **Send review to session (3)**, **Read this change**, **Open in Mend**.
- **Threads:** a CommentController `mend-review` on `mend-change:` documents.
  - Each thread is one comment (Mend has no replies), anchored to the checkpoint pair and the hunk
    context hash.
  - A human comment is `open` from the start. Mend's comment is `draft`, authored `Mend · draft`,
    and links its evidence (`seq 214`, opens the web app) or its check.
  - Actions by state:
    - `draft`: Accept, Dismiss.
    - `open`: Mark addressed, Dismiss.
    - `addressed` or `dismissed`: Reopen.
    - `sent to session`: read-only.
  - "Edit" is Dismiss plus a new comment (gap G1).
- **States:**
  - No session selected: "Select a session to see its change."
  - No change: "<session> has no change yet."
  - Loading.
  - Change gone (worktree deleted).
  - Over 300 files: the first 300, then "Open the rest in Mend".
  - Offline: read-only, and comment input refused with "Mend is offline; your comment was not sent."
- **VS Code API:**
  - `registerFileSystemProvider('mend-change', …, { isReadonly: true })`.
  - `registerFileDecorationProvider`.
  - `comments.createCommentController` with `commentingRangeProvider`, `contextValue`-driven thread
    menus, `CommentThreadState`.
  - `vscode.diff`, `vscode.changes`.
- **Mend API:**
  - POST `/changes/:id/reviews/open`.
  - GET `/changes/:id/reviews/:sliceId/diff`.
  - GET `/worktrees/:id/contents?path&at`.
  - GET `/changes/:id/comments`.
  - POST `/changes/:id/reviews/:sliceId/comments`.
  - POST `/changes/:id/comments/:commentId/state`.
  - POST `/changes/:id/read`, `/changes/:id/suggest`, GET `/changes/:id/passes`.

### S4 Send review

**Send review to session** opens a virtual document, `mend-review:/<session>.md`. It holds the
structured instruction Mend builds from the open comments, and it is editable. The editor title
action **Deliver to session** sends it. Progress shows in S2's view, and the result shows on each
thread as `sent to session`, then `follow-up pending`, or as `delivery failed · retryable` with
[Retry delivery]. Delivery uses an idempotency key, so a double press sends once.

- **Mend API:**
  - POST `/sessions/:id/follow-up/deliver` with the slice, checkpoints, digest, commentIds,
    instruction and idempotencyKey.
  - GET `/sessions/:id/follow-up`.

### S5 Terminal

- Kept from today (extension.ts:393-473, tty-attachment.ts).
- New:
  - The terminal icon and colour follow the session status.
  - The tab name ends `· read-only` for watchers.
  - `Mend · <session>` terminals restore after a window reload: register a terminal profile and
    revive it on activation.
- The picker of processes stays a QuickPick when there is more than one.
- **States:** watching, reattaching (n/5), ended, refused, not steerable (all exist today).

### S6 Status bar

One item on the left. Its texts:

- `$(mend) <project> › <session> · waiting`
- `$(mend) <project> · 3 sessions · 1 waiting`
- `$(mend) not connected`
- `$(mend) offline · retrying`

A click opens the session quick pick, which leads into S8. The sign-in code item stays for the
length of a browser sign-in (config.ts `browserSignIn`).

### S7 New session

One QuickPick with steps:

1. **Step 1/2, what runs:** Workbench, claude, codex, opencode, pi. Each agent row has an item
   button **Options…**.
2. **Step 2/2, prompt:** the same quick input becomes a prompt field. An empty prompt is allowed for
   agents, and Workbench skips this step.

The options path adds Model → Thinking → Permissions → Base, numbered `3/6` and so on. Each step has
Back, is prefilled with the last choice (stored per project in `globalState`), and skips itself when
it has only one choice. A prompt starting with `-` is refused inline, as a validation message, not a
toast.

After **Start**:

- The session row appears at once as `starting`, with the launch line in its description.
- No progress toast.
- When the session runs, the window opens only if the person ticked **Open when ready**, which is on
  by default; it goes through S8 with the remembered answer.
- **Mend API:**
  - GET `/harnesses/models`.
  - POST `/projects/:id/sessions` (or POST `/worktrees/:id/sessions` for a join).
  - POST `/sessions/:id/launch`, or POST `/sessions/:id/resume` with `{harness:"shell"}` for a
    Workbench.
  - GET `/sessions/:id` to follow the launch.

### S8 Open: the one question

**This is the fix for the reported bug.** One command, `mend.open`, with an optional
`where: "thisWindow" | "newWindow"` argument. The row's inline actions and the context menu pass
`where`, so they open without a question. The QuickPick appears only when `where` is unknown: from
the palette, the status bar, a deep link, or the end of S7. A plain open of a running session opens
it alongside: the agent keeps running. Taking over is its own explicit action (**Take over…**), so
the open never asks "alongside or take over?". Two cases still ask, even with `where`, because the
default would fail or cost something: another person launched the workspace, and SSH is not set up
yet.

- **Before it shows:** the extension computes everything it needs (session detail, viewer, SSH
  readiness, Remote-SSH installed, whether this window is that workspace). The QuickPick is busy
  while it computes.
- **Single flight:** an open already in flight for the same session id focuses the existing
  QuickPick instead of starting another.
- **Already here:** if this window already is that workspace
  (`windowRemoteAuthority() === authority`), nothing is asked. The terminal or change is revealed,
  and the status bar says `Mend: already in <session>`. If another window has it open, VS Code
  focuses that window itself instead of opening a third.
- **Items:**
  - `This window` (detail: "Replaces <current folder>") and `New window`. The first item follows
    `window.openFoldersInNewWindow`, the same way VS Code decides when no flag is passed: `on` puts
    New window first; `off` and `default` put This window first.
  - Only from **Take over…**: `Take over in this window` and `Take over in a new window`, with the
    detail "Ends the claude Mend runs from the phone. Resumes it here: claude --resume 4b1e…". There
    is no confirmation after this.
  - Settled session: the items read `Resume and open here` and `Resume and open in a new window`.
    From an inline action, a settled session resumes without asking. The row already reads
    `stopped`, and progress says `Resuming as a workbench shell…`.
  - Launched by another person: the window items are replaced by `Open terminal`, with the detail
    "Remote-SSH opens only for Ana; the terminal needs no SSH". `Open anyway` stays at the bottom.
  - Workspace SSH not set up: the window items gain the detail "Sets up workspace SSH first (adds
    one Host block to ~/.ssh/config)". Choosing one runs the setup inside the same flow, with no
    extra modal.
  - Remote-SSH missing: the items are `Install Remote-SSH, then open` and `Copy code command`.
- **Remember:** an item button **Remember for this server** stores `mend.open.where` =
  `ask | thisWindow | newWindow`. When it is set, the question is skipped for plain opens, while
  takeover and the launcher case still ask. **Mend: Forget open choice** clears it.
- **Seeding:** SSH setup writes `remote.SSH.remotePlatform[<alias>] = "linux"`, so Remote-SSH never
  asks for the platform of a Mend workspace. The e2e suite already seeds this
  (test/e2e/suite.ts:477-478).
- **Window opening:** `vscode.openFolder(uri, { forceNewWindow })`, where `forceNewWindow` is the
  answer, never a constant.
- **Takeover from here:** S11.
- **States:**
  - Offline: one item, "Mend is offline; opening needs the server".
  - Resume failed: an error toast with [Retry].
  - Resume did not report a workspace within 120 s: the same toast, saying how long it waited.
- **VS Code API:** `window.createQuickPick` (`busy`, `buttons`, `ignoreFocusOut`,
  `QuickPickItemKind.Separator`), `vscode.openFolder`,
  `workspace.getConfiguration('window').get('openFoldersInNewWindow')`,
  `extensions.getExtension('ms-vscode-remote.remote-ssh')`.
- **Mend API:**
  - GET `/sessions/:id`.
  - GET `/organization` (viewer).
  - GET `/workspace-ssh`, POST `/workspace-ssh/keys`.
  - POST `/sessions/:id/resume` `{harness:"shell"}`.
  - For takeover: POST `/sessions/:id/shell` and POST `/sessions/:id/stop`.

### S9 First run and sign-in

- **Walkthrough "Get started with Mend":**
  1. Connect to a server.
  2. Set up workspace SSH (checks Remote-SSH).
  3. Adopt a project.
  4. Start a session.
  5. Bring your extensions into workspaces (P2).
- **Accounts menu:** an AuthenticationProvider `mend` lists `Mend · <email> @ <server>` with
  sign-out, the same place GitHub and Microsoft accounts live.
- **Browser walk:** one cancellable progress toast, "Approve in the browser if it shows ABCD-EFGH",
  with [Copy link] [Use a device token]. The status bar code item stays. One success toast, "Signed
  in to <server> as <email>", replaces today's two (config.ts:120 and extension.ts:297).
- **States:**
  - Waiting.
  - Denied ("Denied in the browser. Nothing was granted.").
  - Expired.
  - Unreachable (the transport reason).
  - Plain-http warning in the URL step.
  - Late approval revoked.
- **VS Code API:**
  - `contributes.walkthroughs`.
  - `authentication.registerAuthenticationProvider`.
  - `contributes.viewsWelcome` with `when` keys `mend.connection == none | signedOut | ok`.
- **Mend API:**
  - POST `/cli/auth`, POST `/cli/auth/token`.
  - DELETE `/me/devices/:id`.
  - GET `/organization`.

### S10 Remote workspace window

- VS Code's own remote indicator (`SSH: mend-ws-…`) stays VS Code's.
- Mend's status item reads `$(mend) <session> · running`.
- The Change view follows this window's session.
- The terminal profile **Mend agent** offers the resume command for this session's harness.

### S11 Takeover

Reached from S8, or from the context menu (which opens S8 with only the takeover items).

1. A progress toast, "Taking over <session> · stopping claude".
2. Open shell, then stop.
3. The window opens per the answer.
4. A terminal `claude · Mend` runs the resume. The pending-takeover record carries it to a new
   window (takeover.ts) as today.
5. The row reads `running · claude (observed)` within about 30 s.

If the stop fails, the agent keeps running, and an error toast offers [Retry] [Open alongside].
claude and codex only; any other harness's takeover items read "Take over in a terminal: mend attach
<id>" and copy that line.

### S12 Answer a waiting session

Protocol sessions only.

- **Answer…** opens a QuickPick titled with the request (`claude asks: run pnpm db:migrate?`). Its
  items come from the request: `Allow once`, `Deny`, or the question's options. A free-text answer
  goes in the quick input's value.
- PTY sessions show **Open terminal** instead.
- Toast only when the window is not showing that session: "<session> is waiting · approval"
  [Answer…] [Open terminal]. One toast per wait.
- **Mend API:** GET `/sessions/:id/requests?pending=true`, POST `/requests/:id/respond`.

### P1 Placeholder: mend handoff

Bring local work into Mend: the current branch, with its uncommitted changes, is adopted as a
session, so an agent (or you, from another device) carries on exactly where you were.

- **Starts from:**
  - The Source Control view title `⋯` → **Hand off to Mend…** (`scm/title`).
  - The Mend view title button.
  - A status bar item in a local window whose repository is an adopted project and has changes:
    `$(mend) feat/login · 3 changed · Hand off`.
  - The command **Mend: Hand off this branch…**
- **The question (one QuickPick):**
  - Title: `Hand off feat/login to Mend · newsroom-api`.
  - Fact line: `feat/login · 2 commits ahead of main · 3 uncommitted files (1 untracked)`.
  - Items:
    - `Hand off; keep this checkout as it is` (default).
    - `Hand off and start claude on a prompt…`
    - `Hand off and start codex on a prompt…`
  - Detail: "Mend copies the branch and the uncommitted files into a new worktree. This checkout is
    not changed."
  - When the folder is not an adopted project, the first item reads `Adopt <origin> and hand off`.
- **While it runs:** a progress toast with the steps `bundling 2 commits · 3 files` →
  `uploading 1.2 MB` → `creating worktree` → `workspace ready`. The new row appears as
  `starting · handoff`.
- **Done:**
  - A toast: "Handed off as <session>. This checkout is unchanged." [Open…] [Start an agent…] [Open
    in Mend].
  - The row reads `idle · handed off from <machine>`.
  - Its change shows the same diff the person had locally (base = merge base with the project's
    default branch).
- **Errors:**
  - Not a git repository.
  - Detached HEAD.
  - No origin, or an origin that is not the project's.
  - Files over the size limit (named).
  - A server without the endpoint: "This Mend server does not take handoffs yet."
- **Needs:** gap G6.

### P2 Placeholder: settings and extensions in workspaces

A workspace opened over Remote-SSH gets your VS Code extensions, settings files and keybindings, so
it feels like your own editor rather than a bare server.

- **What is already true:** in a Remote-SSH window VS Code applies the local user settings and
  keybindings. What a fresh workspace lacks is every workspace-kind extension, installed on the
  remote server per workspace (the slow first open), and machine-scoped settings. The feature
  therefore preinstalls the person's workspace extensions and writes machine settings into the
  workspace's VS Code server directory before the window connects.
- **Starts from:**
  - Walkthrough step 5.
  - Settings `Mend › Workspaces: Bring my editor`, with the values
    `off | extensions | extensions and settings`.
  - In a remote window that has not been synced, the status item
    `$(mend) extensions not synced · Sync`.
- **While it runs:** S8's progress gains the step `installing your extensions · 12/41`. In the
  remote window the status item reads `$(sync~spin) installing extensions 12/41`.
- **Done:**
  - Status item: `$(mend) <session> · 41 extensions`.
  - Tooltip: the ones skipped ("2 not available for linux-x64: …").
  - Output channel **Mend: workspace editor**: the full log.
- **Errors:**
  - The workspace can't reach the Marketplace or Open VSX (mirror hint).
  - An extension refused by policy.
  - Turned off by the organization.
- **Needs:** gap G8.

## Decisions for Yiannis

Each has a recommendation; the Figma frame D carries the same list.

| #   | Decision                                       | Options                                                                                       | Recommendation                                                                                     |
| --- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| D1  | What a click on a session row does             | Select and show its change / open the window / nothing                                        | Select and show its change. Opening stays an explicit action.                                      |
| D2  | How the window choice is made                  | Inline "this / new window" actions plus one question when unknown / always ask / setting only | Inline actions plus one question, with Remember for this server                                    |
| D3  | Where review happens in 0.36                   | In the editor (diff + threads + send) / browser only, as today                                | In the editor, read-only first (PR 5), threads next (PR 6). Tour and evidence stay in the web app. |
| D4  | Takeover's place                               | Its own action / an item in every open question                                               | Its own action. A plain open never ends an agent.                                                  |
| D5  | A settled session opened from an inline action | Resume without asking / ask first                                                             | Resume without asking: the row already says `stopped`, and the resume is reversible (Stop)         |
| D6  | Webviews                                       | None in 0.36 / a session panel webview                                                        | None. Every screen fits a native surface, and the web app is one click away.                       |
| D7  | Handoff and the local checkout                 | Copy and leave the checkout untouched / move (reset local) / ask                              | Copy, never touch the checkout (invariant 8)                                                       |
| D8  | Settings and extensions scope                  | Extensions only / extensions and machine settings / plus a dotfiles-style keybindings copy    | Extensions and machine settings. User settings and keybindings already apply over Remote-SSH.      |

## Figma frames by state

File `JSdDTmRfO3b2YdtN4v8J1l`. Light / dark node ids.

**Redesign** (page `147:5`; Start here `165:1586`):

| Screen | State                                        | Light / dark              |
| ------ | -------------------------------------------- | ------------------------- |
| S1     | default (window)                             | `165:13971` / `169:19983` |
| S1     | not connected                                | `165:21920` / `169:20152` |
| S1     | signed out after 401                         | `165:22278` / `169:20241` |
| S1     | no projects                                  | `165:22636` / `169:20330` |
| S1     | loading                                      | `165:23010` / `169:20431` |
| S1     | error                                        | `165:35072` / `169:20554` |
| S1     | offline                                      | `165:35469` / `169:20666` |
| S1     | row context menu                             | `165:35989` / `169:20844` |
| S1     | hover tooltip                                | `165:36567` / `169:20988` |
| S2     | default (window)                             | `166:16849` / `169:21134` |
| S2     | no session selected                          | `167:19045` / `169:21334` |
| S2     | no change yet                                | `167:19413` / `169:21424` |
| S2     | loading                                      | `167:19779` / `169:21515` |
| S2     | change gone                                  | `167:20273` / `169:21643` |
| S2     | over 300 files                               | `167:20639` / `169:21734` |
| S2     | offline                                      | `167:21204` / `169:21898` |
| S6     | session focused                              | `169:15727` / `169:22016` |
| S6     | project                                      | `169:16083` / `169:22059` |
| S6     | not connected                                | `169:16356` / `169:22102` |
| S6     | offline                                      | `169:16622` / `169:22144` |
| S6     | click → session quick pick                   | `169:16888` / `169:22186` |
| S10    | remote workspace window                      | `169:17357` / `169:22230` |
| S8     | inline action, opening (window)              | `165:2871` / `165:3169`   |
| S8     | this window, result                          | `165:6966` / `165:7259`   |
| S8     | new window, result                           | `165:11159` / `165:11969` |
| S8     | already here                                 | `165:7447` / `165:7768`   |
| S8     | one gesture, one window (flow)               | `165:12089` / `165:12140` |
| S8     | the question, default                        | `165:15313` / `165:15500` |
| S8     | openFoldersInNewWindow on                    | `165:15548` / `165:15735` |
| S8     | settled session                              | `165:15783` / `165:15968` |
| S8     | launched by another person                   | `165:16014` / `165:16196` |
| S8     | SSH not set up                               | `165:16240` / `165:16420` |
| S8     | Remote-SSH missing                           | `165:16462` / `165:16642` |
| S8     | busy                                         | `165:16684` / `165:16847` |
| S8     | offline                                      | `165:16875` / `165:17047` |
| S8     | resume failed                                | `165:21781` / `165:21849` |
| S11    | context menu, Take over…                     | `165:27649` / `165:27851` |
| S11    | the question                                 | `165:27890` / `165:28070` |
| S11    | progress                                     | `165:28112` / `165:28178` |
| S11    | resumed in this window                       | `165:37256` / `165:37564` |
| S11    | row after                                    | `165:37619` / `165:37696` |
| S11    | stop failed                                  | `165:28185` / `165:28253` |
| S11    | harness without a takeover                   | `165:28260` / `165:28432` |
| S3     | diff with threads (window)                   | `165:12725` / `165:13304` |
| S3     | multi-diff (window)                          | `165:25713` / `165:26263` |
| S3     | no comments                                  | `165:26771` / `165:26808` |
| S3     | sent to session                              | `165:26999` / `165:27013` |
| S3     | addressed and dismissed                      | `165:27178` / `165:27192` |
| S3     | offline                                      | `165:39033` / `165:39068` |
| S3     | Read this change, running                    | `165:39275` / `165:39312` |
| S3     | Read this change, result                     | `165:39609` / `165:39646` |
| S4     | `mend-review:` document (window)             | `165:43644` / `165:43993` |
| S4     | delivering                                   | `165:44345` / `165:44382` |
| S4     | sent to session                              | `165:44668` / `165:44705` |
| S4     | follow-up pending                            | `165:44899` / `165:44913` |
| S4     | delivery failed · retryable                  | `165:45108` / `165:45166` |
| S12    | approval (window)                            | `166:18891` / `166:19354` |
| S12    | hover → Answer…                              | `166:19708` / `166:19747` |
| S12    | options and free text                        | `166:19877` / `166:20088` |
| S12    | PTY → Open terminal                          | `166:20318` / `166:20357` |
| S12    | toast                                        | `166:20485` / `166:20560` |
| S5     | owner, live (window)                         | `167:21839` / `167:22185` |
| S5     | watcher, read-only                           | `167:22393` / `167:22452` |
| S5     | reattaching                                  | `167:22500` / `167:22565` |
| S5     | ended                                        | `167:22618` / `167:22680` |
| S5     | refused                                      | `167:22730` / `167:22789` |
| S5     | not steerable                                | `167:22836` / `167:22891` |
| S5     | process picker                               | `167:22935` / `167:23115` |
| S7     | step 1/2 what runs                           | `165:2252` / `165:28808`  |
| S7     | step 2/2 prompt                              | `165:4069` / `165:29023`  |
| S7     | prompt starts with -                         | `165:4413` / `165:29228`  |
| S7     | options 3/6 model                            | `165:4757` / `165:29433`  |
| S7     | options 4/6 thinking                         | `165:5123` / `165:29626`  |
| S7     | options 5/6 permissions                      | `165:5505` / `165:29833`  |
| S7     | options 6/6 base                             | `165:5879` / `165:30033`  |
| S7     | after Start, starting (window)               | `165:317` / `165:30230`   |
| S7     | running                                      | `165:10152` / `165:30376` |
| S7     | launch failed (window)                       | `165:10376` / `165:30523` |
| S7     | base not in store                            | `165:10645` / `165:30683` |
| S9     | fresh install, walkthrough (window)          | `165:19765` / `165:30831` |
| S9     | Accounts menu                                | `165:20089` / `165:30917` |
| S9     | server URL, plain http                       | `165:23530` / `165:31060` |
| S9     | method pick                                  | `165:23731` / `165:31201` |
| S9     | browser walk (window)                        | `165:23957` / `165:31330` |
| S9     | signed in, one toast                         | `165:24209` / `165:31434` |
| S9     | denied                                       | `165:24398` / `165:31593` |
| S9     | expired                                      | `165:24525` / `165:31694` |
| S9     | unreachable                                  | `165:24654` / `165:31794` |
| S9     | late approval revoked                        | `165:24777` / `165:31895` |
| P1     | starts from SCM menu and status bar (window) | `165:8752` / `165:9016`   |
| P1     | starts from the Mend view and palette        | `165:9149` / `165:9365`   |
| P1     | the question                                 | `165:14516` / `165:14664` |
| P1     | not adopted                                  | `165:14708` / `165:14856` |
| P1     | running                                      | `165:14899` / `165:15145` |
| P1     | done (window)                                | `165:20658` / `165:21084` |
| P1     | errors                                       | `165:21157` / `165:21373` |
| P2     | starts from walkthrough step 5 (window)      | `165:42663` / `165:42916` |
| P2     | starts from Settings                         | `165:42999` / `165:43029` |
| P2     | starts from the remote window                | `165:43062` / `165:43091` |
| P2     | running                                      | `166:13864` / `166:13923` |
| P2     | done (window)                                | `166:14154` / `166:14564` |
| P2     | errors                                       | `166:14689` / `166:14827` |
| D      | decisions, gaps, open items                  | `166:20789`               |

**As-built** (page `147:3`, redrawn from code at 637009289): rows A `165:2247` (sidebar and status
bar), B `165:2248` (connect and sign in), C `165:2249` (adopt and new session), D `165:2250` (open
in VS Code; D7 "The open bug, traced" `166:18699`), E `165:2251` (takeover, terminal, review, stop).

**Pattern study** (page `147:4`): GitHub Pull Requests `157:408`, GitLens `159:2`, Remote-SSH and
Dev Containers `159:284`, Claude Code `159:561`, Copilot agent sessions `159:814`, Cline `161:144`,
Container Tools `161:364`, Testing API `161:636`, Live Share `161:870`, VS Code UX guidelines and
API limits `161:1959`, What Mend takes `161:2378`.

**Kit** (page `147:2`): variables `VS Code theme` (2026 Light / 2026 Dark) and `Mend` (light /
dark); components `VSC/*`, `Note/Violet`, `Tag/Surface`, `Chip/CodePath`.

## Mend API gaps

| #   | Wanted                                                 | Today                                                                                      | Proposed                                                                                       |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| G1  | Edit or delete a review comment                        | Neither exists; only state changes (`C/changes.ts:70`)                                     | PATCH and DELETE `/changes/:id/comments/:commentId` for the author while `open`                |
| G2  | Replies on a thread                                    | `ReviewComment` has no parent (`review-comment.ts:73`)                                     | Out of 0.36; threads stay single comments                                                      |
| G3  | Human draft comments                                   | Human comments start `open`                                                                | Out of 0.36; editor drafts stay local until sent                                               |
| G4  | A waiting reason for PTY sessions                      | Only shared-steering waits and protocol requests carry text                                | Out of 0.36; the row reads `waiting`                                                           |
| G5  | Takeover as one server action                          | Client sequences shell, stop and resume (extension.ts:658-659)                             | POST `/sessions/:id/takeover` returning the resume line; the row can read `taking over`        |
| G6  | Handoff of local work                                  | Nothing; only push to origin, POST `/projects/:id/refresh`, create with `base`             | POST `/projects/:id/handoffs` taking a git bundle plus an uncommitted patch; returns a session |
| G7  | Resolve a folder to a project on the server            | Client-side match (client.ts:233)                                                          | Optional                                                                                       |
| G8  | VS Code extensions and machine settings in a workspace | Dotfiles snapshot (1 MiB per file, 4 MiB total, applied at launch; `dotfiles-store.ts:46`) | A per-person editor profile (extension ids, machine settings) applied at workspace boot        |
| G9  | Open the record at a sequence                          | Comments carry `RecordLink{runId, sequence}`; only `/processes/:id/logs?from=` reads logs  | Evidence links open the web app until a run-keyed route exists                                 |

`C/` is `packages/api-contracts/src/`.

## Build sequence

Small PRs, each shippable and each ending in a state the editor e2e suite proves.

1. **Open, fixed.**
   - `mend.open` with the one question and single flight.
   - The window choice honoured, and `remote.SSH.remotePlatform` seeded.
   - The tree row loses its window-opening command.
   - The takeover confirmation goes.
   - e2e: a double-click opens one window; this window and a new window are each honoured; the
     "already here" case.
2. **Tree and status bar.** Groups, dot icons with `mend.status.*` colours, `<status> · <fact>`
   descriptions, the view badge, the welcome states, offline.
3. **New session as one multi-step QuickPick**, with Back, remembered choices and the row appearing
   as `starting`.
4. **Sign-in.** AuthenticationProvider, the walkthrough and one success toast.
5. **Change view and diffs.** The `mend-change:` provider, file decorations and multi-diff,
   read-only.
6. **Review threads.** CommentController, the state actions and Mend's drafts with evidence links.
7. **Send review to session.** The `mend-review:` document and delivery states.
8. **Answer a waiting protocol session.**
9. **Takeover through S8.** Uses G5 if it lands; otherwise the client sequence.
10. **P1 handoff**, after G6.
11. **P2 settings and extensions**, after G8.

## Invariants

1. One user gesture opens at most one window.
2. An open of a session never asks a question whose answer is already known: the window choice when
   remembered, SSH setup when done, the takeover confirmation after takeover was picked.
3. The window choice the person makes is the one used: `forceNewWindow` comes from the answer or the
   setting, never a constant.
4. Cancelling the open question at any point leaves no side effect. No session is resumed, no agent
   stopped, no SSH config written.
5. Takeover ends the engine agent only after the person chose a takeover item and Remote-SSH admits
   them. A failure before the stop leaves the agent running.
6. Review delivery is idempotent: one press, one follow-up, whatever the retries.
7. Status words in every surface are observed words from plan §16.4. No verdict words appear
   anywhere.
8. Handoff never changes the local checkout.

## Edge cases and failure behaviour

- **Two windows of VS Code both run the extension.** Each has its own single flight; the "already
  here" check stops the second from opening the workspace again.
- **The SSE stream drops.** The tree keeps its rows and shows `offline · retrying`. On reconnect it
  refetches.
- **The server restarts during a resume.** The open waits up to 120 s, then says so, with [Retry].
- **Shared control is turned off mid-terminal.** The terminal ends with the not-steerable line, as
  today.
- **An older server without an endpoint the screen needs** (G5, G6, G8). The action is hidden behind
  a `when` key set from the server's capabilities, and the item says which server version adds it.
- **Permissions.**
  - A member who doesn't own the session watches the terminal and reads the change.
  - Steering items need ownership or shared control.
  - Remote-SSH items need the workspace launcher.

## Known limits

- No webview in 0.36. The tour, the evidence drawer and landing stay in the web app.
- Threads are single comments (G2), and a PTY session's waiting reason is not known (G4).
- Takeover is claude and codex only (`continueCommand`, takeover.ts).

## How to verify

- **Unit tests:** `apps/vscode/src/*.test.ts` (vitest).
- **The editor e2e suite:** apps/vscode/test/e2e/suite.ts, under
  `scripts/vscode-remote-acceptance.mjs`. On main 637009289 the harness fails before the suite:
  setup refuses because the harness does not preload the cloud-metadata guard image
  `busybox:1.37@sha256:bdf57e…`. With that patched in, a later run failed
  `PUT /projects/:id/workspace-image … other side closed`. Fix the harness before PR 1.
- **PR 1 adds suite steps:**
  - Fire `mend.open` twice in a row for one session and count `vscode.openFolder` calls (1).
  - Answer This window and New window and check `forceNewWindow`.
  - Open from inside the workspace window and expect no question.

## Divergences found while writing

The reported open bug, traced in today's code:

1. **A double-click on a session row runs the open twice.** The row's `command` is
   `mend.openWorktree` (apps/vscode/src/tree.ts:184-188). VS Code opens a tree item on the first
   click and again on the double-click event. In microsoft/vscode,
   `src/vs/platform/list/browser/listService.ts` `onPointer` skips only the `detail === 2` click,
   while `onMouseDblClick` opens again with `pinned: true`;
   `src/vs/workbench/browser/parts/views/treeView.ts` `tree.onDidOpen` runs the item command on
   every open. A single click, even one meant only to select, opens a window too.
2. **Nothing stops two runs at once.** `openWorktree` has no single-flight guard
   (apps/vscode/src/extension.ts:345). The second run's QuickPick replaces the first, which resolves
   `undefined` and drops that answer. Modals queue, one per run, so the same questions are asked
   twice. Cancelling one run does not stop the other, so a window opens anyway.
3. **The window choice is a constant.** Every open passes `{ forceNewWindow: true }`
   (apps/vscode/src/extension.ts:1319 and 1336). VS Code's `window.openFoldersInNewWindow` is
   ignored, no "this window" option exists, and only takeover checks whether this window already is
   the workspace (extension.ts:665).
4. **One open is up to five separate dialogs:**
   - the running-agent QuickPick (extension.ts:352-378);
   - the launcher modal (518-540);
   - the SSH setup modal (1215-1238);
   - the resume modal (1252-1289);
   - the Remote-SSH install toast (1292-1310).

   Takeover then asks again with a modal (643-651) after the person picked **Take over** in the
   first.

5. **Remote-SSH asks for the platform on first connect.** The extension never seeds
   `remote.SSH.remotePlatform` for its alias; only the e2e suite does
   (apps/vscode/test/e2e/suite.ts:477-478).
6. **One sign-in shows two success toasts:** apps/vscode/src/config.ts (`Signed in to Mend at …`)
   and apps/vscode/src/extension.ts:297 (`Connected to Mend at …`).
