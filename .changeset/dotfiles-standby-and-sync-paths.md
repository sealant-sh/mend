---
"@sealant/mend": patch
---

A standby workspace is no longer handed to a session after its owner changes the dotfiles
repository's branch, subdirectory, manager or `install.sh` setting. Before, only the URL and branch
were compared, so a session could start with the manager the standby was warmed with; now any saved
change sends the next session cold and the next reconcile warms a standby with the new setting.
Every standby warmed before this release is replaced once after upgrading.

`mend dotfiles sync <paths...>` refuses a path outside your home directory before it reads the file.
Before, `mend dotfiles sync ../file` read the file and uploaded it, and only the server refused it.
An absolute path under your home directory (what a shell makes of `~/.zshrc`) is now taken as its
home-relative path.
