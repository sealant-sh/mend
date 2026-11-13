# Developing Mend

How to get a checkout running and tested. `AGENTS.md` holds the rules and the checks before a PR.
For an installed server, see [Install Mend](apps/docs/src/content/docs/getting-started/install.md)
and the [operator pages](apps/docs/src/content/docs/operate/) of the public docs.

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

The default suite runs no performance benchmark. Three measurements have their own commands. Run
each on an otherwise idle machine, and keep the JSON report, the workload and the machine with the
result, failures included:

```sh
# Session list and view reads, on a disposable Postgres: each enriched read must stay within +5% or
# +20 ms of its plain read, median and p90, in each of three rounds.
MEND_TEST_DATABASE_URL=postgres://mend:mend@localhost:5434/mend pnpm --filter @mend/db bench:session-live-people

# Verifying a capture of 126,000 files against local blobs, twice. A measurement with no budget.
MEND_VERIFY_BENCH_REPORT=/tmp/mend-capture-verification.json pnpm --filter @mend/store bench:capture-verification

# Worktree routes (diff, file, search, a 400,000-file listing) through the real request handler,
# against their p90 budgets. Needs no database. The Worktree reads performance workflow runs it too.
GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
MEND_WORKTREE_PERF_CONTEXT=local-serial \
MEND_WORKTREE_PERF_REPORT=/tmp/mend-worktree-reads.json \
pnpm --filter @mend/api-server bench:worktree-reads
```

A running checkout is not verification. To see a change working on a real stack, use the `verify`
skill in `.agents/skills/verify/`.

## When something fails

- **A resumed session meets a logged-out harness.** Captures never carry login files, so every
  pickup must inject the credential again. Check that the pickup path did.
- **Executors cannot reach Mend or the bucket.** See executor reachability above: the URLs must
  resolve inside the container.
