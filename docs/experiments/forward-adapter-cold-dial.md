# Forward adapter cold dial, local Docker and the box, 2026-10-25

ADR 0017 delivery step 5 asks for the cost of a cold dial on Docker and on Firecracker. This page
records the local Docker series and an end-to-end series on the box (VM 130). Firecracker is not
verified live.

A dial here is one `ForwardAdapter` dial: one workspace lookup (`getWorkspace`, a control-plane
GET), the loopback open, and a Docker sidecar open only after a loopback connection refusal.
`openMs` is the SDK's `workspace.forward(port, { flow: "bounded" })`: the WebSocket handshake to
Core, Core's authentication and daemon lookup, the runtime connection, the TCP connect inside the
workspace (plus the `/proc` check when bound), and the `ready` frame. Mend cannot split it.

## Setup

- Machine: Linux 6.18.57, 32 cores, Docker 29.9.1. Node 26.1.0 ran the driver; the repository pins
  26.4.0.
- Core 0.40.0-next.763 from Core's `compose.selfhost.yaml` (Postgres, migrate, API, worker), all on
  127.0.0.1: `sealant-api-next@sha256:2ed5ef53c86e…`, `sealant-worker-next@sha256:e516f51450ea…`.
  The workspace runs `sealantd-next:0.21.0-next.177@sha256:078b65210d4d…`.
- Transport: the host unix socket. The workspace's recorded endpoint is `unix:///…/control.sock`,
  and the API container has no Docker socket or `socat`. The Docker exec/socat transport was not
  selected and is not measured here.
- Workspace: `github.com/octocat/Hello-World` on the Docker runtime, with no Docker sidecar. The
  fixture is a Node HTTP/1.1 keep-alive server on port 3000 in a PTY session.
- Mend: branch `037/lp-05-forward-adapter`, the adapter itself (`ForwardAdapterLive`) over the same
  seam code as the live client, `ForwardPolicy` as noted per series.

## Method

`packages/sessions/bench/forward-dial.ts` writes one JSON line per dial (the adapter's
`ForwardDialRecord`) or per HTTP request. Each series is one process, run in sequence, with no other
load on the stack.

```sh
node packages/sessions/bench/forward-dial.ts probe --core http://127.0.0.1:24763 --key <key> \
  --owner usr_local --workspace <id> --port 3000 --runs 100 --out probe-port-ready.jsonl
# also: --port 3999 (nothing listens); --session <pty session id>; --rule allow-port-scoped;
# `cold` (a new forward per GET) and `warm` (one keep-alive forward for every GET)
node packages/sessions/bench/forward-dial-summary.ts *.jsonl
```

`probe` opens a forward and closes it, reading no bytes. `cold` sends 100 sequential GETs, each
through a new `ForwardAgent`, so each pays a dial. `warm` sends 100 GETs through one keep-alive
`ForwardAgent`, so only the first dials.

## Results

Milliseconds. N counts dials or requests. The worst value in each series is its process's first dial
(see the next section).

| Series                                       | Outcome               |   N | lookup median / p90 | open loopback median / p90 | open docker median / p90 | total median / p90 / worst |
| -------------------------------------------- | --------------------- | --: | ------------------- | -------------------------- | ------------------------ | -------------------------- |
| probe, port 3000, port-scoped, run 1         | ready                 | 100 | 2.0 / 3.0           | 1.5 / 2.1                  |                          | 3.7 / 5.3 / 22.1           |
| probe, port 3000, port-scoped, run 2         | ready                 | 100 | 1.8 / 2.4           | 1.4 / 2.0                  |                          | 3.2 / 4.4 / 22.5           |
| probe, port 3000, port-scoped, run 3         | ready                 | 100 | 1.5 / 2.2           | 1.2 / 1.8                  |                          | 2.8 / 3.9 / 21.1           |
| probe, port 3000, session-bound              | ready, session proved | 100 | 1.9 / 2.9           | 2.7 / 3.6                  |                          | 4.7 / 6.9 / 23.0           |
| probe, port 3999, port-scoped                | refused, connection   | 100 | 1.7 / 2.2           | 1.2 / 1.4                  | 3.1 / 4.2                | 6.1 / 8.0 / 76.7           |
| probe, port 3999, bound, `refuse`            | refused, connection   |  50 | 1.7 / 2.4           | 1.4 / 2.3                  | not tried                | 3.1 / 4.7 / 21.3           |
| probe, port 3999, bound, `allow-port-scoped` | refused, connection   |  50 | 1.8 / 2.2           | 1.3 / 1.8                  | 2.4 / 3.0                | 5.4 / 7.4 / 24.2           |
| GET, a new forward per request               | 200                   | 100 | 1.5 / 2.0           | 1.1 / 1.5                  |                          | 2.6 / 3.7 / 21.4           |

| HTTP series                               |   N | time to first byte median / p90 / worst |
| ----------------------------------------- | --: | --------------------------------------- |
| GET, a new forward per request (cold)     | 100 | 3.0 / 4.2 / 29.3                        |
| GET on one keep-alive forward (warm)      |  99 | 0.2 / 0.3 / 0.8                         |
| the warm series' first GET, which dialled |   1 | 26.6                                    |

