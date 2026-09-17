---
"@sealant/mend": minor
---

Add budgets: what one client address, one account and one organization may ask of an instance. A
request body is refused before it is decoded (1 MiB; 24 MiB on the routes that take a file), a
WebSocket frame over 1 MiB closes its socket, requests are counted per minute per address and per
credential with a tighter window for sign-in attempts, and an account holds a bounded number of
unsettled sessions, launches starting at once, event streams, terminals, tunnels and key bridges. A
refusal is `429` (or `413`) with the budget's name, and never stops a running session or closes an
open connection. Every limit is a `MEND_BUDGET_*` variable, `0` turns one off, and
`docs/operations/budgets.md` lists them. `sessions.create` and `sessions.launch` gain the
`BudgetExceeded` error.
