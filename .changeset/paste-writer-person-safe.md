---
"@sealant/mend": patch
---

A pasted image is now written as the person who pasted it in a per-person workspace, into their own
saved directory (`/workspace/harness-home/people/<account id>/paste/`, a new directory group `mend`
and 2770, the image 0640). Before, Mend wrote it as root into the shared harness home.

In every layout the paste writer follows no link and changes the mode of no directory already there.
Before, a `paste` link planted in the harness home led the root write outside it, and the writer
widened the directory it found there to 0755. Such a link is now refused and nothing is written. The
co-located store's writer on the server follows the same rules.
