import { SessionsRepo, WorktreesRepo } from "@mend/db";
import type { ProjectId, WorktreeId } from "@mend/domain";
import type { ResourceDefinition } from "@mend/domain/workbench";
import { asSealantUser, SealantClient } from "@mend/sealant";
import type { FileRead } from "@mend/store";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";
import { parse as parseToml } from "smol-toml";

import { MEND_TOML, LEGACY_MEND_TOML, selectMendToml, tomlDiagnostic } from "../recipes.ts";
import { readResourceTables, type ResourceTables } from "../resource-tables.ts";
import { SessionRepository } from "../session-repository.ts";
import {
  WORKTREE_STAMP,
  WorktreeReads,
  stampLabel,
  type Stamped,
  type WorktreeReadError,
  type DefaultBranchUnavailableError,
} from "../worktree-reads.ts";
import { WORKSPACE_RESOURCE_TABLE_SCRIPT } from "./append-table.ts";
import { resourceWorkspace } from "./workspace.ts";

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
const readTables = Effect.fn("Resources.readTables")(function* (
  load: (
    name: string,
  ) => Effect.Effect<Stamped<FileRead | null>, WorktreeReadError | DefaultBranchUnavailableError>,
  unavailable?: string,
) {
  const readFile = (name: string) => load(name).pipe(Effect.result);
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
      message: unavailable ?? `${name} could not be read`,
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

/** Reads the available co-located file or captured observation when no workspace is live. */
export const readWorktreeTables = (
  reads: Pick<WorktreeReads["Service"], "readFile">,
  projectId: ProjectId,
  worktreeId: WorktreeId,
) => readTables((name) => reads.readFile(projectId, worktreeId, name, null, MEND_TOML_MAX_BYTES));
/** Default-branch definitions for the Resources page, independent of the worktree selected for Start. */
export const readDefaultBranchTables = (
  reads: Pick<WorktreeReads["Service"], "readDefaultBranchFile">,
  projectId: ProjectId,
) =>
  readTables(
    (name) => reads.readDefaultBranchFile(projectId, name, MEND_TOML_MAX_BYTES),
    "the default branch is not available on this server",
  );

/** Current resource declarations for actions and status; review reads retain their capture stamp. */
export class ResourceTableReads extends Context.Service<
  ResourceTableReads,
  {
    readonly forWorktree: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
    ) => Effect.Effect<WorktreeTablesRead>;
  }
>()("@mend/sessions/resources/ResourceTableReads") {}

const make: Effect.Effect<
  ResourceTableReads["Service"],
  never,
  WorktreeReads | SessionRepository | WorktreesRepo | SessionsRepo | SealantClient
> = Effect.gen(function* () {
  const reads = yield* WorktreeReads;
  const repository = yield* SessionRepository;
  const worktrees = yield* WorktreesRepo;
  const sealant = yield* SealantClient;
  const liveWorkspace = yield* resourceWorkspace;
  const forWorktree = Effect.fn("ResourceTableReads.forWorktree")(
    function* (projectId: ProjectId, worktreeId: WorktreeId) {
      const worktree = yield* worktrees.byId(worktreeId);
      if (worktree.projectId !== projectId)
        return {
          kind: "unavailable",
          message: "The worktree does not belong to this project",
        } satisfies WorktreeTablesRead;
      const mount = yield* repository.worktreeMount(projectId, worktree.directory);
      const live = mount === undefined ? yield* liveWorkspace(worktreeId) : null;
      if (live === null) return yield* readWorktreeTables(reads, projectId, worktreeId);
      const read = yield* sealant
        .exec(live.workspace, [
          "sh",
          "-c",
          WORKSPACE_RESOURCE_TABLE_SCRIPT,
          "sh",
          "/workspace/repo",
          "observe",
          String(MEND_TOML_MAX_BYTES + 1),
        ])
        .pipe(asSealantUser(live.owner));
      const newline = read.stdout.indexOf("\n");
      const name = read.stdout.slice(0, newline);
      if (
        (read.exitCode !== 0 && read.exitCode !== 44) ||
        newline < 0 ||
        (name !== MEND_TOML && name !== LEGACY_MEND_TOML)
      )
        return {
          kind: "unavailable",
          message: "The worktree file could not be read in its workspace",
        } satisfies WorktreeTablesRead;
      const bytes = new Uint8Array(Buffer.from(read.stdout.slice(newline + 1), "base64"));
      const file: FileRead | null =
        read.exitCode === 44
          ? null
          : {
              bytes,
              size: bytes.length,
              truncated: bytes.length > MEND_TOML_MAX_BYTES,
              binary: bytes.includes(0),
            };
      return yield* readTables((path) =>
        Effect.succeed({ value: path === name ? file : null, stamp: WORKTREE_STAMP }),
      );
    },
    (effect) =>
      effect.pipe(
        Effect.catch(() =>
          Effect.succeed({
            kind: "unavailable",
            message: "The worktree file could not be reached",
          } satisfies WorktreeTablesRead),
        ),
      ),
  );
  return ResourceTableReads.of({ forWorktree });
});

export const ResourceTableReadsLive: Layer.Layer<
  ResourceTableReads,
  never,
  WorktreeReads | SessionRepository | WorktreesRepo | SessionsRepo | SealantClient
> = Layer.effect(ResourceTableReads, make);
