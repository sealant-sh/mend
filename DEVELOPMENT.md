# Developing Mend

How to get a checkout running and tested. `AGENTS.md` holds the rules and the checks before a PR.
For an installed server, see [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md).

## First run

```sh
direnv allow     # Node and pnpm at the pinned versions; or match .node-version and packageManager
pnpm install     # first, in every fresh worktree
pnpm build       # once: generates the gitignored route trees that typecheck needs
cp .env.example .env
pnpm dev
```

`pnpm dev` starts Postgres (port 5434) and Garage (3900) from `compose.dev.yaml`, the web app on
**3105** and the API on **3101**, then runs migrations. Open `http://localhost:3105`.

## Environment

`.env.example` is a working set for a Linux Docker host. `pnpm dev` loads `.env`; a variable set in
the shell wins. Three things need care:

- **Sealant.** Mend reaches the platform only through the SDK, at `SEALANT_BASE_URL`. A local
  sealant stack serves port 4000; the SDK's default, 8080, fails. Without a working sealant the web
  app starts but no session launches. Set `SEALANT_SERVICE_KEY` when that control plane has service
  keys, and configure sealant's worker to mount the store paths this API uses.
- **Executor reachability.** `MEND_SESSION_ENDPOINT_URL` and `MEND_BLOB_STORE_PUBLIC_URL` are read
  from inside the executor container, not from your shell. On Linux, name the docker0 bridge IP
  (`172.17.0.1`) and trust the bridge in the host firewall (NixOS:
  `networking.firewall.trustedInterfaces = [ "docker0" ];`), or run the relay that
  `scripts/capture-e2e.sh` describes and name its IP. On Docker Desktop, use `host.docker.internal`.
  The engine refuses to start without the session endpoint.
- **Origins.** `APP_URL` is the one public origin. Add others to `MEND_ALLOWED_ORIGINS` as exact
  `scheme://host:port` values. Nothing else grants trust: leave `BETTER_AUTH_TRUSTED_ORIGINS` unset.

Every other variable has a working default. Mend-run Executor needs the API in a container, so the
host-side dev server refuses it; the comment in `deploy/dev/executor.compose.yaml` gives the setup.

## Tests

- Postgres tests use the dev Postgres (`postgres://mend:mend@localhost:5434/mend`, started by
  `pnpm dev` or `docker compose -f compose.dev.yaml up -d`), or `MEND_TEST_DATABASE_URL`. For a
  partial local run without Postgres, set `MEND_SKIP_POSTGRES_TESTS=1`; CI refuses it.
- `pnpm run test:s3-contract` runs the blob-store contracts against throwaway Garage and MinIO. It
  needs Docker.
- The `scripts/*.test.mjs` suites run in CI's static job (`.github/workflows/ci.yml`). Run the one
  for any script you change with `node --test`.
- With `pnpm dev` running, `node --test apps/web/scripts/dev-auth.integration.mjs` checks that auth
  requests reach the auth server rather than the app.

A running checkout is not verification. To see a change working on a real stack, use the `verify`
skill in `.agents/skills/verify/`.

## When something fails

- **A resumed session meets a logged-out harness.** Captures never carry login files, so every
  pickup must inject the credential again. Check that the pickup path did.
- **Executors cannot reach Mend or the bucket.** See executor reachability above: the URLs must
  resolve inside the container.
