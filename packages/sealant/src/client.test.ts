import { SealantApiError } from "@sealant/sdk";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  captureDrainOf,
  captureStatusOf,
  platformErrorCode,
  runtimeDeadlineOf,
  runtimeResourceIdOf,
  stopWith,
  type WorkspaceStopOptions,
  workspaceByKeyOf,
  fenceWorkspaceCreateOf,
  workspaceStopAnswerOf,
  workspaceStopStateOf,
} from "./client.ts";

/**
 * The engine branches on the platform's STABLE codes (`workspace-docker-unsupported`,
 * `runtime-env-references-unsupported`). The SDK reports a typed contract error's TAG as its
 * `code` and keeps the decoded error as `cause`; the stable code must win, on every shape the
 * client can receive. The decoded contract error is modelled as what it is at runtime: a record
 * with `_tag`, `code` and `message`.
 */
describe("platformErrorCode", () => {
  const contractError = {
    _tag: "WorkspaceDockerServiceUnsupportedError",
    code: "workspace-docker-unsupported",
    message: "no Docker here",
  };

  it("prefers the body code over the SDK's tag code", () => {
    const sdkError = new SealantApiError("no Docker here", {
      code: contractError._tag,
      status: 422,
      cause: contractError,
    });
    expect(sdkError.code).toBe("WorkspaceDockerServiceUnsupportedError");
    expect(platformErrorCode(sdkError)).toBe("workspace-docker-unsupported");
  });

  it("reads the body code off a bare contract error (Effect-native operations)", () => {
    expect(platformErrorCode(contractError)).toBe("workspace-docker-unsupported");
  });

  it("falls back to the SDK code, then the tag, then UNKNOWN", () => {
    expect(platformErrorCode(new SealantApiError("boom", { code: "api_error", status: 500 }))).toBe(
      "api_error",
    );
    expect(platformErrorCode({ _tag: "SomethingElse", message: "x" })).toBe("SomethingElse");
    expect(platformErrorCode(new Error("plain"))).toBe("UNKNOWN");
  });
});

/**
 * A stop's answer (Core's `WorkspaceStopResult`): only `stopped` is a termination. SDK 0.37.2
 * resolves nothing, which is a stop asked and nothing more known.
 */
describe("workspaceStopStateOf", () => {
  it("reads the platform's four states and nothing else", () => {
    expect(workspaceStopStateOf({ state: "stopped" })).toBe("stopped");
    expect(workspaceStopStateOf({ state: "draining", drain: {} })).toBe("draining");
    expect(workspaceStopStateOf({ state: "kept" })).toBe("kept");
    expect(workspaceStopStateOf({ state: "requested" })).toBe("requested");
    expect(workspaceStopStateOf(undefined)).toBe("requested");
    expect(workspaceStopStateOf({ state: "gone" })).toBe("requested");
  });
});

describe("captureStatusOf", () => {
  const status = {
    epoch: 3,
    worktreeId: "wt-1",
    pending: 1,
    stagedBytes: 10,
    uploadedObjects: 2,
    uploadedBytes: 20,
    registered: 2,
    fenced: false,
    paused: false,
    lastSnapError: "EIO: tree/db.sqlite",
    snapFailingSinceUnixMs: 1_790_000_000_000,
  };

  it("asks nothing of an SDK without `capture.status()` (0.37.2)", async () => {
    const answer = await Effect.runPromise(
      captureStatusOf({ capture: { flush: async () => status } }),
    );
    expect(answer).toBeNull();
  });

  it("reads Core's `capture.status()` as it is, with the fields the SDK does not type yet", async () => {
    const answer = await Effect.runPromise(
      captureStatusOf({ capture: { status: async () => status } }),
    );
    expect(answer).toEqual(status);
  });

  it("refuses an answer without what Mend reads", async () => {
    const error = await Effect.runPromise(
      Effect.flip(captureStatusOf({ capture: { status: async () => ({ pending: 1 }) } })),
    );
    expect(error.code).toBe("capture_status_unreadable");
  });
});

