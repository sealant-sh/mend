---
"@sealant/mend": patch
---

VS Code Remote-SSH into a per-person workspace runs as its launcher's own Linux user, in their 0700
home with their logins, not as root. The launcher is the person whose launch started the workspace;
after it stops, whoever launches the next one. A person launch names the launcher as the workspace's
SSH user at create, where the Sealant control plane reports `workspaceSshUser` (sealant#348); a
prepare that falls back to one shared home sets it back to root, off the launch path and retried;
until Sealant takes it, the session says `Remote-SSH unavailable`. Only the launcher can open
Remote-SSH there, as before. SFTP (and `scp`) is refused in such a workspace until Sealant pins a
sealantd that runs it as the user.
