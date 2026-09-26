# Mend — Agent Workbench Plan

> **Status:** Canonical product direction  
> **Working name:** Mend; the name may change  
> **Audience:** Product and engineering agents working in the Mend and Sealant repositories  
> **Authority:** Where this document conflicts with the current issue-to-PR product definition,
> queue roadmap, or related planning documents, this document wins. Update or archive the older
> documents rather than attempting to satisfy both directions.  
> **Amended:** 2026-07-25 — execution model decided: repositories are adopted into a Mend-managed
> central store (bare repo + per-session git worktrees) and sessions run in managed Sealant
> workspaces that mount their worktree. No host-bind execution against the user's pre-existing
> checkout. See §8.1.A and the decision log in §17.

## 1. Executive summary

Mend is becoming a **local-first workbench for developers who use coding agents heavily**.

It keeps the three things that are currently scattered across terminals, provider apps,
repositories, notes, and browser tabs in one place:

1. Project context
2. Agent sessions
3. Code changes and their review

It then makes that same workbench available from desktop, web, and mobile, with straightforward
private remote access through an existing network layer such as Tailscale.

The product statement is:

> **Mend keeps project context, coding-agent sessions, and code changes together. It gives
> developers a first-class local review workflow and lets them steer the work from any device.**

Mend is built entirely on the public Sealant SDK. Mend is the opinionated product; Sealant remains
the reusable runtime and evidence platform underneath it.

The shortest description of the relationship is:

> **Sealant records and controls agent work. Mend turns it into a coherent developer workflow.**

This is not an issue-to-PR product. Issues and pull requests may be linked later, but neither is
required to use Mend and neither defines its core object model.

---

## 2. The user problem

The target user is an individual developer who uses coding agents throughout the day: Codex, Claude
Code, OpenCode, custom harnesses, or similar tools.

The recurring problems are:

### 2.1 Context is scattered

Useful context lives in repository instructions, architecture documents, issue trackers, previous
agent conversations, personal notes, external documentation, other repositories, and the developer's
memory. Every new session begins with another round of copying, linking, and re-explaining.

The developer often cannot answer a basic question after the fact:

> What did the agent actually know when it made this change?

### 2.2 Sessions are scattered

Agent sessions live in separate terminals and provider-specific histories. A developer may have
several repositories, machines, branches, and agents active at once. It is difficult to see what is
running, what is waiting for input, what failed, and where a previous line of work stopped.

### 2.3 Local review is weak

Agent-heavy development produces a large amount of uncommitted local work. Review usually happens in
an editor's source-control panel, through raw `git diff`, or only after opening a pull request. None
of these is a strong review workflow for work that is still being shaped locally.

### 2.4 Existing diff tools lack provenance

A normal diff shows what changed. It does not show:

- which agent session introduced the change;
- which prompt or instruction caused it;
- which sources were consulted;
- which commands and checks ran afterwards;
- which parts of the working tree have no clear recorded cause.

Sealant can provide this missing evidence.

### 2.5 Agent work is trapped on one computer

Developers want to check progress, answer a question, approve an action, review a diff, or send
follow-up guidance from a phone or another laptop without turning the product into a cloud IDE.

### 2.6 Remote access is unnecessarily difficult

The user should not need to expose a public port, configure a reverse proxy, or build a custom VPN.
Mend should make an existing private network such as Tailscale easy to use and easy to verify.

### 2.7 The running application is trapped with the workspace

Starting a development server inside an agent workspace is easy; reaching the exact application it
serves from another browser or phone is not. Container ports, forwarding commands, and disposable
preview URLs force the developer to reconstruct which service belongs to which session. The running
application should be another authenticated view of the session, not a separate deployment chore.

---

## 3. Product thesis

The project is the center of the product, not an issue and not a pull request.

```text
Machine
└── Project
    ├── Context
    ├── Agent sessions
    └── Changes
        ├── Local review
        ├── Verification
        └── Optional publication
```

The normal workflow is:

```text
Open or adopt a project
→ choose or reuse context
→ start or resume an existing coding agent
→ work normally
→ review the accumulated local change
→ send review feedback back to the agent
→ commit, verify, or optionally publish a PR
```

Mend must improve this workflow without asking the developer to adopt a new coding agent. The user
keeps the harness they already trust. Mend wraps, records, organizes, reviews, and remotely exposes
that work.

---

## 4. Product principles

### 4.1 The project is the primary object

A project is a repository on a machine. Context, sessions, changes, and reviews all live under it.
Tracker issues and pull requests are references attached to project work, not the identity of the
work.

### 4.2 Bring your own agent

Mend does not become another coding harness. It launches or attaches to Codex, Claude Code,
OpenCode, or an arbitrary command through adapters over the same Sealant primitives.

### 4.3 Local changes are first-class

The user must receive value before creating a commit, issue, or pull request. The session worktree
itself is a reviewable product object.

### 4.4 Evidence is available, but not noisy

A normal diff must remain easy to read. Sealant provenance should appear when the developer asks
“why did this change?” or opens the change overview. Evidence enriches the review; it does not bury
the review in telemetry.

### 4.5 Context is explicit and inspectable

Mend should not begin as an opaque “AI memory” system. Context is composed from explicit items,
collected into versioned packs, and recorded as an immutable session snapshot. Suggestions may
become intelligent later, but the developer must always be able to see and edit what was supplied.

### 4.6 Mobile is for control and review

The mobile experience is not a full IDE. It is for seeing active work, answering agent questions,
sending guidance, reviewing changes, and opening a terminal only when necessary.

### 4.7 Remote access should be boring

Use Tailscale or an equivalent private network. Do not build a custom VPN or require public ingress
for the initial product.

### 4.8 Sealant remains a platform

Mend must use only the public Sealant SDK. Missing capabilities are implemented as general
SDK/runtime capabilities, documented in the platform feedback workstream, and then consumed by Mend
through the public surface.

### 4.9 The product reports; the developer decides

No confidence scores, risk meters, “safe to merge” verdicts, or automatic approval. Show what was
observed, what was inferred, what was not run, and what needs attention.

### 4.10 The running application belongs to the session

A development server runs against one session worktree. Mend should surface it on that session and
make it reachable through the same private, authenticated boundary as the conversation, terminal,
and review. It must not become public by default.

---

## 5. Core product model

The following nouns are the product spine.

### 5.1 Machine

A machine is a developer-controlled computer or devbox running Sealant and Mend. A user may
eventually connect several machines, but the first release may assume one machine per instance.

Examples:

- local Linux desktop;
- MacBook;
- persistent remote devbox;
- home server reached over Tailscale.

### 5.1a Organization and roles

An organization is the tenant (decided 2026-09-17, `docs/adr/0003-organizations-and-tenancy.md`). It
owns its members, projects, folders, reference repositories and audit log. An account belongs to
exactly one organization, as its `owner` or a `member`. Owners invite people with single-use links,
remove them, change roles, decide project visibility and manage folders and references; members work
in the projects they can see. The `operator` is an instance role that administers the machine and
has no default read access to any organization's content. `MEND_TENANCY=single` (the default) runs
one organization and keeps it nearly invisible; `multi` hosts many and stays refused until the multi
mode gate passes.

### 5.2 Project

A project is a repository adopted into Mend's central store on a machine, owned by one organization.
Its name is unique within that organization, and it is `private` (visible to its creator) or
`shared` (visible to the organization). Adoption clones the repository into the store —
`<store>/<project id>/repo.git` bare (older projects keep `<store>/<name>/`), plus one git worktree
per session. The store copy is canonical for Mend; the user's pre-existing checkout, if any, is a
peer that syncs through git, never an execution target.

A project owns:

- context items and context packs;
- agent sessions;
- current repository state;
- changes and reviews;
- optional tracker and GitHub references.

For the first vertical slice, a project may be limited to one Git repository; because each session
gets its own worktree, concurrent sessions are structurally supported from the start.

### 5.3 Context item

A context item is one explicit source of information that may be supplied to an agent.

Supported item kinds should eventually include:

- repository file or directory;
- repository instructions such as `AGENTS.md`;
- Markdown or text document;
- developer note;
- URL;
- issue or pull request;
- previous Mend session or session handoff;
- file or document from another adopted project.

Each item has provenance, an updated timestamp, and a digest or revision identifier.

### 5.4 Context pack

A context pack is a named selection of context items for a recurring kind of work.

Example:

```text
Authentication service
- AGENTS.md
- docs/authentication.md
- docs/legacy-sso.md
- Decision: database sessions remain authoritative
- Handoff: legacy callback investigation
```

Packs are editable, but every session receives an immutable snapshot. The review can later show the
exact snapshot used by that session.

