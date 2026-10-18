import { describe, expect, it } from "@effect/vitest";
import { ReviewCommentId } from "@mend/domain";
import { Change, ReviewComment, Session } from "@mend/domain/workbench";
import { Deferred, Effect, Layer } from "effect";
import * as FastCheck from "fast-check";

import {
  callTool,
  exitedEvent,
  fixtureFor,
  makeHarness,
  refuseTool,
} from "./change-pass.test-fixtures.ts";
import { ChangeReader } from "./change-reader.ts";
import { InferenceError } from "./provider.ts";

const finding = () => ({
  file: "src/login.ts",
  line: 4,
  endLine: 6,
  body: "The retry was exercised once.",
  disposition: "direct-evidence",
  evidence: [{ sequence: "3", excerpt: "check exited 0" }],
});

describe("ChangeReader actual tool evidence", () => {
  it.effect(
    "writes exact anchored and change-level draft notes with the current platform run",
    () => {
      const f = fixtureFor();
      const h = makeHarness(
        (request) =>
          Effect.gen(function* () {
            expect(request.context).toBe("change-reading");
            expect(request.maxRounds).toBe(30);
            expect(request.tools?.map((tool) => tool.name)).toEqual([
              "read_change",
              "read_recording",
              "read_terminal",
              "draft_finding",
            ]);
            yield* callTool(request, "read_change");
            yield* callTool(request, "read_terminal");
            yield* callTool(request, "read_recording", { fromSequence: "3", toSequence: "3" });
            expect(yield* callTool(request, "draft_finding", finding())).toEqual({
              recorded: true,
              commentId: "comment-1",
            });
            expect(yield* callTool(request, "draft_finding", { ...finding(), file: null })).toEqual(
              { recorded: true, commentId: "comment-2" },
            );
            return "two findings";
          }),
        f,
      );
      return Effect.gen(function* () {
        const service = yield* ChangeReader;
        expect(yield* service.read({ changeId: f.change.id })).toBe(2);
        const expected = {
          changeId: f.change.id,
          file: "src/login.ts",
          line: 4,
          endLine: 6,
          authorKind: "mend",
          authorName: "Mend",
          body: "The retry was exercised once.",
          state: "draft",
          evidence: [{ sealantRunId: "run-one", sequence: 3n, excerpt: "check exited 0" }],
        };
        expect(h.commentWrites).toEqual([
          expected,
          { ...expected, file: null, line: null, endLine: null },
        ]);
        expect(h.comments).toEqual(
          [1, 2].map((index) => ({
            ...expected,
            id: ReviewCommentId.make(`comment-${index}`),
            file: index === 1 ? "src/login.ts" : null,
            line: index === 1 ? 4 : null,
            endLine: index === 1 ? 6 : null,
            kind: "note",
            suggestion: null,
            anchor: null,
            sentToSessionId: null,
            createdAt: new Date("2026-09-25T10:00:00.000Z"),
            updatedAt: new Date("2026-09-25T10:00:00.000Z"),
          })),
        );
        expect(h.recordCalls.length).toBeGreaterThan(0);
        expect(h.recordCalls.every((call) => call.runId === "run-one")).toBe(true);
      }).pipe(Effect.provide(ChangeReader.layer.pipe(Layer.provide(h.layer))));
    },
  );

  for (const { name, patch } of [
    { name: "empty evidence", patch: { evidence: [] } },
    { name: "unseen evidence", patch: { evidence: [{ sequence: "9", excerpt: "not read" }] } },
    {
      name: "mixed evidence",
      patch: {
        evidence: [
          { sequence: "3", excerpt: "seen" },
          { sequence: "9", excerpt: "not read" },
        ],
      },
    },
    { name: "foreign path", patch: { file: "foreign.ts" } },
    { name: "body overflow", patch: { body: "b".repeat(501) } },
    {
      name: "excerpt overflow",
      patch: { evidence: [{ sequence: "3", excerpt: "e".repeat(201) }] },
    },
    {
      name: "malformed sequence",
      patch: { evidence: [{ sequence: "not-decimal", excerpt: "invalid" }] },
    },
    { name: "invalid disposition", patch: { disposition: "approved" } },
    { name: "noninteger line", patch: { line: 1.5 } },
    { name: "missing body", patch: { body: undefined } },
  ]) {
    it.effect(`refuses ${name} without a repository write`, () => {
      const f = fixtureFor();
      const h = makeHarness(
        (request) =>
          Effect.gen(function* () {
            yield* callTool(request, "read_change");
            yield* callTool(request, "read_recording");
            const error = yield* refuseTool(request, "draft_finding", { ...finding(), ...patch });
            expect(error._tag).toBe("InferenceToolError");
            expect(error.tool).toBe("draft_finding");
            return "no findings";
          }),
        f,
      );
      return Effect.gen(function* () {
        expect(yield* (yield* ChangeReader).read({ changeId: f.change.id })).toBe(0);
        expect(h.commentWrites).toEqual([]);
        expect(h.comments).toEqual([]);
      }).pipe(Effect.provide(ChangeReader.layer.pipe(Layer.provide(h.layer))));
    });
  }

  it.effect("only read_change authorizes file anchors, and a refusal can be repaired", () => {
    const f = fixtureFor();
    const h = makeHarness(
      (request) =>
        Effect.gen(function* () {
          yield* callTool(request, "read_recording");
          expect((yield* refuseTool(request, "draft_finding", finding())).message).toContain(
            "not in this change",
          );
          yield* callTool(request, "read_change");
          yield* callTool(request, "draft_finding", {
            ...finding(),
            body: "b".repeat(500),
            evidence: [{ sequence: "3", excerpt: "e".repeat(200) }],
          });
          return "one finding";
        }),
      f,
    );
    return Effect.gen(function* () {
      expect(yield* (yield* ChangeReader).read({ changeId: f.change.id })).toBe(1);
      expect(h.comments).toHaveLength(1);
      expect(h.comments[0]?.body).toBe("b".repeat(500));
      expect(h.comments[0]?.evidence[0]?.excerpt).toBe("e".repeat(200));
    }).pipe(Effect.provide(ChangeReader.layer.pipe(Layer.provide(h.layer))));
  });

  it.effect("terminal reads alone cannot ground a finding", () => {
    const f = fixtureFor();
    const h = makeHarness(
      (request) =>
        Effect.gen(function* () {
          yield* callTool(request, "read_change");
          yield* callTool(request, "read_terminal");
          expect((yield* refuseTool(request, "draft_finding", finding())).message).toContain(
            "never read",
          );
          return "none";
        }),
      f,
    );
    return Effect.gen(function* () {
      expect(yield* (yield* ChangeReader).read({ changeId: f.change.id })).toBe(0);
      expect(h.comments).toEqual([]);
    }).pipe(Effect.provide(ChangeReader.layer.pipe(Layer.provide(h.layer))));
  });

  it.effect("zero findings succeeds and gives existing comments to the provider", () => {
    const f = fixtureFor();
    const h = makeHarness(
      (request) =>
        Effect.sync(() => {
          expect(request.prompt).toContain("already reported");
          return "nothing additional";
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
        body: "already reported",
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
      expect(yield* (yield* ChangeReader).read({ changeId: f.change.id })).toBe(0);
      expect(h.commentWrites).toEqual([]);
      expect(h.comments).toHaveLength(1);
    }).pipe(Effect.provide(ChangeReader.layer.pipe(Layer.provide(h.layer))));
  });

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
          (yield* (yield* ChangeReader).read({ changeId: f.change.id }).pipe(Effect.flip))._tag,
        ).toBe("InferenceError");
        expect(h.comments).toEqual([]);
        expect(h.requests).toHaveLength(absent === "provider" ? 1 : 0);
      }).pipe(Effect.provide(ChangeReader.layer.pipe(Layer.provide(h.layer))));
    });
  }

  it.effect("interleaved jobs on one service isolate evidence, anchors and counters", () =>
    Effect.gen(function* () {
      const first = fixtureFor("first"),
        second = fixtureFor("second");
      const firstRead = yield* Deferred.make<void>(),
        secondTried = yield* Deferred.make<void>();
      const h = makeHarness(
        (request) =>
          Effect.gen(function* () {
            if (request.prompt.includes("session-first")) {
              yield* callTool(request, "read_change");
              yield* callTool(request, "read_recording");
              yield* Deferred.succeed(firstRead, undefined);
              yield* Deferred.await(secondTried);
            } else {
              yield* Deferred.await(firstRead);
              yield* refuseTool(request, "draft_finding", finding());
              yield* callTool(request, "read_change");
              yield* refuseTool(request, "draft_finding", finding());
              yield* callTool(request, "read_recording");
              yield* Deferred.succeed(secondTried, undefined);
            }
            yield* callTool(request, "draft_finding", {
              ...finding(),
              evidence: [
                {
                  sequence: request.prompt.includes("session-first") ? "3" : "13",
                  excerpt: "check exited 0",
                },
              ],
            });
            return "one";
          }),
        first,
      );
      h.fixtures.push(second);
      h.state.eventsByRun.set("run-first", [exitedEvent(3n)]);
      h.state.eventsByRun.set("run-second", [exitedEvent(13n)]);
      const result = yield* Effect.gen(function* () {
        const service = yield* ChangeReader;
        return yield* Effect.forEach(
          [first, second],
          (f) => service.read({ changeId: f.change.id }),
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.provide(ChangeReader.layer.pipe(Layer.provide(h.layer))));
      expect(result).toEqual([1, 1]);
      expect(
        h.comments
          .map((row) => [row.changeId, row.evidence[0]?.sealantRunId, row.evidence[0]?.sequence])
          .toSorted(),
      ).toEqual([
        [first.change.id, "run-first", 3n],
        [second.change.id, "run-second", 13n],
      ]);
    }),
  );

  it("generated foreign paths never become anchors after reading the change", async () => {
    await FastCheck.assert(
      FastCheck.asyncProperty(
        FastCheck.subarray(["a.ts", "b.ts", "c.ts"]),
        FastCheck.constantFrom("a.ts", "b.ts", "c.ts", "foreign.ts"),
        async (paths, file) => {
          const f = fixtureFor();
          const h = makeHarness(
            (request) =>
              Effect.gen(function* () {
                yield* callTool(request, "read_change");
                yield* callTool(request, "read_recording");
                const input = { ...finding(), file };
                if (paths.includes(file)) yield* callTool(request, "draft_finding", input);
                else yield* refuseTool(request, "draft_finding", input);
                return "finished";
              }),
            f,
          );
          h.state.files = paths.map((path) => ({ path, additions: 1, deletions: 0 }));
          const count = await Effect.runPromise(
            Effect.flatMap(ChangeReader, (service) => service.read({ changeId: f.change.id })).pipe(
              Effect.provide(ChangeReader.layer.pipe(Layer.provide(h.layer))),
            ),
          );
          expect(count).toBe(paths.includes(file) ? 1 : 0);
          expect(h.comments.map((row) => row.file)).toEqual(paths.includes(file) ? [file] : []);
        },
      ),
      { seed: 2032027, numRuns: 30 },
    );
  });
});
