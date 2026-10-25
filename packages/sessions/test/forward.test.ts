import { SealantWorkspaceId } from "@mend/domain";
import {
  type ForwardBytes,
  type ForwardIoFailure,
  ForwardSessionOwner,
  SealantPlatformError,
} from "@mend/sealant";
import { ForwardDialError } from "@sealant/sdk";
import { Effect, Exit, Fiber, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ForwardAdapter, type ForwardTarget, forwardStartupAction } from "../src/forward.ts";
import {
  adapterLayer,
  dialLog,
  echo,
  type FakeForward,
  fakeForward,
  held,
  refusal,
  scriptedSealant,
  type DialScript,
  takeFirst,
  untilAborted,
} from "./forward-fixture.ts";

const portTarget: ForwardTarget = {
  workspaceId: SealantWorkspaceId.make("ws-1"),
  port: 3000,
  binding: { kind: "port" },
};
const owner = ForwardSessionOwner.make("pty-7");
const boundTarget: ForwardTarget = { ...portTarget, binding: { kind: "session", session: owner } };

const options = { timeoutMs: 5_000, purpose: "benchmark" } as const;

/** Run `probe` through the real adapter over a scripted SDK; the dial log comes back with it. */
const probeWith = (
  script: DialScript,
  target: ForwardTarget,
  rule: "refuse" | "allow-port-scoped" = "refuse",
  probeOptions: Parameters<ForwardAdapter["Service"]["probe"]>[1] = options,
) => {
  const sealant = scriptedSealant(script);
  const log = dialLog();
  return Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* ForwardAdapter;
      const record = yield* adapter.probe(target, probeOptions);
      return { record, ledger: sealant.ledger, logged: log.records };
    }).pipe(Effect.provide(Layer.merge(adapterLayer(sealant.layer, rule), log.layer))),
  );
};

const openPort = (): DialScript => async (destination) =>
  destination.route === "loopback"
    ? fakeForward(
        echo,
        destination.binding.kind === "session"
          ? { kind: "session", session: destination.binding.session }
          : { kind: "port" },
      ).forward
    : fakeForward(echo).forward;

/** Loopback refuses the connection; the sidecar holds the port. */
const loopbackRefuses: DialScript = async (destination) => {
  if (destination.route === "loopback") throw refusal("connection-refused");
  return fakeForward(echo).forward;
};

