# Forward adapter cold dial, local Docker, 2026-10-25

ADR 0017 delivery step 5 asks for the cost of a cold dial on Docker and on Firecracker. This page
records the local Docker series. The box (VM 130) and Firecracker series are still to run.

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

## What this does not cover

- The box and Firecracker. On the box Core is in the Mend image; on Firecracker the daemon
  connection is a WebSocket through the VM's authenticated endpoint, so each open adds a remote TLS
  handshake. Both series stay open for delivery 5.
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

The JSON lines are kept on the machine that ran them, outside the repository, in the step's audit
directory (`.audit/step5/bench-results/`). The Core stack and its workspace were removed after the
run.
