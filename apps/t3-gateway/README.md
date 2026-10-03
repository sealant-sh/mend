# @mend/t3-gateway

A t3code environment in front of Mend (ADR 0012, `docs/adr/0012-t3code-gateway.md`). t3code's
desktop, mobile and web clients add it as a remote environment and pair with a Mend pairing code. To
them it is a t3code server; to Mend it is an ordinary client of `/api`, calling with the device
token of the person who paired. Mend stays the only source of truth and its access rules apply
unchanged.

It runs on Effect `4.0.0-rc.115` from the `t3` catalog and speaks t3code's contracts from
`@mend/t3-contracts`, pinned to one t3code nightly tag. It does not import `@mend/api-contracts`: it
decodes only the Mend fields it reads.

## Phase 0: HTTP

| t3code route                      | What the gateway does                                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/t3/environment` | The descriptor: a persisted `environmentId`, `orchestrationProtocolVersion` 2, `serverVersion` `<t3code tag>+mend.<n>`, no optional capability |
| `POST /oauth/token`               | Claims the pairing code through Mend's `POST /api/pair`, keeps the device token, answers a bearer of its own (30 days, standard scopes)        |
| `POST /api/auth/websocket-ticket` | A gateway-local ticket for `/ws?wsTicket=`: single use, thirty seconds, in memory                                                              |
| `GET /api/auth/session`           | Authenticated while the bearer is live and Mend still accepts its device token (`GET /api/me/devices`; Mend has no `GET /api/me`)              |
| `POST /api/auth/browser-session`  | Refused: the gateway offers bearer tokens only                                                                                                 |
| pairing links and client sessions | Refused with `insufficient_scope`: devices are administered in Mend                                                                            |

| `GET /api/orchestration/shell` | The empty shell: no projects, no threads. The thread routes
beside it answer `thread_not_found` |

Refusals carry t3code's own error bodies (`EnvironmentAuthInvalidError`,
`EnvironmentRequestInvalidError`, `EnvironmentScopeRequiredError`, `EnvironmentInternalError`). The
project and pull request routes come with phase 1.

## Phase 0: the RPC socket

`GET /ws?wsTicket=…&orchestrationProtocol=2` upgrades to Effect RPC in JSON on `rc.115`, serving
t3code's whole `WsRpcGroup`. Without `orchestrationProtocol=2` it answers 426 with t3code's body. A
ticket is spent once; a socket without one may use the request's own bearer, as t3code allows. Each
socket gets its own RPC server, holding the handlers of the person who paired.

| Method                                                  | What the gateway does                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `subscribeServerConfig`, `server.getConfig`             | The config: the descriptor, and one provider per Mend harness from `GET /api/harnesses/models` read as the person |
| `subscribeServerLifecycle`                              | `welcome` with `bootstrapStatus: "complete"`, then open                                                           |
| `orchestration.subscribeShell`                          | The empty shell, the catch-up marker when asked, then open                                                        |
| `server.probe`                                          | `{}`                                                                                                              |
| every other command or read                             | A typed failure from the method's own contract, never a defect                                                    |
| feeds of things Mend never has (terminals, previews, …) | Open, and never emit                                                                                              |

`codex` is driver `codex` and `claude` is driver `claudeAgent`; other harnesses are left out. The
capability flags say what Mend does: a session keeps its model (`requiresNewThreadForModelChange`),
no rollback, no plan mode, runtime modes `full-access` (`bypass`) and `approval-required` (`ask`),
and no provider setup through t3code. Mend unreachable answers `ServerSettingsError`, which t3code
retries; a device revoked in Mend answers `EnvironmentAuthorizationError`, which blocks the
connection.

## Run it

Nothing in Mend starts the gateway. Run it beside a Mend server:

```sh
MEND_T3_GATEWAY_MEND_URL=http://127.0.0.1:3101 pnpm --filter @mend/t3-gateway start
```

| Variable                     | Default                                               |
| ---------------------------- | ----------------------------------------------------- |
| `MEND_T3_GATEWAY_MEND_URL`   | `http://127.0.0.1:3101`, Mend's API                   |
| `MEND_T3_GATEWAY_HOST`       | `127.0.0.1`. Anything wider is an exposure (ADR 0004) |
| `MEND_T3_GATEWAY_PORT`       | `3120`                                                |
| `MEND_T3_GATEWAY_STATE_PATH` | `$XDG_STATE_HOME/mend/t3-gateway/state.sqlite`        |
| `MEND_T3_GATEWAY_LABEL`      | `Mend`, the name t3code shows                         |

The gateway needs its own origin: t3code forces a remote environment's base path to `/`.

To pair, mint a code in Mend (`POST /api/me/devices/pairings`, or the devices page) and give t3code
the gateway's host and that code, or `http://<gateway>/pair#token=<code>`. The device shows in
Mend's device list as `t3code · <client label>`; revoking it there ends the bearer.

## State

One `node:sqlite` file the gateway owns: the environment id, bearer sessions (the bearer's sha256
and the Mend device token it stands for), and the id maps phase 1 fills (`project_ids`,
`thread_ids`, `message_ids`). Mend's database is never touched. Losing the file loses pairings and
t3code-side ids, never Mend records.

## Tests

`pnpm --filter @mend/t3-gateway test` runs the gateway on an ephemeral port in front of a fake Mend
and drives it with `HttpApiClient` over the vendored `EnvironmentHttpApi`, as a t3code client does.

- `test/ws.test.ts` is the handshake end to end: descriptor, `/oauth/token`, ticket, `/ws`, then the
  config snapshot naming the descriptor's environment, the welcome, and the empty shell. Its client
  is built as t3code's `client-runtime` builds one; `client-runtime` itself is not used (the test
  says why).
- `test/rpc-surface.test.ts` checks that the registered handlers are exactly the vendored group's
  methods, then calls every method not served over a bare socket with a payload generated from its
  own schema: each answers a typed failure its contract decodes, or stays silent if it is a feed.
