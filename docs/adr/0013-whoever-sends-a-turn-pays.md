# Whoever sends a turn pays: the workspace's login follows the turn's sender

Status: proposed 2026-10-03. Amends [ADR 0008](0008-one-refresher-for-provider-logins.md) ("Whose
login pays") and [ADR 0003](0003-organizations-and-tenancy.md) ("Sessions and shared control"):
under shared control a steerer's turn no longer spends the owner's login. Read against Mend at
`6abd2ab9` and Sealant Core `origin/main` at `6d624c1` (SDK 0.38.1).

## Context

Shared control lets other members steer a session. Today every turn runs on the owner's login (ADR
0008), so one person's subscription pays for several people's prompts. A login is one person's, and
lending it to others is the sharing that provider terms forbid. ROADMAP 0.38 already plans the fix:
"the session's credentials are passed with each turn, on the fly, instead of being fixed when the
session starts." This ADR records the design.

It is also the base for a later feature: switching one person between their own named accounts when
a usage limit is reached. That is the same switch with the same person on both sides.

### What exists

- **Every protocol turn has a sender.** `submitTurn(sessionId, input, author)` records the caller's
  user id from the web route (`apps/api/src/routes/workbench.ts`) and the linked Slack user from
  Slack (`apps/api/src/slack-runner.ts`).
- **Turns go through one serialised dispatch.** `dispatchNext` in
  `packages/sessions/src/protocol-host.ts` claims the next queued turn and calls `adapter.sendTurn`,
  one turn at a time per process, under a permit. A turn sent while the harness is busy is requeued,
  not merged into the running one.
- **Core can write a login into a running workspace.** Its refresh workers push each refreshed copy
  over the executor's control connection (`writeCredentialFiles`, ADR 0008 "Push, do not wait") to
  every running instance launched with that account. Nothing can choose a different account for a
  live workspace: credentials are fixed at create, and `restartWorkspace` rebuilds them from the
  recorded spec.
