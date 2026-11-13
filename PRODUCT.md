# Mend product

What Mend is and is not, for anyone deciding what to build. The product model and glossary live in
the public docs (`apps/docs/src/content/docs/concepts/product-model.md` and
`apps/docs/src/content/docs/reference/product-language.md`), decisions in `docs/decisions.md` and
`docs/adr/`, and the roadmap in Linear.

## What Mend is

Mend is a local-first workbench for developers who use coding agents heavily. It keeps three things
together that otherwise sit across terminals, provider apps, repositories, notes and browser tabs:
project context, agent sessions, and code changes with their review.

A developer adopts a repository into Mend's central store and runs the agent they already use in a
recorded git worktree. They review the accumulated local change with evidence beside every claim,
send review comments back to the same session, then commit, verify or open a pull request if they
want one. The same work is reachable from the CLI, the desktop app, the web app, the VS Code
extension and a phone.

Mend must improve that loop without asking anyone to adopt a new coding agent. The developer keeps
the harness they trust. Mend wraps, records, organises, reviews and remotely exposes the work.

Mend is built only on the public sealant SDK. Mend is the opinionated product; sealant is the
reusable runtime and evidence platform underneath it.

> Sealant records and controls agent work. Mend turns it into a coherent developer workflow.

Issues and pull requests are optional references attached to work. Neither is needed to use Mend,
and neither defines its object model.

## The user problem

The user is a developer who runs coding agents throughout the day (Codex, Claude Code, opencode, pi
or a command of their own), alone or with others in one organization on a shared Mend. They keep
hitting the same problems:

- **Context is scattered.** It lives in repository instructions, architecture docs, trackers, old
  agent conversations, notes and the developer's head. Every new session starts with another round
  of re-explaining, and afterwards nobody can say what the agent knew when it made a change.
- **Sessions are scattered.** Sessions sit in separate terminals and provider histories, across
  several repositories, machines and branches. It is hard to see what is running, what is waiting
  for input, what failed and where a line of work stopped.
- **Local review is weak.** Agents produce a lot of uncommitted work. An editor's source-control
  panel, raw `git diff` or a pull request opened early are poor places to review work that is still
  being shaped.
- **Diffs lack provenance.** A diff shows what changed. It does not show which session or prompt
  caused it, which sources the agent read, which checks ran afterwards, or which edits have no
  recorded cause. sealant can supply that evidence.
- **Agent work is stuck on one computer.** Developers want to check progress, answer a question,
  approve an action, review a diff or send guidance from a phone or another laptop, without turning
  Mend into a cloud IDE.
- **Remote access is too hard.** Reaching Mend from another device should not mean building a VPN or
  setting up a reverse proxy from scratch. It should work on the machine itself, over a tailnet or
  LAN the operator already has, or publicly behind an edge they run.
- **The running application is stuck in the workspace.** A development server inside an agent
  workspace is easy to start and hard to reach from another browser or phone. Container ports and
  forwarding commands leave the developer working out which service belongs to which session.

## Principles

1. **The project is the primary object.** A project is a Git repository adopted into Mend's central
   store. Context, sessions, changes and reviews all belong to it. Tracker issues and pull requests
   are references attached to the work, not its identity.
2. **Bring your own agent.** Mend is not another coding harness. It launches or observes Codex,
   Claude Code, opencode, pi or any command, through adapters over the same sealant SDK.
3. **Local changes are first-class.** The developer gets value before any commit, issue or pull
   request. The change, a worktree against its base, is itself a reviewable object.
4. **Evidence is available, but not noisy.** A normal diff stays easy to read. Provenance appears
   when the developer asks why something changed or opens the change overview, and never buries the
   review in telemetry.
5. **Context is explicit and inspectable.** Context is built from explicit items, gathered into
   versioned packs and recorded as an immutable snapshot for each session, never an opaque "AI
   memory". Suggestions may get smarter, but the developer can always see and edit what was
   supplied.
