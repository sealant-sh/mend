---
"@sealant/mend": patch
---

A pasted image is now written as the person who pasted it in a per-person workspace, into their own
saved directory (`/workspace/harness-home/people/<account id>/paste/`; a new directory is 0770 and
the image 0640, both group `mend`). Before, Mend wrote it as root into the shared harness home. A
first paste makes only that person's user, home and Mend token: none of their logins is written,
nothing is delivered to them (no dotfiles or install.sh, skills, secret files or shell profile), and
the token is revoked once the image is written.

In every layout the paste writer follows no link and never changes the mode of a directory: a new
directory is made with its mode in one step. Before, a `paste` link planted in the harness home led
the root write outside it, and the writer widened the directory it found there to 0755. A link is
now refused, and so is a write whose directory is moved while it is written: the file is taken back
out and nothing is answered as placed. The co-located store's writer on the server follows the same
rules.

Slack images take the same path, as the person who asked: in a captured session's running workspace,
as that person where it runs per person. On the capture store, a Slack request that starts a session
attaches no image, because its workspace does not exist yet when the opening turn is written. The
turn and the requester's note say
`not attached · the session has no running workspace to place it in yet`. Before, Mend wrote such an
image on the server, where the workspace never saw it.
