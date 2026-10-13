import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";
import {
  composeProtocolArgv,
  ProtocolHarnessUnsupportedError,
  type AgentEvent,
} from "@mend/domain/workbench";
import { Cause, Deferred, Effect, Fiber, Queue, Stream } from "effect";
import { afterEach } from "vitest";

import {
  AgentProtocolError,
  ClaudeAdapter,
  CodexAdapter,
  type AgentTransport,
  type AgentStartOptions,
} from "../src/index.ts";

// Mandatory synthetic-peer checks: no ambient providers/accounts are probed. These exercise
// actual adapters and composed core argv over OS pipes, not released-provider compatibility.
type Harness = "codex" | "claude";
type Peer = {
  readonly home: string;
  readonly record: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly transport: AgentTransport;
  readonly ready: Promise<void>;
  readonly stderr: () => string;
};
const peers: Peer[] = [];
afterEach(() => {
  for (const peer of peers.splice(0)) {
    expect(peer.child.exitCode !== null || peer.child.signalCode !== null).toBe(true);
    expect(fs.existsSync(peer.home)).toBe(false);
  }
});

const peerProcess = Effect.fn("test.peerProcess")(function* (
  harness: Harness,
  scenario: "fresh" | "resume" | "resume-refused" | "hang",
) {
  const home = yield* Effect.acquireRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "mend-provider-peer-"))),
    (directory) => Effect.sync(() => fs.rmSync(directory, { recursive: true, force: true })),
  );
  const providerSessionId =
    scenario === "resume" || scenario === "resume-refused"
      ? harness === "codex"
        ? "thread-owned"
        : "11111111-1111-4111-8111-111111111111"
      : undefined;
  const argv = composeProtocolArgv(
    harness,
    {
      mode: "protocol",
      permissionMode: "ask",
      model: "fixture-model",
      effort: "high",
    },
    providerSessionId,
  );
  if (argv instanceof ProtocolHarnessUnsupportedError) return yield* Effect.die(argv);
  const sessionId =
    harness === "claude"
      ? argv[argv.indexOf(providerSessionId === undefined ? "--session-id" : "--resume") + 1]
      : providerSessionId;
  if (harness === "claude" && sessionId === undefined)
    return yield* Effect.die("Claude argv has no session id.");
  const record = path.join(home, "wire.ndjson");
  const resumePath = path.join(home, "rollout-owned.jsonl");
  const error = (operation: string, cause: unknown) =>
    new AgentProtocolError({
      adapter: harness,
      operation,
      message: `Synthetic peer ${operation} failed.`,
      cause,
    });
  const owned = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./fixtures/provider-peer.mjs", import.meta.url)), ...argv],
        {
          cwd: home,
          env: {
            HOME: home,
            XDG_CONFIG_HOME: home,
            FIXTURE_RECORD: record,
            FIXTURE_SCENARIO: scenario,
            FIXTURE_CWD: home,
            FIXTURE_RESUME_PATH: resumePath,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      let stderr = "";
      let announce: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        announce = resolve;
      });
      child.stderr.on("data", (bytes: Buffer) => {
        stderr += bytes.toString("utf8");
        if (stderr.includes("synthetic hang ready")) announce?.();
      });
      const close = async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      };
      return { child, close, ready, stderr: () => stderr };
    }),
    (ownedChild) => Effect.promise(ownedChild.close),
  );
  const transport: AgentTransport = {
    send: (bytes) =>
      Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) =>
            owned.child.stdin.write(bytes, (cause) => {
              if (cause) {
                reject(cause);
                return;
              }
              resolve();
            }),
          ),
        catch: (cause) => error("write", cause),
      }),
    // Node's async iterator return can wait for an outstanding read. Callback listeners release
    // immediately on interruption, so the following child finalizer can kill and await the peer.
    output: Stream.callback<Uint8Array, AgentProtocolError>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onData = (bytes: Buffer) => {
            Queue.offerUnsafe(queue, bytes);
          };
          const onEnd = () => {
            Queue.endUnsafe(queue);
          };
          const onError = (cause: Error) => {
            Queue.failCauseUnsafe(queue, Cause.fail(error("output", cause)));
          };
          owned.child.stdout.on("data", onData);
          owned.child.stdout.once("end", onEnd);
          owned.child.stdout.once("error", onError);
          owned.child.once("error", onError);
          return () => {
            owned.child.stdout.off("data", onData);
            owned.child.stdout.off("end", onEnd);
            owned.child.stdout.off("error", onError);
            owned.child.off("error", onError);
          };
        }),
        (removeListeners) => Effect.sync(removeListeners),
      ),
    ),
    close: () => Effect.promise(owned.close),
  };
  const peer = {
    home,
    record,
    child: owned.child,
    transport,
    ready: owned.ready,
    stderr: owned.stderr,
  };
  peers.push(peer);
  const options: AgentStartOptions = {
    cwd: home,
    permissionMode: "ask",
    model: "fixture-model",
    effort: "high",
    providerSessionId: sessionId,
    providerSessionPath:
      harness === "codex" && providerSessionId !== undefined ? resumePath : undefined,
  };
  return { ...peer, options };
});

const isFrame = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const frames = (record: string): ReadonlyArray<Readonly<Record<string, unknown>>> =>
  fs
    .readFileSync(record, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!isFrame(value)) throw new Error("Expected object fixture frame.");
      return value;
    });

