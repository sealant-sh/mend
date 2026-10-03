---
"@sealant/mend": minor
---

One model picker, the same on every client, and the server owns the list. The models each harness
offers now live in a table on the server, seeded with what Claude and Codex take today and editable
in place, and `GET /api/harnesses/models` hands every client the same list with the default and the
efforts each model takes. The phone's session composer picks from it with the default preselected,
as the web and desktop composers and the VS Code picks do; `mend models` prints it, and `--effort`
takes `ultra` where the model does. A launch that names no model runs the harness's default from
that list, and every session records the model and effort it was started with: the session page, the
phone's session header, the desktop's tab bar and `mend sessions` show them.
