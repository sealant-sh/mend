---
"@sealant/mend": patch
---

With `MEND_HARNESS_LAYOUT=person`, the default, each person's dotfiles now apply as them, into their
own home, in a workspace they share: the person who started it and everyone who joins. A new
worktree whose launcher has dotfiles no longer has to run as one person to get them. Your agent
waits for your dotfiles' `install.sh` when you started the workspace, or when you turned on "Start
my agents after install.sh", and so does every later session of yours while the script still runs;
otherwise it starts beside it and the session line says "install.sh finished after the agent
started" once it ends. If applying your dotfiles takes longer than two minutes, your agent starts
anyway, the session says "dotfiles still applying", and once they land Mend puts its links back and
the line says "dotfiles applied after the agent started". When Sealant refuses to apply them (your
home there is not the one Mend named, or the workspace stopped), the session says why and your agent
still starts. Joining a session is now exactly one login write: the logins you have connected are
written, the rest are left out and not asked for again, and a refusal names the provider ("Connect
Claude to start a session here."). pi's and opencode's ChatGPT logins are now written and removed by
Sealant with your other logins, and the session line says when one could not be written. When a
workspace falls back to one person after it starts, your dotfiles are not applied to it, since
Sealant applies dotfiles only as a person; the session says so, and a workspace started next on that
image applies them at boot. A Sealant control plane that does not report that it runs processes as a
person keeps every workspace on one person, and says why. With `MEND_HARNESS_LAYOUT=shared`, nothing
changes.
