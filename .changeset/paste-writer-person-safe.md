---
"@sealant/mend": patch
---

A pasted image is now written as the person who pasted it in a per-person workspace, into their own
saved directory (`/workspace/harness-home/people/<account id>/paste/`; a new directory is 0770 and
the image 0640, both group `mend`). Before, Mend wrote it as root into the shared harness home. The
logins and Mend token a first paste writes into that person's home are released after the start's
grace, as when a process of theirs ends.

In every layout the paste writer follows no link and never changes the mode of a directory: a new
directory is made with its mode in one step. Before, a `paste` link planted in the harness home led
the root write outside it, and the writer widened the directory it found there to 0755. A link is
now refused, and so is a write whose directory is moved while it is written: the file is taken back
out and nothing is answered as placed. The co-located store's writer on the server follows the same
rules.
