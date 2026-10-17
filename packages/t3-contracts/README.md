# @mend/t3-contracts

t3code's contracts, for the t3code gateway (ADR 0012, `docs/adr/0012-t3code-gateway.md`).

## Attribution

Everything under `src/`, `t3-shared/src/` and `client-runtime/` is copied verbatim from
[t3code](https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., under the MIT
License in `LICENSE` (t3code's own, copied with the files):

- `src/` is `packages/contracts/src`.
- `client-runtime/threadSettled.ts` is `packages/client-runtime/src/state/threadSettled.ts`: how
  t3code's clients read a thread's settle and snooze, including when a snooze wakes. The gateway's
  tests hold its shell to it. The other files in `client-runtime/` are the client state it takes
  types from.
- `t3-shared/src/` holds the files of t3code's `packages/shared/src` that the copied files import,
  `keybindings.ts` among them (t3code's default keybindings, `DEFAULT_KEYBINDINGS`), and
  `serverSettings.ts` with its imports: how t3code's server applies a settings patch
  (`applyServerSettingsPatch`), which the gateway applies to the model preferences it keeps.
- The copied files import `@t3tools/contracts` and `@t3tools/shared/<name>` as upstream does. This
  package links the first to itself and the second to `t3-shared/`, whose `package.json` (Mend's,
  not copied) maps each name to `src/<name>.ts` as t3code's own package does. When a pin brings a
  new import, add its file to `scripts/sources.ts`; the typecheck names the missing one.

`t3code.pin.json` records the tag, its commit, and the git blob id and SHA-256 of every copied file.

## Rules

- Never edit the copied files. Mend's lint and format skip them; `tsconfig.json` carries t3code's
  compiler options so they typecheck as upstream does.
- The package runs on Effect `4.0.5` from the `t3` catalog in `pnpm-workspace.yaml`, apart from the
  rest of the monorepo.
- To move the pin, run the copy script with a nightly or preview tag, never `main`:

  ```sh
  pnpm --filter @mend/t3-contracts sync --tag <t3code tag> [--source <t3code checkout>]
  ```

  It reads the files from the tag's commit, replaces the previous copy and rewrites the pin. Set the
  `t3` catalog to t3code's versions at that tag (its `pnpm-workspace.yaml`), then run `pnpm install`
  and this package's tests.

  All source reads and the new pin are staged before the old copy changes. A publication error
  restores the previous files and pin. If restoration itself fails, the command retains its
  `.sync-*/previous` backup and reports its location. Run sync exclusively, without builds or
  another sync reading/writing the package. Multiple filesystem renames are not a crash-atomic
  transaction; after process or machine loss, inspect the retained staging directory before
  retrying.

- `scripts/drift.ts` says whether t3code moved on: it lists the files under the vendored sources at
  the newest nightly or preview tag (or `--tag`) by git blob id and compares them with the pin,
  writing nothing here. Exit 0 is no drift, 1 drift (the report lists what changed, what is new,
  what is gone), 2 that it could not tell. `.github/workflows/t3code-drift.yml` runs it every day
  and opens one issue, or comments on it for a new tag; moving the pin stays a person's step.

## Tests

- `test/verbatim.test.ts`: every copied file matches the pin, and nothing was added or removed.
- `test/sync.test.ts`: the actual sync command copies a complete tagged fixture, ignores dirty
  files, and preserves the old copy and pin on source-read and publication failures.
- `test/drift.test.ts`: the drift job's tag order, comparison and report.
- `test/rpc-group.test.ts`: `WsRpcGroup` loads on the `t3` catalog and its schemas decode real
  frames.
- t3code's own tests under `src/` run too, on vitest (`vite-plus/test` is aliased to it).
