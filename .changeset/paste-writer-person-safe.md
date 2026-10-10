---
"@sealant/mend": patch
---

A pasted image is now written by the process of the person who pasted it in a per-person workspace,
as them, into their own saved directory (`/workspace/harness-home/people/<account id>/paste/`; a new
directory is 0700 and the image 0600). Before, Mend wrote it as root into the shared harness home.
Root writes nothing of the person's: a first paste makes only that person's user and home, writes
none of their logins and delivers nothing to them (no dotfiles or install.sh, skills, secret files
or shell profile). Each paste fetches its image with a Mend token of its own, which redeems that
paste's pickups and nothing else, is never revoked along with the person's other tokens, is revoked
when the paste ends however it ends, and lapses 15 minutes after it is issued in any case.

In every layout the paste writer follows no link, creates the image only where nothing is, and never
changes the mode of a directory: a new directory is made with its mode in one step. Before, a
`paste` link planted in the harness home led the root write outside it, and the writer widened the
directory it found there to 0755. The co-located store's writer on the server follows the same
rules, and refuses a paste on a server where no `/proc/self/fd` reaches a directory (a server run
outside Linux, not the packaged one).

Slack images take the same path, as the person who asked: in a captured session's running workspace,
as that person where it runs per person. On the capture store, a Slack request that starts a session
attaches no image, because its workspace does not exist yet when the opening turn is written. The
turn and the requester's note say
`not attached · the session has no running workspace to place it in yet`. Before, Mend wrote such an
image on the server, where the workspace never saw it.
