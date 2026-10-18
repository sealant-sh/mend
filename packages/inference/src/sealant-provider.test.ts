import { describe, expect, it } from "@effect/vitest";
import { InferenceCallsRepo } from "@mend/db";
import { SealantClient, SealantPlatformError } from "@mend/sealant";
import type { InferenceResponse } from "@sealant/sdk";
import { Cause, ConfigProvider, Effect, Exit, Layer } from "effect";
import * as FastCheck from "fast-check";

import { InferenceProvider, InferenceToolError, type InferenceTool } from "./provider.ts";
import { sealantProviderLayer } from "./sealant-provider.ts";

type Exchange = Parameters<SealantClient["Service"]["inferenceRespond"]>[0];
type Audit = Parameters<InferenceCallsRepo["Service"]["record"]>[0];

const text = (value: string, sessionId = "subscription-session"): InferenceResponse => ({
  sessionId,
  turn: { type: "text", text: value },
});

const calls = (
  pending: Extract<InferenceResponse["turn"], { type: "toolCalls" }>["calls"],
  sessionId = "subscription-session",
): InferenceResponse => ({ sessionId, turn: { type: "toolCalls", calls: pending } });

/** Only the SDK exchange is scripted; every request runs the shipped provider Layer. */
const harness = (
  outcomes: ReadonlyArray<Effect.Effect<InferenceResponse, SealantPlatformError>>,
  configuration: Record<string, string> = {},
) => {
  const exchanges: Exchange[] = [];
  const audits: Audit[] = [];
  const order: string[] = [];
  const pending = [...outcomes];
  const layer = sealantProviderLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(SealantClient, {
          inferenceRespond: (options) =>
            Effect.suspend(() => {
              exchanges.push(options);
              order.push(`exchange:${exchanges.length}`);
              return pending.shift() ?? Effect.die("unexpected SDK exchange: script exhausted");
            }),
        }),
        Layer.succeed(InferenceCallsRepo, {
          record: (call) =>
            Effect.sync(() => {
              audits.push(call);
              order.push(`audit:${call.tool ?? "exchange"}`);
            }),
        }),
      ),
    ),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(configuration))),
  );
  return { layer, exchanges, audits, order, remaining: () => pending.length };
};

const inputSchema = {
  type: "object",
  properties: { cursor: { type: "integer" } },
  required: ["cursor"],
  additionalProperties: false,
} satisfies InferenceTool["inputSchema"];

const outputSchema = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};

