---
"@sealant/mend": minor
---

Per-person workspaces (ADR 0016) are on by default. Each person who runs anything in a new
worktree's workspace gets their own Linux user and home, and everything they run runs as them: their
agent, shells, Services, `git push` and the `mend` helper, with their own Mend key or signer and Git
author. `MEND_HARNESS_LAYOUT` is `person` unless set (an empty value counts as unset); this includes
a loopback server on the capture store, the default `mend server setup`.
`MEND_HARNESS_LAYOUT=shared` keeps new worktrees on one shared home. A worktree that has run per
person stays per person whatever the setting.

Each person's agent runs on their own Claude, Codex, GitHub and ChatGPT logins, written into their
own home and removed when their last process there ends, never on another person's. A session whose
owner has not connected the provider its harness needs is refused before it starts, whether it is
the first in the worktree or a join:
`Connect Claude to start a session here. Connect it in Settings → Connected accounts, or run mend connect claude.`
Logins, the session token and the Git author reach the home through a single-use pickup only that
person can redeem, never through a command's arguments. The workspace's own token is refused for Git
and the helper.

Everything Mend delivers goes into each person's home, as them: skills, agent memory, secret files,
the pi profile, carried Codex conversations, the default shell profile and dotfiles. Each person's
conversations and memory are read back from their own saved directory, so two people in one worktree
each resume their own conversation. Your agent waits for your dotfiles' `install.sh` when you
started the workspace, or when "Start my agents after install.sh" is on
(`PUT /api/dotfiles/start-after-install`). Otherwise it starts beside it and the session line says
`install.sh running`, then `install.sh finished after the agent started`. Dotfiles that take over
two minutes leave the agent starting anyway (`dotfiles still applying`), and Mend puts its links
back once they land. When Sealant restores a worktree saved per person, each person's saved files
come back as theirs and the worktree is given to everyone working in it, so each person's processes
can edit it and use `sudo`.

Where a workspace cannot run per person, a new worktree runs with one shared home and the session
says why: a nix image, an image without `sudo`, an image Core reports it cannot run that way, a
Kubernetes or Cloudflare workspace runtime (ruled out before any launch), a Docker host that sets
no-new-privileges (checked before anyone is made), or a Sealant that does not run processes as a
person. A worktree already saved per person is refused there, with the reason. A remembered "no" is
checked again by the next shared launch when a shared workspace can see every reason (no `sudo`, no
ACLs and the like), and after a day when a person could not be made; a "no" from no-new-privileges,
an owner map refused or Core is kept until the image changes. A per-person workspace's first setup
sends one short line per member of the organization, so an organization of any size stays far below
Linux's limit on a command's length.

Starting a session where someone else's runs says that everything you run runs as you, on your own
logins, but either of you can read the other's files, logins included. A live session reads
`Shared workspace with Anna · each of you runs as yourself · either of you can read the other's files.`
A turn that waits for another person's agent says what it waits for. The API's session list and view
list the people live in each workspace (`livePeople`). Everyone in a per-person workspace has
passwordless `sudo` and can read the others' files: see Known issues.
