---
"@sealant/mend": minor
---

Secret files: a file you keep in Mend, encrypted at rest, written into every session you own before
its agent starts, such as `~/.aws/credentials`, a kubeconfig or an `.npmrc` token file.
`mend secrets add <path> --from <file>` keeps one (or reads stdin), `mend secrets` lists them by
path and size, `mend secrets rm <path>` removes one; the web app's settings page has the same list
with add and remove, and the phone shows it. They are yours alone, the content never comes back out
of the server, and a secret file is never captured: it goes into the workspace's own home directory,
a path under a captured directory such as `.claude` is refused, and the workspace refuses to write
through a symlink.