### 5.5 Worktree and session

**The worktree is the durable container** (decided 2026-08-31): a first-class named place in the
project's central store — display name split from its immutable directory — that owns the change,
the checkpoint chain, and their review. Sessions are conversations inside it: many over its life,
several concurrently live, each in its own workspace mounting the same worktree. A worktree with
zero sessions is a legal durable place. Removal is the worktree's own explicit verb, refused while
any conversation is live; deleting a session deletes the conversation record only. Launching with an
existing worktree name JOINS that worktree (a conflicting base is refused, never silently re-based).

A session is one logical supervised coding-agent conversation inside a worktree. At the Sealant
layer, it is backed by one or more coding-agent runs and their durable execution records, exactly
one active at a time. Resuming a settled coding-agent run starts a new run whose sequence space
begins at one; Mend preserves the ordered run membership instead of pretending their sequences are
global.

A session's current Sealant workspace may also contain independently recorded supporting shell and
Service processes. They belong to the session because they can observe or mutate its worktree, but
they are not additional sessions or coding-agent runs. The coding-agent state, workspace state, and
each supporting process state are independent observations. A completed coding-agent run may leave
the workspace retained by a shell or Service. A protocol-mode agent runs as a pipe session whose
live conversation is projected into authored turns, ordered items, and agent-to-human requests. PTY
remains the desktop and CLI default.

Concretely (decided 2026-08-21, amended 2026-08-31, `docs/SESSION-SERVICES.md` "The model"): the
worktree is the place, the session is a conversation against it plus its record, and everything that
interacts is a process of one kind — `shell`, `agent-pty`, `agent-protocol`, `service` — with one
lifecycle. A session holds several agent processes over its life; harness native state is harvested
per agent process. Session status is a fold over live processes: a pending request on a live
protocol agent → `waiting`; any other live agent → `running`; shells or Services only → `idle`;
nothing live → settled from the last agent's outcome.

A session contains or references:

- provider and harness type;
- provider-specific session/thread identifier when available;
- start and end state for each coding-agent run;
- PTY input and output;
- supporting shell and Service processes;
- commands and child processes;
- file changes;
- network and source activity;
- artifacts;
- context snapshot;
- repository state at start and at later checkpoints;
- generated handoff;
- coding-agent status such as running, waiting, idle, completed, failed, or stopped;
- current workspace and supporting-process states.

### 5.6 Change

A change is a reviewable repository comparison. It is not necessarily a pull request or even a
commit.

Supported comparison shapes should include:

- session worktree versus its base (the primary shape);
- staged versus unstaged within a worktree;
- branch versus base;
- commit versus commit;
- a selected set of files or hunks.

A change can be associated with one or more contributing session spans. Each worktree exposes one
change — the worktree against its base (amended 2026-08-31: was one per session while sessions and
worktrees were 1:1) — and every conversation inside the worktree contributes to it. Because every
write in a worktree happens through a supervised workspace, evidence attribution is structural
rather than inferred. Landing a change — merging the worktree branch into the project's default
branch — belongs to publication.

#### Checkpoints and slices (decided 2026-07-25, amended 2026-08-20 and 2026-08-31)

A checkpoint is a cheap snapshot of the worktree: a commit to a hidden ref that never touches the
visible branch. Git carries what changed; run-aware record positions carry what Mend had observed
when the checkpoint was taken. The chain belongs to the worktree — one dense ordinal sequence across
every conversation in it, anchored at ordinal 0 by the worktree-start snapshot (no session attached)
— and any two checkpoints define a reviewable slice. Checkpoints are taken at worktree and session
start, after each settled command the record observes, at turn boundaries where the adapter can mark
them, whenever review opens, and on an explicit user mark.

A session with only a coding-agent run can use the existing `(ref, Sealant run ID, seq)` shape. Once
supporting processes contribute records, the target shape is the hidden ref plus the latest Mend
observed position for every recorded process attempt. Mend labels telemetry gaps and never presents
those positions as an atomic cross-run barrier unless the public SDK supplies one.

A reviewable slice is any two checkpoints. The diff is `refA..refB`; its digest travels with the
checkpoint IDs and anchors comments to that immutable comparison. The evidence beside it is the set
of run-aware record spans between their observed positions. "Review from here to here" is picking
two marks. Per-turn review is the special case where both checkpoints are adapter-marked turn
boundaries; the generic adapter falls back to command-settle and manual marks. Turn metadata is
never treated as stronger evidence than the record (§9.2).

### 5.7 Review comment

A review comment is feedback attached to a file, line, hunk, or the change as a whole. New comments
are anchored to a checkpoint pair and diff digest, not a moving worktree. Comments can remain notes
or be selected for an editable follow-up instruction sent to the same session.

### 5.8 Verification

A verification is a recorded check against a change. It may run in a workspace over the session
worktree or, when independence matters, in a clean clone-based Sealant workspace.

### 5.9 Publication

Publication is optional output from an already useful local workflow. Examples include:

- create a commit;
- create or update a GitHub pull request;
- copy or export a review summary.

Publication is not a prerequisite for context, session management, or local review.

Landing is the first publication ([ADR 0007](docs/adr/0007-landing.md)): the change's owner commits
the change from a checkpoint, pushes its branch to origin fast-forward only, and opens or updates a
GitHub pull request whose description is the review tour. Sessions started from Slack land
automatically after a turn that asked for a change, as Cursor does. `mend pull` fetches a change
into the person's own checkout from a bundle, which settles open decision 8 in that direction.

### 5.10 Slack

A session can start from Slack ([ADR 0006](docs/adr/0006-slack.md)). `@mend <prompt>` in a thread
starts a session owned by the person's linked account, in the project the message, the thread or a
default names. The session reports into that thread (a status, the agent's messages, a review link)
and a later `@mend` there is a follow-up. Review stays in Mend.

---

## 6. Primary user experience

Mend should have five primary surfaces.

### 6.1 Now

The home screen is a sparse attention inbox, not a kanban board.

It should answer:

- What is running?
- What is waiting for me?
- What recently finished?
- Which local changes have not been reviewed?
- Which machine or project is currently unreachable?

Example:

```text
Needs you

Claude Code · newsroom-api
Waiting for approval
“Replace the legacy session validation path”

Ready to review

Codex · sealantd
4 files changed · 2 checks observed

Active

OpenCode · Mend
Running pnpm test
```

### 6.2 Project

The project page brings together:

- current repository and branch state;
- active and recent sessions;
- active local change;
- context packs and recent handoffs;
- optional issue or PR links;
- remote reachability.

The project page is the place from which the user starts or resumes an agent and opens the local
review.

### 6.3 Session

The session page combines:

- the agent conversation or PTY stream;
- current status;
- commands and process milestones;
- files changed;
- context used;
- sources consulted;
- checks and artifacts;
- controls to send input, stop, resume, or open a session-owned supporting terminal;
- explicitly declared Services, their process and forwarding observations, and browser links only
  when HTTP or HTTPS was declared;
- a link to review the resulting change.

The browser or phone may disconnect without terminating the session. Reopening the page resumes from
the last durable sequence.

### 6.4 Review

The review page is the center of the product.

It contains:

1. A concise change overview
2. A first-class diff viewer
3. Inline and change-level comments
4. Optional provenance for files and hunks
5. Actions to send feedback, verify, stage, commit, or publish

The change overview should answer:

```text
What changed
What was exercised
What was not exercised
What needs attention
Which sessions and context contributed
```

The overview is derived from evidence and must link back to that evidence. It is not a merge
verdict.

### 6.5 Context

The context surface lets the user:

- browse and search context items;
- create and edit context packs;
- inspect the exact context snapshot used by a session;
- turn a completed session into a handoff;
- promote an individual decision or discovery from a session into durable project context;
- identify stale or missing items.

---

## 7. Functional requirements

## 7.1 Context management

### Required for the first useful version

- Manually add project files, documents, notes, URLs, and previous handoffs.
- Group items into named context packs.
- Choose a pack when starting a session.
- Persist an immutable context manifest for each session.
- Show the manifest from the session and review pages.
- Generate a session handoff containing:
  - goal;
  - decisions made;
  - files changed;
  - commands and checks run;
  - unresolved questions;
  - suggested next step.
- Allow the user to edit a generated handoff before saving it as context.

### Later

- Semantic search over context.
- Suggestions based on the task prompt and repository area.
- Staleness detection for decisions contradicted by newer context.
- Cross-project context with explicit user selection.
- Import from Linear, Jira, GitHub, Notion, or similar systems.

### Explicitly not required initially

- Fully automatic long-term memory.
- Automatic ingestion of every file and session into a vector store.
- Hidden context selection that the user cannot inspect.

## 7.2 Session management

Mend should initially launch agents through a thin wrapper or adapter:

```bash
mend codex
mend claude
mend opencode
mend run -- <arbitrary command>
```

The wrapper must not change the normal agent experience. It creates a session worktree from the
project's store, starts the process in a managed Sealant workspace that mounts that worktree,
attaches the caller's connected-account credentials and dotfiles (both exist in the SDK today:
`credentials: { profile, claude, codex, github }` and `dotfilesSelection`), associates the session
with the selected context snapshot, and makes it remotely attachable.

