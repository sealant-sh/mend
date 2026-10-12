---
"@sealant/mend": patch
---

Refuse a flag a command does not list, before the command reads, locks or sends anything.
`mend dotfiles sync --dry-run` used to upload anyway; it now exits 1 with `unknown flag --dry-run`
and the command's usage line. A flag that takes a value no longer takes the next flag as its value:
`mend skills push --project --prune` pushes to the current directory's project and prunes, and
`mend land <session> --branch --no-pr` says `--branch needs a value`.

Also refused now: `--` outside `mend run` and `mend service run`, an unknown short flag such as
`-n`, `--flag=value` spellings other than `--json=v2`, and flags placed before a subcommand's name
(`mend skills --project web push`), which used to run a different subcommand. The help pages now
list flags commands already read: `snake --no-tunnel`, `refresh --project`, `ssh --host`,
`env cluster --clear`, and `-y` for `uninstall`, `session share` and `workspace replace`.
