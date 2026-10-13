import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { CaptureStoreRepo, OrganizationsRepo, ProjectsRepo } from "@mend/db";
import { OrganizationId, WorktreeId } from "@mend/domain";
import { Organization, Project } from "@mend/domain/workbench";
import {
  CaptureRuntimeLive,
  bulkSectionOfCache,
  dependencyCachePrefix,
  readDependencyCache,
} from "@mend/sessions";
import { makeCaptureWorld, newWorktreeId } from "@mend/sessions/testing";
import { BlobStore, BlobStoreFsLive, captureKeys, materialize } from "@mend/store";
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
  const shipBulk = (worktreeId: WorktreeId, contents: string) =>
    Effect.gen(function* () {
      const dir = `${world.scratch}/tree-${worktreeId}`;
      fs.mkdirSync(`${dir}/node_modules/left-pad`, { recursive: true });
      fs.writeFileSync(`${dir}/node_modules/left-pad/index.js`, contents);
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
      // The capture register boundary records uploaded pack ownership separately from the head.
      yield* repo.recordPacks(
        snapshot.packs.map((key) => {
          const bytes = snapshot.objects.get(key);
          if (bytes === undefined) throw new Error("Missing fixture pack bytes");
          return {
            key,
            class: "bulk",
            bytes: bytes.byteLength,
            worktreeId,
            epoch: claimed.epoch,
            platform: PLATFORM,
          };
        }),
      );
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
      return {
        id: built.id,
        manifest: built.manifest,
        objects: new Map([...snapshot.objects, [built.key, built.bytes]]),
      };
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
    const agentContents = "module.exports = 'agent';\n".repeat(16);
    const agentCapture = await Effect.runPromise(shipBulk(agentWorktree, agentContents));
    // The install session's worktree: what the runner hands back.
    const installWorktree = newWorktreeId();
    const installContents = "module.exports = 'cache';\n".repeat(16);
    const installCapture = await Effect.runPromise(shipBulk(installWorktree, installContents));
    const packRowsBefore = [...world.memory.packs.entries()];
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
    expect(outcome).toEqual({
      outcome: "promoted",
      platform: PLATFORM,
      captureId: installCapture.id,
    });
    const cache = await Effect.runPromise(
      readDependencyCache(world.project.id, PLATFORM).pipe(Effect.provide(world.layer)),
    );
    expect(cache?.capture_id).toBe(installCapture.id);
    if (cache === null) throw new Error("Install did not publish its cache record");
    const prefix = dependencyCachePrefix(world.project.id, PLATFORM);
    // Restore with only cache objects available, so references back into either capture fail.
    const cacheOnly = BlobStoreFsLive(path.join(world.scratch, "cache-only-blobs"));
    await Effect.runPromise(
      Effect.gen(function* () {
        const source = yield* BlobStore;
        const objects = yield* Effect.forEach(yield* source.list(prefix), (entry) =>
          source.get(entry.key).pipe(Effect.map((bytes) => ({ key: entry.key, bytes }))),
        );
        yield* Effect.gen(function* () {
          const isolated = yield* BlobStore;
          for (const object of objects) yield* isolated.put(object.key, object.bytes);
        }).pipe(Effect.provide(cacheOnly));
      }).pipe(Effect.provide(world.layer)),
    );
    const restored = path.join(world.scratch, "restored-cache");
    const standby = buildManifest({
      worktreeId: "owned-standby",
      epoch: 1,
      n: 0,
      parent: null,
      bulk: bulkSectionOfCache(cache),
    }).manifest;
    await Effect.runPromise(materialize(standby, "bulk", restored).pipe(Effect.provide(cacheOnly)));
    const restoredBytes = fs.readFileSync(path.join(restored, "node_modules/left-pad/index.js"));
    expect(restoredBytes).toEqual(Buffer.from(installContents));
    expect(createHash("sha256").update(restoredBytes).digest("hex")).toBe(
      createHash("sha256").update(installContents).digest("hex"),
    );
    expect(restoredBytes).not.toEqual(Buffer.from(agentContents));

    // Promotion cannot move, overwrite or repoint the original agent's immutable capture objects.
    const agentRestored = path.join(world.scratch, "restored-agent");
    await Effect.runPromise(
      Effect.gen(function* () {
        const blobs = yield* BlobStore;
        for (const [key, bytes] of agentCapture.objects)
          expect(yield* blobs.get(key)).toEqual(bytes);
        yield* materialize(agentCapture.manifest, "bulk", agentRestored);
      }).pipe(Effect.provide(world.layer)),
    );
    expect(
      fs.readFileSync(path.join(agentRestored, "node_modules/left-pad/index.js"), "utf8"),
    ).toBe(agentContents);
    expect([...world.memory.packs.entries()]).toEqual(packRowsBefore);
    expect(packRowsBefore.length).toBeGreaterThan(0);
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

  it("automatic install off: the job runs no install session and promotes nothing", async () => {
    const ran: Array<string> = [];
    const off = Layer.mock(ProjectsRepo, {
      byId: () => Effect.succeed(new Project({ ...world.project, installEnabled: false })),
    });
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const installer = yield* DependencyInstaller;
        return yield* installer.install({
          projectId: world.project.id,
          requestedByUserId: "user-requester",
        });
      }).pipe(
        Effect.provide(
          DependencyInstallerLive.pipe(
            Layer.provide(runtime),
            Layer.provide(
              Layer.succeed(InstallRunner, {
                run: (projectId, ownerUserId) =>
                  Effect.sync(() => {
                    ran.push(`${projectId}:${ownerUserId}`);
                    return { worktreeId: newWorktreeId() };
                  }),
              }),
            ),
            Layer.provide(organizations),
            Layer.provide(off),
            Layer.provide(world.layer),
          ),
        ),
      ),
    );
    expect(outcome).toEqual({ outcome: "skipped", reason: "automatic install is off" });
    expect(ran).toEqual([]);
  });
});
