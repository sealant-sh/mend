# Git Access — SSH, custom servers, and the workspace shim

Design notes from the 2026-08-13/14 discussion. Decisions here govern the git story for alpha; the
delivery prompt lives with the session that builds it.

## Where git actually runs today (verified against live containers)

- Mend's clone/fetch happen **on the Mend server host** (`git clone --bare` into the store,
  `GIT_TERMINAL_PROMPT=0`). If the login user's `git clone git@gitlab.com:…` works in a shell, it
  works in Mend today — GitLab and custom servers included. What breaks: passphrase keys without an
  agent, first-contact host-key prompts, and there is no readable failure surface.
- Inside a workspace, **full local git already works with zero credentials**: the worktree mounts at
  `/workspace/repo` and the bare `repo.git` is bind-mounted **path-identically, read-write**, so the
  worktree's `gitdir:` pointer resolves and the object store is shared. Host-side fetches are
  instantly visible inside every session through the filesystem.
- Remote access from inside a workspace is today GitHub-only via the platform's injected
  connected-account credential (`gh` / `GITHUB_TOKEN`).

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
   gets no key, no agent socket, no token. Instead the workspace image sets `GIT_SSH_COMMAND` to a
   small shim that carries git's transport bytes over the session socket (`/run/mend/mend.sock`) to
   the host; the host opens the real authenticated connection and shuttles the pack protocol
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

The **read-write `repo.git` mount** means workspace code can already write refs/objects in the
shared project store directly — including refs other sessions hang off. Confused-deputy shape: an
agent rewrites a ref, the user later publishes it host-side. Review-before-landing is the mitigation
today. Candidate fix, own timeline: read-only common dir + per-session writable admin/objects
overlay.