describe("the forward adapter's dial", () => {
  it("opens on loopback first and records what it proved", async () => {
    const { record, ledger, logged } = await probeWith(openPort(), boundTarget);
    expect(record).toMatchObject({
      kind: "ready",
      arrival: { route: "loopback", proof: { kind: "session", session: "pty-7" } },
      requested: { kind: "session", session: "pty-7" },
      attempts: [{ route: "loopback", outcome: "ready" }],
    });
    expect(ledger.dials).toEqual([
      { route: "loopback", binding: { kind: "session", session: "pty-7" } },
    ]);
    expect(ledger.lookups).toBe(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.dialId).toBe(record.dialId);
  });

  it("tries the sidecar for a port-scoped target only after loopback refuses the connection", async () => {
    const { record, ledger } = await probeWith(loopbackRefuses, portTarget);
    expect(record).toMatchObject({
      kind: "ready",
      arrival: { route: "docker", proof: { kind: "port" } },
      attempts: [
        { route: "loopback", outcome: "connection-refused" },
        { route: "docker", outcome: "ready" },
      ],
    });
    expect(ledger.dials.map((dial) => dial.route)).toEqual(["loopback", "docker"]);
  });

  for (const reason of [
    "forbidden",
    "not-found",
    "dial-timeout",
    "peer-mismatch",
    "workspace-not-ready",
    "binding-unverifiable",
  ] as const) {
    it(`does not try the sidecar after a loopback ${reason}`, async () => {
      const { record, ledger } = await probeWith(async () => {
        throw refusal(reason, 403);
      }, portTarget);
      expect(record).toMatchObject({ kind: "failed", issue: { reason } });
      expect(ledger.dials.map((dial) => dial.route)).toEqual(["loopback"]);
    });
  }

  it("reports the loopback refusal when the sidecar is absent or holds nothing", async () => {
    for (const docker of ["name-unresolved", "connection-refused"] as const) {
      const { record } = await probeWith(async (destination) => {
        throw refusal(destination.route === "loopback" ? "connection-refused" : docker);
      }, portTarget);
      expect(record).toMatchObject({
        kind: "failed",
        issue: { reason: "connection-refused" },
        attempts: [
          { route: "loopback", outcome: "connection-refused" },
          { route: "docker", outcome: docker },
        ],
      });
    }
  });

  it("reports the sidecar's refusal when it says something new", async () => {
    const { record } = await probeWith(async (destination) => {
      throw destination.route === "loopback"
        ? refusal("connection-refused")
        : refusal("forbidden", 403);
    }, portTarget);
    expect(record).toMatchObject({ kind: "failed", issue: { reason: "forbidden" } });
  });

  describe("a session-bound target that loopback refuses", () => {
    it("stops there under `refuse`", async () => {
      const { record, ledger } = await probeWith(loopbackRefuses, boundTarget, "refuse");
      expect(record).toMatchObject({ kind: "failed", issue: { reason: "connection-refused" } });
      expect(ledger.dials.map((dial) => dial.route)).toEqual(["loopback"]);
    });

    it("tries the sidecar port-scoped under `allow-port-scoped`, and says the session was not proved", async () => {
      const { record, ledger } = await probeWith(loopbackRefuses, boundTarget, "allow-port-scoped");
      expect(record).toMatchObject({
        kind: "ready",
        requested: { kind: "session", session: "pty-7" },
        arrival: { route: "port-fallback", proof: { kind: "port" }, requested: "pty-7" },
      });
      expect(ledger.dials).toEqual([
        { route: "loopback", binding: { kind: "session", session: "pty-7" } },
        { route: "docker", binding: { kind: "port" } },
      ]);
    });

    it("never tries the sidecar after any other loopback refusal, under either rule", async () => {
      for (const rule of ["refuse", "allow-port-scoped"] as const) {
        const { ledger } = await probeWith(
          async () => {
            throw refusal("peer-mismatch", 409);
          },
          boundTarget,
          rule,
        );
        expect(ledger.dials.map((dial) => dial.route)).toEqual(["loopback"]);
      }
    });
  });

  it("keeps a reason Core sent that this SDK does not know", async () => {
    const { record } = await probeWith(async () => {
      throw new ForwardDialError({
        reason: "unrecognized-refusal",
        wireReason: "quota-thawing",
        status: 503,
        message: "newer Core",
      });
    }, portTarget);
    expect(record).toMatchObject({
      kind: "failed",
      issue: { reason: "unrecognized-refusal", wireReason: "quota-thawing" },
    });
    expect(
      forwardStartupAction(
        record.kind === "failed" ? record.issue : { reason: "cancelled", message: "" },
      ),
    ).toBe("stop");
  });

  it("keeps Mend's own refusals apart from Core's, and a lookup failure apart from both", async () => {
    for (const code of ["no_standing", "creator_no_access", "NO_PRINCIPAL"] as const) {
      const sealant = scriptedSealant(openPort(), () =>
        Effect.fail(new SealantPlatformError({ code, status: 403, message: code, cause: null })),
      );
      const record = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* ForwardAdapter).probe(portTarget, options);
        }).pipe(Effect.provide(adapterLayer(sealant.layer, "refuse"))),
      );
      expect(record).toMatchObject({ kind: "failed", issue: { reason: code }, attempts: [] });
      expect(sealant.ledger.dials).toEqual([]);
    }
    const sealant = scriptedSealant(openPort(), () =>
      Effect.fail(
        new SealantPlatformError({
          code: "HttpClientError",
          status: null,
          message: "down",
          cause: null,
        }),
      ),
    );
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ForwardAdapter).probe(portTarget, options);
      }).pipe(Effect.provide(adapterLayer(sealant.layer, "refuse"))),
    );
    expect(record).toMatchObject({
      kind: "failed",
      issue: { reason: "platform-failed", code: "HttpClientError" },
    });
    expect(
      forwardStartupAction(
        record.kind === "failed" ? record.issue : { reason: "cancelled", message: "" },
      ),
    ).toBe("retry");
  });

  it("ends at once on a lookup Core will answer the same way again: gone, unauthorized, forbidden", async () => {
    for (const [status, reason] of [
      [404, "not-found"],
      [401, "unauthorized"],
      [403, "forbidden"],
    ] as const) {
      const sealant = scriptedSealant(openPort(), () =>
        Effect.fail(
          new SealantPlatformError({
            code: "WorkspaceNotFoundError",
            status,
            message: "refused",
            cause: null,
          }),
        ),
      );
      const record = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* ForwardAdapter).probe(portTarget, options);
        }).pipe(Effect.provide(adapterLayer(sealant.layer, "refuse"))),
      );
      expect(record).toMatchObject({ kind: "failed", issue: { reason } });
      expect(
        forwardStartupAction(
          record.kind === "failed"
            ? record.issue
            : { reason: "platform-failed", code: "", message: "" },
        ),
      ).toBe("stop");
    }
  });

  it("records a dial that throws synchronously as a platform failure, never a cancellation", async () => {
    const { record, logged } = await probeWith(() => {
      throw new TypeError("ReadableStream is locked");
    }, portTarget);
    expect(record).toMatchObject({
      kind: "failed",
      issue: { reason: "platform-failed" },
      attempts: [{ route: "loopback", outcome: "platform-failed" }],
    });
    expect(logged).toEqual([expect.objectContaining({ dialId: record.dialId })]);
  });

  it("records a dial that dies as a defect, never a cancellation", async () => {
    const sealant = scriptedSealant(openPort(), () => Effect.die(new Error("boom")));
    const log = dialLog();
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* (yield* ForwardAdapter).probe(portTarget, options);
      }).pipe(Effect.provide(Layer.merge(adapterLayer(sealant.layer, "refuse"), log.layer))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(log.records).toEqual([
      expect.objectContaining({
        kind: "failed",
        issue: expect.objectContaining({ reason: "platform-failed", code: "defect" }),
      }),
    ]);
  });

  it("holds lookup and both attempts to one deadline", async () => {
    const started = Date.now();
    const { record } = await probeWith(
      async (destination, signal) => {
        if (destination.route === "loopback") {
          await new Promise((resolve) => setTimeout(resolve, 60));
          throw refusal("connection-refused");
        }
        return untilAborted(signal);
      },
      portTarget,
      "refuse",
      { timeoutMs: 150, purpose: "benchmark" },
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(record).toMatchObject({
      kind: "failed",
      issue: { reason: "deadline-exceeded" },
      attempts: [
        { route: "loopback", outcome: "connection-refused" },
        { route: "docker", outcome: "deadline-exceeded" },
      ],
    });
    expect(record.totalMs).toBeGreaterThanOrEqual(140);
  });
});

