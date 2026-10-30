import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CaptureStoreRepo, RemovalFenceId } from "@mend/db";
import { ProjectId, WorktreeId } from "@mend/domain";
import { makeMemoryCaptureStore } from "@mend/sessions/testing";
import { makeFsBlobStore } from "@mend/store";
import { Data, Effect, Exit } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { purgeProjectBlobs } from "./project-purge-blobs.ts";

const project = ProjectId.make("purged");
const own = WorktreeId.make("w-purged");
const other = WorktreeId.make("w-other");
const ownPack = `captures/${own}/1/packs/${"a".repeat(64)}`;
const sharedPack = `captures/${own}/1/packs/${"b".repeat(64)}`;
const basePack = `projects/${project}/packs/${"c".repeat(64)}`;
const change = `changes/${own}/diff`;

class MarkLost extends Data.TaggedError("MarkLost") {}

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A removed project's objects, one pack another project's capture inherited, and both chains. */
const world = async () => {
  root = mkdtempSync(join(tmpdir(), "mend-purge-blobs-"));
  const memory = makeMemoryCaptureStore();
  memory.purgeMarks.set(project, "rmv_purge");
  const repo = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        return yield* CaptureStoreRepo;
      }),
      memory.layer,
    ),
  );
  const blobs = makeFsBlobStore(root);
  const bytes = new TextEncoder().encode("bytes");
  await Effect.runPromise(
    Effect.gen(function* () {
      for (const key of [ownPack, sharedPack, `${sharedPack}.idx`, basePack, change])
        yield* blobs.put(key, bytes);
      for (const [worktree, names] of [
        [own, [ownPack, sharedPack]],
        [other, [sharedPack]],
      ] as const) {
        yield* repo.init(worktree);
        const { epoch } = yield* repo.claim(worktree, "exec", 3600);
        yield* repo.register({
          worktreeId: worktree,
          id: `cap-${worktree}`,
          n: 0,
          parent: null,
          epoch,
          seq: 0n,
          kind: "checkpoint",
          manifestKey: `captures/${worktree}/${epoch}/manifests/m`,
          sections: { git: { packs: names } },
          gitFsck: "verified",
          names: [...names],
        });
      }
    }),
  );
  const keys = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const listed = [
          ...(yield* blobs.list(`captures/${own}/`)),
          ...(yield* blobs.list(`projects/${project}/`)),
          ...(yield* blobs.list(`changes/${own}/`)),
        ];
        return listed.map((entry) => entry.key).toSorted();
      }),
    );
  const purge = (step: Effect.Effect<void, MarkLost> = Effect.void) =>
    Effect.runPromise(
      Effect.exit(
        purgeProjectBlobs(
          { repo, blobs },
          { projectId: project, mark: RemovalFenceId.make("rmv_purge") },
          [own],
          [],
          step,
        ),
      ),
    );
  return { memory, repo, keys, purge };
};

describe("purging a removed project's stored objects", () => {
  it("refuses while an upload URL it issued can still land bytes, and deletes nothing", async () => {
    const { repo, keys, purge } = await world();
    const before = await keys();
    await Effect.runPromise(repo.recordPutAuthority(own, 1, new Date(Date.now() + 10 * 60_000)));
    const exit = await purge();
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("UploadAuthorityOpen");
    expect(await keys()).toEqual(before);
  });

  it("refuses while a URL bound to its bytes can still land them, though it replaces nothing", async () => {
    const { repo, keys, purge } = await world();
    const before = await keys();
    expect(
      await Effect.runPromise(repo.recordUploadWindow(own, new Date(Date.now() + 10 * 60_000))),
    ).toBe(true);
    const exit = await purge();
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("UploadAuthorityOpen");
    expect(await keys()).toEqual(before);
  });

  it("deletes the objects only it names, keeps an inherited pack and its index, and tombstones every deletion", async () => {
    const { repo, keys, purge } = await world();
    await Effect.runPromise(repo.recordPutAuthority(own, 1, new Date(Date.now() - 1000)));
    expect(Exit.isSuccess(await purge())).toBe(true);
    expect(await keys()).toEqual([sharedPack, `${sharedPack}.idx`]);
    const state = await Effect.runPromise(repo.referenceState([own], [ownPack, basePack, change]));
    expect(state.tombstones.map((tombstone) => tombstone.key).toSorted()).toEqual(
      [ownPack, change, basePack].toSorted(),
    );
    // A later capture naming a purged object is refused: its bytes are gone for good.
    const epoch = (await Effect.runPromise(repo.leaseOf(other)))?.epoch ?? -1;
    const registerNaming = (key: string) =>
      Effect.runPromise(
        Effect.exit(
          repo.register({
            worktreeId: other,
            id: `cap-late-${key.length}-${key.at(-1) ?? ""}`,
            n: 1,
            parent: `cap-${other}`,
            epoch,
            seq: 1n,
            kind: "auto",
            manifestKey: `captures/${other}/${epoch}/manifests/late`,
            sections: { git: { packs: [key] } },
            gitFsck: "verified",
            names: [key],
          }),
        ),
      );
    expect(Exit.isFailure(await registerNaming(ownPack))).toBe(true);
    expect(Exit.isSuccess(await registerNaming(sharedPack))).toBe(true);
  });

  it("condemns and deletes nothing once its mark went to another purge", async () => {
    const { memory, keys, purge } = await world();
    const before = await keys();
    memory.purgeMarks.set(project, "rmv_other");
    const exit = await purge();
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("PurgeBlobFailure");
    expect(await keys()).toEqual(before);
  });

  it("stops deleting once the purge no longer holds its mark", async () => {
    const { keys, purge } = await world();
    let steps = 0;
    const exit = await purge(
      Effect.suspend(() => {
        steps += 1;
        return steps > 1 ? Effect.fail(new MarkLost()) : Effect.void;
      }),
    );
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("MarkLost");
    expect((await keys()).length).toBeGreaterThan(2);
  });
});