describe("runtimeDeadlineOf", () => {
  it("asks nothing of an SDK without `runtimeDeadline()` (0.37.2)", async () => {
    await expect(
      Effect.runPromise(runtimeDeadlineOf({ status: async () => "ready" })),
    ).resolves.toBeNull();
  });

  it("reads the platform's deadline, and null where the runtime has none", async () => {
    const at = "2026-09-28T08:00:00.000Z";
    await expect(
      Effect.runPromise(runtimeDeadlineOf({ runtimeDeadline: async () => at })),
    ).resolves.toEqual(new Date(at));
    await expect(
      Effect.runPromise(runtimeDeadlineOf({ runtimeDeadline: async () => null })),
    ).resolves.toBeNull();
    await expect(
      Effect.runPromise(runtimeDeadlineOf({ runtimeDeadline: async () => "not a time" })),
    ).resolves.toBeNull();
  });
});

describe("workspaceStopAnswerOf", () => {
  it("reads a kept executor retained for recovery, and what became of a completion", () => {
    expect(
      workspaceStopAnswerOf({
        state: "kept",
        drain: {
          state: "kept",
          retained: {
            since: "x",
            reason: "ended without a complete final flush",
            recoverable: true,
          },
        },
        completion: { outcome: "ignored", detail: "not the current executor" },
      }),
    ).toEqual({
      state: "kept",
      retained: { reason: "ended without a complete final flush", recoverable: true },
      completion: { outcome: "ignored", detail: "not the current executor" },
    });
  });

  it("reads SDK 0.37.2's empty answer as requested and nothing more", () => {
    expect(workspaceStopAnswerOf(undefined)).toEqual({
      state: "requested",
      retained: null,
      completion: null,
    });
  });
});

describe("runtimeResourceIdOf", () => {
  it("names the executor from the handle's launch, else from `runtime()`, and nothing on 0.37.2", async () => {
    await expect(
      Effect.runPromise(
        runtimeResourceIdOf({
          launch: { replayed: false, runtime: { kind: "docker", resourceId: "c0ffee" } },
          runtime: async () => ({ kind: "docker", resourceId: "other" }),
        }),
      ),
    ).resolves.toBe("c0ffee");
    await expect(
      Effect.runPromise(
        runtimeResourceIdOf({
          launch: undefined,
          runtime: async () => ({ kind: "microvm", resourceId: "vm-1" }),
        }),
      ),
    ).resolves.toBe("vm-1");
    await expect(
      Effect.runPromise(runtimeResourceIdOf({ runtime: async () => null })),
    ).resolves.toBeNull();
    await expect(Effect.runPromise(runtimeResourceIdOf({}))).resolves.toBeNull();
  });
});

/** Core's `createState` answering `answer`. */
const state = (answer: unknown) =>
  Effect.runPromise(
    workspaceByKeyOf(
      { createState: async () => answer, findByIdempotencyKey: async () => null },
      "k",
    ),
  );
await expect(state({ idempotencyKey: "k", state: "found", workspaceId: "ws-3" })).resolves.toEqual({
  kind: "found",
  workspaceId: "ws-3",
});

describe("workspaceByKeyOf", () => {
  it("finds what a keyed create made, says when it made none, and says 0.37.2 cannot look", async () => {
    await expect(
      Effect.runPromise(
        workspaceByKeyOf({ findByIdempotencyKey: async () => ({ id: "ws-9" }) }, "k"),
      ),
    ).resolves.toEqual({ kind: "found", workspaceId: "ws-9" });
    await expect(
      Effect.runPromise(workspaceByKeyOf({ findByIdempotencyKey: async () => null }, "k")),
    ).resolves.toEqual({ kind: "none" });
    await expect(
      Effect.runPromise(workspaceByKeyOf({ create: async () => ({}) }, "k")),
    ).resolves.toEqual({ kind: "unsupported" });
  });

  it("reads Core's createState: found, cancelled, pending and none as nothing on record yet, anything else unknown", async () => {
    await expect(state({ idempotencyKey: "k", state: "cancelled" })).resolves.toEqual({
      kind: "cancelled",
    });
    await expect(state({ idempotencyKey: "k", state: "pending" })).resolves.toEqual({
      kind: "none",
    });
    await expect(state({ idempotencyKey: "k", state: "none" })).resolves.toEqual({ kind: "none" });
    await expect(state({ idempotencyKey: "k", state: "later" })).resolves.toMatchObject({
      kind: "unknown",
    });
  });

  it("reads an answer it does not recognise as unknown, never as none (review 3 #21)", async () => {
    for (const answer of [{}, { workspace: "ws-9" }, "ws-9", 42, true]) {
      const read = await Effect.runPromise(
        workspaceByKeyOf({ findByIdempotencyKey: async () => answer }, "k"),
      );
      expect(read.kind, JSON.stringify(answer)).toBe("unknown");
    }
  });
});