describe("the forward adapter's cancellation", () => {
  it("gives up a dial in flight when the signal aborts, with no sidecar attempt after it", async () => {
    const lifetime = new AbortController();
    const pending = probeWith(
      (_destination, signal) => untilAborted(signal),
      portTarget,
      "refuse",
      { ...options, signal: lifetime.signal },
    );
    setTimeout(() => lifetime.abort(), 20);
    const { record, ledger, logged } = await pending;
    expect(record).toMatchObject({
      kind: "failed",
      issue: { reason: "cancelled" },
      attempts: [{ route: "loopback", outcome: "cancelled" }],
    });
    expect(ledger.dials).toHaveLength(1);
    expect(logged).toHaveLength(1);
  });

  it("gives up a lookup in flight when the signal aborts, at once and as a cancellation", async () => {
    const sealant = scriptedSealant(openPort(), () => Effect.never);
    const lifetime = new AbortController();
    setTimeout(() => lifetime.abort(), 20);
    const started = Date.now();
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ForwardAdapter).probe(portTarget, {
          ...options,
          signal: lifetime.signal,
        });
      }).pipe(Effect.provide(adapterLayer(sealant.layer, "refuse"))),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(record).toMatchObject({
      kind: "failed",
      issue: { reason: "cancelled" },
      lookupMs: null,
      attempts: [],
    });
    expect(sealant.ledger.dials).toEqual([]);
  });

  it("does not dial at all when the signal already aborted", async () => {
    const lifetime = new AbortController();
    lifetime.abort();
    const { record, ledger } = await probeWith(openPort(), portTarget, "refuse", {
      ...options,
      signal: lifetime.signal,
    });
    expect(record).toMatchObject({
      kind: "failed",
      issue: { reason: "cancelled" },
      lookupMs: null,
    });
    expect(ledger.lookups).toBe(0);
  });

  it("resets a forward that opens after its fiber was interrupted, and still logs the dial once", async () => {
    const opening = held<ReturnType<typeof fakeForward>>();
    const asked = held<void>();
    const sealant = scriptedSealant(async () => {
      asked.resolve();
      // The SDK resolves although the open was given up: the seam must reset what it gets.
      return (await opening.promise).forward;
    });
    const log = dialLog();
    const late = fakeForward(echo);
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ForwardAdapter;
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.open(portTarget, options)));
        yield* Effect.promise(() => asked.promise);
        yield* Fiber.interrupt(fiber);
        opening.resolve(late);
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
      }).pipe(Effect.provide(Layer.merge(adapterLayer(sealant.layer, "refuse"), log.layer))),
    );
    expect(late.closedByClient()).toBe(true);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]).toMatchObject({ kind: "failed", issue: { reason: "cancelled" } });
  });

  it("resets an open forward when its scope closes, and when the signal aborts after it opened", async () => {
    const first = fakeForward(echo);
    const second = fakeForward(echo);
    const forwards = [first, second];
    const sealant = scriptedSealant(
      async () => forwards.shift()?.forward ?? Promise.reject(new Error("no more")),
    );
    const lifetime = new AbortController();
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const adapter = yield* ForwardAdapter;
        yield* Effect.scoped(adapter.open(portTarget, options));
        expect(first.closedByClient()).toBe(true);
        return yield* Effect.scoped(
          Effect.gen(function* () {
            yield* adapter.open(portTarget, { ...options, signal: lifetime.signal });
            lifetime.abort();
            return second.closedByClient();
          }),
        );
      }).pipe(Effect.provide(adapterLayer(sealant.layer, "refuse"))),
    );
    expect(exit).toEqual(Exit.succeed(true));
  });
});

