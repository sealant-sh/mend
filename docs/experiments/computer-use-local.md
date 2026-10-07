# Computer-use prototype: local reproduction and recovery

This runbook belongs to the [implementation handoff](computer-use.md). It describes the Linux amd64
experiment exercised on 2026-10-07, not a supported Mend installation. Use the standalone fixture to
try the optional pilot. Use a real captured session to exercise the coding agent's own MCP tools,
session authorization, and saved replay.

## Checkout and build

The existing checkout is `/home/yiannis/Developer/OSS/Sealant/Mend-desktop-pilot`, branch
`feat/desktop-pilot`. The original `Mend` checkout has unrelated work. The final implementation
commit is `b96af101b`; the original handoff commit is `7db701616`. The documentation-only PR does
not include these implementation commits. Run the commands below in the prototype checkout, not the
documentation-only branch.

From the experiment checkout:

```sh
pnpm install --frozen-lockfile
pnpm --filter @mend/api-server build
pnpm --filter @mend/web build
pnpm --filter @sealant/mend build
docker build --platform linux/amd64 -f deploy/desktop/Dockerfile -t mend-desktop:pilot-v4 .
```

The image must exist on the Docker executor that provisions the workspace. Rebuilding a tag already
compiled by Core does not invalidate its custom-base cache. Use a new immutable revision and update
the project image when changing image contents. The v4 preset runs a syntax check of
`pilot-home.mjs`; a setup command is not an image-cache invalidation mechanism.

The host `~/.local/bin/mend` points to this checkout's `apps/cli/dist/main.js`. Its executable bit
was set after building. The existing CLI server configuration still points to the user's remote
instance. Merely installing this local CLI does not select the loopback test server. The web test
and workspace-injected session channel used the isolated instance below.

## Standalone fixture

Prerequisites are Docker and a host sign-in for the CLI being tested. The fixture mounts only
existing Claude/Codex login files, read-only, rather than the whole host home.

```sh
node scripts/desktop-preview.mjs start --build
MEND_DESKTOP_PREVIEW_URL=http://127.0.0.1:6090 pnpm --filter @mend/web dev
```

Open <http://127.0.0.1:3105/desktop-experiment>. Select the harness and action/code mode, and ask it
to open `http://127.0.0.1:6090/demo`, click **Add one** twice, and enter a name. Compare its
reported observation with the page. The bundled demo displays `Hello, <name>` without an exclamation
mark.

Take control during a longer task, use the desktop manually, then release control. Verify the pilot
stops and its recording appears. The fixture has no Mend sign-in and binds to host loopback. It runs
as UID/GID 1000, with a 3GB memory limit, four CPUs, 512MB shared memory, dropped capabilities, and
`no-new-privileges`.

Artifacts persist in `~/.local/share/mend/desktop-preview/runs/`. The named container is
`mend-desktop-pilot-preview`; an existing container is reused even after rebuilding the image.
Changing its image or mounts requires recreating that specific fixture. Stop it with:

```sh
node scripts/desktop-preview.mjs stop
```

The standalone fixture does not provide a real Mend session channel. It validates the separate pilot
and display, not lazy startup from the primary coding agent's MCP client.

## Real session acceptance

Use a Mend instance with connected Claude/Codex accounts, captured session storage, a reachable
session channel, and the matching public Sealant SDK/Core. The observed pair was `0.39.0-next.696`.
Keep the normal application origin, auth, socket and capture configuration. See
[server setup](../../apps/docs/src/content/docs/getting-started/install.md) for the supported
installation entry point; the custom private fixture below is historical test setup.

1. In a project's **Setup → Environment**, select **Use desktop image** and save. Confirm the
   selected image revision is available on the executor.
2. Start a fresh native Claude or Codex session with the owner's connected login. Existing CLI
   processes need relaunching to load MCP registration.
3. Ask the coding agent to create a counter page and start it through `mend service run`, listening
   on IPv4 inside the workspace. Ask it to verify the page in Chromium using its desktop tools,
   record the interaction, and report what it sees. Use explicit expected text so a mismatch is
   visible in the result.
4. The first desktop tool call should start the desktop Service. Confirm the terminal stays on the
   left, the live desktop appears on the right, and the agent operates that same display.
5. Confirm a completed recording, final image, action log and result appear. Play and seek the MP4.
6. During an active desktop operation, take control. Confirm pending desktop work stops, manual
   input works, and the primary coding process remains alive. Release control explicitly.
7. Stop the workspace through Mend after the completed artifacts are captured. Reopen the session
   and verify saved replay, capture provenance, and seeking with live controls disabled.

The session UI can also start the desktop explicitly and launch an optional separate pilot. That
pilot uses a separate credentials/native conversation home. It is a different acceptance path from
the coding agent using its own MCP tools.

## Existing isolated test installation

Private fixture root: `~/.local/share/mend/desktop-pilot`. Store root:
`~/.local/share/mend/desktop-pilot-store`. The test database is `mend_desktop_pilot` on the existing
local Postgres listener at port 5434. It has its own local account and auth secret; existing
accounts and the main database were not changed.

| Component                               | Observed local address or file                             |
| --------------------------------------- | ---------------------------------------------------------- |
| Built Mend API                          | `http://127.0.0.1:3101`, `api.pid`, `api-built.log`        |
| Built web front                         | `http://127.0.0.1:3105`, `web.pid`, `web-built.log`        |
| Web's internal Nitro server             | `127.0.0.1:3210`                                           |
| Session channel in private Core network | `http://channel:3106`                                      |
| Private Core API                        | `http://localhost:4000`                                    |
| Development Garage blob store           | host port 3900; workspace-visible `http://172.17.0.1:3900` |
| Host channel relay                      | `channel.pid`, `channel.log`, `channel.sock`               |
| Core compose configuration              | `core/compose.json`                                        |
| Local sign-in details                   | `local-account.json`, mode 0600                            |
| Runtime environment                     | `runtime-env.json`, mode 0600                              |
| Core secrets                            | `core/secrets.json`, mode 0600                             |

