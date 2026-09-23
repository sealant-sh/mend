# Budgets

What one account, one organization and one client address may hold or ask of a Mend instance
([ADR 0004](../adr/0004-access-without-a-private-network.md), "Budgets"; MEND-05). A budget refuses
new work with `429` (or `413` for a body), the budget's name and, for a window, `Retry-After`. It
never stops a running session, never closes a connection that is already open and never drops a
capture. Every refusal happens before the effect it guards: the request windows and the body limit
before routing and authentication, the session and connection budgets after authorization (so a
refusal never says whether something you may not see exists).

| Variable                                     | Default    | What it bounds                                                                                                        |
| -------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `MEND_BUDGET_BODY_BYTES`                     | `1048576`  | One request body. A declared length over it is refused unread; an undeclared body is cut at it.                       |
| `MEND_BUDGET_UPLOAD_BODY_BYTES`              | `25165824` | The same, for the routes that take a file: pasted images, `skills sync`, folder uploads, dotfiles, workspace image.   |
| `MEND_BUDGET_FRAME_BYTES`                    | `1048576`  | One WebSocket frame from a client on a terminal, a service tunnel or the key bridge. Over it, the socket closes 1009. |
| `MEND_BUDGET_ADDRESS_REQUESTS_PER_MINUTE`    | `1200`     | Requests from one client address, counted before authentication.                                                      |
| `MEND_BUDGET_CREDENTIAL_REQUESTS_PER_MINUTE` | `1200`     | Requests presenting one credential (a session cookie or a bearer), valid or not.                                      |
| `MEND_BUDGET_SIGN_IN_ATTEMPTS_PER_MINUTE`    | `20`       | Sign-in, sign-up, password reset and invitation attempts from one address.                                            |
| `MEND_BUDGET_ACCOUNT_LIVE_SESSIONS`          | `24`       | Unsettled sessions one account holds.                                                                                 |
| `MEND_BUDGET_ORGANIZATION_LIVE_SESSIONS`     | `120`      | Unsettled sessions one organization holds.                                                                            |
| `MEND_BUDGET_ACCOUNT_LAUNCHES_IN_FLIGHT`     | `4`        | Launches one account has starting at once.                                                                            |
| `MEND_BUDGET_BUNDLE_BYTES`                   | `67108864` | One `mend pull` bundle (`GET /changes/:id/bundle`). A larger one is refused with 413 and its size.                    |
| `MEND_BUDGET_ACCOUNT_EVENT_STREAMS`          | `12`       | Open event streams (one per browser tab or client) for one account.                                                   |
| `MEND_BUDGET_ACCOUNT_TERMINALS`              | `24`       | Open terminal sockets for one account.                                                                                |
| `MEND_BUDGET_ACCOUNT_TUNNELS`                | `24`       | Open service tunnels for one account.                                                                                 |
| `MEND_BUDGET_ACCOUNT_KEY_BRIDGES`            | `4`        | Open ssh-agent shares for one account.                                                                                |

`0` turns one budget off. The API logs at start which are off, and the public exposure gate needs
every one of them set.

## What they are, exactly

- **The client address** is the one `@mend/network` resolves: the socket's address, or, when the
  socket is a trusted hop (`MEND_TRUSTED_PROXIES`, and loopback), the rightmost `X-Forwarded-For`
  entry that is not itself a trusted hop. A client cannot choose it. IPv6 is counted by its /64.
  When every hop is trusted (a load balancer inside a trusted CIDR that does not forward its client,
  a pod dialling the API directly), the address is the socket's own and is counted like any other,
  so clients hidden behind such a hop share one window: that shows as refusals, and the fix is to
  make the hop forward its client or to narrow `MEND_TRUSTED_PROXIES`. The one request not counted
  by address is a loopback socket with no `X-Forwarded-For`: a process on the machine itself.
  Sign-in attempts are counted from every address, that one included.
- **The credential** is the `Authorization` value and the value of each session cookie, each counted
  apart. The rest of a `Cookie` header is ignored, so padding it changes nothing.
- **Bodies.** A declared length over the limit answers `413` unread. A body that does not declare
  its length is cut at the limit: the route's read fails, and what the client sees is that route's
  error (a `400`, or `413` on sign-in routes), not a budget refusal.
- **Windows are bounded.** One window remembers at most 50,000 subjects; past that, new subjects
  share one overflow window until idle ones leave.
- **Not budgeted here:** resuming a session or opening a shell takes no launch slot, and Mend's own
  hot-pool and job provisions are not counted against a ceiling.
- **Request windows are per API process**, in memory. The API runs as one process today. With N
  processes an address reaches N times the rate.
- **Session ceilings are counted from the database**, connection budgets from the connections this
  process holds. Two requests that arrive together can both pass a ceiling: it can be overshot by
  the number in flight, never by more.
- **Frames.** Effect's Node HTTP server builds its WebSocket server without options, so the `ws`
  library buffers a frame up to its own 100 MiB default before Mend sees it. Mend then refuses to
  forward it and closes the socket. The frame budget and the connection budget together bound the
  total; they do not bound the single frame. What would close this: a `maxPayload` option upstream.
- Core enforces its own budgets behind these (CORE-04). Mend's come first and say more.
