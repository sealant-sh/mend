# Turborepo

Mend and Sealant Core both run their tasks through Turborepo, pinned exactly to `turbo` **2.11.9**
in each root `package.json`. This page covers how turbo is meant to be used, the rules both
repositories follow, and the crash that drove the pin. Cache inputs and CI selection for Mend are in
[ci-cache-audit.md](ci-cache-audit.md). The Core section at the end covers what differs there.

Citations point into a reference clone of `vercel/turborepo` at tag `v2.11.9`
(`~/Developer/refs/turborepo`): `docs/…` means `apps/docs/content/docs/…`.

## Why turbo crashed

From August to October 2026 this machine recorded 360 turbo core dumps (`~/.cache/drkonqi/crashes`).
All 360 came from `turbo@2.10.3`, all were `SIGSEGV` or `SIGBUS` in a `tokio-rt-worker` thread, and
all were Mend runs: `turbo typecheck --force`, `lint --force`, `build --force` and `test --force`.
GitHub Actions saw the same crash: three `checks` runs on 2026-10-11 and 2026-10-13 ended in
`Command was killed with SIGSEGV (Segmentation fault): turbo test --force`, each 1 to 10 seconds
after a test task failed. Successful runs never crashed: 16 forced typecheck and lint runs passed.

- **Cause.** When turbo stops tasks that are still running, it scans each child's descendants on
  several threads at once. In 2.10.0 to 2.10.3 that scan made non-reentrant libc calls. The npm
  Linux binaries are static musl builds, and the scan corrupted musl's `mallocng` heap. The faulting
  addresses in the dumps are `mallocng`'s `get_meta` assertions (`hlt`), so the corrupt heap is what
  kills the process. Upstream: vercel/turborepo#13254, fixed by #13256 (`bf2d8273b`, "Avoid
  non-reentrant libc calls in concurrent shutdown process scans"). Turbo 2.10.4 also replaced musl's
  allocator with mimalloc (#13237, `c42a8a971`; `crates/turborepo/src/main.rs`).
- **Trigger.** Anything that stops tasks mid-run:
  - one task fails while others are still running (the default `--continue=never`);
  - Ctrl-C;
  - an agent or CI timeout signalling the process group.
- **Why Core never crashed.** 2.9.x did not have the scan, and Core was locked to 2.9.18.
- **What it looked like.** `Segmentation fault (core dumped)` or `Bus error` (exit 139 or 135) in
  place of turbo's failure summary. Dev servers were left orphaned holding their ports, so the next
  `pnpm dev` failed with `EADDRINUSE`.
- **Reproduction.** The first two rows use a 60-package fixture where one task fails after 0.8 s,
  run with `--force`. The third is Mend's marketing and docs dev servers, stopped after 30 s by
  SIGINT to turbo's process group. Each cell counts runs that died by signal:

  | Run                     | 2.9.18 | 2.10.3                        | 2.11.9 |
  | ----------------------- | ------ | ----------------------------- | ------ |
  | One failing task        | 0/20   | 28/30 (`SIGSEGV`/`SIGBUS`)    | 0/30   |
  | SIGINT after 0.5 s      | 0/20   | 17/20                         | 0/20   |
  | Mend `turbo dev` Ctrl-C | —      | 3/3, both dev ports left held | 0/3    |

Other fixes in the 2.10.4 to 2.11.9 range that matter here (`gh release view`,
`git tag --contains`):

| Issue / PR      | First stable | What 2.10.3 did                                                                                      |
| --------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| #13282          | 2.10.4       | Never raised the soft open-file limit: `Too many open files (os error 24)` on wide runs.             |
| #13637          | 2.10.9       | The panic hook panicked when stderr was gone, so you got a bare `Aborted (core dumped)`.             |
| #13732 → #13734 | 2.10.11      | A vanishing `.git/index.lock` while hashing failed the run before any task started (`os error 21`).  |
| #13907 → #13908 | 2.10.13      | Kept every task's output in memory for the whole run.                                                |
| #14463 → #14489 | 2.11.8       | Its `git diff` child could outlive turbo and hold `.git/index.lock`, failing an agent's next commit. |
| #14367 → #14373 | 2.11.9       | Could drop or cut short the output of a task that exited non-zero.                                   |

## How turbo is meant to be used

- **Pin the version.** A range lets the lockfile drift, and the global `turbo` shim always defers to
  the local install without warning when the versions differ
  (`docs/getting-started/installation.mdx` § Installing turbo). Pin exactly and upgrade on purpose.
- **Inputs.** By default a task hashes every Git-tracked file in its package, plus `package.json`,
  `turbo.json` and the lockfile. Setting `inputs` replaces that default; keep `$TURBO_DEFAULT$` in
  the list. Use `$TURBO_ROOT$/…` for files outside the package (`docs/reference/configuration.mdx` §
  inputs, § `$TURBO_DEFAULT$`). A file a task reads from outside its package is not hashed unless it
  is listed: change it and turbo replays a stale result.
- **Outputs.** "Omitting this key or passing an empty array tells `turbo` to cache nothing (except
  logs)" (`docs/reference/configuration.mdx` § outputs). Every directory a build writes that a later
  task or deploy reads must be listed, or a cache hit restores nothing.
