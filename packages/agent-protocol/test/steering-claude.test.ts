import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent } from "@mend/domain/workbench";
import { Deferred, Effect, Exit, Fiber } from "effect";

import {
  AgentProtocolError,
  ClaudeAdapter,
  type AgentControlCheckpoint,
  type AgentControlJournal,
  type AgentRehydrateOptions,
  type AgentSession,
} from "../src/index.ts";
import {
  CHUNKINGS,
  concatBytes,
  encodeLine,
  isObject,
  makeRecordingPeer,
  makeWire,
  readTranscript,
  type JsonObject,
  type TranscriptStep,
} from "./steering-wire.ts";

const SESSION = "05f72f7d-81d5-4db9-a3cf-234191cf79f9";
const STEER_ID = "6f1d2c3b-9a8e-4f70-8d61-5c4b3a291807";

type Step =
  | { readonly line: JsonObject }
  | { readonly text: string }
  | { readonly send: string }
  | { readonly trySend: string }
  | { readonly steer: string; readonly id: string; readonly target?: string }
  | { readonly interrupt: true }
  | { readonly respond: string }
  | { readonly end: true };

type Outcome = { readonly step: number; readonly result: unknown };

const memoryJournal = (recorded: ReadonlyArray<AgentControlCheckpoint> = []) => {
  const records: Array<AgentControlCheckpoint> = [];
  const journal: AgentControlJournal = {
    record: (checkpoint) => Effect.sync(() => records.push(checkpoint)),
    recorded,
  };
  return { records, journal };
};

const outcomeOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isSuccess(exit)
    ? exit.value
    : exit.cause.reasons.map((reason) =>
        reason._tag === "Fail" && isObject(reason.error)
          ? {
              _tag: reason.error["_tag"],
              reason: reason.error["reason"] ?? reason.error["certainty"] ?? null,
            }
          : reason._tag,
      );

const startedTurnIds = (events: ReadonlyArray<AgentEvent>): ReadonlyArray<string> =>
  events.flatMap((event) =>
    event._tag === "turn.started" || event._tag === "harness-turn.started"
      ? [event.providerTurnId]
      : [],
  );

const runSteps = Effect.fn("test.runSteps")(function* (
  steps: ReadonlyArray<Step>,
  options: {
    readonly first?: number;
    readonly journal?: ReturnType<typeof memoryJournal> | null;
    readonly rehydrate?: AgentRehydrateOptions;
    readonly replayBytes?: ReadonlyArray<Uint8Array>;
  } = {},
) {
  const wire = yield* makeWire();
  const events: Array<AgentEvent> = [];
  const ended = yield* Deferred.make<void>();
  const journal = options.journal === undefined ? memoryJournal() : options.journal;
  const session: AgentSession = yield* ClaudeAdapter.start(wire.transport, {
    cwd: "/workspace/repo",
    providerSessionId: SESSION,
    permissionMode: "ask",
    controlJournal: journal?.journal,
    rehydrate: options.rehydrate,
    onEvent: (event) =>
      Effect.sync(() => events.push(event)).pipe(
        Effect.andThen(
          event._tag === "runtime.error" ? Deferred.succeed(ended, undefined) : Effect.void,
        ),
      ),
  });
  for (const chunk of options.replayBytes ?? []) if (chunk.length > 0) wire.pushBytes(chunk);
  yield* wire.drain;
  const sentBeforeLive = wire.sent.length;
  const lines: Array<Uint8Array> = [];
  const outcomes: Array<Outcome> = [];
  const answered: Array<string> = [];
  const target = (): string =>
    startedTurnIds(events).at(-1) ?? options.rehydrate?.replayProviderTurnIds.at(-1) ?? "none";
  const first = options.first ?? 0;
  for (const [offset, step] of steps.entries()) {
    const index = first + offset;
    if ("line" in step || "text" in step) {
      const bytes = "line" in step ? encodeLine(step.line) : new TextEncoder().encode(step.text);
      lines.push(bytes);
      wire.pushBytes(bytes);
      yield* wire.drain;
    } else if ("send" in step) {
      yield* session.sendTurn(step.send);
    } else if ("trySend" in step) {
      const exit = yield* session.sendTurn(step.trySend).pipe(Effect.exit);
      outcomes.push({ step: index, result: outcomeOf(exit) });
    } else if ("steer" in step) {
      const exit = yield* session
        .steer({ id: step.id, expectedTurnId: step.target ?? target(), input: step.steer })
        .pipe(Effect.exit);
      outcomes.push({ step: index, result: outcomeOf(exit) });
    } else if ("interrupt" in step) {
      yield* session.interrupt();
    } else if ("respond" in step) {
      const exit = yield* session.respond(step.respond, "accept").pipe(Effect.exit);
      if (Exit.isSuccess(exit)) answered.push(step.respond);
      outcomes.push({ step: index, result: outcomeOf(exit) });
    } else {
      yield* wire.end;
      yield* Deferred.await(ended);
    }
  }
  return {
    session,
    events,
    outcomes,
    sent: wire.sent,
    sentBeforeLive,
    lines,
    answered,
    journal: journal?.records ?? [],
  };
});

type Run = Effect.Success<ReturnType<typeof runSteps>>;