6. **Mobile is for control and review.** A phone is not a full IDE. It is for seeing active work,
   answering agent questions, sending guidance, reviewing changes, and opening a terminal only when
   needed.
7. **Remote access should be boring.** Mend is its own front door at one HTTPS origin, and
   authenticates every request itself. A tailnet, LAN or VPN is an extra gate an operator may add,
   never something Mend trusts as identity. Do not build a custom VPN.
8. **Sealant remains a platform.** Mend uses only the public sealant SDK and never imports its
   internals. When the SDK lacks something, file it in Linear with the `sealant` label, build it in
   sealant as a general capability, and use it through the SDK.
9. **The product reports; the developer decides.** No confidence scores, risk meters, "safe to
   merge" verdicts or automatic approval. Show what was observed, what was inferred, what was not
   run, and what needs attention.
10. **The running application belongs to the session.** A development server runs against one
    session's worktree. Mend shows it on that session and serves it behind the same sign-in as the
    conversation, terminal and review. It is never public by default.

## Direction

Not built yet, and still where the product is heading. Linear holds when.

- **Context.** Context items (files, documents, notes, URLs, issues and pull requests, earlier
  session summaries), each with its source, update time and digest; named context packs chosen when
  a session starts; and an immutable context snapshot for every session, shown from the session and
  its review. Never hidden context selection.
- **Session summaries.** Goal, decisions, files changed, checks run, open questions and next step,
  drafted with inference, edited by the person, then saved as context. A single decision or
  discovery can be promoted the same way.
- **Verification.** Recorded checks against a change, run in a clean workspace when independence
  matters. Mend's findings may ship as proposed checks that turn "never ran" into an observed fact.
- **Provenance per hunk.** "Why did this change?" answered with the contributing sessions, the
  instruction, nearby record events and later checks, each labelled direct, inferred or unknown.
- **Review.** Image and snapshot diffs, and reading the change automatically when a session settles,
  as an opt-in setting.
- **Scoped device permissions** for paired devices.

## Non-goals

Mend does not do these. Work that heads towards one needs an explicit decision first.

- Choosing issues to work on by itself.
- A backlog or kanban queue.
- Issue-to-PR orchestration.
- Multi-agent swarms.
- A Mend-native coding model or agent.
- Automatic merge decisions.
- Confidence or risk scores.
- Enterprise policy and governance beyond an organization's roles and audit log (ADR 0003).
- Hosted code execution. Mend runs on machines its operator controls.
- Public Internet exposure by default.
- A custom VPN.
- A full mobile IDE.
- Invisible, automatic long-term memory.
- Cross-repository atomic changes. A session can use several repositories, but each keeps its own
  change (ADR 0011).
- Replacing GitHub, Linear, Jira, editors or terminals.

## Security and privacy

Adopted repositories and credentialed workspaces hold valuable source code and real identities.
Security is part of the product contract.

- Self-hosted and local-first by default.
- No product telemetry or code upload unless the user configures it.
- Never record secret values. Record credential references and granted scopes where possible.
- Apply sealant redaction to terminal, environment, network and artifact data.
- Store integration secrets encrypted, and bearer credentials only as hashes.
- Pairing codes are short-lived and single-use. Device tokens and access keys act as one person and
  are revocable.
- Mend authenticates and authorises every request itself. It never trusts a request more because of
  the network it came from (ADR 0004).
- The operator declares the exposure: `loopback`, `private` (the default) or `public`. Mend reports
  what it observes beside that declaration, and refuses to start `public` while the public exposure
  gate has open items. sealant, the database and raw service ports stay private.
- Destructive git actions need explicit confirmation.
- Sending input to a session or typing in its terminal needs more permission than reading its
  review.
- Every remote control action is audited.
- The interface says plainly when evidence is incomplete because a process ran outside sealant
  supervision or telemetry was lost.