Every ready dial arrived on loopback. Every Docker attempt answered `name-unresolved` (the workspace
has no sidecar), so each refused dial reported the loopback refusal, as the fallback rule says. No
dial failed for any other reason.

## What the numbers say

- A cold dial costs about 3 ms here: about 1.5 to 2 ms of lookup and 1.2 to 1.5 ms of open. A cold
  GET costs about 3 ms to its first byte, against 0.2 ms on a kept-alive forward.
- Binding a dial to a session adds about 1.3 ms to the open (2.7 against 1.4 ms median).
- A refused port-scoped dial costs a second open (3.1 ms median) for the Docker attempt.
- The lookup is as large as the open. The adapter makes one lookup per dial by design; a warm
  forward skips both.
- The first dial in each process costs 16 to 17 ms of lookup and 21 to 23 ms in total (76.7 ms when
  its Docker attempt was also the process's first name lookup). Later dials in the same process stay
  at or under 16.3 ms, and under 11.5 ms outside the refused port-scoped series. The likely cause,
  not measured apart, is the first HTTP request of a new SDK client paying its connection setup,
  which a running Mend server would pay once.

## The box, end to end

The box series measures what a person sees, not the adapter alone: a GET through
`mend service connect` from a laptop, where each new local connection pays a ticket, a WebSocket and
a dial, against GETs on one kept-alive local connection, which dial once.

### Setup

- Server and CLI: Mend `0.37.0-next.1096` (it contains #1147, the adapter), alpha.mend.run on the
  box, a Docker install. The CLI ran on a laptop outside the box, from the npm package of the same
  version.
- Project: `octocat/Hello-World`, adopted private as `lp-step5-dial`, and one session that wrote
  `mend.toml` and a one-line Node server (`step5 <path>` on 127.0.0.1:3000), then slept.
- `mend service run <session> web --wait --no-connect`, then
  `mend service connect web --port 43872`. The tunnel dials port-scoped, after the upgrade
  (`apps/api/src/routes/service-tunnel.ts`).
- One warm-up GET, then the series, one request at a time. The box was serving other sessions at the
  same time, which this series does not control for.

### Results

Milliseconds, measured by curl on the laptop.

| Series                                                     |   N | median |   p90 | worst |
| ---------------------------------------------------------- | --: | -----: | ----: | ----: |
| TCP connect to alpha.mend.run (one network round trip)     |  30 |   44.8 |  45.1 |  45.2 |
| `GET /api/health` on a new HTTPS connection, first byte    |  30 |  140.6 | 141.7 | 142.2 |
| tunnel GET, a new local connection each (cold), first byte |  30 |  255.0 | 299.2 | 365.6 |
| tunnel GET on one kept-alive local connection (warm)       |  30 |   46.0 |  46.4 |  48.1 |
| the warm series' first GET, which dialled                  |   1 |  367.0 |       |       |

Every request answered 200.

### What the numbers say

- A warm tunnel GET costs one network round trip (46.0 against 44.8 ms). The tunnel and the forward
  add about 1 ms on top.
- A cold tunnel GET costs about 210 ms more than a warm one. The CLI mints a ticket, opens a new
  WebSocket (TCP and TLS), upgrades, and the server dials before the request crosses. That is five
  round trips, or about 224 ms at 44.8 ms each, if the ticket request reuses the CLI's kept-alive
  HTTPS connection. It must: seven round trips (314 ms) is more than the median.
- What is left, about 31 ms at the median, is the server's share of a new connection: minting and
  spending the ticket, authorizing the caller, and the adapter's dial. A cold dial on the box costs
  at most that. This series cannot split it further. The adapter logs a ready dial's trace only at
  debug level, and reading the server's logs needs access to the box beyond the CLI.
- For a person, network round trips dominate a cold connection here, and the dial does not. The
  preview gateway in delivery step 7 keeps each viewer's forwards alive, so a page pays a dial once
  per pooled socket, not once per request.

The project, its worktree and its session were removed afterwards.

## What this does not cover

- Firecracker, which is not verified live. There the daemon connection is a WebSocket through the
  VM's authenticated endpoint, so each open adds a remote TLS handshake.
- The adapter's own phases on the box (lookup against open). The box series bounds the server's
  whole share of a new connection, and does not split it.
- The Docker exec/socat daemon transport, which spawns a process per dial.
- Load: one dial at a time, on loopback, on an idle stack. These numbers bound nothing under
  contention.
- The Service tunnel end to end. Its upload is bounded at every hop: the CLI pauses the local
  connection while its WebSocket holds more than 1 MiB unsent, the route holds at most 1 MiB the
  workspace has not taken, and the forward's window holds the rest. Its download is bounded only in
  the forward: Effect's server WebSocket writer and the CLI's WHATWG receiver have no drain, so a
  slow local client grows the API's and the CLI's buffers.
- Leaving behind a held upload. A tunnel client that closes while more than the route's 1 MiB hold
  is in flight toward a workspace that takes nothing is seen only once the workspace reads, ends or
  resets: its close frame is behind that data. ServiceHost's relay has the same limit once it stops
  reading a client socket, because Node does not see a reset on a paused TCP socket.

## Raw results

The JSON lines and the box series' curl timings are kept on the machine that ran them, outside the
repository, in the step's audit directory (`.audit/step5/bench-results/`). The Core stack and its
workspace were removed after the run.
