import * as fs from "node:fs";

import { SessionEngine } from "@mend/sessions";
import { Clock, Effect, Exit } from "effect";
import { expect } from "vitest";

import { it, TestClock } from "./effect-vitest.ts";
import { setup, withEngineEffect } from "./engine/fixture.ts";

it.effect(
  "engine fixture rows share the caller's Clock and close before their directory is removed",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(123_000);
      const finalizers: Array<boolean> = [];
      const tmp = yield* withEngineEffect((world, directory) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              finalizers.push(fs.existsSync(directory));
            }),
          );
          const project = yield* setup(directory, world);
          expect(project.createdAt.getTime()).toBe(123_000);
          yield* TestClock.adjust(100);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "clock",
            ownerUserId: "user-fixture",
            base: null,
          });
          expect(world.sessions.get(session.id)?.createdAt.getTime()).toBe(123_100);
          expect(yield* Clock.currentTimeMillis).toBe(123_100);
          return directory;
        }),
      );
      expect(finalizers).toEqual([true]);
      expect(fs.existsSync(tmp)).toBe(false);
    }),
);

it.effect(
  "engine fixture removes its directory when preparation defects before engine construction",
  () =>
    Effect.gen(function* () {
      let directory: string | undefined;
      const exit = yield* withEngineEffect(() => Effect.void, {
        prepareWorld: (_world, tmp) => {
          directory = tmp;
          throw new Error("fixture preparation failed");
        },
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(directory).toBeDefined();
      if (directory === undefined) throw new Error("fixture did not acquire its directory");
      expect(fs.existsSync(directory)).toBe(false);
    }),
);
