import {
  WorkspaceImage,
  type ProjectId,
  type SealantWorkspaceId,
  type SessionId,
  type Sha,
  type WorktreeId,
} from "@mend/domain";
import {
  HotWorkspace,
  HotWorkspaceEnvironment,
  SessionDotfiles,
  type SessionExtraMount,
  type SessionReferenceMount,
} from "@mend/domain/workbench";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { hotWorkspaces } from "../schema/workbench.ts";

export interface NewHotWorkspace {
  readonly id: SessionId;
  readonly projectId: ProjectId;
  /** Always null since standby workspaces (ADR-0001): the claiming session brings its own worktree. */
  readonly worktreeId: WorktreeId | null;
  readonly ownerUserId: string;
  readonly fingerprint: string;
  readonly worktree: string | null;
  readonly branch: string | null;
  readonly baseSha: HotWorkspace["baseSha"];
}

/** What prewarm observed once the workspace was live — stamped onto the claiming session. */
export interface HotWorkspaceStamps {
  readonly sealantWorkspaceId: SealantWorkspaceId;
  readonly workspaceImage: WorkspaceImage;
  readonly dotfiles: SessionDotfiles;
  readonly environment: HotWorkspaceEnvironment;
  readonly referenceMounts: ReadonlyArray<SessionReferenceMount>;
  readonly extraMounts: ReadonlyArray<SessionExtraMount>;
}

/** The pool of pre-provisioned session skeletons (hot sessions). */
export class HotWorkspacesRepo extends Context.Service<
  HotWorkspacesRepo,
  {
    /** Insert a `warming` row before any provisioning side effect, so recovery can drain it. */
    readonly create: (entry: NewHotWorkspace) => Effect.Effect<HotWorkspace>;
    readonly byId: (id: SessionId) => Effect.Effect<HotWorkspace | null>;
    readonly listForProject: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<HotWorkspace>>;
    readonly listAll: () => Effect.Effect<ReadonlyArray<HotWorkspace>>;
    readonly setReady: (id: SessionId, stamps: HotWorkspaceStamps) => Effect.Effect<void>;
    /** Capture mode: the base the standby's plan was prepared from (`hot-pool.ts`). */
    readonly setBaseSha: (id: SessionId, baseSha: Sha) => Effect.Effect<void>;
    readonly setFailed: (id: SessionId, error: string) => Effect.Effect<void>;
    /**
     * Atomically pop the oldest `ready` entry of this owner matching the project's CURRENT
     * fingerprint for them — `FOR UPDATE SKIP LOCKED` inside one statement, so concurrent
     * provisions never double-claim. Null when nothing matches (the cold path).
     */
    readonly claim: (
      projectId: ProjectId,
      fingerprint: string,
      ownerUserId: string,
    ) => Effect.Effect<HotWorkspace | null>;
    readonly remove: (id: SessionId) => Effect.Effect<void>;
  }
>()("@mend/db/HotWorkspacesRepo") {}

const decodeWorkspaceImage = Schema.decodeUnknownSync(WorkspaceImage);
const decodeDotfiles = Schema.decodeUnknownSync(SessionDotfiles);
const decodeEnvironment = Schema.decodeUnknownSync(HotWorkspaceEnvironment);

const toHotWorkspace = (row: typeof hotWorkspaces.$inferSelect): HotWorkspace =>
  new HotWorkspace({
    ...row,
    workspaceImage: row.workspaceImage === null ? null : decodeWorkspaceImage(row.workspaceImage),
    dotfiles: row.dotfiles === null ? null : decodeDotfiles(row.dotfiles),
    environment: row.environment === null ? null : decodeEnvironment(row.environment),
  });

export const HotWorkspacesRepoLive: Layer.Layer<HotWorkspacesRepo, never, MendDB> = Layer.effect(
  HotWorkspacesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const create = Effect.fn("HotWorkspacesRepo.create")(function* (entry: NewHotWorkspace) {
      const [row] = yield* db.insert(hotWorkspaces).values(entry).returning().pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("hot workspace insert returned no row");
      return toHotWorkspace(row);
    });

    const byId = Effect.fn("HotWorkspacesRepo.byId")(function* (id: SessionId) {
      const [row] = yield* db
        .select()
        .from(hotWorkspaces)
        .where(eq(hotWorkspaces.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toHotWorkspace(row);
    });

    const listForProject = Effect.fn("HotWorkspacesRepo.listForProject")(function* (
      projectId: ProjectId,
    ) {
      const rows = yield* db
        .select()
        .from(hotWorkspaces)
        .where(eq(hotWorkspaces.projectId, projectId))
        .orderBy(asc(hotWorkspaces.createdAt))
        .pipe(Effect.orDie);
      return rows.map(toHotWorkspace);
    });

    const listAll = Effect.fn("HotWorkspacesRepo.listAll")(function* () {
      const rows = yield* db
        .select()
        .from(hotWorkspaces)
        .orderBy(asc(hotWorkspaces.createdAt))
        .pipe(Effect.orDie);
      return rows.map(toHotWorkspace);
    });

    const setReady = Effect.fn("HotWorkspacesRepo.setReady")(function* (
      id: SessionId,
      stamps: HotWorkspaceStamps,
    ) {
      yield* db
        .update(hotWorkspaces)
        .set({ ...stamps, status: "ready", error: null, updatedAt: new Date() })
        .where(eq(hotWorkspaces.id, id))
        .pipe(Effect.orDie);
    });

    const setBaseSha = Effect.fn("HotWorkspacesRepo.setBaseSha")(function* (
      id: SessionId,
      baseSha: Sha,
    ) {
      yield* db
        .update(hotWorkspaces)
        .set({ baseSha, updatedAt: new Date() })
        .where(eq(hotWorkspaces.id, id))
        .pipe(Effect.orDie);
    });

    const setFailed = Effect.fn("HotWorkspacesRepo.setFailed")(function* (
      id: SessionId,
      error: string,
    ) {
      yield* db
        .update(hotWorkspaces)
        .set({ status: "failed", error, updatedAt: new Date() })
        .where(eq(hotWorkspaces.id, id))
        .pipe(Effect.orDie);
    });

    const claim = Effect.fn("HotWorkspacesRepo.claim")(function* (
      projectId: ProjectId,
      fingerprint: string,
      ownerUserId: string,
    ) {
      // A skeleton was provisioned AS its owner (its workspace carries that user's connected
      // accounts), so only that owner's sessions may claim it (docs/SEALANT-IDENTITY.md).
      const oldestReady = db
        .select({ id: hotWorkspaces.id })
        .from(hotWorkspaces)
        .where(
          and(
            eq(hotWorkspaces.projectId, projectId),
            eq(hotWorkspaces.status, "ready"),
            eq(hotWorkspaces.fingerprint, fingerprint),
            eq(hotWorkspaces.ownerUserId, ownerUserId),
          ),
        )
        .orderBy(asc(hotWorkspaces.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      const [row] = yield* db
        .update(hotWorkspaces)
        .set({ status: "claimed", updatedAt: new Date() })
        .where(inArray(hotWorkspaces.id, oldestReady))
        .returning()
        .pipe(Effect.orDie);
      return row === undefined ? null : toHotWorkspace(row);
    });

    const remove = Effect.fn("HotWorkspacesRepo.remove")(function* (id: SessionId) {
      yield* db.delete(hotWorkspaces).where(eq(hotWorkspaces.id, id)).pipe(Effect.orDie);
    });

    return {
      create,
      byId,
      listForProject,
      listAll,
      setReady,
      setBaseSha,
      setFailed,
      claim,
      remove,
    };
  }),
);