const projection = (
  run: Pick<Run, "events" | "outcomes">,
  replayed: ReadonlyArray<string> = [],
  settled: ReadonlySet<string> = new Set(),
) => {
  const kept = run.events.filter(
    (event) =>
      event._tag !== "session.ready" &&
      event._tag !== "turn.started" &&
      event._tag !== "harness-turn.started" &&
      event._tag !== "drain.ended" &&
      !(event._tag === "request.opened" && settled.has(event.request.providerRequestId)) &&
      !(event._tag === "request.resolved" && settled.has(event.providerRequestId)),
  );
  const named = (value: unknown): unknown => {
    let text = JSON.stringify(value);
    [...replayed, ...startedTurnIds(run.events)].forEach((turnId, index) => {
      text = text.split(turnId).join(`turn#${index}`);
    });
    const parsed: unknown = JSON.parse(text);
    return parsed;
  };
  return { events: named(kept), outcomes: named(run.outcomes) };
};

const runCrashed = Effect.fn("test.runCrashed")(function* (
  steps: ReadonlyArray<Step>,
  cut: number,
  chunking: (bytes: Uint8Array) => ReadonlyArray<Uint8Array>,
) {
  const before = yield* Effect.scoped(runSteps(steps.slice(0, cut)));
  const replayProviderTurnIds = startedTurnIds(before.events);
  const settled = new Set([
    ...before.events.flatMap((event) =>
      event._tag === "request.resolved" ? [event.providerRequestId] : [],
    ),
    ...before.answered,
  ]);
  const after = yield* runSteps(steps.slice(cut), {
    first: cut,
    journal: memoryJournal(before.journal.toReversed()),
    replayBytes: chunking(concatBytes(before.lines)),
    rehydrate: { replayProviderTurnIds, resolvedProviderRequestIds: settled },
  });
  return {
    after,
    replayProviderTurnIds,
    settled,
    projection: projection(
      { ...after, outcomes: [...before.outcomes, ...after.outcomes] },
      replayProviderTurnIds,
      settled,
    ),
    priorJournal: before.journal,
  };
});

const expectDeterministicReplay = (steps: ReadonlyArray<Step>) =>
  Effect.gen(function* () {
    const uninterrupted = yield* Effect.scoped(runSteps(steps));
    const ends = steps.some((step) => "end" in step);
    for (let cut = 0; cut <= steps.length - (ends ? 1 : 0); cut += 1) {
      for (const [name, chunking] of Object.entries(CHUNKINGS)) {
        const crashed = yield* Effect.scoped(runCrashed(steps, cut, chunking));
        const whole = projection(uninterrupted, [], crashed.settled);
        expect({ cut, name, ...crashed.projection }).toEqual({ cut, name, ...whole });
        expect({ cut, name, replayWrites: crashed.after.sentBeforeLive }).toEqual({
          cut,
          name,
          replayWrites: 0,
        });
        const liveControls = steps
          .slice(cut)
          .filter((step) => "steer" in step || "interrupt" in step).length;
        expect(crashed.after.journal.length).toBeLessThanOrEqual(liveControls);
        for (const control of crashed.after.journal) {
          expect(control.ordinal).toBeGreaterThan(
            Math.max(-1, ...crashed.priorJournal.map((prior) => prior.ordinal)),
          );
        }
      }
    }
  });

const line = (frame: JsonObject): Step => ({ line: frame });
const init = (uuid: string): Step =>
  line({ type: "system", subtype: "init", uuid, session_id: SESSION });
const usage = (input: number | null, output: number | null): JsonObject => ({
  ...(input === null ? {} : { input_tokens: input }),
  ...(output === null ? {} : { output_tokens: output }),
});
const result = (uuid: string, tokens: JsonObject = usage(3, 6)): Step =>
  line({ type: "result", subtype: "success", uuid, session_id: SESSION, usage: tokens });
const aborted = (
  uuid: string,
  terminalReason: "aborted_streaming" | "aborted_tools" = "aborted_streaming",
  tokens: JsonObject = usage(0, 0),
): Step =>
  line({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: terminalReason,
    uuid,
    session_id: SESSION,
    usage: tokens,
    errors: ["Error: Request was aborted."],
  });
const idle: Step = line({
  type: "system",
  subtype: "session_state_changed",
  state: "idle",
  session_id: SESSION,
});
const assistant = (id: string, text: string): Step =>
  line({
    type: "assistant",
    session_id: SESSION,
    message: { id, content: [{ type: "text", text }] },
  });
const permission = (requestId: string, agentId?: string): Step =>
  line({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "sleep 60", tool_use_id: `toolu_${requestId}` },
      tool_use_id: `toolu_${requestId}`,
      ...(agentId === undefined ? {} : { agent_id: agentId }),
    },
  });

const bytesOf = (steps: ReadonlyArray<Step>): ReadonlyArray<Uint8Array> =>
  steps.flatMap((step) => ("line" in step ? [encodeLine(step.line)] : []));
const completions = (run: Pick<Run, "events">) =>
  run.events.filter((event) => event._tag === "turn.completed");
const userFrames = (run: Run) => run.sent.filter((frame) => frame["type"] === "user");

const recordedSteps = (): ReadonlyArray<Step> => {
  const steps = readTranscript("claude_transcript.ndjson").flatMap((step): ReadonlyArray<Step> => {
    if (step.type === "emit_inbound") return [{ line: step.frame }];
    const message = step.frame["message"];
    if (!isObject(message)) return [];
    const content = isObject(message["message"]) ? message["message"]["content"] : null;
    if (typeof content !== "string") return [];
    return message["priority"] === "now" ? [{ steer: content, id: STEER_ID }] : [{ send: content }];
  });
  return [...steps, { end: true }];
};

const promptOf = (frame: JsonObject): JsonObject => {
  const message = isObject(frame["message"]) ? frame["message"] : {};
  const content = message["content"];
  return {
    type: frame["type"],
    role: message["role"],
    text:
      typeof content === "string"
        ? content
        : Array.isArray(content) && isObject(content[0])
          ? content[0]["text"]
          : null,
    parent_tool_use_id: frame["parent_tool_use_id"],
    priority: frame["priority"] ?? null,
  };
};

