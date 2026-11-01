import type { ProjectId, WorktreeId } from "@mend/domain";
import type { ResourceDefinition } from "@mend/domain/workbench";
import { Effect } from "effect";
import { parse as parseToml } from "smol-toml";

import { MEND_TOML, LEGACY_MEND_TOML, selectMendToml, tomlDiagnostic } from "../recipes.ts";
import { readResourceTables, type ResourceTables } from "../resource-tables.ts";
import { stampLabel, type WorktreeReads } from "../worktree-reads.ts";

/** A `mend.toml` larger than this is reported unread, never cut. */
const MEND_TOML_MAX_BYTES = 256 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A worktree's `[resource.*]` tables as read: unavailable is never shown as an empty file. */
export type WorktreeTablesRead =
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "absent"; readonly observed: string }
  | { readonly kind: "unparsed"; readonly observed: string; readonly message: string }
  | ({ readonly kind: "read"; readonly observed: string } & ResourceTables);

/** Reads the `[resource.*]` tables of a worktree's `mend.toml`. */
export const readWorktreeTables = Effect.fn("Resources.readWorktreeTables")(function* (
  reads: Pick<WorktreeReads["Service"], "readFile">,
  projectId: ProjectId,
  worktreeId: WorktreeId,
) {
  const readFile = (name: string) =>
    reads.readFile(projectId, worktreeId, name, null, MEND_TOML_MAX_BYTES).pipe(Effect.result);
  const preferred = yield* readFile(MEND_TOML);
  const legacy =
    preferred._tag === "Success" && preferred.success.value === null
      ? yield* readFile(LEGACY_MEND_TOML)
      : null;
  const selected = selectMendToml(
    preferred._tag === "Success" && preferred.success.value === null ? null : preferred,
    legacy,
  ) ?? { path: MEND_TOML, value: preferred };
  const { path: name, value: read } = selected;
  if (read._tag === "Failure") {
    return {
      kind: "unavailable",
      message: `${name} could not be read`,
    } satisfies WorktreeTablesRead;
  }
  const { value: file, stamp } = read.success;
  const observed = `${name} · ${stampLabel(stamp)}`;
  if (file === null) return { kind: "absent", observed } satisfies WorktreeTablesRead;
  const unparsed = (message: string): WorktreeTablesRead => ({
    kind: "unparsed",
    observed,
    message,
  });
  if (file.truncated) {
    return unparsed(`${name} is over ${MEND_TOML_MAX_BYTES / 1024} KiB · not read`);
  }
  if (file.binary) return unparsed(`${name} is not text · not read`);
  let parsed: unknown;
  try {
    parsed = parseToml(new TextDecoder().decode(file.bytes));
  } catch (cause) {
    return unparsed(tomlDiagnostic(cause, name));
  }
  return {
    kind: "read",
    observed,
    ...readResourceTables(isRecord(parsed) ? parsed["resource"] : undefined),
  } satisfies WorktreeTablesRead;
});

/** The tables a read found, or none. */
export const tablesOf = (read: WorktreeTablesRead): ReadonlyArray<ResourceDefinition> =>
  read.kind === "read" ? read.tables : [];