- **Environment.** `envMode` defaults to `strict` (§ envMode). A task sees only:
  - the variables in its `env` and in `globalEnv`, which are hashed;
  - the variables in `passThroughEnv` and `globalPassThroughEnv`, which are not hashed;
  - turbo's built-in passthrough list: `PATH`, `HOME`, `CI`, `DOCKER_*`, `NIX_*`, `GITHUB_*` and
    others (`crates/turborepo-env/src/lib.rs`, `BUILTIN_PASS_THROUGH_ENV`).

  Everything else is stripped. A variable that changes behaviour belongs in `env` (wildcards such as
  `MEND_*` work, and `!` negates). A package that depends on `vite` gets `VITE_*` inferred
  automatically (`docs/crafting-your-repository/using-environment-variables.mdx` § Framework
  Inference, § Strict Mode).

- **Package configurations.** `extends: ["//"]` inherits scalars, but arrays replace the root's
  unless they start with `$TURBO_EXTENDS$`. If the root task has no `inputs`, `$TURBO_EXTENDS$` has
  nothing to extend, so list `$TURBO_DEFAULT$` yourself (`docs/reference/package-configurations.mdx`
  § Array fields replace by default, § Extending arrays;
  `crates/turborepo-turbo-json/src/extend.rs`).
- **`dependsOn`.** `^task` waits for the task in each dependency and folds its hash in. A task that
  only needs the hash propagation, not the ordering, can use a transit node instead and run in
  parallel (`docs/guides/tools/vitest.mdx`; `docs/crafting-your-repository/configuring-tasks.mdx` §
  Dependent tasks that can be run in parallel). No task may depend on a `persistent` task
  (`crates/turborepo-engine/src/validate_engine.rs`).
- **`--force`** re-executes everything and still writes the cache (`docs/reference/run.mdx` §
  `--force`). 2.11.9 still rejects `--force` together with `--cache`, which `scripts/ci-turbo.mjs`
  relies on.
- **`--affected`** is `--filter=...[main...HEAD]`, using `TURBO_SCM_BASE` and `TURBO_SCM_HEAD`. A
  shallow checkout marks everything changed (§ `--affected`). The `affectedUsingTaskInputs` and
  `filterUsingTasks` future flags are still flags at 2.11.9, not stabilised or renamed (§
  futureFlags).
- **UI.** The default is `stream` (§ ui). The TUI only starts on a TTY: in agent shells and CI,
  `--ui=tui` falls back to stream, and a truthy `CI` forces stream
  (`crates/turborepo-config/src/lib.rs` `fn ui`).