Required behavior:

- Start a PTY-backed process in a workspace mounting the session worktree.
- Stream output live.
- Send input and resize the terminal.
- Detach and reattach without terminating the process.
- Recover after the web client or mobile client disconnects.
- Persist a searchable durable record.
- Surface running, waiting, idle, completed, failed, and stopped states.
- Associate file changes and repository checkpoints with the session timeline.
- Record provider-specific session IDs when available.
- Allow a follow-up review bundle to be sent to the same session.
- Provide a generic command adapter first; provider-specific adapters may add richer turn, approval,
  and resume semantics.

A session started outside Mend cannot be assumed to have complete evidence. Importing external
session history may be supported later, but the first version should be honest about the boundary:
complete records begin when the process is launched or attached through Sealant.

### PTY-first, reaffirmed (decided 2026-08-09)

Examined against t3code, which drives every harness over a structured protocol (agent SDK,
`codex app-server` JSON-RPC, ACP) and reserves the PTY for a user shell. Mend deliberately stays
PTY-first: the unmodified interactive harness in a recorded PTY is the product identity — any agent
works, and the recorded TUI session is the evidence trail. Consequences accepted: composer sends to
a TUI must keep the body and the Enter keypress as separate PTY writes (a combined write trips
harness paste-burst heuristics), and richer turn/approval/resume semantics stay where §7.2 already
places them — optional provider-specific adapters layered on top, never a replacement for the PTY
path.

## 7.3 Local review and diff

The diff viewer must be good enough to use instead of opening a pull request solely for review.

### P0 diff capabilities

- File tree grouped by status.
- Change statistics.
- Unified view.
- Side-by-side view on sufficiently wide screens.
- Syntax highlighting.
- Collapsible unchanged regions.
- Keyboard navigation between files and hunks.
- Whitespace controls.
- Binary-file and generated-file handling.
- Line selection and inline comments.
- Change-level comments.
- Stable anchors as the working tree changes where possible.
- Session worktree versus its base.
- Branch versus configured base.

### P1 diff capabilities

- Staged versus unstaged views.
- Stage or unstage file and hunk.
- Discard with explicit confirmation.
- Commit creation.
- Image and snapshot diffs.
- Review history across checkpoints.

### Sealant-enhanced provenance

From a file or hunk, the user should be able to ask “Why did this change?” and see:

- contributing session or sessions;
- relevant prompt or instruction span when known;
- file-write and command events around the change;
- sources consulted during that span;
- checks run afterwards;
- context snapshot used;
- whether attribution is direct, inferred, or unknown.

Provenance must not be presented with false precision. File-event timing can establish that a
session touched a file; it may not always prove that one exact model turn caused one exact line. The
UI must label inference honestly.

### Review-to-agent loop

The critical closed loop is:

```text
Review local diff
→ leave inline comments
→ select “Send review to agent”
→ Mend creates a structured follow-up instruction
→ the same session resumes
→ the diff updates
→ comments are marked addressed or remain open
```

The user should be able to choose the comments included and inspect and edit the generated
instruction before sending it. Delivery is complete only after Sealant accepts the new PTY process
for that exact instruction and Mend persists the new run membership and delivery correlation.
Retries use an idempotency key and must not start a second run. The first implementation relaunches
settled coding-agent sessions; sending review input to a live TUI remains a separate later action.

### Mend reads the change (decided 2026-07-25)

Mend performs a machine review pass over a settled change — "Mend read this change" in the UI; per
the language contract this feature has no product noun ("Mend uses inference"). It is what a
diff-only reviewer cannot be, because it reads the record, not just the patch:

- **Inputs:** the diff, the instruction that opened the span, the context snapshot, what the session
  read and did not read, what ran and did not run, and the checkpoint timeline.
- **Output is draft review comments, dispositions, and proposed checks — never verdicts.** Findings
  land as pre-drafted comments the user accepts, edits, or dismisses; accepted findings join the
  user's own comments and flow through the same review-to-agent loop. Dispositions use the existing
  vocabulary (observed / never ran / unexplained). No scores, no "LGTM", no approval.
