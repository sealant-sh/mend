---
"@sealant/mend": minor
---

The CLI can report errors it did not expect to a Sentry project, with stack traces that read as its source. It is off unless `MEND_SENTRY_DSN` is set, and no published build sets it. A report carries the error's type, its message with URLs, tokens and paths taken out, the CLI's own frames, the command's name and the CLI's version. It never carries arguments, environment, configuration or anything the server answered. The CLI ignores a `SENTRY_DSN` your shell holds for your own app.
