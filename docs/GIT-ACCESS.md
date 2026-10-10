# Git Access — SSH, custom servers, and the workspace shim

Design notes from the 2026-08-13/14 discussion. Decisions here govern the git story for alpha; the
delivery prompt lives with the session that builds it.

## Where git runs today (updated 2026-09-26)

- Mend's clone/fetch happen **on the Mend server** (`git clone --bare` into the store,
  `GIT_TERMINAL_PROMPT=0`), signed with the account's git access below.
- The capture store is the default session store (`packages/store/src/deployment.ts`, #235). A
  workspace materialises its worktree from the bucket onto its own disk and ships captures back.
  Nothing from the store is mounted into it, so local git inside the workspace works on its own
  repository copy with no credentials.
- Remote git from inside a workspace goes through the transport shim (decision 3). Since #302 the
  shim and the `mend` helper are written into captured workspaces at provisioning, and #305 added a
  packaged acceptance check that a `git push` from inside a session reaches the remote.
- The deprecated co-located store (`MEND_SESSION_STORE=colocated`, which logs a startup warning)
  still bind-mounts the bare `repo.git` path-identically and read-write into the workspace. The
  2026-08-13 notes that described this as the only shape are superseded.

## Decisions

1. **Three auth modes per project, host-side only; a per-user default.**
   - _Mend key_ (the default, per user since 2026-09-02): Mend generates an ed25519 keypair for each
     user on the server machine (`<keys root>/users/<userId>/id_ed25519`; the keys root is
     `MEND_KEYS_ROOT`, else `~/.config/mend/keys`; 0600; the private key never leaves the host,
     never enters a workspace). A server-wide key from before per-user keys is claimed by the first
     user who asks, so a public key already registered on a git host keeps working. The UI/CLI shows
     the public key with a copy button and the recommendation: add it to the user's git account SSH
     keys, so every repository they can reach works from detached sessions, the phone, and the hot
     pool alike; a deploy key on one repository is the scoped alternative. Git ops run with
     `GIT_SSH_COMMAND="ssh -i <key> -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"` and
     the credential is the session owner's (the shim resolves session → owner; an unowned op on a
     single-user install uses the only key, and refuses to guess between two).
   - _Ambient_: the login user's git/ssh setup on the server host, unchanged. Fix the failure story
     only: run ssh with `BatchMode=yes`, surface "permission denied / host key unknown" as readable
     errors instead of dead clones.
   - _Bridge_: below.
   - The user-level choice (`user_git_access`, `GET/PUT /me/git-access`, Settings → Git access,
     `mend keys mode`) is between Mend key and bridge. It is asked once, as the second step of
     creating an account (`/welcome`, right after registration): the Mend key is the default and is
     generated before that page paints, so the visitor sees the public half to add to their git
     account, not a button. New projects adopt with the choice; a project's setup page overrides it.
     The key's comment is the account's email — a signed-in call passes it, and a key born under the
     older `mend@<host>` comment (or on the shim path, which knows only the owner's id) is relabeled
     in place with `ssh-keygen -c`; the key material and fingerprint do not change.

2. **YubiKey / hardware keys: the agent bridge (shipped).** A hardware key cannot be copied and
   demands a touch per signature, so it can never back daemon fetches. The universal interface in
   front of it is the ssh-agent socket; agent forwarding is a solved shape. `mend keys share` on the
   laptop — or, when the user's git access is bridge, any attaching `mend` command and the dashboard
   for as long as they run — reverse-forwards the local `SSH_AUTH_SOCK` to the Mend server over the
   private network (one outbound WebSocket, agent-protocol frames relayed verbatim inside; nothing
   secret ever transits — challenges and signatures only, serialized one at a time). While
   connected, the server exposes a real agent socket under `~/.config/mend/keys/_bridge/` and
   projects in the third auth mode, `bridge`, sign through it — host-side ops and the workspace shim
   alike; the key blinks on the laptop, and the share CLI prints what each signature is for
   ("signature requested by mend (project shimtest → localhost)") with an honest waiting line and a
   60s touch window. Disconnected → those ops fail fast with "no signer connected — run
   `mend keys share` on the machine that holds your key", and the deploy key still covers everything
   routine. The web card reports presence as an observation ("signer connected · laptop"), never a
   judgment. Browser-based signing stays impossible by design (WebAuthn cannot produce SSH
   signatures), and nothing about an agent response is ever persisted.

3. **Remotes never enter the workspace; plain `git push` still works — the shim.** The container
   gets no key, no agent socket, no token. Instead Mend sets `core.sshCommand` in the workspace's
   system git config to a small shim (`/run/mend/bin/mend-git-ssh`) that carries git's transport
   bytes to the host: over the session socket (`/run/mend/mend.sock`) where one exists, otherwise
   over the authenticated network session endpoint (`MEND_SESSION_ENDPOINT`), which is the path in
   capture mode. The host opens the real authenticated connection and shuttles the pack protocol
   (jump-host pattern, `ProxyCommand` shape). Stock git, every subcommand, no aliasing — one env var
   reroutes the transport layer git itself designed to be replaceable.
   - The host resolves _which_ credential per request: session → project → owner. That is the
     owner's Mend key (per user since 2026-09-02) or the connected agent bridge — this is what makes
     multi-tenant identity possible at all (a baked-in container key decides too early and produces
     a copyable secret).
   - The seam is also the policy point: log every remote op; optionally auto-allow `mend shell`
     pushes and require confirmation for agent-initiated ones. Whether the gate is on is product
     policy; the shim makes it possible.

## Honest scorecard (vs. key-in-container)

The security delta against the real baseline (agents run locally with ambient credentials) is modest
and precisely two things: a shim credential is **mortal** (misuse dies with the workspace; a leaked
key file works from anywhere until rotated) and the socket is a **seam** for audit/gating. Shim
costs: it is code we own; git-in-workspace requires the Mend server to be up; the socket capability
is per-session, not per-process.

## Known independent risk (not caused by either option)

This applies only to the deprecated co-located store. A captured workspace has no mount of the
project store. On the co-located store, the **read-write `repo.git` mount** means workspace code can
already write refs/objects in the shared project store directly — including refs other sessions hang
off. Confused-deputy shape: an agent rewrites a ref, the user later publishes it host-side.
Review-before-landing is the mitigation today. Candidate fix, own timeline: read-only common dir +
per-session writable admin/objects overlay.

## Which remotes Mend's git reaches

Mend clones and fetches on its own behalf for adoption, reference repositories, dotfiles and project
refreshes. `MEND_SOURCE_POLICY` decides where those may go. `operator` (the default) allows private
networks, refuses the cloud metadata service, and reaches this machine only for the operator.
`tenant` also refuses private, reserved and local addresses and `git://`, unless
`MEND_SOURCE_ALLOWED_HOSTS` names the host or its range; loopback and the metadata service can never
be allowed. A refusal names the rule, never the addresses a host resolved to. Under `tenant`, git
then dials exactly the address that was checked, so a name cannot answer differently a moment later:
HTTPS through `http.curloptResolve`, ssh through `HostName` with `HostKeyAlias`, so known hosts
still match the name. The dotfiles clone at each launch is checked and pinned the same way.

A workspace's git transport signs with its owner's key, so it only reaches the project's own remote:
the origin's host, and its port for ssh. Pushing a mirror or a fork elsewhere from inside a
workspace runs without Mend's signer. An operator who alone uses the machine may set
`MEND_GIT_TRANSPORT_BIND_ORIGIN=false`; `multi` tenancy refuses to start with it.

## Credentials in repository URLs

Since 0.36 (found in the review of mend#611), Mend never stores, returns or logs a repository URL
with a credential in it. A URL is a credential carrier when it has a password (any scheme) or a user
over any scheme but ssh: over HTTP(S) the user is where tokens go (`https://oauth2:TOKEN@…`,
`https://ghp_…@github.com/…`), over ssh it is the login (`ssh://git@host/…`, `git@host:path`) and
stays. One parser in `@mend/domain` (`repository-url.ts`) decides everywhere. It reads an authority
as RFC 3986 does: from `scheme://` to the next `/`, `?` or `#`, with everything before the last `@`
as userinfo, whatever characters it holds (quotes, angle brackets, spaces, unicode, `%`-escapes); no
character class decides what a credential may contain (review of mend#640). Detection also asks a
URL parser, and either finding one is enough. `redactRepositoryUrl` handles one URL (a stored
origin, a git remote, an argument); `redactUrlCredentials` handles free text by the same rule,
whitespace inside userinfo included (review 3 of mend#611), and the CLI's `redactCredentials`
delegates to it, so the CLI and the server never disagree. Output that must keep its shape (the
CLI's `--json`) is redacted one string at a time.

- **Refused where it enters.** `repositoryCloneUrlIssue` refuses such a URL with guidance that names
  the supported ways (`mend keys`, `--auth bridge`). The adopt route checks it before anything else
  and answers `StoreFailure` with that sentence and never the URL; the payload's `source` is a plain
  string so that a client from before the rule reads the reason, not a bare 400. It also backs every
  client's local check (CLI, dashboard, web, phone, VS Code) and `SourcePolicy.check`, which every
  adopt, refresh and reference clone passes. Dotfiles keep their own message
  (`dotfilesRepositoryUrlCredentialIssue`), on the same rule.
- **Never returned.** `ProjectsRepo` and `ReferencesRepo` strip it on write and on every read, so no
  response, no Slack inference prompt and no workspace clone (ADR 0011) can carry one an older
  server stored.
- **Never logged.** `GitError` is built with its args and stderr redacted (a failed clone's message
  carries the whole command line), `ReferenceCloneError.source` likewise, and the server's console
  strips URL credentials from every log line (`RedactingConsoleLive`).
- **Existing data.** Migration 0121 strips project and reference origins and both dotfiles columns.
  At each worker start `RemoteCredentialScrubLive` rewrites any remote URL (`url`, `pushurl`) in a
  project store or reference clone that still carries one. Each repository is reported the moment
  its outcome is known, never after the others: a cleaned one with a warning naming it and an entry
  in its organization's audit log (`project.remote_credentials_removed`, credited to whoever adopted
  it); one that cannot be cleaned yet with its reason and file, retried 1 s doubling to every 5
  minutes. The store leaves a notice file beside the config before its first rewrite
  (`mend-remote-credentials-removed`: when, and which keys; no URL), whichever op did the rewrite,
  and the sweep clears it only once recorded, so a removal a fetch made first, or one a restart
  interrupted, is still reported.
- **Gated until clean.** Every store op that uses or exposes a repository's remotes (a fetch, a
  push, a probe, a reference refresh, opening or resetting a worktree) first cleans them
  (`Store.cleanRemotes`), waiting about a second for a held lock. A remote that still cannot be
  cleaned refuses the op with that reason; nothing fetches, pushes or mounts with the token.
- **What git reads, not what one file says** (reviews 2 and 3 of mend#640). Mend never writes an
  `include` or `includeIf` into a store's config, and a conditional one can turn on in a worktree
  after the gate passed, so a store whose config has any is refused, naming the config, rather than
  evaluated. The scrub reads the config NUL-delimited (`git config -z --show-origin`), so a value
  with a newline is one value. A credential in a `url.<base>.insteadOf` base is not Mend's to edit:
  the gated ops refuse, naming the file.
- **No lost remote, no stale write.** Each dirty value is rewritten by one atomic git write
  (`--fixed-value --replace-all KEY CLEAN OLD`: git writes the new file aside and renames it), so a
  crash or a concurrent reader never sees a remote missing or half-written, and a value keeps its
  place. A writer working from a stale read appends the clean value instead; those copies are
  collapsed into one. The scrub is accepted only once every value read before has its clean spelling
  in the config after, re-read, with no credential left. Within one process the read-and-rewrite of
  a repository runs once at a time (a lock keyed by the git dir's real path, shared by every Store);
  across processes the atomic, idempotent writes are what keep it safe.
- **Known limits.** The gate reads the store's own config. Global and system git config and
  `GIT_CONFIG_*` in the server's environment are the operator's configuration of their own server,
  not input from a person, and are outside it. Neither does it judge `http.<url>.extraHeader` or
  `credential.helper` in a store's config: those predate this rule and are not URL credentials; a
  policy for them is a 0.37 roadmap item.

Why refuse rather than keep the token sealed beside the URL: Mend holds no HTTPS credential of an
account's, and a token in a project's URL is the adopter's credential spent by everyone who works in
the project, including fetches and landings by other members. That is the cross-person spend the
per-person rules forbid. The supported ways are each person's own: their Mend key or their bridge. A
per-account HTTPS token, sealed like other credentials, is the planned follow-up (above), and would
not live in the URL either. A project whose fetch needed the token stops fetching after the upgrade;
it is adopted again from its SSH URL. The owner's box had none (0 of 6 projects, 0 references).

## Accounts and organizations

Since organizations (`docs/adr/0003-organizations-and-tenancy.md`), every signer belongs to one
account. `mend keys share` serves the bridge of the account it signed in as, at its own socket under
`_bridge/`; a session signs with its owner's Mend key or its owner's bridge, and never falls back to
another account's. A hot workspace is warmed as the owner it serves, and a session with no owner has
no signer at all. Reference repositories belong to an organization and are fetched with the git
access of the owner who adds or refreshes them, never the host's ambient identity.

The dotfiles repository is cloned at every launch as the session's owner, and when it is saved as
the account saving it. An SSH URL signs with that account's git access (its Mend key, or its bridge
when that is its choice). An HTTPS or `git://` URL clones with no credential: Mend holds no HTTPS
token of the account's (a connected GitHub account's token lives in Sealant, which never returns
it). Neither reads the host's git or ssh setup: no system or global git config, no askpass, no
agent, no ssh config (`-F /dev/null`), none of ssh's default key files (`-o IdentityFile=none`; ssh
finds `~/.ssh/id_*` through the passwd entry, not HOME, and would offer them on the bridge), and an
empty HOME, so no `.netrc`. Only the operator of a `single` tenancy install clones with the host's
own setup, the same rule as the host's `gh` login below (`packages/sessions/src/dotfiles.ts`,
`DotfilesCloner`).

Calls to the GitHub API from the Mend server (repository discovery, pull request lists) have no
per-account credential yet. On a single-organization install the operator may use the host's `gh`
login; everyone else sees "no identity" with the reason. A per-account GitHub token, sealed like
other credentials, is the planned follow-up.

Landing (`docs/adr/0007-landing.md`) does not use that path. The push signs with the change owner's
git access, like any host-side operation. The pull request step runs `gh` inside a workspace: the
session's own when it is live, otherwise a short-lived one for the owner with the GitHub credential
and nothing else. The owner's connected GitHub token exists only on the platform and in that
workspace; it never reaches Mend's process or database (`packages/landing/src/pull-requests.ts`).

## Git author

The commits an agent makes in a workspace name an author. That is an account setting, **Git
author**: a name and an email in Settings (the web) or `mend git-author "Name" you@example.com` (the
CLI), `GET`/`PUT`/`DELETE /api/me/git-author`. Until the account saves one, it is the name and email
the account registered with; `DELETE` returns it there.

Before the harness starts, in every workspace the session's owner launches (co-located or captured,
cold or a claimed standby), Mend writes it as system git config: `git config --system user.name` and
`user.email`, the values passed as arguments, never through a shell. System level is deliberate: a
`~/.gitconfig` from the owner's dotfiles and the repository's own `.git/config` still decide over
it. `GIT_AUTHOR_*` environment variables would override both, so Mend does not set them. A workspace
that already runs (a sibling session joining a captured worktree's lease holder) keeps the author it
was launched with. A write that fails is logged and the session still launches, like the transport
install beside it.