const matchClaude = (expected: TranscriptStep, actual: JsonObject): ReadonlyArray<string> => {
  const offered = expected.frame["message"];
  if (expected.frame["type"] !== "prompt.offer" || !isObject(offered)) {
    return [`no recorded prompt for ${JSON.stringify(actual)}`];
  }
  const want = promptOf(offered);
  const got = promptOf(actual);
  return JSON.stringify(got) === JSON.stringify(want)
    ? []
    : [`wrote ${JSON.stringify(got)}, recorded ${JSON.stringify(want)}`];
};

describe("Claude steering, recorded (fixtures/steering/claude_transcript.ndjson)", () => {
  for (const reason of ["aborted_streaming", "aborted_tools"]) {
    it.effect(`${reason} and idle between recorded segments keep the steer in the same turn`, () =>
      Effect.gen(function* () {
        // The recording predates Mend enabling session-state events. Exercise its real abort
        // and continuation frames with an added idle event between segments.
        const steps = recordedSteps().flatMap(
          (step): ReadonlyArray<Step> =>
            "line" in step && step.line["terminal_reason"] === "aborted_streaming"
              ? [{ line: { ...step.line, terminal_reason: reason } }, idle]
              : [step],
        );
        const run = yield* Effect.scoped(runSteps(steps));
        expect(startedTurnIds(run.events)).toHaveLength(1);
        expect(run.events.some((event) => event._tag === "harness-turn.started")).toBe(false);
        expect(completions(run)).toEqual([expect.objectContaining({ status: "completed" })]);
        expect(userFrames(run)[1]).toMatchObject({ priority: "now", uuid: STEER_ID });
        yield* expectDeterministicReplay(steps);
      }),
    );
  }

  it.effect("a steer before Claude's first init folds both segments into one turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const peer = makeRecordingPeer(readTranscript("claude_transcript.ndjson"), {
          skip: (step) => step.frame["type"] === "query.open",
          match: matchClaude,
        });
        const wire = yield* makeWire(peer.onSend);
        peer.connect(wire.push);
        const { records, journal } = memoryJournal();
        const events: Array<AgentEvent> = [];
        const session = yield* ClaudeAdapter.start(wire.transport, {
          cwd: "/workspace/repo",
          providerSessionId: SESSION,
          permissionMode: "bypass",
          controlJournal: journal,
          onEvent: (event) => Effect.sync(() => events.push(event)),
        });
        expect(session.activeSteering).toEqual({ supported: true, interruptsTools: true });

        const turnId = yield* session.sendTurn(
          "Respond with exactly: steering fixture initial response",
        );
        const acceptance = yield* session.steer({
          id: STEER_ID,
          expectedTurnId: turnId,
          input: "Actually, respond with exactly: steering fixture observed",
        });
        yield* wire.drain;

        expect(acceptance).toEqual({ _tag: "TransportWritten", providerTurnId: turnId });
        expect(peer.mismatches).toEqual([]);
        expect(peer.remaining()).toEqual([]);
        expect(wire.sent[1]).toMatchObject({ priority: "now", uuid: STEER_ID });
        expect(records).toEqual([
          {
            ordinal: 0,
            controlId: STEER_ID,
            providerTurnId: turnId,
            afterOutputLine: 0,
            action: "steer-now",
          },
        ]);
        expect(events.filter((event) => event._tag === "turn.started")).toHaveLength(1);
        expect(events.some((event) => event._tag === "harness-turn.started")).toBe(false);
        expect(events.filter((event) => event._tag === "turn.completed")).toEqual([
          {
            _tag: "turn.completed",
            providerTurnId: turnId,
            status: "completed",
            usage: {
              inputTokens: 3,
              outputTokens: 6,
              cachedInputTokens: 11_802,
              totalTokens: 9,
              contextWindow: null,
            },
            error: null,
          },
        ]);
        expect(
          events.some(
            (event) =>
              event._tag === "item.updated" &&
              event.item.providerTurnId === turnId &&
              event.item.text === "steering fixture observed",
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("replays to the same turn from every line boundary and chunking", () =>
    Effect.gen(function* () {
      const run = yield* Effect.scoped(runSteps(recordedSteps()));
      expect(completions(run)).toEqual([expect.objectContaining({ status: "completed" })]);
      yield* expectDeterministicReplay(recordedSteps());
    }),
  );
});

describe("Claude steering, synthetic", () => {
  it.effect("sendTurn and an unjournaled interrupt never wait behind a line's projection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wire = yield* makeWire();
        const projecting = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const session = yield* ClaudeAdapter.start(wire.transport, {
          cwd: "/workspace/repo",
          providerSessionId: SESSION,
          permissionMode: "bypass",
          onEvent: (event) =>
            event._tag === "harness-turn.started"
              ? Deferred.succeed(projecting, undefined).pipe(
                  Effect.andThen(Deferred.await(released)),
                )
              : Effect.void,
        });
        wire.push({ type: "system", subtype: "init", uuid: "init-1", session_id: SESSION });
        yield* Deferred.await(projecting);
        const busy = yield* session.sendTurn("now").pipe(Effect.flip);
        expect(busy).toMatchObject({
          _tag: "AgentTurnBusyError",
          providerTurnId: "harness:init-1",
        });
        yield* session.interrupt();
        expect(wire.sent.map((frame) => frame["type"])).toEqual(["control_request"]);
        yield* Deferred.succeed(released, undefined);
        yield* wire.drain;
      }),
    ),
  );

  it.effect("a journaled Stop waits for one line's projection, not the whole chunk's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wire = yield* makeWire();
        const { records, journal } = memoryJournal();
        const projecting = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const session = yield* ClaudeAdapter.start(wire.transport, {
          cwd: "/workspace/repo",
          providerSessionId: SESSION,
          permissionMode: "bypass",
          controlJournal: journal,
          onEvent: (event) =>
            event._tag === "item.updated" && event.item.text === "first line"
              ? Deferred.succeed(projecting, undefined).pipe(
                  Effect.andThen(Deferred.await(released)),
                )
              : Effect.void,
        });
        yield* session.sendTurn("first");
        wire.push({ type: "system", subtype: "init", uuid: "init-1", session_id: SESSION });
        yield* wire.drain;
        wire.pushBytes(
          concatBytes([
            encodeLine({
              type: "assistant",
              session_id: SESSION,
              message: { id: "msg-1", content: [{ type: "text", text: "first line" }] },
            }),
            encodeLine({
              type: "assistant",
              session_id: SESSION,
              message: { id: "msg-2", content: [{ type: "text", text: "second line" }] },
            }),
          ]),
        );
        yield* Deferred.await(projecting);
        const stopping = yield* Effect.forkChild(session.interrupt(), { startImmediately: true });
        yield* Deferred.succeed(released, undefined);
        yield* Fiber.join(stopping);
        yield* wire.drain;
        expect(records.map((control) => [control.action, control.afterOutputLine])).toEqual([
          ["interrupt", 2],
        ]);
      }),
    ),
  );

  it.effect("an unjournaled steer is refused without waiting behind a line's projection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wire = yield* makeWire();
        const projecting = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const session = yield* ClaudeAdapter.start(wire.transport, {
          cwd: "/workspace/repo",
          providerSessionId: SESSION,
          permissionMode: "bypass",
          onEvent: (event) =>
            event._tag === "item.updated"
              ? Deferred.succeed(projecting, undefined).pipe(
                  Effect.andThen(Deferred.await(released)),
                )
              : Effect.void,
        });
        const turnId = yield* session.sendTurn("first");
        wire.push({
          type: "assistant",
          session_id: SESSION,
          message: { id: "msg-1", content: [{ type: "text", text: "held" }] },
        });
        yield* Deferred.await(projecting);
        const refusal = yield* session
          .steer({ id: STEER_ID, expectedTurnId: turnId, input: "second" })
          .pipe(Effect.flip);
        expect(refusal).toMatchObject({ _tag: "AgentSteerRefusedError", reason: "unsupported" });
        yield* Deferred.succeed(released, undefined);
        yield* wire.drain;
      }),
    ),
  );

  it.effect("a normal result that wins the race is an earlier segment, not the turn's end", () =>
    Effect.gen(function* () {
      const steps: ReadonlyArray<Step> = [
        { send: "first" },
        init("init-1"),
        { steer: "second", id: STEER_ID },
        result("result-1", usage(10, 2)),
        init("init-2"),
        assistant("msg-2", "answer to second"),
        result("result-2", usage(3, 6)),
        { end: true },
      ];
      const run = yield* Effect.scoped(runSteps(steps));
      expect(completions(run)).toEqual([
        expect.objectContaining({
          status: "completed",
          usage: {
            inputTokens: 13,
            outputTokens: 8,
            cachedInputTokens: 0,
            totalTokens: 21,
            contextWindow: null,
          },
        }),
      ]);
      expect(run.events.some((event) => event._tag === "harness-turn.started")).toBe(false);
      yield* expectDeterministicReplay(steps);
    }),
  );

  it.effect("a Stop while a steer is armed ends the turn; Claude's answer is its own turn", () =>
    Effect.gen(function* () {
      const steps: ReadonlyArray<Step> = [
        { send: "first" },
        init("init-1"),
        { steer: "second", id: STEER_ID },
        { interrupt: true },
        aborted("result-1"),
        init("init-2"),
        result("result-2"),
        { end: true },
      ];
      const run = yield* Effect.scoped(runSteps(steps));
      const turnId = startedTurnIds(run.events)[0];
      expect(completions(run)).toEqual([
        expect.objectContaining({
          providerTurnId: turnId,
          status: "interrupted",
          error: "Error: Request was aborted.",
        }),
        expect.objectContaining({ providerTurnId: "harness:init-2", status: "completed" }),
      ]);
      expect(run.journal.map((control) => control.action)).toEqual(["steer-now", "interrupt"]);
      expect(run.sent.map((frame) => frame["type"])).toEqual(["user", "user", "control_request"]);
      yield* expectDeterministicReplay(steps);
    }),
  );

  it.effect("a Stop between segments ends the turn at once with the usage so far", () =>
    Effect.gen(function* () {
      const steps: ReadonlyArray<Step> = [
        { send: "first" },
        init("init-1"),
        { steer: "second", id: STEER_ID },
        aborted("result-1", "aborted_streaming", usage(5, 1)),
        { interrupt: true },
        init("init-2"),
        result("result-2"),
        { end: true },
      ];
      const run = yield* Effect.scoped(runSteps(steps));
      expect(completions(run)).toEqual([
        expect.objectContaining({
          status: "interrupted",
          usage: expect.objectContaining({ inputTokens: 5, outputTokens: 1 }),
        }),
        expect.objectContaining({ providerTurnId: "harness:init-2", status: "completed" }),
      ]);
      yield* expectDeterministicReplay(steps);
    }),
  );

  it.effect("a Stop between segments is on the wire before its turn completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wire = yield* makeWire();
        const { journal } = memoryJournal();
        const frameName = (frame: JsonObject): unknown =>
          frame["type"] === "user"
            ? promptOf(frame)["text"]
            : isObject(frame["request"])
              ? frame["request"]["subtype"]
              : frame["type"];
        const seenAtCompletion: Array<ReadonlyArray<unknown>> = [];
        const submitted: Array<unknown> = [];
        let next: Effect.Effect<void> = Effect.void;
        const session = yield* ClaudeAdapter.start(wire.transport, {
          cwd: "/workspace/repo",
          providerSessionId: SESSION,
          permissionMode: "bypass",
          controlJournal: journal,
          onEvent: (event) =>
            event._tag === "turn.completed"
              ? Effect.suspend(() => {
                  seenAtCompletion.push(wire.sent.map(frameName));
                  return next;
                })
              : Effect.void,
        });
        next = session.sendTurn("next").pipe(
          Effect.exit,
          Effect.map((exit) => submitted.push(outcomeOf(exit))),
        );
        const turnId = yield* session.sendTurn("first");
        wire.push({ type: "system", subtype: "init", uuid: "init-1", session_id: SESSION });
        yield* wire.drain;
        yield* session.steer({ id: STEER_ID, expectedTurnId: turnId, input: "second" });
        wire.push({
          type: "result",
          subtype: "error_during_execution",
          terminal_reason: "aborted_streaming",
          uuid: "result-1",
          session_id: SESSION,
        });
        yield* wire.drain;
        yield* session.interrupt();
        expect(seenAtCompletion).toEqual([["first", "second", "interrupt"]]);
        expect(submitted).toEqual([[{ _tag: "AgentTurnBusyError", reason: null }]]);

        wire.push({ type: "system", subtype: "init", uuid: "init-2", session_id: SESSION });
        wire.push({ type: "result", subtype: "success", uuid: "result-2", session_id: SESSION });
        yield* wire.drain;
        expect(submitted).toEqual([
          [{ _tag: "AgentTurnBusyError", reason: null }],
          expect.any(String),
        ]);
        expect(wire.sent.map(frameName)).toEqual(["first", "second", "interrupt", "next"]);
      }),
    ),
  );

  it.effect("a Stop with a steer unanswered refuses the next turn until Claude answers it", () =>
    Effect.gen(function* () {
      const steps: ReadonlyArray<Step> = [
        { send: "first" },
        init("init-1"),
        { steer: "second", id: STEER_ID },
        { interrupt: true },
        aborted("result-1"),
        { trySend: "next" },
        init("init-2"),
        assistant("msg-2", "answer to second"),
        result("result-2"),
        { trySend: "next" },
        { end: true },
      ];
      const run = yield* Effect.scoped(runSteps(steps));
      const [first, , next] = startedTurnIds(run.events);
      expect(run.outcomes.map((outcome) => outcome.result)).toEqual([
        expect.objectContaining({ _tag: "TransportWritten" }),
        [{ _tag: "AgentTurnBusyError", reason: null }],
        next,
      ]);
      expect(completions(run)).toEqual([
        expect.objectContaining({ providerTurnId: first, status: "interrupted" }),
        expect.objectContaining({ providerTurnId: "harness:init-2", status: "completed" }),
        expect.objectContaining({ providerTurnId: next, status: "failed" }),
      ]);
      yield* expectDeterministicReplay(steps);
    }),
  );

  it.effect("a Stop with a steer unanswered ends its wait when Claude reports idle", () =>
    Effect.gen(function* () {
      const steps: ReadonlyArray<Step> = [
        { send: "first" },
        init("init-1"),
        { steer: "second", id: STEER_ID },
        { interrupt: true },
        aborted("result-1"),
        { trySend: "next" },
        idle,
        { trySend: "next" },
        { end: true },
      ];
      const run = yield* Effect.scoped(runSteps(steps));
      expect(run.outcomes.map((outcome) => outcome.result)).toEqual([
        expect.objectContaining({ _tag: "TransportWritten" }),
        [{ _tag: "AgentTurnBusyError", reason: null }],
        startedTurnIds(run.events)[1],
      ]);
      expect(run.events.some((event) => event._tag === "harness-turn.started")).toBe(false);
      yield* expectDeterministicReplay(steps);
    }),
  );

  it.effect("says when a drained Stop stops refusing turns, on idle or on Claude's own turn", () =>
    Effect.gen(function* () {
      const stopped: ReadonlyArray<Step> = [
        { send: "first" },
        init("init-1"),
        { steer: "second", id: STEER_ID },
        { interrupt: true },
        aborted("result-1"),
      ];
      for (const [ending, opens] of [
        [idle, null],
        [init("init-2"), "harness:init-2"],
      ] as const) {
        const run = yield* Effect.scoped(runSteps([...stopped, ending, { end: true }]));
        const tags = run.events.map((event) => event._tag);
        expect(tags.filter((tag) => tag === "drain.ended")).toHaveLength(1);
        expect(tags.indexOf("drain.ended")).toBeGreaterThan(tags.indexOf("turn.completed"));
        expect(startedTurnIds(run.events).at(-1)).toBe(opens ?? startedTurnIds(run.events)[0]);
        yield* expectDeterministicReplay([...stopped, ending, { end: true }]);
      }
      const run = yield* Effect.scoped(runSteps([{ send: "first" }, init("init-1"), idle]));
      expect(run.events.some((event) => event._tag === "drain.ended")).toBe(false);
    }),
  );

  it.effect("idle while awaiting a continuation ends the turn with its last segment", () =>
    Effect.gen(function* () {
      const steps: ReadonlyArray<Step> = [
        { send: "first" },
        init("init-1"),
        { steer: "second", id: STEER_ID },
        result("result-1", usage(4, 2)),
        idle,
        { trySend: "next" },
        { end: true },
      ];
      const run = yield* Effect.scoped(runSteps(steps));
      const [first, next] = startedTurnIds(run.events);
      expect(completions(run)).toEqual([
        {
          _tag: "turn.completed",
          providerTurnId: first,
          status: "completed",
          usage: {
            inputTokens: 4,
            outputTokens: 2,
            cachedInputTokens: 0,
            totalTokens: 6,
            contextWindow: null,
          },
          error: null,
        },
        expect.objectContaining({ providerTurnId: next, status: "failed" }),
      ]);
      expect(run.outcomes.at(-1)?.result).toEqual(next);
      yield* expectDeterministicReplay(steps);
    }),
  );

  it.effect("output ending before the continuation fails the one turn with its usage", () =>
    Effect.gen(function* () {
      const steps: ReadonlyArray<Step> = [
        { send: "first" },
        init("init-1"),
        { steer: "second", id: STEER_ID },
        aborted("result-1", "aborted_streaming", usage(7, 2)),
        { end: true },
      ];
      const run = yield* Effect.scoped(runSteps(steps));
      expect(completions(run)).toEqual([
        expect.objectContaining({
          status: "failed",
          error: "Claude process ended before the steered turn continued.",
          usage: expect.objectContaining({ inputTokens: 7, outputTokens: 2 }),
        }),
      ]);
      yield* expectDeterministicReplay(steps);
    }),
  );

  it.effect("refuses a second steer until the first one's continuation starts", () =>
    Effect.gen(function* () {
      const steps: ReadonlyArray<Step> = [
        { send: "first" },
        init("init-1"),
        { steer: "second", id: STEER_ID },
        { steer: "third", id: "steer-armed" },
        aborted("result-1"),
        { steer: "third", id: "steer-awaiting" },
        init("init-2"),
        { steer: "fourth", id: "steer-continued" },
        aborted("result-2"),
        init("init-3"),
        result("result-3"),
        { end: true },
      ];
      const run = yield* Effect.scoped(runSteps(steps));
      const refusal = [{ _tag: "AgentSteerRefusedError", reason: "in-continuation" }];
      expect(run.outcomes.map((outcome) => outcome.result)).toEqual([
        expect.objectContaining({ _tag: "TransportWritten" }),
        refusal,
        refusal,
        expect.objectContaining({ _tag: "TransportWritten" }),
      ]);
      expect(userFrames(run).map((frame) => frame["uuid"] ?? null)).toEqual([
        null,
        STEER_ID,
        "steer-continued",
      ]);
      expect(completions(run)).toEqual([
        expect.objectContaining({
          status: "completed",
          usage: expect.objectContaining({ inputTokens: 3, outputTokens: 6 }),
        }),
      ]);
      yield* expectDeterministicReplay(steps);
    }),
  );

  it.effect("refuses with no turn, another turn, or no journal, writing nothing", () =>
    Effect.gen(function* () {
      const steps: ReadonlyArray<Step> = [
        { steer: "too early", id: "steer-idle" },
        { send: "first" },
        { steer: "elsewhere", id: "steer-other", target: "turn-other" },
        { end: true },
      ];
      const run = yield* Effect.scoped(runSteps(steps));
      expect(run.outcomes.map((outcome) => outcome.result)).toEqual([
        [{ _tag: "AgentSteerRefusedError", reason: "no-active-turn" }],
        [{ _tag: "AgentSteerRefusedError", reason: "target-changed" }],
      ]);
      expect(userFrames(run)).toHaveLength(1);
      expect(run.journal).toEqual([]);

      const unjournaled = yield* Effect.scoped(
        runSteps([{ send: "first" }, { steer: "second", id: STEER_ID }], { journal: null }),
      );
      expect(unjournaled.session.activeSteering).toEqual({
        supported: false,
        interruptsTools: true,
      });
      expect(unjournaled.outcomes.map((outcome) => outcome.result)).toEqual([
        [{ _tag: "AgentSteerRefusedError", reason: "unsupported" }],
      ]);
      expect(userFrames(unjournaled)).toHaveLength(1);
    }),
  );

  it.effect(
    "a segment close denies the main thread's open permission and keeps a sub-agent's",
    () =>
      Effect.gen(function* () {
        const steps: ReadonlyArray<Step> = [
          { send: "first" },
          init("init-1"),
          permission("permission-1"),
          permission("permission-sub", "agent-7"),
          { steer: "second", id: STEER_ID },
          aborted("result-1", "aborted_tools"),
          { respond: "permission-1" },
          init("init-2"),
          { respond: "permission-sub" },
          result("result-2"),
          { end: true },
        ];
        const run = yield* Effect.scoped(runSteps(steps));
        expect(
          run.events.filter(
            (event) => event._tag === "request.opened" || event._tag === "request.resolved",
          ),
        ).toEqual([
          expect.objectContaining({
            _tag: "request.opened",
            request: expect.objectContaining({ providerRequestId: "permission-1" }),
          }),
          expect.objectContaining({
            _tag: "request.opened",
            request: expect.objectContaining({ providerRequestId: "permission-sub" }),
          }),
          { _tag: "request.resolved", providerRequestId: "permission-1", disposition: "cancelled" },
        ]);
        expect(run.outcomes.slice(1).map((outcome) => outcome.result)).toEqual([
          [{ _tag: "AgentProtocolError", reason: null }],
          undefined,
        ]);
        expect(run.sent.filter((frame) => frame["type"] === "control_response")).toEqual([
          {
            type: "control_response",
            response: {
              subtype: "success",
              request_id: "permission-1",
              response: expect.objectContaining({ behavior: "deny", interrupt: false }),
            },
          },
          {
            type: "control_response",
            response: {
              subtype: "success",
              request_id: "permission-sub",
              response: expect.objectContaining({ behavior: "allow" }),
            },
          },
        ]);
        expect(completions(run)).toEqual([expect.objectContaining({ status: "completed" })]);
        yield* expectDeterministicReplay(steps);
      }),
  );

  it.effect("sums each parsed counter over the segments, null when a segment lacks it", () =>
    Effect.gen(function* () {
      const steps: ReadonlyArray<Step> = [
        { send: "first" },
        init("init-1"),
        { steer: "second", id: STEER_ID },
        aborted("result-1", "aborted_streaming", usage(null, 4)),
        init("init-2"),
        result("result-2", usage(3, 6)),
        { end: true },
      ];
      const run = yield* Effect.scoped(runSteps(steps));
      expect(completions(run)[0]).toMatchObject({
        usage: {
          inputTokens: null,
          outputTokens: 10,
          cachedInputTokens: 0,
          totalTokens: 13,
          contextWindow: null,
        },
      });
      yield* expectDeterministicReplay(steps);
    }),
  );

  it.effect("blank output lines around a steer count for nothing and replay the same", () =>
    Effect.gen(function* () {
      const steps: ReadonlyArray<Step> = [
        { send: "first" },
        { text: "\n" },
        init("init-1"),
        { text: "\n\r\n" },
        { steer: "second", id: STEER_ID },
        { text: "\n" },
        aborted("result-1", "aborted_streaming", usage(5, 1)),
        { text: "\r\n\n" },
        init("init-2"),
        result("result-2", usage(3, 6)),
        { end: true },
      ];
      const run = yield* Effect.scoped(runSteps(steps));
      expect(run.journal.map((control) => [control.action, control.afterOutputLine])).toEqual([
        ["steer-now", 1],
      ]);
      expect(completions(run)).toEqual([
        expect.objectContaining({
          status: "completed",
          usage: expect.objectContaining({ inputTokens: 8, outputTokens: 7 }),
        }),
      ]);
      yield* expectDeterministicReplay(steps);
    }),
  );

  it.effect("a result line seen twice is one segment: counted once, ending nothing", () =>
    Effect.gen(function* () {
      const steps: ReadonlyArray<Step> = [
        { send: "first" },
        init("init-1"),
        { steer: "second", id: STEER_ID },
        aborted("result-1", "aborted_streaming", usage(5, 1)),
        aborted("result-1", "aborted_streaming", usage(5, 1)),
        init("init-2"),
        assistant("msg-2", "answer to second"),
        result("result-2", usage(3, 6)),
        { end: true },
      ];
      const run = yield* Effect.scoped(runSteps(steps));
      expect(completions(run)).toEqual([
        expect.objectContaining({
          providerTurnId: startedTurnIds(run.events)[0],
          status: "completed",
          usage: expect.objectContaining({ inputTokens: 8, outputTokens: 7 }),
        }),
      ]);
      expect(run.events.some((event) => event._tag === "harness-turn.started")).toBe(false);
    }),
  );

  const cancelledWhileRecording = (
    control: "steer-now" | "interrupt",
    journalBlocks: "interruptibly" | "uninterruptibly",
  ) =>
    Effect.gen(function* () {
      const recorded: Array<AgentControlCheckpoint> = [];
      const persisted = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const before: ReadonlyArray<Step> =
        control === "steer-now"
          ? [init("init-1")]
          : [init("init-1"), aborted("result-1", "aborted_streaming", usage(5, 1))];
      const after: ReadonlyArray<Step> =
        control === "steer-now"
          ? [aborted("result-1"), init("init-2"), result("result-2")]
          : [idle];
      const live = yield* Effect.scoped(
        Effect.gen(function* () {
          const wire = yield* makeWire();
          const events: Array<AgentEvent> = [];
          const ended = yield* Deferred.make<void>();
          const session = yield* ClaudeAdapter.start(wire.transport, {
            cwd: "/workspace/repo",
            providerSessionId: SESSION,
            permissionMode: "bypass",
            controlJournal: {
              record: (checkpoint) => {
                const persist = Effect.sync(() => recorded.push(checkpoint)).pipe(
                  Effect.andThen(
                    checkpoint.action === control
                      ? Deferred.succeed(persisted, undefined).pipe(
                          Effect.andThen(Deferred.await(released)),
                        )
                      : Effect.void,
                  ),
                );
                return journalBlocks === "uninterruptibly"
                  ? Effect.uninterruptible(persist)
                  : persist;
              },
              recorded: [],
            },
            onEvent: (event) =>
              Effect.sync(() => events.push(event)).pipe(
                Effect.andThen(
                  event._tag === "runtime.error" ? Deferred.succeed(ended, undefined) : Effect.void,
                ),
              ),
          });
          const turnId = yield* session.sendTurn("first");
          const steer = session.steer({ id: STEER_ID, expectedTurnId: turnId, input: "second" });
          wire.push({ type: "system", subtype: "init", uuid: "init-1", session_id: SESSION });
          yield* wire.drain;
          if (control === "interrupt") {
            yield* steer;
            wire.pushBytes(concatBytes(bytesOf(before.slice(1))));
            yield* wire.drain;
          }
          const caller = yield* Effect.forkChild(
            control === "steer-now" ? Effect.asVoid(steer) : session.interrupt(),
          );
          yield* Deferred.await(persisted);
          const cancelling = yield* Effect.forkChild(Fiber.interrupt(caller), {
            startImmediately: true,
          });
          yield* Deferred.succeed(released, undefined);
          yield* Fiber.join(cancelling);
          wire.pushBytes(concatBytes(bytesOf(after)));
          yield* wire.end;
          yield* Deferred.await(ended);
          return { events, outcomes: [], sent: wire.sent };
        }),
      );
      const replayProviderTurnIds = startedTurnIds(live.events);
      const replayed = yield* Effect.scoped(
        runSteps([{ end: true }], {
          journal: memoryJournal(recorded),
          replayBytes: [concatBytes(bytesOf([...before, ...after]))],
          rehydrate: { replayProviderTurnIds, resolvedProviderRequestIds: new Set() },
        }),
      );
      return {
        live,
        recorded,
        liveProjection: projection(live),
        replayedProjection: projection(replayed, replayProviderTurnIds),
      };
    });

  for (const journalBlocks of ["interruptibly", "uninterruptibly"] as const) {
    it.effect(`a steer cancelled while the journal records ${journalBlocks} still lands`, () =>
      Effect.gen(function* () {
        const run = yield* cancelledWhileRecording("steer-now", journalBlocks);
        expect(run.live.sent.filter((frame) => frame["type"] === "user")).toEqual([
          expect.anything(),
          expect.objectContaining({ priority: "now", uuid: STEER_ID }),
        ]);
        expect(run.recorded.map((checkpoint) => checkpoint.action)).toEqual(["steer-now"]);
        expect(completions(run.live)).toEqual([expect.objectContaining({ status: "completed" })]);
        expect(run.replayedProjection).toEqual(run.liveProjection);
      }),
    );

    it.effect(`a Stop cancelled while the journal records ${journalBlocks} still lands`, () =>
      Effect.gen(function* () {
        const run = yield* cancelledWhileRecording("interrupt", journalBlocks);
        expect(run.live.sent.at(-1)).toMatchObject({ request: { subtype: "interrupt" } });
        expect(run.replayedProjection).toEqual(run.liveProjection);
      }),
    );
  }

  it.effect("a journal that cannot record leaves nothing written and nothing armed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failing: ReturnType<typeof memoryJournal> = {
          records: [],
          journal: {
            record: () =>
              Effect.fail(
                new AgentProtocolError({
                  adapter: "claude",
                  operation: "journal",
                  message: "database unavailable",
                  cause: null,
                }),
              ),
            recorded: [],
          },
        };
        const run = yield* runSteps(
          [
            { send: "first" },
            init("init-1"),
            { steer: "second", id: STEER_ID },
            aborted("result-1"),
            { end: true },
          ],
          { journal: failing },
        );
        expect(run.outcomes.map((outcome) => outcome.result)).toEqual([
          [{ _tag: "AgentSteerDeliveryError", reason: "not-written" }],
        ]);
        expect(userFrames(run)).toHaveLength(1);
        expect(completions(run)).toEqual([expect.objectContaining({ status: "interrupted" })]);
      }),
    ),
  );

  it.effect(
    "a session closed while the journal records rolls the arm back, live and replayed",
    () =>
      Effect.gen(function* () {
        const recorded: Array<AgentControlCheckpoint> = [];
        const released = yield* Deferred.make<void>();
        const recording = yield* Deferred.make<void>();
        const live = yield* Effect.scoped(
          Effect.gen(function* () {
            const wire = yield* makeWire();
            const session = yield* ClaudeAdapter.start(wire.transport, {
              cwd: "/workspace/repo",
              providerSessionId: SESSION,
              permissionMode: "bypass",
              controlJournal: {
                record: (checkpoint) =>
                  Effect.sync(() => recorded.push(checkpoint)).pipe(
                    Effect.andThen(
                      checkpoint.action === "steer-now"
                        ? Deferred.succeed(recording, undefined).pipe(
                            Effect.andThen(Deferred.await(released)),
                          )
                        : Effect.void,
                    ),
                  ),
                recorded: [],
              },
            });
            const turnId = yield* session.sendTurn("first");
            const steering = yield* session
              .steer({ id: STEER_ID, expectedTurnId: turnId, input: "second" })
              .pipe(Effect.flip, Effect.forkChild);
            yield* Deferred.await(recording);
            yield* session.close();
            yield* Deferred.succeed(released, undefined);
            const error = yield* Fiber.join(steering);
            return { turnId, error, sent: wire.sent };
          }),
        );
        expect(live.error).toMatchObject({
          _tag: "AgentSteerDeliveryError",
          certainty: "not-written",
        });
        expect(live.sent.filter((frame) => frame["type"] === "user")).toHaveLength(1);
        expect(recorded.map((control) => [control.action, control.afterOutputLine])).toEqual([
          ["steer-now", 0],
          ["not-written", 0],
        ]);

        const replayed = yield* Effect.scoped(
          runSteps([], {
            replayBytes: [
              concatBytes([
                encodeLine({ type: "system", subtype: "init", uuid: "i", session_id: SESSION }),
                encodeLine({ type: "result", subtype: "success", uuid: "r", session_id: SESSION }),
              ]),
            ],
            journal: memoryJournal(recorded),
            rehydrate: {
              replayProviderTurnIds: [live.turnId],
              resolvedProviderRequestIds: new Set(),
            },
          }),
        );
        expect(completions(replayed)).toEqual([
          expect.objectContaining({ providerTurnId: live.turnId, status: "completed" }),
        ]);
      }),
  );
});