The private JSON files contain credentials and are deliberately outside git. Read them locally only
when needed; do not paste them into reports. If they disappear, provision fresh test credentials
through normal setup rather than trying to reconstruct their values from this doc.

Non-secret runtime choices were `MEND_SESSION_STORE=captured`, `MEND_EXPOSURE=loopback`,
`APP_URL=http://127.0.0.1:3105`, `SEALANT_BASE_URL=http://localhost:4000`,
`MEND_SESSION_ENDPOINT_LISTEN=0.0.0.0:3106`, `MEND_SESSION_ENDPOINT_URL=http://channel:3106`, and
`MEND_EXECUTOR_NETWORK=private`. `MEND_DESKTOP_PREVIEW_URL=http://127.0.0.1:6090` enabled only the
development fixture route. Database, blob-store, Core and auth secrets come from the private runtime
file.

Core uses a private Compose project, `mend-desktop-core`, with network `mend-desktop-core_default`,
a Postgres 17 container, and API/worker images pinned to `0.39.0-next.696`. Its daemon control
directory is `/tmp/mdpctl`; a longer home-directory path failed Linux Unix-socket pathname limits.
The worker needs its configured Docker/control sockets.

The host firewall blocked container-to-host TCP port 3106. The test workaround has two parts:

- `host-channel.mjs` accepts a private Unix socket and forwards to host `127.0.0.1:3106`.
- `container-channel.mjs` in the Core network listens on TCP 3106 and forwards through the mounted
  `/relay/channel.sock`. It has no published host TCP port.

The relay is test infrastructure, not a proposed product transport. On a new machine, configure
normal executor-to-Mend reachability first; use platform feedback for missing SDK capabilities.
Start dependencies before Mend: database/blob storage, private Core and its migrations, channel
relay, API, then web. Check the corresponding component logs if the session cannot connect.

## Restarting the existing built API or web

Inspect the saved PID and `/proc/<pid>/cmdline` before stopping a process. Stop only a process whose
command names this experiment checkout. Restart after rebuilding; a live process keeps its old code.
Keep Core and the channel relay running unless they are the part being repaired.

The following snippet starts either built app with the existing private environment, writes its own
PID/log, and refuses to overwrite a live PID. Set `app` to `api` or `web`. Run it from the
experiment checkout only after the corresponding listener is free:

```python
import json
import os
from pathlib import Path
import subprocess

app = "api"
root = Path.cwd()
fixture = Path.home() / ".local/share/mend/desktop-pilot"
entries = {
    "api": root / "apps/api/dist/main.js",
    "web": root / "apps/web/.output/front.mjs",
}
entry = entries[app]
pidfile = fixture / f"{app}.pid"
if pidfile.exists() and (Path("/proc") / pidfile.read_text().strip()).exists():
    raise SystemExit("Saved PID is live; inspect and stop that process first")
env = dict(os.environ)
env.update(json.loads((fixture / "runtime-env.json").read_text()))
env["PORT"] = "3101" if app == "api" else "3105"
with (fixture / f"{app}-built.log").open("ab") as log:
    process = subprocess.Popen(
        ["node", str(entry)],
        cwd=root / f"apps/{app}",
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
pidfile.write_text(str(process.pid))
```

Open the built app at <http://127.0.0.1:3105>, and sign in with the private local account.
Production asset/CSP/proxy behavior was verified here, not only through Vite development mode.

When shutting the fixture down, finish/stop its sessions through Mend and allow completed files to
be captured. Stop the verified web/API/relay PIDs and then the private Core Compose project. Keep
its volumes and store if replay is still needed. Avoid machine-wide process/container cleanup.

## Retained sessions and verification commands

| Case                            | Session ID                             | Selected image          |
| ------------------------------- | -------------------------------------- | ----------------------- |
| Native Codex terminal           | `0c28afa3-a5b1-4f49-b57e-ba8c8c8e15ff` | `mend-desktop:pilot-v3` |
| Native Claude terminal          | `ba7ded16-50e2-446b-be57-16bf29441103` | `mend-desktop:pilot-v4` |
| Original separate-pilot session | `8633505e-781a-4acd-a34c-2c7cb9b2a3c9` | `mend-desktop:pilot-v2` |
| Earlier stopped replay fixture  | `102ae8bd-e146-4b30-931a-92a1fb484dc1` | Earlier revision        |

The successful native recordings and exact results are in
[computer-use-evidence.json](computer-use-evidence.json). Its videos and screenshot are portable;
the session IDs above depend on the private local database/store still existing.

The implementation checks used:

```sh
node --test deploy/desktop/control.test.mjs deploy/desktop/pilot-home.test.mjs
pnpm --filter @mend/sessions test src/harness-seeds.test.ts src/workspace-note.test.ts
pnpm --filter @mend/api-server test src/routes/desktop-http.test.ts src/routes/desktop-capture.test.ts
pnpm --filter @mend/web test src/lib/workspace-environment.test.ts
pnpm exec turbo typecheck --force
pnpm exec turbo lint --force
pnpm format:fix
```

These checks supplement the real browser/provider acceptance. The controlled takeover probe was a
controller test, not a second provider-driven task. Broader shipping acceptance and remaining
limitations are in the handoff.
