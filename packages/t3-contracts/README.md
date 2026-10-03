# @mend/t3-contracts

t3code's contracts, for the t3code gateway (ADR 0012, `docs/adr/0012-t3code-gateway.md`).

## Attribution

Everything under `src/` and `shared/` is copied verbatim from
[t3code](https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., under the MIT
License in `LICENSE` (t3code's own, copied with the files):

- `src/` is `packages/contracts/src`.
- `shared/keybindings.ts` is `packages/shared/src/keybindings.ts`, which holds t3code's default
  keybindings (`DEFAULT_KEYBINDINGS`). It imports `@t3tools/contracts`, which this package links to
  itself.

`t3code.pin.json` records the tag, its commit, and the git blob id and SHA-256 of every copied file.

## Rules

- Never edit the copied files. Mend's lint and format skip them; `tsconfig.json` carries t3code's
  compiler options so they typecheck as upstream does.
- The package runs on Effect `4.0.0-rc.115` from the `t3` catalog in `pnpm-workspace.yaml`, apart
  from the rest of the monorepo.
- To move the pin, run the copy script with a nightly tag, never `main`:

  ```sh
  pnpm --filter @mend/t3-contracts sync --tag <t3code tag> [--source <t3code checkout>]
  ```

  It reads the files from the tag's commit, replaces the previous copy and rewrites the pin. Set the
  `t3` catalog to t3code's versions at that tag (its `pnpm-workspace.yaml`), then run `pnpm install`
  and this package's tests.

## Tests

- `test/verbatim.test.ts`: every copied file matches the pin, and nothing was added or removed.
- `test/rpc-group.test.ts`: `WsRpcGroup` loads on the `t3` catalog and its schemas decode real
  frames.
- t3code's own tests under `src/` run too, on vitest (`vite-plus/test` is aliased to it).
