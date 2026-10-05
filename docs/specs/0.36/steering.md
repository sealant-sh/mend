# Per-user steering: whoever sends a turn pays

- **Release:** 0.36
- **Status:** partly on main, partly designed.
  - **On main:** ADR 0013 (mend#517); only the owner types in a terminal, opens a shell or runs a
    command (mend#518, migration 0106); every turn records its payer and the conversation says so
    (mend#519, migration 0107).
  - **Designed, not built:** the per-turn login switch (ADR 0013 "The switch sits in dispatch",
    Delivery 4), moved into 0.36 by the owner on 2026-10-05 and redesigned onto a per-conversation
    login directory by ADR 0016 §3 and §5 (mend#534, open; its Delivery 3-5, 8 and 12). Core:
    sealant#315 (open, to be amended with a target home) and sealant#316 (open). No Mend branch is
    pushed for the switch.
- **PRs:** mend#517, #518, #519 (merged); mend#534 (open); sealant#315, sealant#316 (open).
- **Decision records:** docs/adr/0013-whoever-sends-a-turn-pays.md;
  docs/adr/0016-per-person-harness- homes.md (mend#534, open, amends 0013);
  docs/adr/0003-organizations-and-tenancy.md ("Sessions and shared control", amended by 0013);
  docs/adr/0008-one-refresher-for-provider-logins.md ("Whose login pays", amended by 0013).
- **Written:** 2026-10-05, against mend main `c9b645b0b`, sealant main `bc9ec426e`, sealantd main
  `07ada506a`. mend#534 read at `20b160c1e`.

## Why it exists

Shared control (ADR 0003) lets other members steer a session. Every turn ran on the owner's login
(ADR 0008), so one person's subscription paid for several people's prompts. A login is one person's;
lending it is what provider terms forbid, and the owner's rule is that no person ever uses anyone
else's login. A terminal session was worse: the tty route forwarded any steerer's keystrokes, and
any steerer could open a shell or run a command, all on whatever login the workspace held. Nobody
could see whose login a turn had used.

Who hits it: every organization that turns shared control on, every turn a steerer sends, every
Slack follow-up by someone other than the owner, and (capture mode) every person who joins a
worktree another person's session holds, whose agent runs on the holder's login.

## What it does

### On main

- **Terminal sessions: only the owner types.** Any steerer may attach to a session's terminal and
  reads its output; their key, text-input and resize frames are dropped. Their attach is recorded as
  `terminal-watch`, the owner's as `terminal-attach`.
- **Owner only, even while control is shared:** opening a shell, running a Service command or a
  `mend.toml` recipe, launching in any mode but `protocol` (a verbatim `argv` included), a resume
  that reopens a terminal (the current agent is not a conversation, or the harness changes), a
  review follow-up to a session whose agent is not a conversation. Refusal messages
  (`SessionNotSteerable`, 403):
  - `only the session owner starts its agent in a terminal, even while control is shared; the owner can continue it as a conversation`;
  - `only the session owner runs commands in its workspace, even while control is shared`;
  - `only the session owner can do this, even while control is shared` (a shell, through
    `SessionSteering.owned`);
  - the engine's own refusal, code `terminal_owner_only`, same wording as the first.
- **Still open to steerers:** sending turns to a conversation, answering approvals and questions,
  interrupting, restarting and stopping running Services, adopting a listening port, storing an
  image for a conversation's turn, stopping the session.
- **`SessionControlView.terminalInput`**: true only for the owner; older servers omit it and it
  decodes as true. Web, desktop, phone and CLI draw the terminal read-only when false and say
  `This session runs in a terminal. Only <owner> types here; they can continue it as a conversation.`
  Where resume or send-back would be:
  `This session runs in a terminal. Only <owner> resumes it|sends comments to it; they can continue it as a conversation.`
  The CLI's watch mode detaches on Ctrl+] or Ctrl+C and sends nothing.
- **Every turn records its payer:** `billed_user_id`, `billed_account_id`, `billed_account_name` on
  `agent_turns`, set once the harness accepts the turn. On main the payer is the login the workspace
  launched with: the owner's account `default`, id unknown; in a capture-mode join, the lease
  holder's; unknown when the lease names no session or Mend's own claim.
- **The conversation says it** where the payer is not the sender, on desktop and phone: desktop
  `<author line> · billed to Yiannis's default · observed` (or `billed to your default` for the
  viewer); phone `sent by Maria · billed to Yiannis's default · observed`. The web app has no
  protocol turn view.

### Designed (ADR 0013 as amended by ADR 0016), not built

- A conversation's turn runs on its sender's login, for the whole turn. Approvals and interrupts
  during it spend nothing of their own. A turn Mend starts itself, or one with no recorded sender,
  runs on the owner's.
- A steerer who has not connected the harness's provider, or whose login is `invalid`, is refused at
  submit: "Connect Claude to steer this session." Mend never falls back to the owner's login.
- The switch sits in turn dispatch. A Claude or Codex conversation's agent reads its login from its
  own directory `/root/.mend/logins/<session id>` (`L`), which nothing else reads. Before a turn
  whose sender's login `L` does not hold, Mend asks Core to write the sender's login (harness
  provider and GitHub) at `L`; the owner's own turns make no call.
- After a steerer's turn ends (completed, failed, interrupted, cancelled), Mend writes the owner's
  login back unless the next queued turn is the same steerer's.
- Claude reads the new file on its next request. Codex restarts `app-server` in the same `L` and
  resumes the thread.
- A relaunch, Codex restart or resume of an agent in `L` gets the login of whoever sends its first
  turn, the owner's when nobody has, written before it starts. After a Mend restart while a
  steerer's turn runs, `L` counts as holding an unknown login and is written before the next turn. A
  turn never starts on a login nobody confirmed.
- The payer is recorded from Core's answer: "Turn by Maria · billed to Maria's `work` · observed".
- A joiner's session gets its own home and login (ADR 0016 §3-4), so a switch changes exactly one
  process; ADR 0013 open question 2 closes.
- Terminal sessions stay owner-typed and are never switched; a terminal agent reads the person's own
  home `R`.

**In scope.**

- The tty input filter, the owner-only acts, the `terminalInput` flag and the clients' read-only
  terminals.
- Payer columns, their recording in the protocol host, and the payer line on desktop and phone.
- The designed switch: dispatch-time write, switch back, Codex restart, refusal at submit, payer
  from Core, restart behaviour, GitHub with the provider.

**Out of scope.**

- Switching one person between their own named accounts on a usage limit (later feature on the same
  switch, ADR 0013 Context).
- Separate POSIX users per person: everyone in an executor can read every login there (ADR 0016
  §10).
- Codex's external-auth mode (`account/chatgptAuthTokens/refresh`), kept as a fallback option.
- Shared typing in terminals (rejected, ADR 0013 decision log).
- Memory, secret files and settings under steering: the turn runs in the owner's home, writes the
  owner's memory and transcript (ADR 0009 decision 1, ADR 0010 decision 1, ADR 0016 §5).

## How it works

### Authorization (main)

- `canSteerSession` (`packages/domain/src/workbench/session-control.ts:52-54`): owner, or anyone who
  can see the project while `sharedControlEnabledAt` is set. `canTypeInTerminal` (`:63-66`): the
  owner only. `startsInTerminal` (`:80-81`): current agent kind is not `agent-protocol`, or the
  harness changes. `canRelaunchSession` (`:88-93`).
- `sessionControlView` (`apps/api/src/session-steering.ts:44-58`) sends
  `{own, steer, stop, toggleSharedControl, terminalInput}`; `terminalInput` decodes to true when
  absent (`packages/api-contracts/src/project-environment.ts:360`).
- `requireOwnerRuns` (`session-steering.ts:73-80`), after `SessionSteering.session`.
- Routes (`apps/api/src/routes/workbench.ts`): `openShell` `steering.owned` (`:2487-2510`, records
  `shell-open`); `runService` and `runServiceRecipe` `requireOwnerRuns(…, "command")` (`:2573-2577`,
  `:2609-2613`); `resume` `requireOwnerRuns(…, "terminal")` when `startsInTerminal` (`:3103-3120`);
  `launch` when `mode !== "protocol"` (`:3155-3161`); `followUpDeliver` when `startsInTerminal`
  (`:3177-3186`); `submitTurn` only `steering.session` (`:2368-2381`).
- Engine (`packages/sessions/src/engine.ts:13004-13013`): a prompt follow-up whose `author` is not
  the owner is refused `terminal_owner_only`.
- tty (`apps/api/src/routes/tty.ts`): `authorizeUser` at the upgrade (steer);
  `typing = caller === session owner` (`:280`); control event `terminal-attach` or `terminal-watch`
  (`:281-286`, kind added by migration 0106); `ttyInputOf(data, typing)` returns null for every
  frame when not typing (`:36-61`, used at `:315`). The output pump is the same for both.
- Clients: web `apps/web/src/routes/sessions.$sessionId.tsx:458-537`; desktop
  `apps/desktop/src/renderer/src/components/terminal-pane.tsx:254-606`; phone
  `apps/mobile/src/components/session-pane.tsx:90-251`; CLI `apps/cli/src/attach-watch.ts:11-45`.

### Payer (main)

- Migration 0107 (`packages/db/src/migrations.ts:2952-2964`): `agent_turns.billed_user_id` (FK
  `"user"`, `ON DELETE RESTRICT`), `billed_account_id`, `billed_account_name`; null on older turns.
- Protocol host (`packages/sessions/src/protocol-host.ts`): each hosted process carries `holds`
  (`:84-87`), initialised at attach from `launchLogin(input.launchedWithLoginOf)` (`:95-99`,
  `:433`): `{userId, accountId: null, accountName: "default"}`, or all null when the user is
  unknown. `loginForTurn` returns `entry.holds` (`:106-107`). `dispatchNext` (`:181-215`), under a
  per-process permit, claims the next queued turn, takes its payer, sends it; on
  `AgentTurnBusyError` requeues; on another failure fails the turn (no payer); on success
  `setTurnPayer` then `setProviderTurnId` (`:210-211`). A turn the harness opens itself records
  `entry.holds` (`openHarnessTurn`, `:236-256`).
- `launchedWithLoginOf`: cold launch, the session's owner (`engine.ts:12083`); retained launch and
  join, `launchLoginOfWorkspace` (`engine.ts:12572-12587`: co-located, the owner; capture mode, the
  owner of the session the lease names when that session's row names this workspace, else null);
  rehydrate after a Mend restart, `launchLoginOfProcess` (`engine.ts:15057-15065`, `:15112`).
- Display: `turnPayerWords` and `turnPayerLine` (`packages/agent-conversation/src/payer.ts:14-40`)
  return null when the turn has no author, no payer, or author = payer. Desktop
  `components/conversation.tsx:356`, `lib/conversation.ts:150-160`; phone
  `components/protocol-conversation.tsx:75-85`.

### Turn senders (main)

- Web, desktop, phone, t3 gateway: `POST /api/sessions/:id/turns` with the caller as author
  (`workbench.ts:2375`; gateway `apps/t3-gateway/src/mend-client.ts:441-450`).
- Slack: `followUp` (`apps/api/src/slack-runner.ts:1576-1690`) checks `steering.authorizeUser`, then
  `engine.submitTurn(session.id, turn, userId)` with the linked Mend user. When the session is not
  live it resumes it with `start.launchAs(userId, session, protocol)` after checking the owner's
  credentials (`:1546-1565`: "A resume spends the owner's credentials, whoever sends the turn").

### Designed switch (not built)

- Core (ADR 0016 §3):
  `POST /v1/workspaces/:id/credentials { onBehalfOf, home, claude?, codex?, github? }`,
  `DELETE … { home }`, `workspaces.create({ credentialsHome })`. Built on sealant#315 (today
  `{ ownerUserId, onBehalfOfUserId, claude?, codex? }`, writes `$HOME`, one held account per
  instance, refresh push follows the switch by compare-and-set, spec unchanged, service-key callers
  only; 409 `credential-not-switchable` for an env-held login, `workspace-not-running`) amended with
  a `home`, held login per instance/home/provider, GitHub as a provider written as `gh`'s
  `hosts.yml`, and an unconnected provider removed from the home. sealant#316: a Claude setup token
  written as a credentials file, not `CLAUDE_CODE_OAUTH_TOKEN`; an unconfirmed write leaves the held
  login unknown and answers 502.
- Mend (ADR 0016 Delivery 12): in `dispatchNext`, compare the turn's sender with what `L` holds; if
  different, call with `home: L`, `onBehalfOf: sender`; record the payer from the answer; on turn
  end write the owner back unless the next queued turn is the same sender's; Codex restarts
  `app-server` once per change of payer; refusal at submit for a steerer without the provider or
  with an invalid login. `holds` is Core's record, not Mend's memory.

## Happy path

Yiannis owns session `s1` (Claude, conversation) in project `api`; Maria is a member; both have
Claude connected (Yiannis `default`, Maria `work`).

**On main:**

1. Yiannis turns on Shared control (`mend session share s1 on`); the control log shows
   `shared-control-on`, the audit log `session.shared_control_on`.
2. Maria sends "add a test for the parser" from the phone. The turn's row: `author` = Maria,
   `billed_user_id` = Yiannis, `billed_account_name` = `default`. Under the turn the phone shows
   `sent by Maria · billed to Yiannis's default · observed`; Yiannis's desktop shows
   `… · billed to your default · observed`.
3. Maria opens Yiannis's terminal session `s2` in the web app: the terminal is read-only with
   `This session runs in a terminal. Only Yiannis types here; they can continue it as a conversation.`
   Her keys reach nothing. The control log records `terminal-watch` for Maria.
4. Maria tries `mend shell s2`: refused,
   `only the session owner can do this, even while control is shared` (`steering.owned`). Maria
   tries `mend service run s2 --port 3000 -- npm run dev`:
   `only the session owner runs commands in its workspace, even while control is shared`.
5. Maria resumes stopped terminal session `s2` from the web: refused with the terminal wording; the
   Resume control is hidden for her.

**Designed:**

6. Maria sends a turn to `s1`. Before dispatch Mend asks Core to write Maria's `work` login at
   `/root/.mend/logins/s1`; Claude reads it at its next request; the turn records `billed_user_id` =
   Maria, `billed_account_name` = `work`, and the conversation says nothing extra (sender = payer).
7. The turn ends with no queued turn of Maria's; Mend writes Yiannis's login back at `L`. Yiannis's
   shells and his other sessions never saw Maria's login.
8. A member without Claude connected sends a turn: refused with
   `Connect Claude to steer this session.`

## Invariants

On main:

1. Only a session's owner's input frames reach its PTY; for everyone else every frame is dropped and
   output still streams.
2. Only the owner opens a shell, runs a Service command or recipe, launches a non-protocol agent,
   resumes or follows up into a terminal, whatever the shared-control state.
3. Every turn the harness accepted has a payer recorded once, before its provider turn id; a turn
   never accepted has none.
4. The payer line appears only where author and payer differ, and states an observation
   (`· observed`), never a judgment.
5. `terminalInput` is false for every viewer but the owner; a client never offers typing, Resume or
   Send back into a terminal when the server would refuse it.
6. Every terminal attach is recorded with its actor, as `terminal-attach` (owner) or
   `terminal-watch` (anyone else).

Designed (not true on main):

7. No person's turn, shell, terminal or command ever runs on another person's login, under shared
   control or in a joined executor.
8. A steerer's login sits only at the steered conversation's `L`, only for that steerer's turns; no
   other process reads it.
9. No turn starts on a login nobody confirmed; after an unconfirmed write or a Mend restart the next
   turn's login is written first.
10. A steerer without a usable login for the harness's provider never sends a turn; Mend never falls
    back to the owner's.
11. The owner's own turns make no Core call.
12. The payer recorded for a turn is what Core reported holding for it.

## Edge cases and failure behaviour

**Concurrent actions**

- A steerer's turn while the owner's runs: queued as its own turn (never merged), dispatched after;
  each turn has one payer.
- Two steerers alternating: designed switch writes per change of sender; Codex restarts per change.
- The owner turns shared control off with a steerer's turn queued: on main the queued turn is still
  dispatched (see Divergences); a watching steerer's open tty socket keeps streaming output until it
  closes.
- A member removed from the organization while attached: the socket is closed and their input
  dropped from then on (`guardSocket`).

**Restarts**

- Mend restart with a turn sent but not acknowledged: rehydrate fails it ("Mend restarted before the
  turn was acknowledged."), no payer.
- Rehydrate sets `holds` from `launchLoginOfProcess`; in capture mode a lease naming Mend's own
  claim or no session gives a null payer.
- Designed: after a restart `L` is unknown; the next turn's login is written before it.
- Workspace restart: lands on the launch login (recorded spec unchanged), which the designed switch
  rewrites at the next dispatch.

**Partial failures**

- Designed: a Core write that fails or times out: the held login is unknown (sealant#316); the turn
  does not start; Mend writes again before the next one. A Codex restart that fails: per ADR 0013,
  the restart is the cost; the turn waits on it.
- Credential ladder at create (`engine.ts:9094-9109`): a workspace created without the harness login
  (the person has none connected) still records the owner's `default` as payer on main.

**Odd input**

- A turn with no author (Mend's own, a keep-alive, a landing follow-up): payer recorded, no payer
  line.
- A harness-opened turn (background task ended): records `holds`, no payer line.
- `--session-id` or verbatim argv in a protocol launch: still a conversation; anyone steering may
  launch it.

**Older data**

- Turns before 0107: payer null, no line.
- Servers before #518: no `terminalInput`; clients treat it as true.
- Designed: workspaces created before sealant#316 hold a setup token in the environment and answer
  `credential-not-switchable`.

**Permissions**

- Owner: everything. Steerer (shared control on): turns, approvals, interrupts, Service
  restart/stop, port adoption, image paste, stop; terminal read-only. Viewer (shared control off,
  not owner): nothing that steers; `SessionNotSteerable`. Organization owner: can stop any visible
  session and turn shared control off, but not type in a terminal. Operator: no default access.
- Joined session owner in capture mode: owns their session, so `canTypeInTerminal` is true; their
  terminal and shells run in the holder's executor on the holder's login on main.

**Clients**

- Web: read-only terminal, hidden Resume/Send back, no payer line (no protocol turn view).
- Desktop: read-only terminal pane, payer in the turn line.
- Phone: read-only terminal, payer line, conversation composer for steerers.
- CLI: `mend attach` as a watcher prints the read-only line; keys detach.
- VS Code: no tty attach of its own; takeover runs in a Remote-SSH terminal authorised for the
  workspace's own principal.
- Slack: follow-ups by any steerer are turns with the linked Mend user as author; a resume by a
  steerer relaunches on the owner's login on main.
- t3 gateway: turns through `POST /api/sessions/:id/turns` with the device's account.

## Known limits

- Terminal sessions lose shared typing; steering one means continuing it as a conversation (ADR 0013
  Consequences).
- While a steerer's turn runs, their access token is readable inside the owner's workspace; the copy
  has no refresh token (ADR 0013 "Back to the owner").
- People in one executor can read each other's logins (ADR 0016 §10).
- A steerer's switched turn adds a Core call before and after, and a Codex restart (ADR 0013
  Consequences; open question 1, not measured).
- On main the owner pays for every steerer's turn and every joiner's agent pays on the holder's
  login; the conversation says so for steered turns. ADR 0016 is the fix.

## How to verify

**Tests**

- `apps/api/src/routes/tty.test.ts` (owner frames reach the PTY; anyone else's are dropped, resizes
  included).
- `apps/api/src/session-steering.test.ts` (only the owner types, even while shared; an organization
  owner may stop but not type).
- `packages/domain/src/workbench/session-control.test.ts`, `agent-protocol.test.ts`.
- `packages/sessions/test/protocol-host.test.ts:499-520` (payer from the launch login).
- `packages/sessions/test/engine.test.ts:9430` ("a joined session's later conversation runs in the
  holder's executor, on the holder's login").
- `packages/agent-conversation/src/payer.test.ts`,
  `apps/desktop/src/renderer/src/lib/conversation.test.ts`, `apps/cli/src/attach-watch.test.ts`,
  `apps/web/src/lib/viewer.test.ts`, `apps/desktop/src/renderer/src/lib/viewer.test.ts`,
  `packages/sessions/test/follow-up-delivery.test.ts`, `packages/db/test/migrations.test.ts`.
- Not covered: the switch (not built); Slack resume by a steerer; a queued steerer turn after shared
  control is turned off.

**On the box** (two accounts, A owner, B member)

```sh
# as A
mend session share <s> on
# as B, phone or desktop: send a turn to A's conversation <s>
psql "$MEND_DATABASE_URL" -c "select ordinal, author, billed_user_id, billed_account_name from agent_turns where session_id='<s>' order by ordinal"
psql "$MEND_DATABASE_URL" -c "select kind, actor_user_id, created_at from session_control_events where session_id='<t>' order by created_at"
# as B: mend attach <t> (terminal session) → read-only line; mend shell <t> → refused
```

**Signals**: control events `terminal-watch`, `shell-open`, `shared-control-on|off`; refusal codes
`terminal_owner_only` and `SessionNotSteerable` (403); payer lines `billed to … · observed`.
Designed: Core answers `credential-not-switchable`, `workspace-not-running`, 502 on an unconfirmed
write.

## Divergences found while writing

1. `packages/agent-conversation/src/payer.ts:39`: the line reads `sent by Maria · billed to …`; ADR
   0013 "Every turn records its payer" specifies `Turn by Maria · billed to …`.
2. `apps/web`: no payer line anywhere (no protocol turn view). ADR 0013 says "the conversation shows
   it"; mend#519 states the gap.
3. `packages/sessions/src/protocol-host.ts:95-99` with `engine.ts:9094-9109`: the payer is the
   launcher's `default` whatever Core injected; when the create fell back to a credential set
   without the harness login, a steered turn still reads `billed to <owner>'s default`.
4. `apps/api/src/slack-runner.ts:1546-1553` and the web `resume`/`launch` routes
   (`workbench.ts:3103-3170`): a steerer's resume or protocol launch relaunches the agent on the
   owner's login, with the steerer's prompt as its first turn. ADR 0016 §5 (designed): the first
   turn's sender's login is written before the agent starts.
5. `apps/api/src/routes/workbench.ts:2940-2967` and `protocol-host.ts:181-215`: turning shared
   control off does not cancel a steerer's turns already queued; they are dispatched on the owner's
   login. Neither ADR says what should happen to them.
6. `apps/api/src/session-steering.ts:73-80`, `workbench.ts:2487-2492`: the owner-only checks are
   against the session's owner. In capture mode a joined session's owner opens shells, runs Services
   and types in their terminal inside the lease holder's executor, on the holder's login (Core
   injects at create for the launcher; `GITHUB_TOKEN`/`GH_TOKEN` container-wide). Breaks the owner's
   rule today; ADR 0016 §3-4 is the fix, not built.
7. `packages/domain/src/workbench/session-control.ts:104-106`: `canToggleSharedControl`'s comment
   says shared control "lends their credentials"; under ADR 0013 it no longer does once the switch
   ships, and on main the docs (`apps/docs/src/content/docs/organizations/overview.md:167-169`) say
   every act spends the owner's logins, which is true until the switch ships.
8. The Core request body differs across documents: ADR 0013 `{ onBehalfOf, claude?, codex? }`,
   sealant#315 `{ ownerUserId, onBehalfOfUserId, claude?, codex? }`, ADR 0016
   `{ onBehalfOf, home, claude?, codex?, github? }` plus `DELETE` and `credentialsHome`. ADR 0016
   says #315 is amended before it merges; until then the target contract is ADR 0016's.
9. ADR 0013 says a steerer's switch "refuses there and says why" in a joined worktree (open
   question 2) until turns serialise per workspace; ADR 0016 closes it with per-process `L`. On main
   there is no switch, so nothing refuses; the joined conversation runs on the holder's login and
   records it.