/** Core's `cancelCreate` answering `answer`. */
const fence = (answer: unknown) =>
  Effect.runPromise(fenceWorkspaceCreateOf({ cancelCreate: async () => answer }, "k"));

describe("fenceWorkspaceCreateOf", () => {
  it("reads a cancelled key, the workspace a create already made, anything else as unknown, and an SDK that cannot fence", async () => {
    await expect(fence({ cancelled: true })).resolves.toEqual({ kind: "cancelled" });
    // Core's `WorkspaceCreateState` (review 3).
    await expect(fence({ idempotencyKey: "k", state: "cancelled" })).resolves.toEqual({
      kind: "cancelled",
    });
    await expect(
      fence({ idempotencyKey: "k", state: "found", workspaceId: "ws-7", launchId: "k" }),
    ).resolves.toEqual({ kind: "found", workspaceId: "ws-7" });
    await expect(fence({ idempotencyKey: "k", state: "pending" })).resolves.toEqual({
      kind: "open",
      state: "pending",
    });
    await expect(fence({ idempotencyKey: "k", state: "gone-away" })).resolves.toMatchObject({
      kind: "unknown",
    });
    await expect(fence({ workspaceId: "ws-9" })).resolves.toEqual({
      kind: "found",
      workspaceId: "ws-9",
    });
    await expect(fence({ id: "ws-8" })).resolves.toEqual({ kind: "found", workspaceId: "ws-8" });
    await expect(fence(null)).resolves.toMatchObject({ kind: "unknown" });
    await expect(fence({ cancelled: false })).resolves.toMatchObject({ kind: "unknown" });
    await expect(
      Effect.runPromise(fenceWorkspaceCreateOf({ findByIdempotencyKey: async () => null }, "k")),
    ).resolves.toEqual({ kind: "unsupported" });
  });
});

describe("stopWith", () => {
  it("hands Core the completion attestation whole, the seal's time with it; no options, no argument", async () => {
    const asked: Array<ReadonlyArray<unknown>> = [];
    const workspace = {
      stop: (...args: ReadonlyArray<unknown>) => {
        asked.push(args);
        return Promise.resolve(undefined);
      },
    };
    const options: WorkspaceStopOptions = {
      completion: {
        captureN: 41,
        epoch: 3,
        executorId: "container-7f3a",
        launchId: "launch:s:1:k",
        sealedAt: "2026-09-28T00:00:11.000Z",
      },
    };
    await stopWith(workspace, options);
    await stopWith(workspace, undefined);
    expect(asked).toEqual([[options], []]);
  });
});

const readDrain = (workspace: object) => Effect.runPromise(captureDrainOf(workspace));

describe("captureDrainOf (e2e9 F-A)", () => {
  it("reads a drain Core ended, one it retains, none, and an SDK without the method", async () => {
    expect(
      await readDrain({
        captureDrain: async () => ({ state: "stopped", detail: "exited on its own" }),
      }),
    ).toEqual({ kind: "drain", state: "stopped", retained: false });
    expect(
      await readDrain({
        captureDrain: async () => ({
          state: "kept",
          retained: { since: "2026-09-28T00:00:00Z", reason: "x", recoverable: true },
        }),
      }),
    ).toEqual({ kind: "drain", state: "kept", retained: true });
    expect(await readDrain({ captureDrain: async () => null })).toEqual({ kind: "none" });
    expect(await readDrain({})).toEqual({ kind: "unsupported" });
  });
});