- **Daemon.** "The daemon is no longer used for `turbo run`", so `--daemon` and `--no-daemon` are
  ignored. Only `turbo watch` and the LSP still use it (§ daemon). There is no daemon to debug for
  `typecheck`, `lint`, `test` or `dev`.
- **Local cache across worktrees.** With no `cacheDir`, a Git worktree shares the main worktree's
  `.turbo/cache` (§ cacheDir). Every Mend worktree, T3 and herdr alike, writes into
  `~/Developer/OSS/Sealant/Mend/.turbo/cache`; it had reached 2.3 GB in 74,883 entries. Eviction is
  opt-in through `cacheMaxAge` and `cacheMaxSize` (§ cacheMaxAge).
- **`turbo clean` is not a command.** It runs a task named `clean`. Neither repository has a package
  with a `clean` script, so the old `clean:turbo` script did nothing.

## Rules for this repository

1. `turbo` is pinned exactly in the root `package.json`. To upgrade it:
   - read the release notes from the current version to the new one;
   - run `npx @turbo/codemod migrate` (2.10 to 2.11.9 has no transforms);
   - reproduce any crash on both versions.
2. Before a PR, `pnpm exec turbo typecheck --force` and `pnpm exec turbo lint --force`, as
   `AGENTS.md` requires.
3. Every file a task reads from outside its package is an input, written as `$TURBO_ROOT$/…`. A
   package configuration that adds inputs starts with `$TURBO_EXTENDS$` (or `$TURBO_DEFAULT$` when
   the root task has none).
4. Behaviour-changing variables go in `env`, so they are hashed. Use `passThroughEnv` only for
   values that cannot change a result, such as `CI_TEST_REPORT_DIR`.
5. Root `cacheMaxAge` is 14 days, so the cache shared by every worktree stops growing without bound.
6. To stop a non-interactive turbo, signal its process group (as Ctrl-C does) or send `SIGTERM`. The
   npm `turbo` bin is a Node wrapper (`packages/turbo/bin/turbo`). Without a TTY its SIGINT handler
   has no Ctrl-C pipe to write to, so a SIGINT sent only to the wrapper's pid is ignored and the run
   continues. `scripts/ci-shards.mjs` already signals process groups.
7. A failing task stops the run (`--continue=never`). Use `--continue` to see every failure. It is
   no longer a crash trigger on 2.11.9.

## Sealant Core

Core uses the same pin and rules. Its `turbo.json` is smaller: no `globalEnv`, no remote cache, and
CI runs `pnpm lint`, `pnpm typecheck` and `pnpm exec turbo test --force`. The 2.11.9 PR there
(sealant-sh/sealant, branch `chore/turbo-latest`) changed four things:

- `build` hashes `$TURBO_ROOT$/tooling/scripts/bundle-app.mjs`. Before, editing the bundler replayed
  stale `dist/` bundles for api, cli, ssh-gateway and worker.
- `lint` hashes `$TURBO_ROOT$/.oxlintrc.json`, which every package's `oxlint .` reads.
- `test` hashes `SEALANT_*` and `DATABASE_URL`. Strict mode used to strip `SEALANT_TEST_SHELLS`,
  `SEALANT_SMOKE_*` and the `DATABASE_URL` fallback, so setting them did nothing.
- `@sealant/api#test` hashes the root `compose.selfhost.yaml` that its test reads.

Left as they were, with the reason:

- `test` keeps `dependsOn: ["^test"]`. A transit node would let the test tasks run in parallel, but
  several of them (jobs, telemetry, worker) share one test database.
- `packages/workspaces` `home-credentials.test.ts` "sh (bash)" fails under turbo and passes on its
  own. The test depends on the inherited `SHLVL`, which strict mode strips: adding only `SHLVL` back
  makes it pass. It fails the same way on 2.9.18, and the fix belongs in the test.
- `pnpm dev` cannot start every app at once. `@sealant/docs` and `@sealant/web` both take port 3000,
  and the Cloudflare Vite plugin in docs and marketing both take inspector port 9229.
