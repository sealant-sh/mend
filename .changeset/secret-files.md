---
"@sealant/mend": minor
---

Secret files: a file you keep in Mend, encrypted at rest, written into every session you own before
its agent starts, such as `~/.aws/credentials`, a kubeconfig or an `.npmrc` token file.
`mend secrets add <path> --from <file>` keeps one (or reads stdin), `mend secrets` lists them by
path and size, `mend secrets rm <path>` removes one; the web app's settings page has the same list
with add and remove, and the phone shows it. They are yours alone, the content never comes back out
of the server, and a secret file is never captured: it goes into your own home directory in the
workspace, outside what sessions capture, a path under a captured directory such as `.claude` is
refused, and the workspace refuses to write through a symlink. In a workspace someone else launched
that shares one home, none of your secret files is written, and the session line names them:
`secret files · 1 not written · this workspace is another person's · ~/.aws/credentials`.
