---
"@sealant/mend": patch
---

A shell opened while a new worktree's first per-person launch is still being prepared no longer
makes that worktree, and every new worktree on the same image after it, run with one shared home.
Before, the shell could make its person's user a few milliseconds before the launch checked the
image, the check took that user for one the image ships ("uid 40001 is taken in this image"), and
Mend recorded the image as unable to run per-person users. Now a shell, a Service or a paste into a
person's home waits for the launch's check and setup to finish, usually a second or two, before it
makes anyone. If the launch ends with one shared home, the shell runs as root, as the session does.
If the launch is refused, the shell is refused in the same words. The check also no longer counts
the launch's own people, as Mend makes them, as users the image ships. An image that really ships a
user in the reserved range, or a person's name under another uid, is refused in the same words as
before.
