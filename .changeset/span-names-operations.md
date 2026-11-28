---
"@sealant/mend": patch
---

When a server reports to Sentry, each of Mend's spans is named for the operation it times, in the
area it belongs to (`mend.workspace.install_dependencies`, `mend.memory.deliver`,
`mend.turn.steer`), with a short description of its own ("install workspace dependencies") instead
of a word copied from its name. The web tier's procedures read in snake case
(`mend.web.sessions.inbox_row`). A request no route matched is named by its path with its IDs and
codes taken out, and a call's path and URL never carry a CLI sign-in code, a link's token or a
resource's name.
