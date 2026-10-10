---
"@sealant/mend": patch
---

VS Code Remote-SSH, SFTP and `scp` into a per-person workspace run as its launcher's own Linux user,
in their 0700 home with their logins, not as root. The launcher is the person whose launch started
the workspace; after it stops, whoever launches the next one. Only the launcher can open Remote-SSH
there. The API's session list and view name them (`workspaceLauncherUserId`), so an editor can say
so before it opens instead of ending in a bare permission denial. Mend binds each account's person
in Sealant once (`users.bindPerson`). If it cannot (an older Sealant, a refusal), Remote-SSH stays
root and the session says `Remote-SSH: root, Core can't bind your person`; a Sealant that runs SSH
only as root gives `Remote-SSH: root, this Sealant runs it as root`. When a workspace falls back to
one shared home, Mend sets its SSH user back to root off the launch path, and until that lands the
session says `Remote-SSH unavailable · the workspace's SSH user is not yet back to root · retrying`.
A person launch whose Remote-SSH runs as root for any reason, a claimed standby included, says so on
its session line.