describe("the shipped Sealant inference provider", () => {
  for (const selection of [
    {
      name: "default Claude",
      provider: undefined,
      configuration: {},
      credentials: { claude: true },
    },
    {
      name: "explicit Claude",
      provider: "claude",
      configuration: {},
      credentials: { claude: true },
    },
    { name: "default Codex", provider: "codex", configuration: {}, credentials: { codex: true } },
    {
      name: "configured Claude",
      provider: "claude",
      configuration: {
        MEND_INFERENCE_CLAUDE_ACCOUNT: "claude-account",
        MEND_INFERENCE_CODEX_ACCOUNT: "codex-account",
      },
      credentials: { claude: "claude-account" },
    },
    {
      name: "configured Codex",
      provider: "codex",
      configuration: {
        MEND_INFERENCE_CLAUDE_ACCOUNT: "claude-account",
        MEND_INFERENCE_CODEX_ACCOUNT: "codex-account",
      },
      credentials: { codex: "codex-account" },
    },
  ] satisfies ReadonlyArray<{
    name: string;
    provider: "claude" | "codex" | undefined;
    configuration: Record<string, string>;
    credentials: { claude?: boolean | string; codex?: boolean | string };
  }>) {
    it.effect(`selects ${selection.name} and audits the successful exchange`, () => {
      const response = text("a recorded answer");
      const h = harness([Effect.succeed(response)], selection.configuration);
      return Effect.gen(function* () {
        const answer = yield* (yield* InferenceProvider).respond({
          context: "failure-comment",
          prompt: "Explain this recorded failure",
          ...(selection.provider === undefined ? {} : { provider: selection.provider }),
          maxRounds: 1,
        });
        const expected = {
          prompt: "Explain this recorded failure",
          credentials: selection.credentials,
        };
        expect(answer).toBe("a recorded answer");
        expect(h.exchanges).toEqual([expected]);
        expect(h.audits).toEqual([
          { context: "failure-comment", tool: null, input: expected, output: response },
        ]);
        expect(h.order).toEqual(["exchange:1", "audit:exchange"]);
        expect(h.remaining()).toBe(0);
      }).pipe(Effect.provide(h.layer));
    });
  }

  it.effect("forwards system, model, schema and only the declared tool definitions", () => {
    const response: InferenceResponse = {
      sessionId: "structured",
      turn: {
        type: "text",
        text: "ignored when parsed JSON is present",
        json: { summary: "recorded evidence" },
      },
    };
    const h = harness([Effect.succeed(response)]);
    const tool: InferenceTool = {
      name: "read_recording",
      description: "Read a record page",
      inputSchema,
      handle: () => Effect.die("final answer must not execute tools"),
    };
    return Effect.gen(function* () {
      const result = yield* (yield* InferenceProvider).respond({
        context: "change-reading",
        prompt: "Read the change",
        system: "Link every claim to evidence",
        model: "requested-model",
        tools: [tool],
        outputSchema,
      });
      const expected = {
        prompt: "Read the change",
        system: "Link every claim to evidence",
        model: "requested-model",
        credentials: { claude: true },
        tools: [{ name: "read_recording", description: "Read a record page", inputSchema }],
        responseFormat: { type: "json", schema: outputSchema },
      };
      expect(result).toEqual({ summary: "recorded evidence" });
      expect(h.exchanges).toEqual([expected]);
      expect(h.audits).toEqual([
        { context: "change-reading", tool: null, input: expected, output: response },
      ]);
      expect(h.remaining()).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("omits an empty tool set and optional settings", () => {
    const h = harness([Effect.succeed(text("done"))]);
    return Effect.gen(function* () {
      expect(
        yield* (yield* InferenceProvider).respond({
          context: "request-intent",
          prompt: "Question or change?",
          tools: [],
        }),
      ).toBe("done");
      expect(h.exchanges).toEqual([
        { prompt: "Question or change?", credentials: { claude: true } },
      ]);
      expect(h.remaining()).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "executes successful and expected-failure tools in call order before continuing the same session",
    () => {
      const first = calls(
        [
          { toolCallId: "record-call", name: "read_recording", input: { cursor: 4 } },
          { toolCallId: "finding-call", name: "draft_finding", input: { line: 8 } },
        ],
        "first-session",
      );
      const second = calls(
        [{ toolCallId: "next-page", name: "read_recording", input: { cursor: 5 } }],
        "continued-session",
      );
      const final = text("finished with evidence", "continued-session");
      const h = harness([Effect.succeed(first), Effect.succeed(second), Effect.succeed(final)]);
      const handled: Array<{ name: string; input: unknown }> = [];
      const tools: InferenceTool[] = [
        {
          name: "read_recording",
          description: "Read a record page",
          inputSchema,
          handle: (input) =>
            Effect.sync(() => {
              h.order.push("handle:read_recording");
              handled.push({ name: "read_recording", input });
              return { entries: ["observed"] };
            }),
        },
        {
          name: "draft_finding",
          description: "Draft an evidence-linked finding",
          inputSchema: { type: "object" },
          handle: (input) =>
            Effect.sync(() => {
              h.order.push("handle:draft_finding");
              handled.push({ name: "draft_finding", input });
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new InferenceToolError({ tool: "draft_finding", message: "evidence required" }),
                ),
              ),
            ),
        },
      ];
      return Effect.gen(function* () {
        expect(
          yield* (yield* InferenceProvider).respond({
            context: "change-reading",
            prompt: "Read",
            tools,
          }),
        ).toBe("finished with evidence");
        const initial = {
          prompt: "Read",
          credentials: { claude: true },
          tools: [
            { name: "read_recording", description: "Read a record page", inputSchema },
            {
              name: "draft_finding",
              description: "Draft an evidence-linked finding",
              inputSchema: { type: "object" },
            },
          ],
        };
        const continuation = {
          sessionId: "first-session",
          toolResults: [
            { toolCallId: "record-call", content: '{"entries":["observed"]}' },
            { toolCallId: "finding-call", content: '"evidence required"', isError: true },
          ],
        };
        const last = {
          sessionId: "continued-session",
          toolResults: [{ toolCallId: "next-page", content: '{"entries":["observed"]}' }],
        };
        expect(h.exchanges).toEqual([initial, continuation, last]);
        expect(handled).toEqual([
          { name: "read_recording", input: { cursor: 4 } },
          { name: "draft_finding", input: { line: 8 } },
          { name: "read_recording", input: { cursor: 5 } },
        ]);
        expect(h.audits).toEqual([
          { context: "change-reading", tool: null, input: initial, output: first },
          {
            context: "change-reading",
            tool: "read_recording",
            input: { cursor: 4 },
            output: { ok: true, value: { entries: ["observed"] } },
          },
          {
            context: "change-reading",
            tool: "draft_finding",
            input: { line: 8 },
            output: { ok: false, value: "evidence required" },
          },
          { context: "change-reading", tool: null, input: continuation, output: second },
          {
            context: "change-reading",
            tool: "read_recording",
            input: { cursor: 5 },
            output: { ok: true, value: { entries: ["observed"] } },
          },
          { context: "change-reading", tool: null, input: last, output: final },
        ]);
        expect(h.order).toEqual([
          "exchange:1",
          "audit:exchange",
          "handle:read_recording",
          "audit:read_recording",
          "handle:draft_finding",
          "audit:draft_finding",
          "exchange:2",
          "audit:exchange",
          "handle:read_recording",
          "audit:read_recording",
          "exchange:3",
          "audit:exchange",
        ]);
        expect(h.remaining()).toBe(0);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect(
    "rejects an undeclared tool without executing a handler and retains both exchange records",
    () => {
      const first = calls([
        { toolCallId: "outside-tool", name: "arbitrary_shell", input: { command: "must not run" } },
      ]);
      const final = text("refused tool handled");
      const h = harness([Effect.succeed(first), Effect.succeed(final)]);
      return Effect.gen(function* () {
        expect(
          yield* (yield* InferenceProvider).respond({
            context: "change-reading",
            prompt: "Read",
            tools: [
              {
                name: "read_recording",
                description: "Read",
                inputSchema,
                handle: () => Effect.die("undeclared name must not execute an allowed tool"),
              },
            ],
          }),
        ).toBe("refused tool handled");
        const result = {
          toolCallId: "outside-tool",
          content: "Unknown tool: arbitrary_shell",
          isError: true,
        };
        expect(h.exchanges[1]).toEqual({
          sessionId: "subscription-session",
          toolResults: [result],
        });
        expect(h.remaining()).toBe(0);
        expect(h.audits).toEqual([
          {
            context: "change-reading",
            tool: null,
            input: {
              prompt: "Read",
              credentials: { claude: true },
              tools: [{ name: "read_recording", description: "Read", inputSchema }],
            },
            output: first,
          },
          {
            context: "change-reading",
            tool: null,
            input: { sessionId: "subscription-session", toolResults: [result] },
            output: final,
          },
        ]);
        expect(h.order).toEqual(["exchange:1", "audit:exchange", "exchange:2", "audit:exchange"]);
      }).pipe(Effect.provide(h.layer));
    },
  );

  for (const answer of [
    {
      name: "parsed SDK JSON including null",
      response: {
        sessionId: "json",
        turn: { type: "text", text: "not JSON", json: null },
      } satisfies InferenceResponse,
      schema: { type: "null" },
      value: null,
    },
    {
      name: "JSON text fallback",
      response: text('{"summary":"from text"}'),
      schema: outputSchema,
      value: { summary: "from text" },
    },
  ]) {
    it.effect(`returns ${answer.name} when structured output is requested`, () => {
      const h = harness([Effect.succeed(answer.response)]);
      return Effect.gen(function* () {
        expect(
          yield* (yield* InferenceProvider).respond({
            context: "change-tour",
            prompt: "Compose",
            outputSchema: answer.schema,
          }),
        ).toEqual(answer.value);
        expect(h.exchanges).toEqual([
          {
            prompt: "Compose",
            credentials: { claude: true },
            responseFormat: { type: "json", schema: answer.schema },
          },
        ]);
        expect(h.audits).toHaveLength(1);
        expect(h.audits[0]?.output).toEqual(answer.response);
        expect(h.remaining()).toBe(0);
      }).pipe(Effect.provide(h.layer));
    });
  }

  it.effect("refuses invalid JSON text after auditing the model response", () => {
    const response = text("{unfinished");
    const h = harness([Effect.succeed(response)]);
    return Effect.gen(function* () {
      const failure = yield* (yield* InferenceProvider)
        .respond({ context: "change-tour", prompt: "Compose", outputSchema })
        .pipe(Effect.flip);
      expect(failure._tag).toBe("InferenceError");
      expect(failure.message).toBe("final answer was not valid JSON");
      expect(failure.cause).toBeInstanceOf(SyntaxError);
      expect(h.exchanges).toHaveLength(1);
      expect(h.audits).toEqual([
        {
          context: "change-tour",
          tool: null,
          input: {
            prompt: "Compose",
            credentials: { claude: true },
            responseFormat: { type: "json", schema: outputSchema },
          },
          output: response,
        },
      ]);
      expect(h.remaining()).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "preserves plain text even when the SDK supplies JSON without a requested schema",
    () => {
      const h = harness([
        Effect.succeed({
          sessionId: "plain",
          turn: { type: "text", text: "plain text", json: { other: "metadata" } },
        }),
      ]);
      return Effect.gen(function* () {
        expect(
          yield* (yield* InferenceProvider).respond({
            context: "run-summary",
            prompt: "Summarize",
          }),
        ).toBe("plain text");
        expect(h.exchanges).toHaveLength(1);
        expect(h.remaining()).toBe(0);
      }).pipe(Effect.provide(h.layer));
    },
  );

  for (const at of ["initial", "continuation"]) {
    it.effect(`maps an expected SDK failure on the ${at} exchange without losing its cause`, () => {
      const error = new SealantPlatformError({
        code: "connected-account-missing",
        status: 403,
        message: "Reconnect Claude",
        provider: "claude",
        cause: null,
      });
      const initial = calls([{ toolCallId: "read", name: "read_recording", input: { cursor: 1 } }]);
      const h = harness(
        at === "initial" ? [Effect.fail(error)] : [Effect.succeed(initial), Effect.fail(error)],
      );
      const handled: unknown[] = [];
      return Effect.gen(function* () {
        const failure = yield* (yield* InferenceProvider)
          .respond({
            context: "run-summary",
            prompt: "Summarize",
            tools: [
              {
                name: "read_recording",
                description: "Read",
                inputSchema,
                handle: (input) =>
                  Effect.sync(() => {
                    handled.push(input);
                    return "page";
                  }),
              },
            ],
          })
          .pipe(Effect.flip);
        expect(failure._tag).toBe("InferenceError");
        expect(failure.message).toBe("Reconnect Claude");
        expect(failure.cause).toBe(error);
        expect(h.exchanges).toHaveLength(at === "initial" ? 1 : 2);
        expect(handled).toEqual(at === "initial" ? [] : [{ cursor: 1 }]);
        if (at === "continuation")
          expect(h.exchanges[1]).toEqual({
            sessionId: "subscription-session",
            toolResults: [{ toolCallId: "read", content: '"page"' }],
          });
        expect(h.remaining()).toBe(0);
      }).pipe(Effect.provide(h.layer));
    });
  }

  it.effect("preserves a tool defect instead of sending it as an expected tool error", () => {
    const defect = new Error("broken tool implementation");
    const initial = calls([{ toolCallId: "read", name: "read_recording", input: { cursor: 9 } }]);
    const h = harness([Effect.succeed(initial)]);
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        (yield* InferenceProvider).respond({
          context: "run-summary",
          prompt: "Summarize",
          tools: [
            {
              name: "read_recording",
              description: "Read",
              inputSchema,
              handle: () => Effect.die(defect),
            },
          ],
        }),
      );
      if (!Exit.isFailure(exit)) throw new Error("tool defect must fail the request");
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.squash(exit.cause)).toBe(defect);
      expect(h.exchanges).toHaveLength(1);
      expect(h.audits).toHaveLength(1);
      expect(h.remaining()).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("preserves tool interruption and sends no continuation", () => {
    const initial = calls([
      { toolCallId: "interrupted-read", name: "read_recording", input: { cursor: 10 } },
    ]);
    const h = harness([Effect.succeed(initial)]);
    const handled: unknown[] = [];
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        (yield* InferenceProvider).respond({
          context: "run-summary",
          prompt: "Summarize",
          tools: [
            {
              name: "read_recording",
              description: "Read",
              inputSchema,
              handle: (input) =>
                Effect.sync(() => {
                  handled.push(input);
                }).pipe(Effect.andThen(Effect.interrupt)),
            },
          ],
        }),
      );
      if (!Exit.isFailure(exit)) throw new Error("tool interruption must fail the request");
      expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(handled).toEqual([{ cursor: 10 }]);
      expect(h.exchanges).toHaveLength(1);
      expect(h.audits[0]?.output).toEqual(initial);
      expect(h.remaining()).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("does not execute a tool if the preceding exchange could not be audited", () => {
    const response = calls([{ toolCallId: "read", name: "read_recording", input: { cursor: 2 } }]);
    const exchanges: Exchange[] = [];
    const defect = new Error("audit write failed");
    const attemptedAudits: Audit[] = [];
    const failingAudit = Layer.succeed(InferenceCallsRepo, {
      record: (call) =>
        Effect.sync(() => {
          attemptedAudits.push(call);
        }).pipe(Effect.andThen(Effect.die(defect))),
    });
    // Supply the failing repository at the adapter boundary, not after its dependency is captured.
    const layer = sealantProviderLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          failingAudit,
          Layer.mock(SealantClient, {
            inferenceRespond: (options) =>
              Effect.sync(() => {
                exchanges.push(options);
                return response;
              }),
          }),
        ),
      ),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    );
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        (yield* InferenceProvider).respond({
          context: "run-summary",
          prompt: "Summarize",
          tools: [
            {
              name: "read_recording",
              description: "Read",
              inputSchema,
              handle: () => Effect.die("must not execute unaudited tool"),
            },
          ],
        }),
      );
      if (!Exit.isFailure(exit)) throw new Error("audit defect must fail the request");
      expect(Cause.squash(exit.cause)).toBe(defect);
      expect(exchanges).toHaveLength(1);
      expect(attemptedAudits).toEqual([
        {
          context: "run-summary",
          tool: null,
          input: {
            prompt: "Summarize",
            credentials: { claude: true },
            tools: [{ name: "read_recording", description: "Read", inputSchema }],
          },
          output: response,
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  for (const limit of [0, 1, 2, undefined]) {
    it.effect(`bounds a nonsettling loop to ${limit ?? "the default 12"} tool rounds`, () => {
      const rounds = limit ?? 12;
      const h = harness(
        Array.from({ length: rounds + 1 }, (_, index) =>
          Effect.succeed(
            calls(
              [{ toolCallId: `call-${index}`, name: "read_recording", input: { cursor: index } }],
              `session-${index}`,
            ),
          ),
        ),
      );
      const handled: unknown[] = [];
      return Effect.gen(function* () {
        const failure = yield* (yield* InferenceProvider)
          .respond({
            context: "change-reading",
            prompt: "Read",
            ...(limit === undefined ? {} : { maxRounds: limit }),
            tools: [
              {
                name: "read_recording",
                description: "Read",
                inputSchema,
                handle: (input) =>
                  Effect.sync(() => {
                    handled.push(input);
                    return "page";
                  }),
              },
            ],
          })
          .pipe(Effect.flip);
        expect(failure._tag).toBe("InferenceError");
        expect(failure.message).toBe(`tool loop did not settle within ${rounds} rounds`);
        expect(failure.cause).toBeNull();
        expect(handled).toEqual(Array.from({ length: rounds }, (_, cursor) => ({ cursor })));
        expect(h.exchanges).toHaveLength(rounds + 1);
        expect(h.exchanges.slice(1)).toEqual(
          Array.from({ length: rounds }, (_, index) => ({
            sessionId: `session-${index}`,
            toolResults: [{ toolCallId: `call-${index}`, content: '"page"' }],
          })),
        );
        expect(h.audits).toHaveLength(rounds * 2 + 1);
        expect(h.order).toEqual([
          "exchange:1",
          "audit:exchange",
          ...Array.from({ length: rounds }, (_, index) => [
            "audit:read_recording",
            `exchange:${index + 2}`,
            "audit:exchange",
          ]).flat(),
        ]);
        expect(h.remaining()).toBe(0);
      }).pipe(Effect.provide(h.layer));
    });
  }

  it.effect("accepts a final answer returned by the last allowed tool continuation", () => {
    const h = harness([
      Effect.succeed(
        calls([{ toolCallId: "last-round", name: "read_recording", input: { cursor: 1 } }]),
      ),
      Effect.succeed(text("settled at the limit")),
    ]);
    const handled: unknown[] = [];
    return Effect.gen(function* () {
      expect(
        yield* (yield* InferenceProvider).respond({
          context: "change-reading",
          prompt: "Read",
          maxRounds: 1,
          tools: [
            {
              name: "read_recording",
              description: "Read",
              inputSchema,
              handle: (input) =>
                Effect.sync(() => {
                  handled.push(input);
                  return "page";
                }),
            },
          ],
        }),
      ).toBe("settled at the limit");
      expect(handled).toEqual([{ cursor: 1 }]);
      expect(h.exchanges).toHaveLength(2);
      expect(h.audits).toHaveLength(3);
      expect(h.remaining()).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("settles at any generated tool budget without executing beyond it", () =>
    Effect.promise(() =>
      FastCheck.assert(
        FastCheck.asyncProperty(
          FastCheck.integer({ min: 0, max: 8 }),
          FastCheck.integer({ min: 10, max: 1000 }),
          async (budget, firstCursor) => {
            const responses = Array.from({ length: budget }, (_, index) =>
              Effect.succeed(
                calls(
                  [
                    {
                      toolCallId: `generated-${firstCursor + index}`,
                      name: "read_recording",
                      input: { cursor: firstCursor + index },
                    },
                  ],
                  `generated-session-${index}`,
                ),
              ),
            );
            const h = harness([
              ...responses,
              Effect.succeed(text("settled within the requested budget")),
            ]);
            const handled: unknown[] = [];
            const answer = await Effect.runPromise(
              Effect.gen(function* () {
                return yield* (yield* InferenceProvider).respond({
                  context: "change-reading",
                  prompt: "Read",
                  maxRounds: budget,
                  tools: [
                    {
                      name: "read_recording",
                      description: "Read",
                      inputSchema,
                      handle: (input) =>
                        Effect.sync(() => {
                          handled.push(input);
                          return "page";
                        }),
                    },
                  ],
                });
              }).pipe(Effect.provide(h.layer)),
            );
            expect(answer).toBe("settled within the requested budget");
            expect(handled).toEqual(
              Array.from({ length: budget }, (_, index) => ({ cursor: firstCursor + index })),
            );
            expect(h.exchanges.slice(1)).toEqual(
              Array.from({ length: budget }, (_, index) => ({
                sessionId: `generated-session-${index}`,
                toolResults: [
                  { toolCallId: `generated-${firstCursor + index}`, content: '"page"' },
                ],
              })),
            );
            expect(h.exchanges).toHaveLength(budget + 1);
            expect(h.audits).toHaveLength(2 * budget + 1);
            expect(h.remaining()).toBe(0);
          },
        ),
        { numRuns: 30, seed: 20261012 },
      ),
    ),
  );
});
