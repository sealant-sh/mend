import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as FastCheck from "fast-check";

import { exitedEvent, fixtureFor, makeHarness, startedEvent } from "./change-pass.test-fixtures.ts";
import { makeSessionChangePass } from "./session-tools.ts";
import { RecordingEvent } from "./tools.ts";

const eventsOf = Schema.decodeUnknownSync(Schema.Array(RecordingEvent));
const makePass = (f: ReturnType<typeof fixtureFor>) =>
  makeSessionChangePass({
    projectId: f.project.id,
    worktreeId: f.change.worktreeId,
    change: f.change,
    sealantRunId: f.session.sealantRunId ?? "missing-record",
  });
const unusedProvider = () => Effect.die("direct tool tests never call the provider");

describe("actual session-scoped read tools", () => {
  for (const length of [180_000, 180_001]) {
    it.effect(`read_change reports scope and the ${length} character truncation boundary`, () => {
      const f = fixtureFor(),
        h = makeHarness(unusedProvider, f);
      h.state.diff = "d".repeat(length);
      h.state.files = [
        { path: "a.ts", additions: 3, deletions: 2 },
        { path: "b.ts", additions: 1, deletions: 0 },
      ];
      return Effect.gen(function* () {
        const pass = yield* makePass(f);
        expect(yield* pass.readChangeTool.handle({})).toEqual({
          branch: f.change.branch,
          baseSha: f.change.baseSha,
          files: h.state.files,
          diff:
            length === 180_000
              ? "d".repeat(length)
              : `${"d".repeat(180_000)}\n… (diff truncated — 180001 chars total; rely on the per-file counts for scope)`,
          truncated: length > 180_000,
        });
        expect([...pass.changedPaths]).toEqual(["a.ts", "b.ts"]);
        expect(h.reads).toEqual([
          {
            kind: "diff",
            projectId: f.project.id,
            worktreeId: f.change.worktreeId,
            baseSha: f.change.baseSha,
          },
          {
            kind: "files",
            projectId: f.project.id,
            worktreeId: f.change.worktreeId,
            baseSha: f.change.baseSha,
          },
        ]);
      }).pipe(Effect.provide(h.layer));
    });
  }

  it.effect("record selectors and the cap grant only the 500 matching delivered events", () => {
    const f = fixtureFor(),
      h = makeHarness(unusedProvider, f);
    h.state.events = Array.from({ length: 1004 }, (_, index) =>
      index % 2 === 0 ? startedEvent(BigInt(index + 1)) : exitedEvent(BigInt(index + 1)),
    );
    return Effect.gen(function* () {
      const pass = yield* makePass(f);
      const result = eventsOf(
        yield* pass.readRecordingTool.handle({
          fromSequence: "2",
          toSequence: "1004",
          kinds: ["processExited"],
        }),
      );
      expect(result.map((row) => row.sequence)).toEqual(
        Array.from({ length: 500 }, (_, index) => BigInt((index + 1) * 2)),
      );
      expect([...pass.seenSequences]).toEqual(
        Array.from({ length: 500 }, (_, index) => String((index + 1) * 2)),
      );
      expect(pass.seenSequences.has("1002")).toBe(false);
      expect(result[0]).toEqual(
        new RecordingEvent({
          sequence: 2n,
          kind: "processExited",
          occurredAt: new Date("2026-09-25T10:00:00.000Z"),
          summary: "check exited 0",
          provenance: "observed",
          data: { exitCode: 0, reason: 1, durationMicros: "1000" },
        }),
      );
      expect(h.recordCalls).toEqual([
        { kind: "get", runId: "run-one" },
        { kind: "timeline", runId: "run-one", from: 2n },
      ]);
      expect(
        eventsOf(
          yield* pass.readRecordingTool.handle({ fromSequence: "1002", kinds: ["processExited"] }),
        ).map((row) => row.sequence),
      ).toEqual([1002n, 1004n]);
      expect(pass.seenSequences.has("1004")).toBe(true);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("empty kinds returns no events and large sequence identity stays exact", () => {
    const f = fixtureFor(),
      h = makeHarness(unusedProvider, f);
    h.state.events = [exitedEvent(9007199254740993n)];
    return Effect.gen(function* () {
      const pass = yield* makePass(f);
      expect(yield* pass.readRecordingTool.handle({ kinds: [] })).toEqual([]);
      expect(pass.seenSequences.size).toBe(0);
      const raw = yield* pass.readRecordingTool.handle({
        fromSequence: "9007199254740993",
        toSequence: "9007199254740993",
      });
      expect(eventsOf(raw)[0]?.sequence).toBe(9007199254740993n);
      expect([...pass.seenSequences]).toEqual(["9007199254740993"]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a stream that fails after emitting events grants no partial evidence", () => {
    const f = fixtureFor(),
      h = makeHarness(unusedProvider, f);
    h.state.failTimeline = true;
    return Effect.gen(function* () {
      const pass = yield* makePass(f);
      const error = yield* pass.readRecordingTool.handle({}).pipe(Effect.flip);
      expect(error._tag).toBe("InferenceToolError");
      expect(error.tool).toBe("read_recording");
      expect(pass.seenSequences.size).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });

  for (const kind of ["recording", "terminal"]) {
    it.effect(`an unavailable SDK run becomes a typed ${kind} tool error`, () => {
      const f = fixtureFor(),
        h = makeHarness(unusedProvider, f);
      h.state.failRun = true;
      return Effect.gen(function* () {
        const pass = yield* makePass(f);
        const target = kind === "recording" ? pass.readRecordingTool : pass.readTerminalTool;
        const error = yield* target.handle({}).pipe(Effect.flip);
        expect(error._tag).toBe("InferenceToolError");
        expect(error.tool).toBe(`read_${kind}`);
        expect(h.recordCalls).toEqual([{ kind: "get", runId: "run-one" }]);
        expect(pass.seenSequences.size).toBe(0);
        expect(pass.changedPaths.size).toBe(0);
      }).pipe(Effect.provide(h.layer));
    });
  }

  it.effect("malformed selectors fail before the SDK is opened", () => {
    const f = fixtureFor(),
      h = makeHarness(unusedProvider, f);
    return Effect.gen(function* () {
      const pass = yield* makePass(f);
      expect(
        (yield* pass.readRecordingTool.handle({ fromSequence: "bad" }).pipe(Effect.flip))._tag,
      ).toBe("InferenceToolError");
      expect((yield* pass.readTerminalTool.handle({ tailChars: 1.5 }).pipe(Effect.flip))._tag).toBe(
        "InferenceToolError",
      );
      expect(h.recordCalls).toEqual([]);
      expect(pass.seenSequences.size).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "terminal strips ANSI and CR noise, keeps command outcomes, and grants no sequences",
    () => {
      const f = fixtureFor(),
        h = makeHarness(unusedProvider, f);
      h.state.pty = new TextEncoder().encode(
        "\u001b[31mred\u001b[0m\r\n\u001b]0;title\u0007next\r\n\n\n",
      );
      h.state.commands.push({
        executable: "sh",
        args: [],
        command: "sh (1 argument not recorded)",
        stdoutBytes: 0,
        stderrBytes: 0,
      });
      return Effect.gen(function* () {
        const pass = yield* makePass(f);
        expect(yield* pass.readTerminalTool.handle({})).toEqual({
          commands: [
            { command: "claude (2 arguments not recorded)", exitCode: 0, cwd: "/worktree" },
            { command: "sh (1 argument not recorded)", exitCode: null, cwd: null },
          ],
          output: "red\nnext\n\n",
          totalChars: 10,
        });
        expect(h.recordCalls.filter((call) => call.kind === "scrollback")).toEqual([
          { kind: "scrollback", runId: "run-one", processId: "harness", stream: "pty" },
        ]);
        expect(pass.seenSequences.size).toBe(0);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("terminal falls back from empty PTY to stdout of the first process only", () => {
    const f = fixtureFor(),
      h = makeHarness(unusedProvider, f);
    h.state.events = [startedEvent(1n, "first-process"), startedEvent(2n, "later-process")];
    h.state.pty = new Uint8Array();
    h.state.stdout = new TextEncoder().encode("stdout evidence");
    return Effect.gen(function* () {
      const pass = yield* makePass(f);
      expect(yield* pass.readTerminalTool.handle({})).toMatchObject({
        output: "stdout evidence",
        totalChars: 15,
      });
      expect(h.recordCalls.filter((call) => call.kind === "scrollback")).toEqual([
        { kind: "scrollback", runId: "run-one", processId: "first-process", stream: "pty" },
        { kind: "scrollback", runId: "run-one", processId: "first-process", stream: "stdout" },
      ]);
    }).pipe(Effect.provide(h.layer));
  });

  for (const { input, tail } of [
    { input: {}, tail: 30_000 },
    { input: { tailChars: 1 }, tail: 1_000 },
    { input: { tailChars: 200_000 }, tail: 120_000 },
  ]) {
    it.effect(`terminal tail is bounded to ${tail} characters with truthful omission count`, () => {
      const f = fixtureFor(),
        h = makeHarness(unusedProvider, f);
      h.state.pty = new TextEncoder().encode("x".repeat(120_005));
      return Effect.gen(function* () {
        const pass = yield* makePass(f);
        expect(yield* pass.readTerminalTool.handle(input)).toMatchObject({
          output: `…(${120_005 - tail} earlier chars omitted — raise tailChars to see more)\n${"x".repeat(tail)}`,
          totalChars: 120_005,
        });
      }).pipe(Effect.provide(h.layer));
    });
  }

  it.effect("no process returns empty terminal output without losing the command list", () => {
    const f = fixtureFor(),
      h = makeHarness(unusedProvider, f);
    h.state.events = [exitedEvent()];
    return Effect.gen(function* () {
      const pass = yield* makePass(f);
      expect(yield* pass.readTerminalTool.handle({})).toEqual({
        commands: [{ command: "claude (2 arguments not recorded)", exitCode: 0, cwd: "/worktree" }],
        output: "",
        totalChars: 0,
      });
      expect(h.recordCalls.some((call) => call.kind === "scrollback")).toBe(false);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "passes isolate changed paths and seen sequences, and ignore attempted foreign IDs",
    () => {
      const f = fixtureFor(),
        h = makeHarness(unusedProvider, f);
      return Effect.gen(function* () {
        const first = yield* makePass(f),
          second = yield* makePass(f);
        yield* first.readChangeTool.handle({ project: "foreign", worktree: "foreign" });
        yield* first.readRecordingTool.handle({ run: "foreign" });
        expect(first.seenSequences.size).toBe(2);
        expect(first.changedPaths.size).toBe(1);
        expect(second.seenSequences.size).toBe(0);
        expect(second.changedPaths.size).toBe(0);
        expect(h.recordCalls.every((call) => call.runId === "run-one")).toBe(true);
        expect(
          h.reads.every(
            (call) =>
              call.projectId === f.project.id &&
              call.worktreeId === f.change.worktreeId &&
              call.baseSha === f.change.baseSha,
          ),
        ).toBe(true);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it("generated range and kind selectors deliver only their mathematical intersection", async () => {
    await FastCheck.assert(
      FastCheck.asyncProperty(
        FastCheck.integer({ min: 1, max: 12 }),
        FastCheck.integer({ min: 1, max: 12 }),
        FastCheck.boolean(),
        async (from, to, exitsOnly) => {
          const f = fixtureFor(),
            h = makeHarness(unusedProvider, f);
          h.state.events = Array.from({ length: 12 }, (_, index) =>
            index % 2 === 0 ? startedEvent(BigInt(index + 1)) : exitedEvent(BigInt(index + 1)),
          );
          const result = await Effect.runPromise(
            Effect.gen(function* () {
              const pass = yield* makePass(f);
              const events = eventsOf(
                yield* pass.readRecordingTool.handle({
                  fromSequence: String(from),
                  toSequence: String(to),
                  ...(exitsOnly ? { kinds: ["processExited"] } : {}),
                }),
              );
              return { events, seen: [...pass.seenSequences] };
            }).pipe(Effect.provide(h.layer)),
          );
          const expected = Array.from({ length: 12 }, (_, index) => index + 1).filter(
            (number) => number >= from && number <= to && (!exitsOnly || number % 2 === 0),
          );
          expect(result.events.map((row) => Number(row.sequence))).toEqual(expected);
          expect(result.seen).toEqual(expected.map(String));
        },
      ),
      { seed: 2032029, numRuns: 30 },
    );
  });
});