- **The harnesses read the file differently** (ADR 0008's table, tested 2026-10-01). Claude Code
  reads `.claude/.credentials.json` before every request. Codex reads `auth.json` once, and again
  only after a 401. A still-valid token never causes that 401, so Codex keeps the old login.
- **A Claude setup token is injected as `CLAUDE_CODE_OAUTH_TOKEN`.** The environment variable takes
  precedence over the credentials file and cannot be changed in a running process.
- **Credentials are never captured** (ADR 0002, ADR 0010): `.claude/.credentials.json` and
  `.codex/auth.json` are excluded from every capture.
- **Terminal sessions have no turns.** `tty.ts` forwards every input frame from any steerer straight
  to the PTY, and `openShell` admits any steerer. Both spend whatever login the workspace holds.

## Decision

### Whoever sends a turn pays for it

A turn runs on its sender's login, for the whole turn. Approvals answered and interrupts sent during
the turn spend nothing of their own; they belong to the turn. A turn Mend starts itself (a
keep-alive, a landing's follow-up) runs on the owner's. A turn with no recorded sender runs on the
owner's, as it does today.

A steerer who has not connected the harness's provider, or whose login is `invalid`, is refused at
submit: "Connect Claude to steer this session." Mend never falls back to the owner's login for
someone else's turn.

### The switch sits in dispatch

Before `dispatchNext` sends a turn, it compares the turn's sender with the login the workspace
holds. If they differ, Mend asks Core to write the sender's login into the workspace, then sends the
turn. If they match, nothing extra happens.

- **The owner's own turns cost nothing.** A session with shared control off, or one steered only by
  its owner, never makes the call.
- **Launch and saving are untouched.** The workspace still starts with the owner's login. The switch
  writes only credential files, and captures exclude them.
- **Mend still never holds a secret.** Mend names a person and an account; Core decrypts and writes.
- **The host remembers what the workspace holds.** Each hosted process starts with the owner's login
  (the one the workspace launched with) and updates it after each switch. A new process, after a
  restart or a relaunch, starts again from the owner's.

### Back to the owner when a steerer's turn ends

When a turn paid by someone other than the owner ends (completed, failed, interrupted or cancelled),
Mend writes the owner's login back, unless the next queued turn is the same steerer's. Otherwise the
owner's shell in that workspace could run `claude` on the steerer's login while the session sits
idle.

While a steerer's turn runs, their access token is readable inside the owner's workspace. The copy
has no refresh token (ADR 0008), so the exposure ends when the access token expires, and the switch
back removes it from the file. This is the residual risk; it is the same one a workspace already
carries for its owner's login.

### Each harness picks it up

- **Claude Code** reads the new file on its next request. No restart.
- **Codex** keeps its cached login until a 401. After a switch, Mend restarts `codex app-server` in
  the same workspace and resumes the thread (the rehydrate path the host already has). That costs
  one process start and a `thread/resume`, only when the payer changes.

Codex's external-auth mode (`account/chatgptAuthTokens/refresh`, ADR 0008's decision log) would
avoid the restart, but it sits behind Codex's experimental flag and would put token material through
Mend. It stays an option.

### Terminal sessions: only the owner types

A terminal session has no turn boundary to switch at, and a Codex TUI cannot take a new login
without a restart. So in a terminal session only the owner types, even while control is shared:

- **Read-only terminal for everyone else.** `tty.ts` streams output to any steerer but drops their
  input frames and resizes. The session's control view carries a `terminalInput` flag, and every
  client draws the terminal read-only when it is false.
- **Shells are the owner's.** `openShell` requires the owner. A shell runs on whatever login the
  workspace holds, so a steerer's shell would spend the owner's.
- **Steering a terminal session means a conversation.** A steerer sees: "This session runs in a
  terminal. Only \<owner\> types here; they can continue it as a conversation." The owner continues
  it with the existing handoff (`SessionEngine.handoff`), which starts the conversation in the same
  workspace, and from then on every turn is paid by its sender.

### Core: one endpoint

```
POST /v1/workspaces/:id/credentials   { onBehalfOf, claude?: name | true, codex?: name | true }
→ the accounts now injected, by provider
```

It resolves the account the way workspace create does (a name, `true` for `default`), writes a copy
without a refresh token over the control connection, and:

- **records the instance's current injections**, so the next refresh push for the previous account
  does not overwrite the switch, and the next push for the new account reaches it;
- **leaves the recorded spec alone**, so a restart lands on the owner's login, the safe default, and
  Mend switches again at the next dispatch;
- **authorises the write as the steerer's own work**: Mend's instance acts for both people, the
  account belongs to `onBehalfOf`, and the login is selected only for that person's turn. Core's
  rule "a login is selected only for that owner's work" stands.

Core also injects a Claude setup token as a credentials file instead of `CLAUDE_CODE_OAUTH_TOKEN`,
so every Claude login in a workspace can be switched. Mend's seed already writes that file
(`packages/sessions/src/harness-seeds.ts`).

### Every turn records its payer

Each turn records `billed_user_id`, `billed_account_id` and `billed_account_name`: the person and
the connected account it ran on, as Core reported them, with the account's name as it was then.
Until the switch ships, that is the owner's login for every turn, which the conversation then says
truthfully. Where a turn's payer differs from its sender, the conversation shows it: "Turn by Maria
· billed to Yiannis's `default` · observed". After the switch it reads "Turn by Maria · billed to
Maria's `work` · observed".

## Consequences

- A steerer's prompts no longer spend the owner's subscription. "Runs as \<owner\>" (ADR 0003)
  becomes "each turn runs on its sender's login".
- A session where only the owner speaks is exactly as fast as today. A switch adds one Core call
  before the turn, and for Codex a process restart; a steerer's turn adds a second call when it
  ends.
- Terminal sessions lose shared typing. Steering them now means continuing them as a conversation.
- A steerer with no login for the harness can watch and review, but not send turns.
- The same switch gives the later rotation feature its mechanism: on a usage limit, switch the same
  person to another of their accounts.

## Delivery

Mend, one stack:

1. This ADR, the platform feedback entry and the roadmap.
2. Terminal sessions: only the owner types or opens a shell; the control view's `terminalInput`
   flag; clients draw the terminal read-only and say why.
3. Every turn records its payer, and the conversation shows it.
4. After the SDK ships the endpoint: the switch in `dispatchNext`, the switch back, the Codex
   restart, the refusal at submit, and the payer filled from Core's answer.

Core (`sealant-sh/sealant`), its own stack:

1. `POST /v1/workspaces/:id/credentials` and the SDK method.
2. Claude setup tokens injected as a file.

## Decision log

- **A proxy holding everyone's logins (rejected).** A local proxy (CLIProxyAPI, TeamClaude) pools
  logins and rotates them per request. It would be a second credential store and a second refresher,
  against ADR 0008, and pooling is what the providers' terms and Core's design forbid.
- **Switch on Enter in terminal sessions (rejected for now).** Claude would take the new file
  mid-session, but the sender of a keystroke stream is a guess, and Codex cannot switch without a
  restart. Owner decision, 2026-10-03.
- **The owner's login for everything, with consent (the old rule, replaced).** Consent from the
  owner does not make lending a login permitted.
- **Steers join the running turn (rejected).** A second person's message mid-turn queues as their
  own turn, so every turn has exactly one payer.
- **Update the spec on a switch (rejected).** A restart would then land on whoever spoke last;
  landing on the owner's and switching again at dispatch is simpler and never strands a steerer's
  login.

## Open questions

1. **How long does the Codex restart take?** Measured once the switch exists. If it is slow, Codex's
   external-auth mode is the fallback.
2. **Capture mode with a joined worktree.** A session that joins a worktree runs inside the lease
   holder's workspace, so one switch changes the login for both sessions. Turns of the two are
   serialised per process, not per workspace; until they are, the switch refuses there and says why.
