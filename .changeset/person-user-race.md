---
"@sealant/mend": patch
---

Opening `mend shell` while a per-person session resumes no longer fails the resume. The launch and
the shell both made the person's Linux user at once, and the one that lost failed with
`useradd: UID 40001 is not unique`. Now one waits for the other, for at most 60 seconds, and a copy
whose exec was stopped part-way is not waited for.

When a per-person launch cannot make its users in an image that can run them, the refusal now says
what failed and to start the session again. Before, it said the image could not run per-person users
and to pick another image or start a new worktree, which was wrong.
