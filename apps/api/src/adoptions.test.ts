import { OrganizationId, ProjectId } from "@mend/domain";
import { Project } from "@mend/domain/workbench";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeProject } from "../test/support/tenancy-harness.ts";
import { Adoptions, AdoptionsLive } from "./adoptions.ts";

const ID = "5c0ffee0-1b2c-4d3e-8f4a-5b6c7d8e9f00";
const start = {
  id: ID,
  ownerUserId: "alice",
  name: "mend",
  source: "https://github.com/sealant-sh/mend",
};
const adopted = new Project(
  makeProject({
    id: ProjectId.make("p-mend"),
    organizationId: OrganizationId.make("org-acme"),
    visibility: "private",
    createdByUserId: "alice",
    storePath: "/store/p-mend",
  }),
);

const runWith = <A, E>(effect: Effect.Effect<A, E, Adoptions>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.fresh(AdoptionsLive)), Effect.scoped));

describe("adoptions as they run", () => {
  it("reads how far the clone got, in git's own words, while it runs", async () => {
    await runWith(
      Effect.gen(function* () {
        const adoptions = yield* Adoptions;
        const reported = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const fiber = yield* adoptions
          .run(
            start,
            (report) =>
              Effect.gen(function* () {
                report.store({ _tag: "Cloning", git: null });
                report.store({
                  _tag: "Cloning",
                  git: {
                    step: "Receiving objects",
                    remote: false,
                    percent: 45,
                    done: 72,
                    total: 160,
                    received: "1.20 MiB",
                    rate: "2.00 MiB/s",
                  },
                });
                yield* Deferred.succeed(reported, undefined);
                yield* Deferred.await(finish);
                report.store({ _tag: "Checking" });
                report.recording();
                return adopted;
              }),
            () => ({ failure: "never", gitSaid: null }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(reported);
        expect(yield* adoptions.read("alice", ID)).toMatchObject({
          state: "running",
          phase: "cloning",
          git: { step: "Receiving objects", percent: 45, received: "1.20 MiB" },
        });
        // Another account never reads it.
        expect(yield* adoptions.read("bob", ID)).toBeNull();
        yield* Deferred.succeed(finish, undefined);
        expect(yield* Fiber.join(fiber)).toBe(adopted);
        expect(yield* adoptions.read("alice", ID)).toMatchObject({
          state: "adopted",
          phase: "recording",
          projectId: "p-mend",
        });
      }),
    );
  });

  it("keeps Mend's sentence and git's own words when the clone fails", async () => {
    await runWith(
      Effect.gen(function* () {
        const adoptions = yield* Adoptions;
        const failed = yield* adoptions
          .run(
            start,
            () => Effect.fail({ message: "The repository was not found." }),
            (error) => ({
              failure: error.message,
              gitSaid: "fatal: repository 'https://github.com/sealant-sh/mend/' not found",
            }),
          )
          .pipe(Effect.flip);
        expect(failed.message).toBe("The repository was not found.");
        expect(yield* adoptions.read("alice", ID)).toMatchObject({
          state: "failed",
          failure: "The repository was not found.",
          gitSaid: "fatal: repository 'https://github.com/sealant-sh/mend/' not found",
        });
      }),
    );
  });

  it("finishes a clone whose request was cut off, and reads its end", async () => {
    await runWith(
      Effect.gen(function* () {
        const adoptions = yield* Adoptions;
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const request = yield* adoptions
          .run(
            start,
            () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(finish);
                return adopted;
              }),
            () => ({ failure: "never", gitSaid: null }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        // The browser reloaded: the request goes, the clone does not.
        yield* Fiber.interrupt(request);
        expect(yield* adoptions.read("alice", ID)).toMatchObject({ state: "running" });
        yield* Deferred.succeed(finish, undefined);
        yield* Effect.yieldNow;
        expect(yield* adoptions.read("alice", ID)).toMatchObject({
          state: "adopted",
          projectId: "p-mend",
        });
      }),
    );
  });
});
