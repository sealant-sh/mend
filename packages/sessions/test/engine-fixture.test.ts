import * as fs from "node:fs";
import * as net from "node:net";

import { SessionEngine } from "@mend/sessions";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import { Clock, Effect, Exit } from "effect";
import { expect, vi } from "vitest";

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
            start: { kind: "base", base: null },
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

it.effect(
  "engine fixture's Git origin serves even when another process takes each port the fixture lets go of",
  () =>
    Effect.gen(function* () {
      const thieves: Array<net.Server> = [];
      const close = net.Server.prototype.close;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi
            .spyOn(net.Server.prototype, "close")
            .mockImplementation(function (this: net.Server, callback) {
              const address = this.address();
              if (address !== null && typeof address !== "string") {
                this.prependOnceListener("close", () => {
                  const thief = net.createServer();
                  thief.on("error", () => {});
                  thief.listen(address.port, address.address);
                  thieves.push(thief);
                });
              }
              return close.call(this, callback);
            }),
        ),
        (spy) =>
          Effect.sync(() => {
            spy.mockRestore();
            for (const thief of thieves) thief.close();
          }),
      );
      const project = yield* withEngineEffect((world, directory) => setup(directory, world));
      expect(project.adoptedSha).toMatch(/^[0-9a-f]{40}$/);
    }),
);
