---
"@sealant/mend": patch
---

A pasted image is now written as the person who pasted it in a per-person workspace, into their own
saved directory (`/workspace/harness-home/people/<account id>/paste/`; a new directory is 0770 and
the image 0640, both group `mend`). Before, Mend wrote it as root into the shared harness home. A
first paste makes only that person's user and home, with a Mend token of that paste's own in a file
of its own: none of their logins is written, nothing is delivered to them (no dotfiles or
install.sh, skills, secret files or shell profile), and that token, exactly, is revoked when the
paste ends, however it ends. Two pastes at once each have their own. A revocation that fails is
retried until it is done.

In every layout the paste writer follows no link and never changes the mode of a directory: a new
directory is made with its mode in one step. Before, a `paste` link planted in the harness home led
the root write outside it, and the writer widened the directory it found there to 0755. A link is
now refused, and so is a write whose directory is moved while it is written: the image stays
readable only by its writer until it is proved in place, and a refused write empties its file and
removes only what it proves is its own. The co-located store's writer on the server follows the same
rules, and refuses a paste on a server where no `/proc/self/fd` reaches a directory (a server run
outside Linux, not the packaged one).

Slack images take the same path, as the person who asked: in a captured session's running workspace,
as that person where it runs per person. On the capture store, a Slack request that starts a session
attaches no image, because its workspace does not exist yet when the opening turn is written. The
turn and the requester's note say
`not attached · the session has no running workspace to place it in yet`. Before, Mend wrote such an
image on the server, where the workspace never saw it.
