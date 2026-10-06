import {
  HarnessLayoutsRepo,
  type HarnessLayoutsMemoryState,
  OrganizationsRepo,
  harnessLayoutsRepoMemory,
  makeHarnessLayoutsMemoryState,
} from "@mend/db";
import { OrganizationId, WorktreeId, defaultWorkspaceImage } from "@mend/domain";
import { PersonLayoutPlatform } from "@mend/sealant";
import type { Workspace } from "@sealant/sdk";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeHarnessLayoutSteps } from "./harness-layout-steps.ts";

/**
 * The per-person steps' own memory (docs/adr/0016): the layout each launch runs, as the session
 * channel reads it on every request, and what prepare's report makes of a person who could not
 * be given their identity.
 */

const never = () => new Promise<never>(() => {});
const workspace: Workspace = {
  id: "workspace-1",
  name: "fake",
  status: async () => "ready",
  runtimeDeadline: async () => null,
  runtime: async () => null,
  launch: undefined,
  recover: never,
  captureDrain: async () => null,
  ready: async function () {
    return this;
  },
  harness: { run: never, start: never, session: never },
  exec: never,
  bind: async () => [],
  capture: { flush: never, status: never, replan: never },
  sessions: { open: never, get: never, list: async () => [] },
  events: async function* () {},
  forward: never,
  stop: async () => ({ state: "stopped" }),
  restart: async function () {
    return this;
  },
  expire: async () => undefined,
  image: async () => null,
  credentials: { put: never, release: never, list: async () => [] },
};

const platformLayer = Layer.succeed(PersonLayoutPlatform, {
  processUser: true,
  imageReport: () =>
    Effect.succeed({ digest: "sha256:img", runtime: "docker", person: true, missing: [] }),
  postCredentials: () => Effect.void,
  deleteCredentials: () => Effect.void,
  applyDotfiles: () => Effect.void,
});

const organizationsLayer = Layer.mock(OrganizationsRepo, { members: () => Effect.succeed([]) });

/** The steps over the in-memory repo, counting every launch layout read from the store. */
const stepsWith = (flag: "person" | "shared", state: HarnessLayoutsMemoryState) =>
  Effect.gen(function* () {
    const repo = yield* HarnessLayoutsRepo;
    const reads: Array<string> = [];
    // As the engine does at startup: one query.
    const anyRecorded = yield* repo.anyRecorded();
    const steps = makeHarnessLayoutSteps({
      flag,
      repo: {
        ...repo,
        launchLayout: (launchId) =>
          Effect.sync(() => reads.push(launchId)).pipe(Effect.andThen(repo.launchLayout(launchId))),
        worktreeLayout: (worktreeId) =>
          Effect.sync(() => reads.push(`worktree:${worktreeId}`)).pipe(
            Effect.andThen(repo.worktreeLayout(worktreeId)),
          ),
      },
      anyRecorded,
      platform: yield* PersonLayoutPlatform,
      organizations: yield* OrganizationsRepo,
      sealant: { exec: () => Effect.die("not in test") },
      harnessHome: "/workspace/harness-home",
      fork: () => Effect.void,
      identityTicket: () => Effect.succeed("t".repeat(43)),
      discardTicket: () => {},
    });
    return { steps, reads };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(harnessLayoutsRepoMemory(state), platformLayer, organizationsLayer),
    ),
  );

const decideInput = (launchId: string) => ({
  worktreeId: WorktreeId.make("wt-1"),
  sessionId: "sess-1",
  launchId,
  ownerUserId: "user-alice",
  organizationId: OrganizationId.make("org-1"),
  image: Effect.succeed(defaultWorkspaceImage),
  headHasPeople: Effect.succeed(false),
});

const settleInput = (launchId: string, stdout: string) => ({
  launchId,
  worktreeId: WorktreeId.make("wt-1"),
  workspace,
  stdout,
  fallback: { credentials: undefined, dotfiles: [] },
});

