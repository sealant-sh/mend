import * as fs from "node:fs";

import { CaptureStoreRepo, OrganizationsRepo } from "@mend/db";
import { OrganizationId, WorktreeId } from "@mend/domain";
import { Organization } from "@mend/domain/workbench";
import { CaptureRuntimeLive, dependencyCachePrefix, readDependencyCache } from "@mend/sessions";
import { makeCaptureWorld, newWorktreeId } from "@mend/sessions/testing";
import { BlobStore, captureKeys } from "@mend/store";
import { buildManifest, snapshotDirectory, uploadObjects } from "@mend/store/testing";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import {
  DependencyInstaller,
  DependencyInstallerLive,
  InstallRunError,
  InstallRunner,
} from "../src/dependency-install.ts";

/**
 * The install job (ADR-0002 decisions 2 and 9): the one path that promotes a dependency tree
 * into the project's shared cache, and only the tree its own install session captured.
 */
describe("dependency-install", () => {
  const world = makeCaptureWorld();
  const runtime = CaptureRuntimeLive.pipe(Layer.provide(world.layer));
  const PLATFORM = "linux-x86_64-gnu";
  afterAll(() => {
    fs.rmSync(world.scratch, { recursive: true, force: true });
  });

  /** What an install session's executor ships: a capture whose bulk class holds the tree. */
  const shipBulk = (worktreeId: WorktreeId) =>
    Effect.gen(function* () {
      const dir = `${world.scratch}/tree-${worktreeId}`;
      fs.mkdirSync(`${dir}/node_modules/left-pad`, { recursive: true });
      fs.writeFileSync(`${dir}/node_modules/left-pad/index.js`, "module.exports = (s) => s;\n");
      const repo = yield* CaptureStoreRepo;
      yield* repo.init(worktreeId);
      const claimed = yield* repo.claim(worktreeId, `executor-${worktreeId}`);
      const snapshot = snapshotDirectory(dir, captureKeys(worktreeId, claimed.epoch), {
        chunkSize: 64,
      });
      const built = buildManifest({
        worktreeId,
        n: 0,
        parent: null,
        epoch: claimed.epoch,
        seq: 1,
        kind: "final",
        bulk: { root: snapshot.root, packs: snapshot.packs, platform: PLATFORM },
      });
      yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]]));
      yield* repo.register({
        worktreeId,
        id: built.id,
        n: 0,
        parent: null,
        epoch: claimed.epoch,
        seq: 1n,
        kind: "final",
        manifestKey: built.key,
        sections: built.manifest.sections,
        gitFsck: "verified",
      });
      return built.id;
    }).pipe(Effect.provide(world.layer));

  /** Members of the capture world's organization; everyone else may not run there. */
  const members = new Set(["user-requester"]);
  const organizations = Layer.mock(OrganizationsRepo, {
    membershipOf: (userId) =>
      Effect.succeed(
        members.has(userId)
          ? {
              organization: new Organization({
                id: OrganizationId.make("org-capture"),
                name: "Capture",
                createdByUserId: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              }),
              role: "member" as const,
              joinedAt: new Date(),
            }
          : null,
      ),
  });

  const installerWith = (runner: InstallRunner["Service"]) =>
    DependencyInstallerLive.pipe(
      Layer.provide(runtime),
      Layer.provide(Layer.succeed(InstallRunner, runner)),
      Layer.provide(organizations),
      Layer.provide(world.layer),
    );

  it("promotes the install session's bulk capture into the cache, and nothing else's", async () => {
    // An ordinary session captured a dependency tree of its own first.
    const agentWorktree = newWorktreeId();
    await Effect.runPromise(shipBulk(agentWorktree));
    // The install session's worktree: what the runner hands back.
    const installWorktree = newWorktreeId();
    const installCapture = await Effect.runPromise(shipBulk(installWorktree));
    const ran: Array<string> = [];
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const installer = yield* DependencyInstaller;
        return yield* installer.install({
          projectId: world.project.id,
          requestedByUserId: "user-requester",
        });
      }).pipe(
        Effect.provide(
          installerWith({
            run: (projectId, ownerUserId) =>
              Effect.sync(() => {
                ran.push(`${projectId}:${ownerUserId}`);
                return { worktreeId: installWorktree };
              }),
          }),
        ),
      ),
    );
    // The install session signs as the account that asked for it, never as nobody.
    expect(ran).toEqual([`${world.project.id}:user-requester`]);
    expect(outcome).toEqual({ outcome: "promoted", platform: PLATFORM, captureId: installCapture });
    const cache = await Effect.runPromise(
      readDependencyCache(world.project.id, PLATFORM).pipe(Effect.provide(world.layer)),
    );
    expect(cache?.capture_id).toBe(installCapture);
    const prefix = dependencyCachePrefix(world.project.id, PLATFORM);
    const keys = await Effect.runPromise(
      Effect.gen(function* () {
        const blobs = yield* BlobStore;
        return (yield* blobs.list(prefix)).map((entry) => entry.key);
      }).pipe(Effect.provide(world.layer)),
    );
    // The agent session's packs stay under its own epoch prefix; the cache holds one tree — the
    // install session's — and no pack row points into it.
    expect(keys.every((key) => key.startsWith(prefix))).toBe(true);
    expect(keys.length).toBe((cache?.packs.length ?? 0) + 1 + 3);
    const agentKeys = await Effect.runPromise(
      Effect.gen(function* () {
        const blobs = yield* BlobStore;
        return (yield* blobs.list(`captures/${agentWorktree}/`)).map((entry) => entry.key);
      }).pipe(Effect.provide(world.layer)),
    );
    expect(agentKeys.length).toBeGreaterThan(0);
    expect([...world.memory.packs.values()].every((pack) => !pack.key.startsWith(prefix))).toBe(
      true,
    );
  });

  it("runs as nobody else when the requester may no longer run here and there is no creator", async () => {
    const ran: Array<string> = [];
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const installer = yield* DependencyInstaller;
        return yield* installer.install({
          projectId: world.project.id,
          requestedByUserId: "user-removed",
        });
      }).pipe(
        Effect.provide(
          installerWith({
            run: (projectId, ownerUserId) =>
              Effect.sync(() => {
                ran.push(`${projectId}:${ownerUserId}`);
                return { worktreeId: newWorktreeId() };
              }),
          }),
        ),
      ),
    );
    expect(outcome).toEqual({ outcome: "skipped", reason: "no account may run the install" });
    expect(ran).toEqual([]);
  });

  it("an install session that did not run or captured no tree promotes nothing", async () => {
    const bare = newWorktreeId();
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const installer = yield* DependencyInstaller;
        return yield* installer.install({
          projectId: world.project.id,
          requestedByUserId: "user-requester",
        });
      }).pipe(
        Effect.provide(
          installerWith({
            run: (projectId) =>
              Effect.fail(new InstallRunError({ projectId, message: "launch refused" })),
          }),
        ),
      ),
    );
    expect(outcomes).toEqual({ outcome: "skipped", reason: "the install session did not run" });
    const noTree = await Effect.runPromise(
      Effect.gen(function* () {
        const installer = yield* DependencyInstaller;
        return yield* installer.install({
          projectId: world.project.id,
          requestedByUserId: "user-requester",
        });
      }).pipe(Effect.provide(installerWith({ run: () => Effect.succeed({ worktreeId: bare }) }))),
    );
    expect(noTree).toEqual({
      outcome: "skipped",
      reason: "the install session captured nothing",
    });
  });
});
