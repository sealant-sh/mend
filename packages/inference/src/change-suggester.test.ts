import { describe, expect, it } from "@effect/vitest";
import { ReviewCommentId } from "@mend/domain";
import { Change, ReviewComment, Session } from "@mend/domain/workbench";
import { Effect, Layer } from "effect";
import * as FastCheck from "effect/testing/FastCheck";

import {
  callTool,
  exitedEvent,
  fixtureFor,
  makeHarness,
  refuseTool,
} from "./change-pass.test-fixtures.ts";
import { ChangeSuggester, ChangeSuggesterLive } from "./change-suggester.ts";
import { InferenceError } from "./provider.ts";

const suggestion = () => ({
  file: "src/login.ts",
  line: 4,
  endLine: 6,
  category: "correctness",
  failureScenario: "When the first request times out, retry once instead of failing.",
  body: "Retry the timed-out request once.",
  replacement: "return retryOnce();",
  evidence: [{ sequence: "3", excerpt: "check exited 0" }],
});

describe("ChangeSuggester exact draft proposals", () => {
  it.effect("persists exact replacement and null deletion with honest optional evidence", () => {
    const f = fixtureFor();
    const h = makeHarness(
      (request) =>
        Effect.gen(function* () {
          expect(request.context).toBe("change-suggesting");
          expect(request.maxRounds).toBe(30);
          expect(request.tools?.map((tool) => tool.name)).toEqual([
            "read_change",
            "read_recording",
            "read_terminal",
            "draft_suggestion",
          ]);
          yield* callTool(request, "read_change");
          yield* callTool(request, "read_terminal");
          yield* callTool(request, "read_recording", { fromSequence: "3", toSequence: "3" });
          expect(yield* callTool(request, "draft_suggestion", suggestion())).toEqual({
            recorded: true,
            commentId: "comment-1",
          });
          expect(
            yield* callTool(request, "draft_suggestion", {
              ...suggestion(),
              endLine: undefined,
              replacement: null,
              evidence: null,
            }),
          ).toEqual({ recorded: true, commentId: "comment-2" });
          return "two proposals";
        }),
      f,
    );
    return Effect.gen(function* () {
      expect(yield* (yield* ChangeSuggester).suggest({ changeId: f.change.id })).toBe(2);
      const expected = {
        changeId: f.change.id,
        file: "src/login.ts",
        line: 4,
        endLine: 6,
        authorKind: "mend",
        authorName: "Mend",
        body: "Retry the timed-out request once.\n\nFails when: When the first request times out, retry once instead of failing.",
        kind: "suggestion",
        suggestion: "return retryOnce();",
        state: "draft",
        evidence: [{ sealantRunId: "run-one", sequence: 3n, excerpt: "check exited 0" }],
      };
      expect(h.commentWrites).toEqual([
        expected,
        { ...expected, endLine: null, suggestion: null, evidence: [] },
      ]);
      expect(h.comments).toEqual(
        [1, 2].map((index) => ({
          ...expected,
          id: ReviewCommentId.make(`comment-${index}`),
          endLine: index === 1 ? 6 : null,
          suggestion: index === 1 ? "return retryOnce();" : null,
          evidence: index === 1 ? expected.evidence : [],
          anchor: null,
          sentToSessionId: null,
          createdAt: new Date("2026-09-25T10:00:00.000Z"),
          updatedAt: new Date("2026-09-25T10:00:00.000Z"),
        })),
      );
      expect(h.recordCalls.length).toBeGreaterThan(0);
      expect(h.recordCalls.every((call) => call.runId === "run-one")).toBe(true);
    }).pipe(Effect.provide(ChangeSuggesterLive.pipe(Layer.provide(h.layer))));
  });

  for (const evidence of [undefined, null, []]) {
    it.effect(`evidence ${JSON.stringify(evidence)} is an honest code reading`, () => {
      const f = fixtureFor();
      const h = makeHarness(
        (request) =>
          Effect.gen(function* () {
            yield* callTool(request, "read_change");
            yield* callTool(request, "draft_suggestion", { ...suggestion(), evidence });
            return "one";
          }),
        f,
      );
      return Effect.gen(function* () {
        expect(yield* (yield* ChangeSuggester).suggest({ changeId: f.change.id })).toBe(1);
        expect(h.comments[0]?.evidence).toEqual([]);
      }).pipe(Effect.provide(ChangeSuggesterLive.pipe(Layer.provide(h.layer))));
    });
  }

  for (const { name, patch } of [
    { name: "foreign anchor", patch: { file: "foreign.ts" } },
    { name: "unseen pointer", patch: { evidence: [{ sequence: "9", excerpt: "not read" }] } },
    {
      name: "mixed pointers",
      patch: {
        evidence: [
          { sequence: "3", excerpt: "seen" },
          { sequence: "9", excerpt: "not read" },
        ],
      },
    },
    { name: "thin scenario", patch: { failureScenario: "s".repeat(19) } },
    { name: "whitespace scenario", patch: { failureScenario: " ".repeat(30) } },
    { name: "scenario overflow", patch: { failureScenario: "s".repeat(301) } },
    { name: "body overflow", patch: { body: "b".repeat(501) } },
    { name: "blank replacement", patch: { replacement: " \n\t" } },
    {
      name: "excerpt overflow",
      patch: { evidence: [{ sequence: "3", excerpt: "e".repeat(201) }] },
    },
    { name: "noninteger line", patch: { line: 1.5 } },
    { name: "invalid category", patch: { category: "style" } },
    { name: "missing replacement", patch: { replacement: undefined } },
  ]) {
    it.effect(`refuses ${name} without persisting a proposal`, () => {
      const f = fixtureFor();
      const h = makeHarness(
        (request) =>
          Effect.gen(function* () {
            yield* callTool(request, "read_change");
            yield* callTool(request, "read_recording");
            const error = yield* refuseTool(request, "draft_suggestion", {
              ...suggestion(),
              ...patch,
            });
            expect(error._tag).toBe("InferenceToolError");
            expect(error.tool).toBe("draft_suggestion");
            return "none";
          }),
        f,
      );
      return Effect.gen(function* () {
        expect(yield* (yield* ChangeSuggester).suggest({ changeId: f.change.id })).toBe(0);
        expect(h.commentWrites).toEqual([]);
        expect(h.comments).toEqual([]);
      }).pipe(Effect.provide(ChangeSuggesterLive.pipe(Layer.provide(h.layer))));
    });
  }

  it.effect("accepts exact field boundaries and counts only five successful proposals", () => {
    const f = fixtureFor();
    const h = makeHarness(
      (request) =>
        Effect.gen(function* () {
          yield* callTool(request, "read_change");
          yield* callTool(request, "read_recording");
          for (let index = 0; index < 5; index++) {
            yield* refuseTool(request, "draft_suggestion", { ...suggestion(), file: "foreign.ts" });
            expect(
              yield* callTool(request, "draft_suggestion", {
                ...suggestion(),
                body: "b".repeat(500),
                failureScenario: "s".repeat(index === 0 ? 20 : 300),
                evidence: [{ sequence: "3", excerpt: "e".repeat(200) }],
              }),
            ).toEqual({ recorded: true, commentId: `comment-${index + 1}` });
          }
          expect((yield* refuseTool(request, "draft_suggestion", suggestion())).message).toContain(
            "caps at 5",
          );
          return "five";
        }),
      f,
    );
    return Effect.gen(function* () {
      expect(yield* (yield* ChangeSuggester).suggest({ changeId: f.change.id })).toBe(5);
      expect(h.comments).toHaveLength(5);
      expect(h.comments[0]?.body).toBe(`${"b".repeat(500)}\n\nFails when: ${"s".repeat(20)}`);
      expect(h.comments[4]?.evidence[0]?.excerpt).toBe("e".repeat(200));
    }).pipe(Effect.provide(ChangeSuggesterLive.pipe(Layer.provide(h.layer))));
  });

  it.effect(
    "reads must authorize an anchor and every optional pointer before it is written",
    () => {
      const f = fixtureFor();
      const h = makeHarness(
        (request) =>
          Effect.gen(function* () {
            yield* refuseTool(request, "draft_suggestion", { ...suggestion(), evidence: [] });
            yield* callTool(request, "read_change");
            yield* callTool(request, "read_terminal");
            yield* refuseTool(request, "draft_suggestion", suggestion());
            yield* callTool(request, "read_recording");
            yield* callTool(request, "draft_suggestion", suggestion());
            return "one";
          }),
        f,
      );
      return Effect.gen(function* () {
        expect(yield* (yield* ChangeSuggester).suggest({ changeId: f.change.id })).toBe(1);
        expect(h.comments).toHaveLength(1);
      }).pipe(Effect.provide(ChangeSuggesterLive.pipe(Layer.provide(h.layer))));
    },
  );

  it.effect(
    "zero suggestions preserves existing comments while giving them to the provider",
    () => {
      const f = fixtureFor();
      const h = makeHarness(
        (request) =>
          Effect.sync(() => {
            expect(request.prompt).toContain("already suggested");
            return "none";
          }),
        f,
      );
      h.comments.push(
        new ReviewComment({
          id: ReviewCommentId.make("existing"),
          changeId: f.change.id,
          file: null,
          line: null,
          endLine: null,
          anchor: null,
          authorKind: "reviewer",
          authorName: "Alice",
          body: "already suggested",
          kind: "note",
          suggestion: null,
          state: "open",
          evidence: [],
          sentToSessionId: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }),
      );
      return Effect.gen(function* () {
        expect(yield* (yield* ChangeSuggester).suggest({ changeId: f.change.id })).toBe(0);
        expect(h.commentWrites).toEqual([]);
        expect(h.comments).toHaveLength(1);
      }).pipe(Effect.provide(ChangeSuggesterLive.pipe(Layer.provide(h.layer))));
    },
  );

  for (const absent of ["session", "record", "provider"]) {
    it.effect(`missing ${absent} returns InferenceError before drafting`, () => {
      const f = fixtureFor();
      const h = makeHarness(
        () => Effect.fail(new InferenceError({ message: "provider failed", cause: null })),
        f,
      );
      if (absent === "session")
        h.fixtures[0] = { ...f, change: new Change({ ...f.change, sessionId: null }) };
      if (absent === "record")
        h.fixtures[0] = { ...f, session: new Session({ ...f.session, sealantRunId: null }) };
      return Effect.gen(function* () {
        expect(
          (yield* (yield* ChangeSuggester).suggest({ changeId: f.change.id }).pipe(Effect.flip))
            ._tag,
        ).toBe("InferenceError");
        expect(h.comments).toEqual([]);
        expect(h.requests).toHaveLength(absent === "provider" ? 1 : 0);
      }).pipe(Effect.provide(ChangeSuggesterLive.pipe(Layer.provide(h.layer))));
    });
  }

  it.effect("another job does not inherit evidence, anchors or the suggestion cap", () => {
    const first = fixtureFor("first"),
      second = fixtureFor("second");
    const h = makeHarness(
      (request) =>
        Effect.gen(function* () {
          const secondPass = request.prompt.includes("session-second");
          if (secondPass) {
            yield* refuseTool(request, "draft_suggestion", { ...suggestion(), evidence: [] });
            yield* callTool(request, "read_change");
            yield* refuseTool(request, "draft_suggestion", suggestion());
          } else yield* callTool(request, "read_change");
          yield* callTool(request, "read_recording");
          const input = {
            ...suggestion(),
            evidence: [{ sequence: secondPass ? "13" : "3", excerpt: "check exited 0" }],
          };
          for (let index = 0; index < 5; index++)
            yield* callTool(request, "draft_suggestion", input);
          yield* refuseTool(request, "draft_suggestion", suggestion());
          return "five";
        }),
      first,
    );
    h.fixtures.push(second);
    h.state.eventsByRun.set("run-first", [exitedEvent(3n)]);
    h.state.eventsByRun.set("run-second", [exitedEvent(13n)]);
    return Effect.gen(function* () {
      const service = yield* ChangeSuggester;
      expect(yield* service.suggest({ changeId: first.change.id })).toBe(5);
      expect(yield* service.suggest({ changeId: second.change.id })).toBe(5);
      expect(h.comments).toHaveLength(10);
      expect(
        h.comments
          .slice(0, 5)
          .every(
            (row) =>
              row.changeId === first.change.id &&
              row.evidence[0]?.sealantRunId === "run-first" &&
              row.evidence[0]?.sequence === 3n,
          ),
      ).toBe(true);
      expect(
        h.comments
          .slice(5)
          .every(
            (row) =>
              row.changeId === second.change.id &&
              row.evidence[0]?.sealantRunId === "run-second" &&
              row.evidence[0]?.sequence === 13n,
          ),
      ).toBe(true);
    }).pipe(Effect.provide(ChangeSuggesterLive.pipe(Layer.provide(h.layer))));
  });

  it("generated rejection interleavings consume only successful-write capacity", async () => {
    await FastCheck.assert(
      FastCheck.asyncProperty(
        FastCheck.array(FastCheck.boolean(), { minLength: 1, maxLength: 12 }),
        async (flags) => {
          const f = fixtureFor();
          const h = makeHarness(
            (request) =>
              Effect.gen(function* () {
                yield* callTool(request, "read_change");
                let written = 0;
                for (const valid of flags) {
                  const input = {
                    ...suggestion(),
                    evidence: [],
                    ...(valid ? {} : { body: "b".repeat(501) }),
                  };
                  if (valid && written < 5) {
                    yield* callTool(request, "draft_suggestion", input);
                    written++;
                  } else yield* refuseTool(request, "draft_suggestion", input);
                }
                return "finished";
              }),
            f,
          );
          const counts = await Effect.runPromise(
            Effect.gen(function* () {
              const service = yield* ChangeSuggester;
              return [
                yield* service.suggest({ changeId: f.change.id }),
                yield* service.suggest({ changeId: f.change.id }),
              ];
            }).pipe(Effect.provide(ChangeSuggesterLive.pipe(Layer.provide(h.layer)))),
          );
          const expected = Math.min(flags.filter(Boolean).length, 5);
          expect(counts).toEqual([expected, expected]);
          expect(h.comments).toHaveLength(expected * 2);
        },
      ),
      { seed: 2032028, numRuns: 30 },
    );
  });
});