describe("the layout each launch runs, as the channel reads it (docs/adr/0016)", () => {
  it("stays person through prepare and after, even when the cache flushes mid-prepare", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { steps } = yield* stepsWith("person", makeHarnessLayoutsMemoryState());
        const layout = yield* steps.decide(decideInput("launch-person"));
        // Every launch's first channel request looks its layout up: 2,048 of them, then the
        // identity pickup of this launch's prepare, which asks inside prepare's own exec.
        for (let i = 0; i < 2_048; i++) yield* steps.layoutOfLaunch(`launch-${i}`);
        const duringPrepare = yield* steps.layoutOfLaunch("launch-person");
        const settled = yield* steps.settlePrepare({
          layout,
          ...settleInput(
            "launch-person",
            "mend-layout probed\nmend-layout made mxlcv7ihf\nmend-layout ready\n",
          ),
        });
        for (let i = 2_048; i < 4_096; i++) yield* steps.layoutOfLaunch(`launch-${i}`);
        return {
          decided: layout.layout,
          duringPrepare,
          settled: settled.layout,
          afterConfirm: yield* steps.layoutOfLaunch("launch-person"),
        };
      }),
    );
    expect(result).toEqual({
      decided: "person",
      duringPrepare: "person",
      settled: "person",
      afterConfirm: "person",
    });
  });

  it("with the flag off and nothing recorded, reads nothing, before and after a restart", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = makeHarnessLayoutsMemoryState();
        const before = yield* stepsWith("shared", state);
        yield* before.steps.decide(decideInput("launch-live"));
        yield* before.steps.mayRunPerson(WorktreeId.make("wt-1"));
        yield* before.steps.standbyMayServe(WorktreeId.make("wt-1"));
        // Mend restarts: a new process, its cache empty, the launch still live.
        const after = yield* stepsWith("shared", state);
        const layouts = [
          yield* after.steps.layoutOfLaunch("launch-live"),
          yield* after.steps.layoutOfLaunch("launch-from-before"),
        ];
        const runsPerson = yield* after.steps.mayRunPerson(WorktreeId.make("wt-1"));
        const standby = yield* after.steps.standbyMayServe(WorktreeId.make("wt-1"));
        yield* after.steps.decide(decideInput("launch-next"));
        return { layouts, runsPerson, standby, reads: [...before.reads, ...after.reads] };
      }),
    );
    expect(result).toEqual({
      layouts: ["shared", "shared"],
      runsPerson: false,
      standby: true,
      reads: [],
    });
  });

  it("with the flag off, sees on the reaper tick a layout another engine recorded", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = makeHarnessLayoutsMemoryState();
        const { steps, reads } = yield* stepsWith("shared", state);
        const before = yield* steps.mayRunPerson(WorktreeId.make("wt-1"));
        // Another engine over the same store makes the worktree person.
        state.worktrees.set(WorktreeId.make("wt-1"), { layout: "person", requested: null });
        yield* steps.refreshRecorded();
        return { before, after: yield* steps.mayRunPerson(WorktreeId.make("wt-1")), reads };
      }),
    );
    expect(result).toEqual({ before: false, after: true, reads: ["worktree:wt-1"] });
  });

  it("with the flag off, a person worktree recorded before a restart is still read, and still person", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = makeHarnessLayoutsMemoryState();
        state.worktrees.set(WorktreeId.make("wt-1"), { layout: "person", requested: null });
        const { steps, reads } = yield* stepsWith("shared", state);
        return { runsPerson: yield* steps.mayRunPerson(WorktreeId.make("wt-1")), reads };
      }),
    );
    expect(result).toEqual({ runsPerson: true, reads: ["worktree:wt-1"] });
  });

  it("with the flag off, the layout is known at decide: the channel never reads it from the store", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = makeHarnessLayoutsMemoryState();
        const { steps, reads } = yield* stepsWith("shared", state);
        yield* steps.decide(decideInput("launch-shared"));
        const layouts = [];
        for (let i = 0; i < 5; i++) layouts.push(yield* steps.layoutOfLaunch("launch-shared"));
        return { layouts, reads, recorded: state.launches.size };
      }),
    );
    expect(result).toEqual({ layouts: Array(5).fill("shared"), reads: [], recorded: 0 });
  });

  it("refuses a person launch whose people could not be given their identity, with words to try again", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const state = makeHarnessLayoutsMemoryState();
        const { steps } = yield* stepsWith("person", state);
        const layout = yield* steps.decide(decideInput("launch-identity"));
        const refused = yield* steps
          .settlePrepare({
            layout,
            ...settleInput(
              "launch-identity",
              "mend-layout probed\nmend-layout made mxlcv7ihf\n" +
                "mend-layout failed mxlcv7ihf identity: the pickup could not reach Mend\n",
            ),
          })
          .pipe(Effect.flip);
        return { message: refused.message, capabilities: state.capabilities.size };
      }),
    );
    expect(failure.message).toBe(
      "This workspace could not give each person their Mend identity (mxlcv7ihf: identity: the pickup could not reach Mend). Nothing was started; the next launch tries again.",
    );
    expect(failure.message).not.toContain("image");
    // Nothing is held against the image.
    expect(failure.capabilities).toBe(0);
  });
});
