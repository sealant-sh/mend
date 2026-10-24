# Services on the box, 2026-10-24

ADR 0017 delivery step 2: a recipe Service opened through `mend service connect`, with its evidence
recorded. Yiannis made "services work properly in alpha" the gate for Slack work on 2026-09-23, and
the proof was never recorded before the EC2 alpha was torn down. alpha.mend.run now runs on the box
(VM 130), so the check ran there.

## Setup

- Server: alpha.mend.run, Mend `0.36.0-next.1076`, a Docker install on the box. Its `/api/health`
  reports `deploymentMode: "local"`. The check did not record the workspace runtime. CLI:
  `mend 0.36.0` on a laptop outside the box.
- Project: `octocat/Hello-World`, adopted private as `lp-step2-proof`. It is a public repository
  with one README and no dependencies.
- Session: `mend run` wrote `mend.toml` and a 4-line Node server into the worktree
  (`/workspace/repo`), copied the server to `/tmp/step2-server.js` in the workspace, and slept.

```toml
[service.web]
port = 3000
browserScheme = "http"
command = "node /tmp/step2-server.js"
```

The server answers `mend step 2 services proof <method> <path>` to every request.

## What was observed

| Check                                                      | Observed                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `mend service run <session> web --wait --no-connect`       | `✓ Service web · reachable`, exit 0.                                                              |
| `mend service connect web --port 43871` on the laptop      | `● web → 127.0.0.1:43871 (tunnel to https://alpha.mend.run)`                                      |
| `GET /pricing?x=1` through the tunnel                      | `HTTP/1.1 200 OK`, `Connection: keep-alive`, body `… GET /pricing?x=1`                            |
| `POST /form` with an 11-byte body                          | body `… POST /form`. The server echoes only the request line, so the body's arrival is unchecked. |
| `POST /upload` with a 5,000,000-byte body                  | 200 in 0.29 s. As above, the bytes received were not counted.                                     |
| `mend service stop web`                                    | `✓ stopped · web`. A request to `127.0.0.1:43871` then gets an empty reply (`curl: (52)`).        |
| 20 s later                                                 | The same `service connect` process (pid 1522223) still listens on 43871, and still gets `(52)`.   |
| `mend service run <session> web --wait --no-connect` again | A request to `127.0.0.1:43871` answers `… GET /after-restart`, with that process still running.   |

The project, its worktree and both sessions in it were removed afterwards. The transcript below has
each command and the lines of its output that the table quotes.

## What this does not cover

- Which path read the recipe. Mend reads a co-located worktree directly and otherwise reads the
  workspace's copy (`packages/sessions/src/engine.ts`, `fileRecipesOf`). The check did not record
  which one ran, so the executor-side read stays unproved.
- Whether the session ran in capture mode, and the flush at stop.
- `mend attach` printing the Service, hot reload through the tunnel, and the web Services card. The
  "Services on alpha" item in `docs/current-scope.md` names those, and they stay open.
- A Service started by an agent's own `mend service run --http …` in a turn.

## Found

- `mend service connect` keeps its local listener after the Service stops, and prints nothing. A
  client then gets an empty reply with no reason. The current-scope check expects a stop to close
  the tunnel, and for `connect` it did not. Each local connection opens its own WebSocket with its
  own ticket, so after the restart the kept listener answered again. Whether `mend attach` closes
  its tunnel on a stop was not checked here. Its unit test expects it to
  (`apps/cli/src/service-tunnels.test.ts`).
- After the restart, `mend service run` printed `mend service connect web → 127.0.0.1:43100` while a
  `connect` listener was already open on 43871. The hint does not know about the open listener.

## Transcript

Output is cut to the lines the table quotes. `<b64>` stands for the two files, base64-encoded.

```text
$ mend --version
mend 0.36.0
server 0.36.0-next.1076 · https://alpha.mend.run
$ mend adopt https://github.com/octocat/Hello-World.git --name lp-step2-proof --auth mend-key --private
✓ adopted · lp-step2-proof · /var/lib/mend/store/fde8d877-555a-4e10-96d6-dac943c878ad/repo.git
  visible to only you
$ mend run --project lp-step2-proof --worktree step2-services --detach --json -- sh -c "echo <b64> | base64 -d > mend.toml; echo <b64> | base64 -d > server.js; cp server.js /tmp/step2-server.js; cat mend.toml; pwd; sleep 3600"
"sessionId": "d63549e5-7dbd-44cf-bb51-c495dfe274f5"
$ mend logs d63549e5
[service.web]
port = 3000
browserScheme = "http"
command = "node /tmp/step2-server.js"
/workspace/repo
$ mend service run d63549e5 web --wait --timeout 3m --no-connect; echo rc=$?
✓ Service web · reachable
rc=0
$ mend service connect web --port 43871 &
● web → 127.0.0.1:43871 (tunnel to https://alpha.mend.run)
$ curl -i 'http://127.0.0.1:43871/pricing?x=1'
HTTP/1.1 200 OK
Connection: keep-alive
mend step 2 services proof GET /pricing?x=1
$ curl -X POST --data 'hello=world' http://127.0.0.1:43871/form
mend step 2 services proof POST /form
$ curl -X POST --data-binary @big.bin http://127.0.0.1:43871/upload   # 5,000,000 random bytes
POST 5 MB 200 0.290295s
$ mend service stop web
✓ stopped · web
$ curl http://127.0.0.1:43871/
curl: (52) Empty reply from server
$ sleep 20; pgrep -af "service connect web"; ss -ltnp | grep 43871; curl http://127.0.0.1:43871/
1522223 node …/apps/cli/dist/main.js service connect web --port 43871
LISTEN 127.0.0.1:43871 users:(("node-MainThread",pid=1522223,fd=22))
curl: (52) Empty reply from server
$ mend service run d63549e5 web --wait --timeout 3m --no-connect
✓ Service web · reachable
$ curl 'http://127.0.0.1:43871/after-restart'
mend step 2 services proof GET /after-restart
$ pkill -f "service connect web --port 43871"
$ mend stop --services d63549e5; mend stop d63549e5
$ mend worktrees rm step2-services --force --project lp-step2-proof
removed · step2-services · its sessions, change, checkpoints and review went with it
$ curl -X DELETE https://alpha.mend.run/api/projects/fde8d877-555a-4e10-96d6-dac943c878ad
{"removed":true,"leftover":null}
```

An earlier session in the same worktree (`709e3383`) wrote a recipe whose quoting came out wrong,
and was stopped before the run above.