const harnesses: ReadonlyArray<Harness> = ["codex", "claude"];
describe("provider adapter subprocess contracts (synthetic peers)", () => {
  for (const harness of harnesses) {
    for (const scenario of ["fresh", "resume"] satisfies ReadonlyArray<"fresh" | "resume">) {
      it.live(
        `${harness} ${scenario}: turn, approval, output and interrupt cross real pipes`,
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const peer = yield* peerProcess(harness, scenario);
              const opened = yield* Deferred.make<
                Extract<AgentEvent, { readonly _tag: "request.opened" }>,
                AgentProtocolError
              >();
              const firstCompleted = yield* Deferred.make<
                Extract<AgentEvent, { readonly _tag: "turn.completed" }>,
                AgentProtocolError
              >();
              const secondCompleted = yield* Deferred.make<
                Extract<AgentEvent, { readonly _tag: "turn.completed" }>,
                AgentProtocolError
              >();
              const events: AgentEvent[] = [];
              let completions = 0;
              const session = yield* (harness === "codex" ? CodexAdapter : ClaudeAdapter).start(
                peer.transport,
                {
                  ...peer.options,
                  onEvent: (event) =>
                    Effect.gen(function* () {
                      events.push(event);
                      if (event._tag === "request.opened") yield* Deferred.succeed(opened, event);
                      if (event._tag === "turn.completed") {
                        completions += 1;
                        yield* Deferred.succeed(
                          completions === 1 ? firstCompleted : secondCompleted,
                          event,
                        );
                      }
                      if (event._tag === "runtime.error") {
                        const failure = new AgentProtocolError({
                          adapter: harness,
                          operation: "fixture",
                          message: event.message,
                          cause: peer.stderr(),
                        });
                        yield* Deferred.fail(opened, failure);
                        yield* Deferred.fail(firstCompleted, failure);
                        yield* Deferred.fail(secondCompleted, failure);
                      }
                    }),
                },
              );
              const firstTurn = yield* session.sendTurn("inspect fixture");
              const approval = yield* Deferred.await(opened);
              expect(approval.request.providerTurnId).toBe(firstTurn);
              expect(approval.request.providerRequestId).toBe(
                harness === "codex" ? "n:41" : "permission-owned",
              );
              expect(
                frames(peer.record).some(
                  (frame) => frame["id"] === 41 || frame["type"] === "control_response",
                ),
              ).toBe(false);
              yield* session.respond(approval.request.providerRequestId, "accept-for-session");
              const completed = yield* Deferred.await(firstCompleted);
              expect(completed.providerTurnId).toBe(firstTurn);
              expect(completed.status).toBe("completed");
              expect(
                events.some(
                  (event) =>
                    event._tag === "item.updated" &&
                    event.item.providerTurnId === firstTurn &&
                    event.item.text === "héllo fixture",
                ),
              ).toBe(true);
              const secondTurn = yield* session.sendTurn("interrupt fixture");
              expect(secondTurn).not.toBe(firstTurn);
              yield* session.interrupt();
              const interrupted = yield* Deferred.await(secondCompleted);
              expect(interrupted.providerTurnId).toBe(secondTurn);
              expect(interrupted.status).toBe(harness === "codex" ? "interrupted" : "failed");
              expect(
                new Set(
                  events
                    .filter((event) => event._tag === "session.ready")
                    .map((event) => event.providerSessionId),
                ),
              ).toEqual(
                new Set([harness === "codex" ? "thread-owned" : peer.options.providerSessionId]),
              );
              expect(frames(peer.record).at(-1)).toEqual({ accepted: true });
              yield* session.close();
              expect(peer.stderr()).toBe("");
            }),
          ).pipe(Effect.timeout("5 seconds")),
        { timeout: 15_000 },
      );
    }
    it.live(
      `${harness}: cancelled startup/idle scope terminates and awaits its unresponsive child`,
      () =>
        Effect.gen(function* () {
          const acquired = yield* Deferred.make<Peer>();
          const fiber = yield* Effect.scoped(
            Effect.gen(function* () {
              const peer = yield* peerProcess(harness, "hang");
              yield* Deferred.succeed(acquired, peer);
              yield* (harness === "codex" ? CodexAdapter : ClaudeAdapter).start(
                peer.transport,
                peer.options,
              );
              yield* Effect.never;
            }),
          ).pipe(Effect.forkChild);
          const peer = yield* Deferred.await(acquired);
          yield* Effect.promise(() => peer.ready);
          yield* Fiber.interrupt(fiber);
          expect(peer.child.signalCode).toBe("SIGKILL");
          expect(fs.existsSync(peer.home)).toBe(false);
        }).pipe(Effect.timeout("5 seconds")),
      { timeout: 15_000 },
    );
  }
  it.live(
    "Codex: refused resume never falls back to a new thread and still releases its child",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const peer = yield* peerProcess("codex", "resume-refused");
          const error = yield* CodexAdapter.start(peer.transport, peer.options).pipe(Effect.flip);
          expect(error.operation).toBe("thread/resume");
          expect(error.message).toContain("could not find");
          expect(frames(peer.record).filter((frame) => frame["method"] === "thread/start")).toEqual(
            [],
          );
        }),
      ).pipe(Effect.timeout("5 seconds")),
    { timeout: 15_000 },
  );
});
