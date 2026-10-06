import { defaultWorkspaceImage } from "@mend/domain";
import type { Workspace } from "@sealant/sdk";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  PersonLayoutPlatform,
  PersonLayoutPlatformLive,
  UNKNOWN_IMAGE_REPORT,
  withoutProcessUser,
} from "./person-layout.ts";

const user = {
  name: "m3kq7xj2a",
  uid: 40_012,
  gid: 40_000,
  groups: [40_000],
  home: "/home/m3kq7xj2a",
  umask: 0o002,
};

const never = async (): Promise<never> => {
  throw new Error("not in test");
};

describe("a process asked for as a person (docs/adr/0016, decision 1)", () => {
  it("is refused before it reaches the platform, never run as root", async () => {
    let ran = 0;
    const run = () => Effect.sync(() => ran++);
    const refused = await Effect.runPromiseExit(withoutProcessUser(["codex"], { user }, run));
    expect(Exit.isFailure(refused)).toBe(true);
    expect(ran).toBe(0);
    await Effect.runPromise(withoutProcessUser(["codex"], undefined, run));
    await Effect.runPromise(withoutProcessUser(["codex"], {}, run));
    expect(ran).toBe(2);
  });
});

describe("today's platform", () => {
  it("can run no part of the person layout, and says so", async () => {
    const platform = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* PersonLayoutPlatform;
      }).pipe(Effect.provide(PersonLayoutPlatformLive)),
    );
    expect(platform.processUser).toBe(false);
    expect(await Effect.runPromise(platform.imageReport(defaultWorkspaceImage))).toEqual(
      UNKNOWN_IMAGE_REPORT,
    );
    const workspace: Workspace = {
      id: "ws-1",
      name: "ws",
      status: never,
      runtimeDeadline: never,
      runtime: never,
      launch: undefined,
      recover: never,
      captureDrain: never,
      ready: never,
      harness: { run: never, start: never, session: never },
      exec: never,
      bind: never,
      capture: { flush: never, status: never, replan: never },
      sessions: { open: never, get: never, list: never },
      events: async function* () {},
      forward: never,
      stop: never,
      restart: never,
      expire: never,
      image: never,
      credentials: { put: never, release: never, list: never },
    };
    for (const call of [
      platform.postCredentials(workspace, { onBehalfOf: "a", home: "/root", credentials: {} }),
      platform.deleteCredentials(workspace, { home: "/root" }),
      platform.applyDotfiles(workspace, { user: null, home: "/root", archives: [] }),
    ]) {
      const exit = await Effect.runPromiseExit(call);
      expect(Exit.isFailure(exit)).toBe(true);
    }
  });
});
