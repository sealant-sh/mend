---
"@sealant/mend": minor
---

Mend's server can report its errors, traces and logs to a Sentry project its operator names, and
reports nothing until then. `mend server setup --sentry-dsn` turns it on for Mend's API, worker and
t3code gateway, `--sealant-sentry-dsn` for the bundled sealant, to a project of its own, and
`--sentry-browser-dsn` for the web app in the browser; `--sentry-environment` and
`--sentry-traces-sample-rate` say which environment and how many traces. `mend server status` says
where reports go. What leaves the server is scrubbed: no request bodies, prompts, agent or terminal
output, file contents, headers, cookies, tokens or environment.
