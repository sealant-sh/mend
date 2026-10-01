---
"@sealant/mend": patch
---

`mend connect codex` gives Mend a Codex login of its own: it runs `codex login --device-auth` in a
throwaway directory, sends that login and deletes it, instead of sending this machine's
`~/.codex/auth.json`, whose refreshes the laptop would race. `--use-my-login` still sends the shared
one. `mend accounts` and `mend doctor` say `reconnect needed · the provider refused the login` for
an account the platform could not refresh. ADR 0008 and a new page, "How Mend handles your logins",
describe the platform as the only refresher of a login and every other copy as one that cannot
rotate.