- **Finding classes unique to the record:** instruction-versus-diff divergence ("the instruction
  said keep the cookie contract; maxAge changed"); diff-versus-evidence gaps ("this function was
  rewritten but no test exercising it ran"); context-versus-behavior gaps ("the invariant's doc was
  in the pack and never read"); unexplained edits.
- **It has hands:** instead of speculating, a finding may ship as a proposed verification — one
  click runs the check in a clean clone-based workspace and converts an amber "never ran" into an
  observed fact with a sequence number. (Full teeth arrive with M5's verification runs.)
- **The evidential noise filter (hard rule):** every emitted finding must either link to the record
  or ship with the runnable check that would test it. A finding that can cite neither is not
  emitted. This is the guard against nitpick spam.
- **Trigger:** on-demand first ("Read this change"); auto-on-settle as an opt-in setting later. The
  human review loop must never be gated on the machine pass.
- Machine findings also feed the tour's stop ordering.

This deliberately revives the strongest piece of the previous direction — the brief compiler, review
questions, and causal-proof verification built in the queue-era M2/M4 — inside the workbench review
surface (§10).

## 7.4 Mobile access

The initial implementation may be a responsive, installable PWA using the same API as desktop. A
native application can follow once the workflow is proven.

The mobile experience must support:

- the Now inbox;
- project status;
- active and recent sessions;
- live session output;
- send a message or answer a question;
- approve or reject an explicit action when the harness exposes one;
- stop or resume a session;
- review changed files;
- readable unified diffs;
- inline and change-level comments;
- send review feedback to the agent;
- browse context and session handoffs;
- adopt a repository into the store — pick from the host GitHub CLI's repositories or type a source
  (added 2026-08-02, see §17);
- open a terminal as an escape hatch.

The mobile product is not required to support full code editing, project-wide navigation, or every
desktop diff control.

## 7.5 Remote access

_Rewritten 2026-09-17 ([ADR 0004](docs/adr/0004-access-without-a-private-network.md)). The first
version of this section assumed a tailnet: bind to private interfaces, show the tailnet address,
require no public inbound port. The network was the perimeter. It no longer has to be._

Mend is its own authenticated front door. A person reaches it at one HTTPS origin from any device;
the web tier serves the app and proxies the API, the event stream and every WebSocket on that
origin. Mend authenticates and authorizes every request itself, so a private network in front of it
(a tailnet, a VPN, a LAN) is a choice an operator makes, not something the product needs.

Mend:

- binds to localhost by default, and is reached beyond the machine only through an edge that
  terminates TLS for the exact browser origin;
- lets the operator declare how the instance is reached (`loopback`, `private`, `public`) and
  reports what it observes beside that. It never says "reachable" and never says "safe": a server
  cannot observe what is published in front of it;
- refuses to start as `public` while an item of the public exposure gate it can observe is open, and
  reports the items it cannot observe, an independent reassessment among them, as open until the
  operator records them;
- provides a simple pairing flow for another browser or phone, and issues scoped, revocable device
  tokens;
- never puts a long-lived credential in a URL: sockets and the terminal embed take single-use,
  thirty-second upgrade tickets;
- bounds what one client, one account and one organization may ask of it, refusing new work and
  never stopping work that is running;
- keeps everything behind it private: Sealant, its registry, the database, the bucket and raw
  service ports get no exposure of their own.

A QR code may carry the instance address plus a short-lived pairing token. It must not contain a
permanent administrator credential.

Tailscale, Headscale or another private network remains a good way to run a `private` instance, and
the docs say how. None is necessary to use the product.

## 7.6 Session development services

Mend treats a development server as a session capability, not a deployment. A Service is created by
an explicit recipe or user action. A future typed listener event from the public Sealant SDK may
produce a factual declaration suggestion, but it never creates or exposes a Service automatically.
Mend does not inspect container internals to discover listeners.

The first useful version should:

- associate each Service with the visible session and worktree it serves;
- keep the stable Service, each supervised process attempt, the host forward, and target
  reachability as separate facts;
- preserve every attempt's Sealant run pointer, output, exit, and timestamps across restart;
- distinguish `tcp | udp` transport from an optional `http | https` browser scheme;
- show Open only for a declared browser scheme and Copy endpoint for other transports;
- preserve normal browser behavior, including WebSockets and hot reload, through a raw per-port byte
  forward;
- let the user inspect and control the same Service from desktop or phone;
- require no public port and never publish or autostart a Service by default.

Raw forwarded ports have no Mend request authentication. They bind to loopback and explicitly
selected private interfaces; a private network is the access boundary for them, and on an instance
declared `public` they stay on loopback and are reached through the authenticated tunnel. The UI
states this beside private-interface exposure. Mend must consume forwarding and any future listener
observations only through the public Sealant SDK.

---

## 8. Sealant platform boundary

Sealant remains the generic runtime and SDK. Mend remains the end-user workbench.

| Sealant owns                                      | Mend owns                                 |
| ------------------------------------------------- | ----------------------------------------- |
| Workspaces or host attachments                    | Projects                                  |
| Runs and process supervision                      | Agent sessions                            |
| PTYs and stream resumption                        | Session inbox and controls                |
| Durable execution records                         | Searchable session history                |
| Process, filesystem, network, and artifact events | Contextual presentation and provenance UX |
| Git/repository observation primitives             | Changes and local review workflow         |
| SSH or remote terminal access                     | Pairing and remote-access setup UX        |
| Public SDK contracts                              | Opinionated product behavior              |
| Connected account references                      | Context packs and agent adapters          |

Mend must never depend on private database access or private runtime hooks in Sealant.

## 8.1 Capabilities Mend needs from Sealant

Some may already exist partially. Agents must audit the current SDK before implementing duplicates.

### A. Store-sourced workspace mounts (decided 2026-07-25)

Earlier drafts asked for an "attached execution mode" that supervises work directly in the user's
existing checkout on the host. That approach is rejected: Mend never executes agents against a path
it does not own. Instead, repositories live in a Mend-managed central store on the machine (bare
repo plus one git worktree per session), and sessions run in ordinary managed Sealant workspaces
that mount their session worktree.

What Sealant needs is therefore smaller and more generic than host attachment:

- create a workspace whose repository comes from a caller-provided mount instead of a fresh clone —
  for example `workspaces.create({ mounts: [{ path, source }] })` where `source` is a host directory
  the caller owns;
- writes to the mount persist after the workspace stops or is deleted;
- the same record, exec, and control semantics as clone-based workspaces;
- never reprovision or delete the mounted source.

This keeps every session write inside a supervised environment (evidence attribution becomes
structural rather than temporal), solves concurrent sessions by construction (one worktree each),
and reuses the existing workspace noun — no new primitive. Clone-based managed workspaces remain the
right shape for independent verification.

### B. Interactive session lifecycle

The SDK should provide stable operations for:

- start a PTY-backed process;
- attach and detach clients;
- stream from a durable sequence;
- send input;
- resize;
- stop or signal;
- report lifecycle and waiting states;
- reconnect after client or product restart;
- associate external provider session identifiers.

### C. Context manifest

Sealant does not need to become a semantic memory product. It needs a generic provenance-preserving
input manifest associated with a run.

Illustrative shape:

```ts
{
  manifestId: "auth-service@12",
  items: [
    { kind: "file", ref: "AGENTS.md", digest: "..." },
    { kind: "document", ref: "docs/authentication.md", digest: "..." },
    { kind: "session-handoff", ref: "handoff_01J...", digest: "..." }
  ]
}
```

Mend owns selection and presentation. Sealant records the immutable manifest attached to the
execution.

### D. Git and change snapshots

The public SDK needs stable access to machine facts such as:

- repository root;
- branch and base reference;
- start SHA;
- working-tree status;
- staged state;
- commits created during a session;
- diffs between checkpoints;
- current diff;
- file renames and binary changes.

Git is the source of truth for repository comparisons. Filesystem events provide temporal provenance
but should not replace git diff semantics.

### E. Correlation metadata

Records should be able to carry product-provided correlation metadata, including:

- project ID;
- session ID;
- provider and harness;
- provider thread or turn ID;
- context manifest ID;
- change/checkpoint ID;
- review-follow-up ID.

This metadata allows Mend to connect high-level user actions to low-level evidence without changing
the generic event model.

### F. Safe remote control

The SDK and gateway must support scoped access to:

- read a session stream;
- send session input;
- stop or signal a session;
- open a terminal;
- read project and change data.

Mend owns user-facing pairing and authorization. Sealant owns enforcement primitives.

### G. Multiple workspace mounts with read-only support (decided 2026-08-01)

§8.1.A originally specified a plural mount surface (`mounts: [{ path, source }]`); the shipped SDK
is singular (`source: { kind: "mount", path }`) — exactly one host path, always read-write, at the
working directory. Two decided features need the plural shape back, plus one addition:

- accept additional mounts beyond the primary source, each with its own container path outside the
  working directory — e.g. `mounts: [{ hostPath, mountPath, readOnly }]`;
- support `readOnly` per mount (the docker adapter currently never emits `:ro`); read-only is what
  makes one shared host directory safely mountable into many concurrent workspaces;
- extend the mount allowlist policy to cover the additional roots;
- record the full mount set on the workspace so the session manifest can state what the agent could
  see.

Consumers: per-project extra mounts and reference clones (§17, decided 2026-08-01). The primary
source mount semantics of §8.1.A are unchanged.

### H. Workspace port reachability (decided 2026-08-01)

A dev server started inside a workspace container must be reachable by a browser on the host and on
paired devices over the private network. Workspace containers run on the default bridge with no
published ports, and the daemon already has the right primitive — `openForward`/`closeForward`
(direct-tcpip from inside the container, raw byte conduit) — but its only consumer is the SSH
gateway; neither the Core API nor the SDK exposes it.

- expose the forward as a public SDK surface — e.g. `workspace.forward(port)` returning a duplex
  byte stream Mend can terminate on a host listener;
- optionally: have sealantd observe listening sockets inside the container (it is PID 1) and emit a
  typed record event when a port starts or stops listening, so ports are discovered by observation
  rather than agent cooperation;
- record that a forward was opened (an event, not the bytes) so the session record stays honest
  about reachability.

Mend owns the host listener, its binding policy (localhost plus explicitly selected private
interfaces, per §7.5), and the preview UX.

---

## 9. Architecture direction

Preserve the current repository stack unless a deliberate migration is approved. The product can
continue as a self-hosted web application with an API, background work, and durable product state.

### 9.1 Data ownership

- Mend stores product state: machines, projects, context items, context packs, context snapshots,
  sessions, changes, comments, handoffs, pairings, and publication references.
- Sealant stores raw execution records and exposes them through the public SDK.
- Mend stores stable evidence pointers and small denormalized excerpts required to render durable
  review artifacts.
- The central store (bare repo plus session worktrees per project) lives on the user's machine and
  is owned by Mend; workspaces mount worktrees from it and never own repository state.
- Git remains the source of truth for the actual change.

### 9.2 Agent adapters

Adapters should be narrow.

A generic command adapter provides the base capability. Provider-specific adapters may add:

- thread IDs;
- structured waiting or approval states;
- resume flags;
- turn boundaries;
- richer message extraction;
- provider-specific context injection.

Provider-specific metadata is helpful but must never be treated as stronger evidence than the
Sealant record.

### 9.3 Inference

Mend may use inference to:

- generate a session handoff;
- summarize a change;
- read a settled change and draft evidence-linked review findings (§7.3);
- assemble review comments into a follow-up instruction;
- suggest relevant context;
- explain a recorded milestone;
- order the review tour's stops.

All inference must run through the user's connected accounts exposed by Sealant. Mend ships no
hosted model and no hidden model keys.

Generated text is derivative. Claims in a change overview or handoff must either link to evidence or
be labeled as inferred.

### 9.4 Mobile transport

Desktop web and mobile web should use the same contract-first API. Live updates should be resumable
and proxy-friendly. SSE is acceptable for read streams; interactive terminal input may use
WebSockets or another bidirectional transport. The transport decision must preserve durable
sequence-based reconnection.

---

## 10. What to preserve from the current Mend implementation

The previous product direction produced several valuable capabilities. Reuse them rather than
starting over.

| Existing capability             | New role                                               |
| ------------------------------- | ------------------------------------------------------ |
| The brief compiler              | Change overview                                        |
| Evidence pointers               | Links from review claims and hunks to session evidence |
| Run audit                       | Session detail and execution timeline                  |
| Source trail                    | “Context and sources used”                             |
| Review questions                | Optional review checklist and attention items          |
| Reviewer comments               | Local review comments and follow-up guidance           |
| Brief versions                  | Change-overview and review history                     |
| Verification runs               | Clean or targeted verification                         |
| Evidence freshness              | Repository/checkpoint freshness                        |
| Evidence Review design language | Shared visual language for sessions and local review   |

The following concepts should no longer be central:

- triage and drag-and-drop issue queues;
- one harness per issue;
- one issue equals one branch and one change;
- issue intake as the product identity;
- approve-in-Mend as the primary merge workflow;
- a mobile kanban board;
- automatic issue-to-PR orchestration.

Do not delete reusable code merely because its original page is no longer central. First extract the
useful domain and UI pieces into the new project/session/change model.

---

## 11. MVP

The MVP is deliberately narrow:

- one self-hosted instance;
- one user;
- one machine;
- one Git repository per project, adopted into the central store;
- one change per session (worktree versus base);
- generic command adapter validated with Codex and Claude Code;
- manually assembled context packs;
- responsive web/PWA rather than a native mobile application;
- Tailscale-assisted private access;
- no issue tracker required;
- no pull request required.

## 11.1 MVP vertical slice

A complete vertical slice must allow a developer to:

1. Adopt an existing Git repository into the store (from a local path or a remote).
2. Create or choose a small context pack.
3. Start Codex, Claude Code, or an arbitrary PTY command through Mend.
4. Close the browser and reconnect without losing the session.
5. See the session from the Now and project pages.
6. Open a proper diff of the session worktree against its base.
7. Select a changed file or hunk and inspect the associated session evidence.
8. Leave inline review comments.
9. Send those comments back to the same agent as an editable follow-up instruction.
10. Watch the session resume and the diff update.
11. Open the same project, session, and review from a phone over Tailscale.
12. Open a development server running in the session from that phone without publishing it.

## 11.2 MVP exit test

The MVP is complete when the following can be demonstrated on a real repository, not fixtures:

```text
On a desktop, adopt a repository and launch an agent in its session worktree.
The agent changes code and runs a check.
Disconnect the browser.
Reconnect from a phone over Tailscale.
Inspect the live or completed session.
Open the development server attached to that session.
Review the local diff and leave an inline comment.
Send the review back to the same agent.
Observe the agent update the code.
Return to the diff and see the new repository state plus the linked session evidence.
```

No issue and no pull request may be used to satisfy the demonstration.

---

## 12. Milestones and build order

## M0 — Direction reset

Purpose: make the repository unambiguous before adding more product code.

Work:

- Add this document to the repository.
- Mark conflicting issue-to-PR documents as superseded or archive them.
- Stop work on queue, tracker-first, and merge-centric roadmap items.
- Inventory current code under four categories:
  - reuse unchanged;
  - reframe;
  - extract;
  - retire later.
- Create a platform gap list against the public Sealant SDK.
- Define schemas for Project, ContextItem, ContextPack, ContextSnapshot, Session, Change,
  ReviewComment, and MachinePairing.

Exit test:

> A new engineering agent can read the repository and identify one canonical product direction, one
> object model, and the first vertical slice without reconciling contradictory plans.

## M1 — Adopted project and durable session

Purpose: make one real agent session visible and resumable through Mend.

Work:

- Implement the store-sourced mount primitive in Sealant (workspace created over a mounted worktree,
  §8.1.A).
- Build the central store service (bare clone plus per-session worktrees).
- Add the generic PTY command adapter.
- Adopt an existing Git project into the store.
- Start, stream, detach, and reattach a session.
- Persist session metadata and evidence pointers.
- Build the Now, project, and basic session pages.
- Record a minimal context manifest when the session starts.

Exit test:

> Start an agent in a session worktree of an adopted repository, close the browser, reopen it, and
> continue watching or controlling the same process with its complete record intact.

## M2 — Local change review

Purpose: make Mend useful even if the user never creates a PR.

Work:

- Build a git-backed change service over the store.
- Implement session-worktree-versus-base and branch-versus-base comparisons.
- Build the file tree, unified diff, and side-by-side diff.
- Add inline and change-level comments.
- Add change overview compilation from git facts and recorded evidence.
- Link files and best-effort hunks to contributing session spans.
- Add “Send review to agent.”

Exit test:

> Review an agent's uncommitted local change, comment on it, send the review back to the same
> session, and see the updated diff without opening GitHub.

## M2.5 — Mend reads the change

Purpose: a machine review pass that a diff-only reviewer cannot match, grounded in the record (§7.3
"Mend reads the change").

Work:

- Reuse the queue-era brief compiler as the finding generator over diff + record.
- Emit draft review comments with dispositions and evidence links; accept/edit/dismiss flows into
  the existing comment and follow-up pipeline.
- Enforce the evidential noise filter: no finding without a record link or a runnable check.
- Surface proposed checks as one-click verifications (attached-worktree first; clean-workspace
  verification lands with M5).
- Feed machine findings into tour stop ordering.
- On-demand trigger; auto-on-settle behind a setting.

Exit test:

> On a settled real change, "Read this change" produces at least one finding a diff-only reviewer
> could not (instruction divergence, unexercised rewrite, or unread-context gap), every finding
> links to evidence or a runnable check, and accepting one sends it through the normal
> review-to-agent loop.

## M3 — Context and handoffs

Purpose: remove repeated context reconstruction between sessions and agents.

Work:

- Build the context library.
- Build named context packs.
- Snapshot the exact context used by each session.
- Generate editable session handoffs.
- Promote session decisions and discoveries into durable context.
- Search context and previous handoffs.

Exit test:

> Finish a Claude Code session, save its handoff, start a Codex session with that handoff in a
> context pack, and later inspect exactly what the Codex session received.

## M4 — Mobile and private remote access

Purpose: make active work steerable away from the primary computer.

Work:

- Make Now, project, session, review, and context surfaces responsive.
- Ship an installable PWA.
- Add Tailscale detection and reachability checks.
- Add scoped device pairing and revocation.
- Support remote session input and terminal access.
- Surface session Services through raw per-port forwards on loopback and explicitly selected private
  interfaces, with the lack of Mend request authentication stated in the UI.
- Optimize the unified diff and review comments for touch.

Exit test:

> Pair a phone over Tailscale, answer an agent question, open the session's development server,
> review a changed file, and send a review comment without exposing the instance publicly.

## M5 — Verification and optional publication

Purpose: add independent proof and connect the local workflow to external collaboration.

Work:

- Run selected verification commands in worktree-mounted or clean clone-based workspaces.
- Show observed, verified, not executed, and unknown states without verdicts.
- Add commit creation.
- Add optional GitHub PR creation or attachment.
- Export the change overview into the PR while retaining deep links to Mend.

Exit test:

> Review and verify a local change first, then publish it to GitHub without losing its session,
> context, or evidence history.

---

## 13. Parallel workstreams

The project can progress in parallel, provided each track works against explicit contracts.

### Sealant core and SDK

- store-sourced workspace mounts (persistent volumes);
- interactive PTY lifecycle;
- durable resume semantics;
- git snapshots;
- correlation metadata;
- scoped remote-control capabilities.

### Mend domain and API

- project/session/change schemas;
- context manifests and packs;
- evidence pointer mapping;
- review comments and follow-up bundles;
- pairing and device authorization.

### Mend web UI

- Now inbox;
- project and session pages;
- diff viewer;
- provenance drawer;
- context library;
- responsive mobile layout.

### Dogfooding and fixtures

- run real Codex and Claude Code sessions in the Mend and Sealant repositories;
- maintain deterministic recorded fixtures for UI and API tests;
- capture platform gaps found through real use;
- do not accept fixture-only milestone completion.

---

## 14. Non-goals

The following are out of scope until the core workflow is proven:

- autonomous issue selection;
- a backlog or kanban queue;
- issue-to-PR orchestration;
- multi-agent swarms;
- a Mend-native coding model or agent;
- automatic merge decisions;
- confidence or risk scores;
- enterprise policy and team governance;
- hosted code execution;
- public internet ingress by default;
- a custom VPN;
- a full mobile IDE;
- invisible automatic long-term memory;
- cross-repository atomic changes;
- replacing GitHub, Linear, Jira, editors, or terminals.

---

## 15. Security and privacy requirements

Adopted repositories and credentialed workspaces contain valuable source code and real identities.
Security is part of the product contract.

- Self-hosted and local-first by default.
- No product telemetry or code upload without explicit user configuration.
- Do not record secret values. Record credential references and granted scopes where possible.
- Apply Sealant redaction to terminal, environment, network, and artifact data.
- Store device and integration secrets encrypted.
- Pairing tokens are short-lived; device tokens are scoped and revocable.
- Bind to loopback by default. Private-network exposure is explicit and visible.
- Destructive git actions require explicit confirmation.
- Remote session input and terminal access require stronger scopes than read-only review.
- Every remote control action is audited.
- The UI must clearly identify when evidence is incomplete because a process ran outside Sealant
  supervision or telemetry was lost.

---

## 16. UX and design rules

Continue using the Evidence Review design language, with the following product-specific rules.

### 16.1 Evidence beside the claim

A change summary, review question, or provenance statement links directly to the session event, git
fact, context item, or verification record behind it.

### 16.2 The diff remains primary

Do not surround the diff with dashboard chrome. The ordinary review experience must remain fast even
when the user never opens provenance.

### 16.3 Provenance is progressive disclosure

The default view says what changed. A drawer or secondary pane answers why, when, and from which
session.

### 16.4 Status language is factual

Use terms such as:

- running;
- waiting;
- completed;
- failed;
- observed;
- verified in clean workspace;
- not executed;
- attribution unknown;
- context snapshot stale.

Do not use terms such as:

- safe to merge;
- low risk;
- high confidence;
- agent score;
- trusted change.

### 16.5 Desktop is keyboard-first; mobile is touch-first

The desktop review needs strong keyboard navigation. Mobile needs readable unified diffs, large
comment targets, and a minimal set of consequential actions.

### 16.6 Avoid vanity dashboards

Do not add token counts, lines generated, agent productivity scores, or fleet metrics merely because
the data exists. Surface information only when it helps the developer continue, review, or
understand the work.

---

## 17. Open decisions

### Decided

- **2026-09-17: organizations are the tenant.** One organization per account, owners and members, an
  operator role with no default read access, private and shared projects, owner-only steering with
  opt-in shared control, invitation-only registration, and `MEND_TENANCY=single|multi` with `multi`
  refused until the isolation gate passes. Details and the delivery stack:
  [ADR 0003](docs/adr/0003-organizations-and-tenancy.md).

- **2026-09-05: CLI-installed, two-container server.** Installing Mend installs only the CLI;
  `mend server setup` creates one application container containing Mend and its pinned Sealant
  services, plus a separate official Postgres container with separate databases and users. Setup
  manages named-volume storage, exact public origins, and persistent secrets/SSH identity. Users
  select only a Mend version. Adoption accepts Git URLs, replacing earlier local-path adoption.
  Remote-SSH uses per-server configuration and the client's Mend hostname by default. macOS and
  installed VS Code acceptance are release gates. Details and implementation sequence:
  [Packaging plan](docs/archive/PACKAGING-PLAN.md).

- **2026-08-28: externally-run agents are observed process rows.** An agent the user runs by hand —
  in a mend shell, an SSH session, an editor terminal — writes through the mounted harness home, and
  that makes it observable server-side: fresh transcript writes become an `agent-external` process
  row ("claude (observed)"), the session fold reads `running`, the workspace lease holds, and the
  settle harvest captures the conversation like any engine-launched agent's. Mend observes; it does
  not own the process — it cannot steer or stop it, and the row ends when the writes go quiet (five
  minutes). Quiet is an inference, not an exit: ending an observed row never sweeps the workspace (a
  user reading output writes nothing, and reaping on quiet would kill an agent between turns — the
  platform TTL stays the backstop), and the next write revives the session with a fresh observed
  row, including a quiet-settled session whose workspace pointer survives (revival requires writes
  that postdate the settle). While an engine-launched agent is live, transcript writes are presumed
  to be its; observation fills only the blind spot. This is what makes opening the workspace from an
  editor (VS Code over SSH) a normal workflow: run the agent by hand, keep the workbench's status,
  record, and resume.

- **2026-08-28: harness state is durable by construction — the mounted harness home.** Every session
  owns a store-backed `harness-home/` directory (beside its harvested captures), mounted read-write
  into each of its workspaces at `/workspace/harness-home`; boot moves whatever `$HOME` holds into
  it and symlinks each harness's state dirs (`.claude`, `.codex`, `.local/share/opencode`) onto the
  mount, so every transcript/todo/skill write lands on the store the moment the harness makes it.
  Harvest-at-settle stays as the immutable per-process evidence capture (now dereferencing the
  symlinks), but it is no longer the only copy: a workspace that dies without settling loses
  nothing, and a relaunch commits a capture straight from the live harness home ("Saved harness
  state is missing" becomes a working native resume). An archive restore runs only when no live
  state exists (legacy sessions). Decided after an OOM-killed workspace pod took two sessions'
  conversations with it — the container writable layer was the sole copy. The mounted home is also
  the server-side seam for managing what a harness sees in `$HOME` (skills management writes into
  `harness-home/.claude/skills` with no workspace exec). Trade-off accepted: harness-written
  credential files land on the store volume, which already holds the repo and Mend's keys.

- **2026-08-26: deployment strategies are named compositions; the session workspace authority is
  identity-keyed.** The co-located store ("Mend and the workspace see the same POSIX worktree") is
  an implementation technique of the `local` and `kubernetes` strategies, not the product invariant.
  The invariant is: every session has one authoritative mutable workspace, and
  checkpoints/diffs/evidence are ordered against it. The engine reaches that authority through the
  `SessionRepository` port (identity-keyed; co-location is the explicit `worktreeMount` capability),
  and each deployment strategy is a named, tested bundle — `local`, `kubernetes`, and a
  `cloudflare-hosted` strategy sequenced in two tiers (hosted workspaces first, Workers-native
  control plane later). Design: `docs/DEPLOYMENT-STRATEGIES.md`; the Sealant half is the cloudflare
  runtime adapter + bridge Worker series.

- **2026-08-31: mode handoff — cross-mode pickup with native fidelity.** A session started as a PTY
  can be picked up from the phone in full structured mode, and a phone-driven protocol session can
  be reopened as a TUI — one live agent process at a time, the provider session id the durable
  identity (`POST /sessions/:id/handoff {to}`). Fidelity comes from the harness's own record: the
  takeover harvests synchronously, PTY-era history backfills into the durable conversation from the
  native transcript through the SAME item mapping the live adapter uses (real `msg_`/`toolu_` ids,
  raw blocks in `item.data` — never an inferred rendering), and the reverse direction is a native
  `claude --resume` / `codex resume` whose scrollback holds the phone-authored turns. The
  per-session native-ingest cursor (advanced at backfill and at every protocol harvest) is what
  keeps a second pickup from duplicating protocol-era turns. Reading stays instant and read-only on
  open; the composer is the pickup. PTY-first stands: the handoff is provider-specific machinery
  layered on top, claude and codex only, and every other harness refuses with a clear message.

- **2026-08-31: protocol process restart policy v2 — rehydrate in place.** The pipe process survives
  a Mend restart (its stdio terminates at the platform daemon), so boot re-attaches a fresh adapter
  to the surviving pipe on the SAME `session_processes` row and replays the recorded output from 0
  to rebuild correlation state: claude's client-minted turn ids come back from the durable turn rows
  as an ordered replay queue; codex skips the handshake, seeds the durable thread id, and
  epoch-scopes new JSON-RPC ids so stale replayed responses can never resolve a new call. Requests
  already resolved before the restart are skipped during replay; responses caught mid-delivery reset
  `sending → failed`; a turn dispatched but never acknowledged fails honestly. Dispatch stays gated
  until replay passes the probe-time high water. When the pipe is beyond reach the boot watcher
  settles the row; when the adapter cannot rehydrate, the row ends and a fresh pipe relaunches by
  provider id with queued turns following it. "Mend restarted" is no longer a session-failing
  verdict.

- **2026-08-21: protocol process restart policy v1 (superseded by v2 above).** Protocol adapters own
  pending provider calls in memory. On Mend boot, live `agent-protocol` rows are ended instead of
  reconstructing adapter state from the Sealant journal. An explicit resume starts a fresh pipe
  process and uses the harvested provider id (`thread/resume` or `claude --resume`). Provider-keyed
  item upserts preserve item identity and sequence if native events replay.

- **2026-08-20: desktop shells belong to visible sessions; hidden benches are retired.** A writable
  supporting shell runs in the focused coding-agent session's current workspace and contributes to
  that session's change. If only a project is focused, the shell shortcut opens the session launcher
  instead of creating hidden work. Shell tab close confirms and stops the process group; an explicit
  Detach tab action leaves it running. A completed coding-agent run may leave its workspace retained
  by shells or Services. Resume reuses that retained workspace and preserves those processes; a
  separate stop-retained-work-and-resume-fresh action names what it will end. Hot workspaces remain
  prepared capacity for new visible sessions only.

- **2026-08-20: Review is pinned to a checkpoint pair and diff digest.** Opening Review is an
  idempotent command that creates or reuses the To checkpoint. The diff, comments, evidence, and
  machine passes read the same immutable comparison. A later worktree edit marks the snapshot stale
  but never mutates it silently. New comments carry slice-bound anchors, including side and range.
  Legacy moving-diff comments stay readable and are labeled as such.

- **2026-08-20: follow-up delivery is server-owned and recoverable.** The reviewer selects comments
  and edits the instruction. Mend stores the selected comment IDs, checkpoint pair, digest,
  instruction, and idempotency key before launch. Delivery completes only when the new PTY accepts
  the instruction and Mend persists the run membership and correlation. Failed and interrupted
  delivery remains retryable; selected comments are not marked sent early.

- **2026-08-20: Services are explicit, session-owned, and privately forwarded.** Recipes and user
  actions create Services; future public listener events may suggest declarations but never create
  them. Raw TCP or UDP forwards have no Mend request authentication and bind only to loopback or
  explicitly selected private interfaces by default. Browser Open requires a separately declared
  HTTP or HTTPS scheme. Services never autostart. A stable Service retains immutable process-attempt
  history, forwards, and timestamped target observations. Any live agent, shell, Service attempt, or
  selected open forward renews its ordinary workspace's 12-hour TTL on a separate 10-minute
  heartbeat from the hot pool. Mend persists the platform-returned expiry; a failure preserves the
  last successful renewal and known expiry while recording when and why renewal failed.

- **2026-08-20 — Hot sessions: a per-project pool of pre-provisioned workspaces.** Each project
  carries a `hotSessions` count (default 0, the setup page's stepper): Mend keeps that many complete
  session skeletons ready — a pre-generated session id, its worktree and branch, its session socket
  dir, and a live workspace mounting them — so a new session claims one at provision and the launch
  skips straight to opening the PTY. The skeleton must be complete because the platform fixes every
  create-time input (mount path, mounts, env, secrets, dotfiles, image, credentials) at
  `workspaces.create` with no mutation API; a fingerprint over those resolved inputs gates claims,
  and the engine drains-and-rewarms the pool when any of them change (settings handlers trigger it;
  a 10-minute heartbeat re-arms workspace TTLs and heals the rest). The worktree is a bind mount, so
  the claim freshens it to the requested base host-side and the running container sees the reset
  immediately. Skeletons launch with the shell shape — every harness CLI baked, all connected
  accounts attached — so one pool serves every supported coding harness. Supporting shells and
  Services reuse a claimed session workspace and never claim another pool entry. A resume is cold
  when no retained workspace exists because its worktree path is fixed; a session retained by live
  leases resumes in place. Status stays observational: "2 ready · 1 warming", never a promise.

- **2026-08-22 — Mend owns the people; Sealant owns the resources.** Every Mend user ran as one
  Sealant user (`SEALANT_OWNER_USER_ID`): one set of connected accounts for the whole team, which
  shares subscriptions against the providers' terms, and every platform resource owned by one id.
  Decided: Mend is the only login. Mend authenticates to Sealant as a service principal
  (`SEALANT_SERVICE_KEY`) and acts on behalf of each signed-in user under a Sealant user it
  provisions on first use (idempotent on email; mapping in `user_sealant_identities`). The platform
  principal is an Effect reference set per request (the caller) and per session fiber (the session
  OWNER — a collaborator reads a session's workspace as its owner); an unset principal is a typed
  failure, never a seed user. Users connect their own Claude / Codex / GitHub accounts from Mend
  (Settings on web and desktop, `mend connect`); secrets pass straight through and are never stored.
  Hot-pool skeletons are claimed only by their owner's sessions. The Sealant web app is not part of
  a Mend deployment. Details and consequences: `docs/SEALANT-IDENTITY.md`.

- **2026-08-21 — Sessions are worktrees; everything else is a process.** The engine's data model and
  status logic treated "the session" as "the agent PTY" (`sessions.sealant_session_id`, one watcher
  settling the row). Protocol-mode agents and multiplayer both need the session to be the worktree
  plus its record, with every way of interacting with it a process kind sharing one lifecycle.
  Decided: `session_processes.kind` ∈ `shell | agent-pty | agent-protocol | service`; agent rows
  carry `harness` and `provider_session_id`; harness state is harvested per agent process under
  `sessions/<id>/processes/<process-id>/` (older session-root captures still read); session status
  is a fold over live processes (agent live → running; supporting only → idle; nothing → settled
  from the last agent outcome), so the same per-process watcher ends agents, shells, and Service
  attempts; stop ends agent processes only; follow-ups and resumes are refused while an agent is
  live, not while shells hold the workspace. The API exposes `processes[]` and `currentAgent` on the
  session detail (and `currentAgent` on list annotations); the singular `sealantSessionId` stays as
  a mirror of the current agent's PTY until list readers migrate. `waiting` is reserved for protocol
  mode. Nothing here builds protocol mode.
- **2026-08-11 — One saved workspace profile, with runtime services distinct from packages.** Mend
  settings own the environment for workspace launches: OS family, portable package names, and
  explicit services. The initial profile is Arch with pnpm, Python + uv, mise for managed Node and
  Python versions, GitHub CLI, lazygit, bat, curl, jq, ripgrep, fd, and fzf; Docker is a service,
  not a package. Sealant builds the client into the image and supplies a disposable rootless daemon
  per workspace without mounting the host socket. Every harness requests the user's default GitHub
  connected account so `gh` receives `GH_TOKEN`. Mend may scan only an allowlist of executable names
  and fixed configuration paths on its host and suggest additions; it never enumerates or reads the
  user's home-directory contents. Observations are suggestions, not an automatic copy.

- **2026-08-14 — Git access: host-owned credentials, workspace shim.** Remote git never enters a
  workspace: the host owns clone/fetch/push with two per-project auth modes (ambient, or a
  Mend-generated deploy key whose public half the UI hands out), and plain `git push` inside a
  session works through a `GIT_SSH_COMMAND` shim that carries transport bytes over the session
  socket to the host — stock git, no credential in the container, host-side seam for per-user
  identity and audit/gating later. Hardware keys get an optional agent bridge (laptop
  reverse-forwards its ssh-agent; touch happens where the key is). Design and scorecard:
  `docs/GIT-ACCESS.md`.

- **2026-08-13 — Workspace images: prebuilt stays, custom bases planned.** Confirmed sessions reuse
  one cache-ordered image per os family (containers are per-session, images are not); sealantd is a
  fully static musl binary on `scratch`, so any Linux base can host a workspace. Direction:
  plan-hash build short-circuit, an ubuntu family, then `baseImage` custom images (sealant overlays
  one static binary + env + entrypoint) with a per-project three-field editor — base, packages,
  setup; not a compose editor (compose lives inside the workspace's docker sidecar). Facts and
  sequence: `docs/archive/WORKSPACE-IMAGES.md`.

- **2026-08-10 — Resumed sessions retain every Sealant run.** A Mend session is the stable logical
  conversation, worktree, and change; each launch or settled-session resume creates an ordered
  Sealant run with its own sequence space and supervision cursor. Mend stores only that membership
  and stable record pointers — Sealant remains the raw-record owner. Checkpoints point to a hidden
  git ref plus `(Sealant run ID, sequence)`. Sessions migrated from the former single-run pointer
  are labeled as incomplete record history because overwritten run IDs cannot be reconstructed
  honestly.

- **2026-08-02 — Mobile adoption, discovered through the host's GitHub CLI.** Adoption joins the
  mobile capability set (§7.4): typing a clone URL on a phone was the real barrier, so the server
  asks its own `gh` for repositories to tap (`GET /api/github/status`, `GET /api/github/repos`, same
  auth middleware, args passed as a vector — user input never meets a shell). The credentials are
  gh's, not Mend's — no Mend-held GitHub token, and a host where `gh auth login` ran usually has
  private-repo clones already working. No new product noun: this is still adoption; discovery
  degrades honestly (a missing or signed-out gh is reported in the CLI's own words) and the
  typed-source form always remains. `POST /projects` stays blocking; the mobile client treats a
  dropped request as "clone continuing on the server" and watches the project list for the name
  rather than failing blind. If large clones make that feel bad in practice, the recorded follow-up
  is an adopting-state project row fed by the existing `mend_events` notify path. The web adopt form
  can reuse the discovery endpoints unchanged.

- **2026-08-01 — Browser access to session development services. Superseded in part 2026-08-20.** A
  development server remains part of its session, alongside the conversation, terminal, record, and
  change. The later Service decision replaces automatic detection and authenticated-link language:
  declarations are explicit, listener events may only suggest them, and raw forwards use the private
  network rather than Mend request authentication.

- **2026-07-25 — Execution model: central store, no host bind.** Agents never execute against the
  user's pre-existing checkout. Repositories are adopted into a Mend-managed store (bare repo plus
  per-session git worktrees); sessions run in managed Sealant workspaces that mount their worktree
  (§8.1.A). This settles the former open question about "the exact Sealant noun for persistent host
  attachment": there is no new noun — workspaces gain mounts. Consequences: the primary review
  object is the session worktree versus its base; concurrent sessions are supported structurally;
  every session write is supervised, so attribution is structural; BYO-agent identity rides the
  SDK's existing `credentials` and dotfiles options (present since 0.5.x).

- **2026-07-25 — Checkpoint policy.** Checkpoints are `(hidden git ref, Sealant run ID, record seq)`
  tuples taken at session start, command settles, adapter-known turn boundaries, review opens, and
  explicit user marks. Any two checkpoints define a reviewable slice: `refA..refB` for the diff and
  the ordered run-aware record span for the evidence (§5.6). Per-session worktrees make slices clean
  — no other session can interleave edits.
- **2026-07-25 — Machine review pass ("Mend reads the change").** Mend performs an inference review
  over settled changes, grounded in the record: draft comments with dispositions, never verdicts;
  every finding must link to the record or ship with a runnable check (the evidential noise filter);
  proposed checks discharge via verification runs. New milestone M2.5; details in §7.3. Revives the
  queue-era brief compiler inside the workbench review surface.

- **2026-08-01 — Dev-server preview: per-port TCP forwards, not an HTTP path proxy; amended
  2026-08-20.** An explicitly declared Service receives a host port bound to loopback and selected
  private interfaces. Mend pumps bytes to the workspace port over the SDK forward (§8.1.H). Path
  prefixes are rejected because they break absolute asset paths, HMR WebSockets, and cookies on real
  development servers. Raw forwards cannot enforce Mend authentication per request; the UI states
  that the private network is the access boundary. Transport does not imply browser behavior: HTTP
  or HTTPS must be declared before Mend shows Open. A typed public listener event may later produce
  an observed suggestion, never an automatic declaration or forward.

- **2026-08-01 — Per-project extra mounts, read-only, review scope unchanged.** A project may
  declare additional host folders (sibling repos, an uncommitted experiments folder) mounted into
  every session workspace outside the working directory (e.g. `/workspace/home/<name>`), default
  read-only, per-folder explicit opt-in — never "mount everything" (sibling checkouts carry `.env`
  secrets). The review focuses on the repo in question: the reviewable change remains exactly
  worktree-versus-base; extra mounts widen what the agent can see, not what Mend reviews. The mount
  set is declared on the session record and listed in the operational-contract prompt. Needs §8.1.G.
  The "scratch files inside each worktree" sub-case has a no-platform-change alternative: a
  per-project seed folder copied into each worktree at creation and covered by the managed excludes
  (a symlink would dangle inside the container).

- **2026-08-01 — References: cloned dependency sources mounted read-only.** A new product noun,
  `reference`: an upstream repository cloned into the store (`_references/<name>`, shallow by
  default, refreshed manually or periodically) — not a project: no sessions, no worktrees, no
  adoption. A global list with per-project selection; selected references mount read-only at
  `/workspace/ref/<name>` (one shared clone serves concurrent workspaces safely). Where possible,
  pin the checkout to the version the project's lockfile declares, and record reference names + SHAs
  in the session manifest for reproducibility. The operational-contract prompt tells the agent:
  source for these dependencies is mounted under `/workspace/ref/`; read it before guessing APIs.
  References sit beside context packs, not inside them — packs are immutable snapshots, references
  are live clones with a per-session pinned SHA; a later bridge may let a context item point into a
  reference. Needs §8.1.G.

- **2026-08-30 — Sessions are (project, base ref, worktree); bases stay current.** The base a
  session starts from is part of its identity, not a launch flag: the requested ref (branch, tag, or
  sha — the project's default branch when nothing was chosen) is recorded on the session as
  `baseRef` beside the pinned `baseSha`, and every surface that names a session names its base (web
  lists and review header, CLI table and dashboard, mobile detail). The composer picks from the
  store's real branches (`GET /projects/:id/branches`) instead of a blind text field, on web and
  mobile alike. Bases also stay current: provisioning freshens the base ref from origin through the
  project's git auth before the worktree is created — best-effort by design, so an unreachable
  remote, a disconnected bridge signer, or plain offline work costs currency, never a session — and
  base resolution prefers `refs/remotes/origin/<ref>` over the store's own heads, which freeze at
  adoption. `POST /projects/:id/refresh` (`mend refresh`) fetches every origin branch into the store
  on demand; nothing is ever pruned (session branches live in `refs/heads`). This dissolves the
  duplicate-project-per-branch workaround; a per-branch default project remains possible but is no
  longer the mechanism.

### Still open

These decisions should not block the first vertical slice. Choose the smallest reversible
implementation and record the choice.

1. Whether the final product keeps the name Mend.
2. Whether the first mobile release is PWA-only or includes a minimal native shell.
3. Whether staged/unstaged hunk operations land in M2 or immediately afterwards.
4. How much structured state provider-specific adapters can reliably extract.
5. Whether one instance supports multiple machines before or after the MVP.
6. The exact storage engine for the smallest local install; preserve the current stack unless
   changing it produces a clear user benefit.
7. Whether clean verification is automatic, suggested, or always manually triggered.
8. Where the central store lives on disk, and how adopted repositories sync with their origin and
   the user's pre-existing checkout (push to origin versus user pulls from the store).

A decision becomes canonical only when this document or a linked decision record is updated.

---

## 18. Instructions for implementation agents

Every agent working on this direction must follow these rules.

1. Read this document before reading the old product roadmap.
2. Treat this document as canonical when plans conflict.
3. Do not continue the queue, issue-to-PR, or merge-centric roadmap unless a task explicitly says to
   preserve a reusable component.
4. Build one observable vertical slice at a time.
5. Use the public `@sealant/sdk` only. Do not reach into Sealant databases or private services.
6. When a required platform capability is missing, document the gap and implement it generically in
   Sealant before depending on it in Mend.
7. Prefer a generic command/session contract before provider-specific code.
8. Keep git as the source of truth for diffs and repository state.
9. Never present inferred provenance as direct evidence.
10. Preserve existing useful brief, audit, evidence, and review code where practical.
11. Avoid broad rewrites that do not advance the current milestone's exit test.
12. Add automated tests for contracts and state transitions, but also dogfood every milestone on a
    real repository.
13. Update this document or a linked decision record when making a product-level decision.
14. Leave the repository in a state where the next agent can identify what is complete, what is
    blocked, and how to reproduce the current vertical slice.

### Definition of done for an implementation change

A change is done when:

- it advances one stated milestone or fixes a documented platform gap;
- its user-visible behavior has an acceptance test;
- public contracts and schemas are updated first;
- error and reconnect behavior are handled;
- security-sensitive behavior is explicit;
- tests pass;
- the real workflow has been exercised where the feature touches agents, PTYs, git, or remote
  access;
- relevant planning and platform-feedback documents are current.

---

## 19. Recommended first work package

The first agent should not attempt to build the full product. It should complete M0 and prepare M1.

Deliverables:

1. Add this document as the canonical plan.
2. Audit the current Mend codebase and produce a short mapping of:
   - reusable brief/review code;
   - reusable run/session code;
   - queue-specific code;
   - issue/PR-specific assumptions embedded in schemas and APIs.
3. Audit the current Sealant SDK for:
   - creating a workspace over a caller-provided mount (a store worktree);
   - credentials and dotfiles injection (exists in 0.5.x — verify provider coverage);
   - stream detach/reattach;
   - durable sequence resumption;
   - git snapshots;
   - arbitrary correlation metadata;
   - scoped remote input.
4. Add concrete missing capabilities to `PLATFORM-FEEDBACK.md` or the current equivalent.
5. Add or revise product schemas for:
   - Project;
   - Session;
   - ContextSnapshot;
   - Change;
   - ReviewComment.
6. Implement the smallest real M1 path:
   - adopt one repository into the store;
   - start one generic PTY command in a workspace mounting its session worktree;
   - render its live and historical output in Mend;
   - detach and reattach.

The work package is complete only when the path runs against a real local repository and survives
closing and reopening the browser.

---

## 20. Final product test

A developer should eventually be able to say:

> I can open any project, see every agent session working on it, know exactly what context each
> session had, open the application it is running, review the local code properly, ask why a change
> exists, send comments back to the agent, and do all of that from my phone without exposing my
> machine publicly.

If a proposed feature does not materially improve that sentence or strengthen the Sealant SDK
required to deliver it, it is probably not part of this product yet.