describe("the startup classification", () => {
  it("retries what a starting Service answers and stops on what will not change", () => {
    expect(forwardStartupAction({ reason: "connection-refused", message: "" })).toBe("retry");
    expect(forwardStartupAction({ reason: "workspace-not-ready", message: "" })).toBe("retry");
    expect(forwardStartupAction({ reason: "not-found", message: "" })).toBe("stop");
    expect(forwardStartupAction({ reason: "no_standing", message: "" })).toBe("stop");
    expect(forwardStartupAction({ reason: "owner-exited", message: "" })).toBe("stop");
    expect(forwardStartupAction({ reason: "peer-mismatch", message: "" })).toBe("stop");
  });
});

const withBytes = <A>(
  forward: FakeForward,
  use: (bytes: ForwardBytes) => Effect.Effect<A, ForwardIoFailure>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* (yield* ForwardAdapter).open(portTarget, options);
        return yield* use(connection.bytes);
      }),
    ).pipe(
      Effect.match({
        onFailure: (failure) => ({ ok: false as const, failure }),
        onSuccess: (value) => ({ ok: true as const, value }),
      }),
      Effect.provide(adapterLayer(scriptedSealant(async () => forward.forward).layer, "refuse")),
    ),
  );

const readAll = (bytes: ForwardBytes) =>
  Effect.gen(function* () {
    let text = "";
    for (;;) {
      const next = yield* bytes.read();
      if (next.kind === "eof") return text;
      text += Buffer.from(next.bytes).toString();
    }
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("an open forward's bytes", () => {
  it("fails the read with the reset when the workspace ends without taking what came before the client's FIN", async () => {
    const forward = fakeForward(async (side) => {
      await takeFirst(side);
      void side.send(Buffer.from("answer"));
      await sleep(30);
      await side.end();
    });
    const result = await withBytes(forward, (bytes) =>
      Effect.gen(function* () {
        yield* bytes.write(Buffer.from("taken"));
        yield* bytes.write(Buffer.from("never taken"));
        yield* bytes.finish();
        const first = yield* bytes.read();
        expect(first.kind === "bytes" && Buffer.from(first.bytes).toString()).toBe("answer");
        return yield* bytes.read();
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { _tag: "ForwardIoFailure", reason: "workspace-ended" },
    });
  });

  it("keeps the answer of a workspace that ended while the client was still sending, and drops the rest", async () => {
    const answer = "HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\n\r\n";
    const forward = fakeForward(async (side) => {
      await takeFirst(side);
      void side.send(Buffer.from(answer));
      await side.end();
    });
    const result = await withBytes(forward, (bytes) =>
      Effect.all(
        [
          Effect.gen(function* () {
            for (let i = 0; i < 50; i++) yield* bytes.write(Buffer.alloc(64 * 1024, i));
            yield* bytes.finish();
          }),
          readAll(bytes),
        ],
        { concurrency: 2 },
      ),
    );
    expect(result).toEqual({ ok: true, value: [undefined, answer] });
    expect(forward.closedByClient()).toBe(false);
  });
});
