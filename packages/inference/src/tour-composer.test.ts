import { createHash } from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { ChangeToursRepo, ProjectsRepo, SessionsRepo, WorktreeChangesRepo } from "@mend/db";
import {
  ChangeId,
  OrganizationId,
  ProjectId,
  SealantRunId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { Change, ChangeTour, Project, Session } from "@mend/domain/workbench";
import { SealantClient } from "@mend/sealant";
import { WORKTREE_STAMP, WorktreeReads } from "@mend/sessions";
import { Effect, Layer } from "effect";
import * as FastCheck from "fast-check";

import { callTool, exitedEvent, fixtureFor, makeHarness } from "./change-pass.test-fixtures.ts";
import { InferenceError, InferenceProvider } from "./provider.ts";
import { ComposeTourJob, TourComposer } from "./tour-composer.ts";

const NOW = new Date("2026-09-25T10:00:00.000Z");
const CHANGE = ChangeId.make("change-1");
const PROJECT = ProjectId.make("project-1");
const WORKTREE = WorktreeId.make("wt-1");
const SESSION = SessionId.make("session-1");
const DIFF = "diff --git a/src/login.ts b/src/login.ts\n+retry once\n";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

const change = new Change({
  id: CHANGE,
  projectId: PROJECT,
  worktreeId: WORKTREE,
  sessionId: SESSION,
  branch: "mend/fix-login",
  baseSha: Sha.make("a".repeat(40)),
  headSha: Sha.make("b".repeat(40)),
  createdAt: NOW,
  updatedAt: NOW,
});

const project = new Project({
  id: PROJECT,
  name: "web",
  organizationId: OrganizationId.make("org-1"),
  visibility: "shared",
  createdByUserId: null,
  originUrl: null,
  storePath: "/store/web/repo.git",
  defaultBranch: "main",
  adoptedSha: Sha.make("a".repeat(40)),
  autoTour: "inherit",
  autoSuggest: "inherit",
  autoName: "inherit",
  autoLand: "inherit",
  backgroundSessions: "inherit",
  gitAuthMode: "mend-key",
  workspaceImage: null,
  applyDotfiles: true,
  defaultShellProfile: true,
  inheritUserSkills: true,
  hotSessions: 0,
  installCommand: null,
  installEnabled: true,
  createdAt: NOW,
  updatedAt: NOW,
});

const session = new Session({
  id: SESSION,
  projectId: PROJECT,
  worktreeId: WORKTREE,
  harness: "claude",
  providerSessionId: null,
  label: null,
  worktree: "fix-login",
  branch: "mend/fix-login",
  baseSha: Sha.make("a".repeat(40)),
  baseRef: "main",
  contextSnapshotId: null,
  referenceMounts: [],
  extraMounts: [],
  sealantRunId: SealantRunId.make("run-1"),
  sealantWorkspaceId: null,
  sealantSessionId: null,
  workspaceExpiresAt: null,
  workspaceTtlRenewedAt: null,
  workspaceTtlRenewalFailedAt: null,
  workspaceTtlRenewalError: null,
  workspaceImage: null,
  dotfiles: null,
  ownerUserId: "alice",
  hasTranscript: true,
  status: "completed",
  summary: null,
  lastSeenSequence: 10n,
  recordHistoryComplete: true,
  startedAt: NOW,
  settledAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
});

/** Compose once over a change whose current tour was composed from `tourDiff` (null: none). */
const composeOver = (tourDiff: string | null) => {
  const asked: Array<string> = [];
  const layer = TourComposer.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(InferenceProvider, {
          respond: (request) =>
            Effect.suspend(() => {
              asked.push(request.context);
              return Effect.fail(new InferenceError({ message: "no account", cause: null }));
            }),
        }),
        Layer.mock(WorktreeChangesRepo, { byId: () => Effect.succeed(change) }),
        Layer.mock(SessionsRepo, { byId: () => Effect.succeed(session) }),
        Layer.mock(ProjectsRepo, { byId: () => Effect.succeed(project) }),
        Layer.mock(ChangeToursRepo, {
          byChange: () =>
            Effect.succeed(
              tourDiff === null
                ? null
                : new ChangeTour({
                    id: "tour-1",
                    changeId: CHANGE,
                    sessionId: SESSION,
                    summary: "Retries the login once.",
                    approach: null,
                    stops: [],
                    diffDigest: digest(tourDiff),
                    createdAt: NOW,
                  }),
            ),
          upsert: (tour) => Effect.die(`not upserted in this test: ${tour.diffDigest}`),
        }),
        Layer.mock(WorktreeReads, {
          diffWorktree: () => Effect.succeed({ value: DIFF, stamp: WORKTREE_STAMP }),
        }),
        Layer.mock(SealantClient, {}),
      ),
    ),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const composer = yield* TourComposer;
      return yield* composer.compose(new ComposeTourJob({ changeId: CHANGE })).pipe(Effect.result);
    }).pipe(Effect.provide(layer)),
  ).then((result) => ({ result, asked }));
};

describe("TourComposer", () => {
  it("spends nothing when the diff is the one the current tour was composed from", async () => {
    // No inference asked for, no tour written (the fake dies on either).
    const { result, asked } = await composeOver(DIFF);
    expect(result._tag === "Success" ? result.success : null).toBe("unchanged");
    expect(asked).toEqual([]);
  });

  it("composes when the diff moved since the tour, or there is none", async () => {
    for (const tourDiff of ["diff --git a/src/old.ts b/src/old.ts\n", null]) {
      const { result, asked } = await composeOver(tourDiff);
      expect(asked).toEqual(["change-tour"]);
      expect(result._tag).toBe("Failure");
    }
  });
});

const tourAnswer = () => ({
  summary: "Retries the login once.",
  approach: "Read the retry and ran its check.",
  stops: [
    {
      title: "Retry",
      file: "src/login.ts",
      line: 4,
      endLine: 6,
      narration: "The retry ran once.",
      evidence: [
        { sequence: "3", excerpt: "check exited 0" },
        { sequence: "99", excerpt: "not read" },
      ],
    },
    {
      title: "Other path",
      file: "foreign.ts",
      line: 8,
      endLine: 9,
      narration: "A code reading.",
      evidence: [{ sequence: "99", excerpt: "not read" }],
    },
    {
      title: "Approach",
      file: null,
      line: 4,
      endLine: 6,
      narration: "The check completed.",
      evidence: [{ sequence: "3", excerpt: "check exited 0" }],
    },
  ],
});

const compose = (id: ChangeId) =>
  Effect.flatMap(TourComposer, (service) => service.compose({ changeId: id }));

describe("TourComposer successful evidence publication", () => {
  it.effect("persists the exact filtered tour with current run identity and digest", () => {
    const f = fixtureFor();
    const h = makeHarness(
      (request) =>
        Effect.gen(function* () {
          expect(request.context).toBe("change-tour");
          expect(request.maxRounds).toBe(24);
          expect(request.outputSchema).toBeDefined();
          expect(request.tools?.map((tool) => tool.name)).toEqual([
            "read_change",
            "read_recording",
            "read_terminal",
          ]);
          expect(yield* callTool(request, "read_change")).toEqual({
            branch: f.change.branch,
            baseSha: f.change.baseSha,
            files: [{ path: "src/login.ts", additions: 1, deletions: 0 }],
            diff: DIFF,
            truncated: false,
          });
          expect(yield* callTool(request, "read_terminal")).toEqual({
            commands: [
              { command: "claude (2 arguments not recorded)", exitCode: 0, cwd: "/worktree" },
            ],
            output: "check passed\n",
            totalChars: 13,
          });
          yield* callTool(request, "read_recording", { fromSequence: "3", toSequence: "3" });
          return tourAnswer();
        }),
      f,
    );
    return Effect.gen(function* () {
      expect(yield* compose(f.change.id)).toBe("composed");
      expect(h.tourWrites).toEqual([
        {
          changeId: f.change.id,
          sessionId: f.session.id,
          summary: "Retries the login once.",
          approach: "Read the retry and ran its check.",
          diffDigest: digest(DIFF),
          stops: [
            {
              title: "Retry",
              file: "src/login.ts",
              line: 4,
              endLine: 6,
              narration: "The retry ran once.",
              evidence: [{ sealantRunId: "run-one", sequence: 3n, excerpt: "check exited 0" }],
              grounded: true,
            },
            {
              title: "Other path",
              file: null,
              line: null,
              endLine: null,
              narration: "A code reading.",
              evidence: [],
              grounded: false,
            },
            {
              title: "Approach",
              file: null,
              line: null,
              endLine: null,
              narration: "The check completed.",
              evidence: [{ sealantRunId: "run-one", sequence: 3n, excerpt: "check exited 0" }],
              grounded: true,
            },
          ],
        },
      ]);
      expect(h.tours.get(f.change.id)).toMatchObject(h.tourWrites[0] ?? {});
      expect(h.recordCalls.every((call) => call.runId === "run-one")).toBe(true);
      expect(h.recordCalls.some((call) => call.kind === "scrollback")).toBe(true);
    }).pipe(Effect.provide(TourComposer.layer.pipe(Layer.provide(h.layer))));
  });

  it.effect("terminal reads alone do not grant record evidence or file anchors", () => {
    const h = makeHarness((request) =>
      Effect.gen(function* () {
        yield* callTool(request, "read_terminal");
        return tourAnswer();
      }),
    );
    return Effect.gen(function* () {
      expect(yield* compose(h.fixtures[0]?.change.id ?? CHANGE)).toBe("composed");
      expect(
        h.tourWrites[0]?.stops.map((stop) => [
          stop.file,
          stop.line,
          stop.endLine,
          stop.evidence,
          stop.grounded,
        ]),
      ).toEqual([
        [null, null, null, [], false],
        [null, null, null, [], false],
        [null, null, null, [], false],
      ]);
    }).pipe(Effect.provide(TourComposer.layer.pipe(Layer.provide(h.layer))));
  });

  it.effect("truncates register fields and preserves the actual large record sequence", () => {
    const h = makeHarness((request) =>
      Effect.gen(function* () {
        yield* callTool(request, "read_change");
        yield* callTool(request, "read_recording");
        return {
          summary: "s".repeat(701),
          approach: "a".repeat(501),
          stops: [
            {
              title: "t".repeat(91),
              file: "src/login.ts",
              narration: "n".repeat(701),
              evidence: [{ sequence: "9007199254740993", excerpt: "e".repeat(201) }],
            },
          ],
        };
      }),
    );
    h.state.events = [exitedEvent(9007199254740993n)];
    const id = h.fixtures[0]?.change.id ?? CHANGE;
    return Effect.gen(function* () {
      expect(yield* compose(id)).toBe("composed");
      expect(h.tourWrites).toEqual([
        {
          changeId: id,
          sessionId: h.fixtures[0]?.session.id,
          summary: "s".repeat(700),
          approach: "a".repeat(500),
          diffDigest: digest(DIFF),
          stops: [
            {
              title: "t".repeat(90),
              file: "src/login.ts",
              line: null,
              endLine: null,
              narration: "n".repeat(700),
              grounded: true,
              evidence: [
                { sealantRunId: "run-one", sequence: 9007199254740993n, excerpt: "e".repeat(200) },
              ],
            },
          ],
        },
      ]);
    }).pipe(Effect.provide(TourComposer.layer.pipe(Layer.provide(h.layer))));
  });

  for (const answer of [
    { summary: "empty", approach: null, stops: [] },
    { summary: 1 },
    { ...tourAnswer(), approach: 7 },
  ]) {
    it.effect("refuses invalid or empty documents without writing a tour", () => {
      const h = makeHarness(() => Effect.succeed(answer));
      return Effect.gen(function* () {
        const failure = yield* compose(h.fixtures[0]?.change.id ?? CHANGE).pipe(Effect.flip);
        expect(failure._tag).toBe("InferenceError");
        expect(h.tourWrites).toEqual([]);
        expect(h.tours.size).toBe(0);
      }).pipe(Effect.provide(TourComposer.layer.pipe(Layer.provide(h.layer))));
    });
  }

  for (const absent of ["session", "record", "provider"]) {
    it.effect(`refuses a missing ${absent} without publishing`, () => {
      const f = fixtureFor();
      const h = makeHarness(
        () => Effect.fail(new InferenceError({ message: "provider refused", cause: null })),
        f,
      );
      if (absent === "session")
        h.fixtures[0] = { ...f, change: new Change({ ...f.change, sessionId: null }) };
      if (absent === "record")
        h.fixtures[0] = { ...f, session: new Session({ ...f.session, sealantRunId: null }) };
      return Effect.gen(function* () {
        expect((yield* compose(f.change.id).pipe(Effect.flip))._tag).toBe("InferenceError");
        expect(h.tourWrites).toEqual([]);
        expect(h.requests).toHaveLength(absent === "provider" ? 1 : 0);
      }).pipe(Effect.provide(TourComposer.layer.pipe(Layer.provide(h.layer))));
    });
  }

  it.effect("a successful tour becomes cached, and a changed diff recomposes", () => {
    const f = fixtureFor();
    const h = makeHarness(
      (request) =>
        Effect.gen(function* () {
          yield* callTool(request, "read_change");
          return {
            summary: "code reading",
            approach: null,
            stops: [
              { title: "Retry", file: "src/login.ts", narration: "Read the retry.", evidence: [] },
            ],
          };
        }),
      f,
    );
    return Effect.gen(function* () {
      expect(yield* compose(f.change.id)).toBe("composed");
      expect(yield* compose(f.change.id)).toBe("unchanged");
      h.state.diff = "a different diff";
      expect(yield* compose(f.change.id)).toBe("composed");
      expect(h.requests).toHaveLength(2);
      expect(h.tourWrites.map((row) => row.diffDigest)).toEqual([
        digest(DIFF),
        digest("a different diff"),
      ]);
      expect(h.tours.get(f.change.id)?.approach).toBeNull();
    }).pipe(Effect.provide(TourComposer.layer.pipe(Layer.provide(h.layer))));
  });

  it.effect("each job gets fresh evidence and anchor sets on the same service instance", () => {
    const first = fixtureFor("first"),
      second = fixtureFor("second");
    let calls = 0;
    const h = makeHarness(
      (request) =>
        Effect.gen(function* () {
          if (calls++ === 0) {
            yield* callTool(request, "read_change");
            yield* callTool(request, "read_recording");
          }
          return tourAnswer();
        }),
      first,
    );
    h.fixtures.push(second);
    return Effect.gen(function* () {
      const service = yield* TourComposer;
      yield* service.compose({ changeId: first.change.id });
      yield* service.compose({ changeId: second.change.id });
      expect(h.tourWrites[0]?.stops[0]).toMatchObject({
        grounded: true,
        file: "src/login.ts",
        evidence: [{ sealantRunId: "run-first", sequence: 3n, excerpt: "check exited 0" }],
      });
      expect(
        h.tourWrites[1]?.stops.every(
          (stop) => stop.file === null && stop.evidence.length === 0 && !stop.grounded,
        ),
      ).toBe(true);
      expect(h.tourWrites).toHaveLength(2);
      expect(h.tourWrites[1]?.sessionId).toBe(second.session.id);
    }).pipe(Effect.provide(TourComposer.layer.pipe(Layer.provide(h.layer))));
  });

  it.effect("different jobs read and retain only their own platform record", () => {
    const first = fixtureFor("first"),
      second = fixtureFor("second");
    const h = makeHarness(
      (request) =>
        Effect.gen(function* () {
          yield* callTool(request, "read_change");
          yield* callTool(request, "read_recording");
          const sequence = request.prompt.includes("session-first") ? "3" : "13";
          return {
            summary: "record-grounded",
            approach: null,
            stops: [
              {
                title: "Check",
                file: "src/login.ts",
                narration: "The check completed.",
                evidence: [{ sequence, excerpt: "check exited 0" }],
              },
            ],
          };
        }),
      first,
    );
    h.fixtures.push(second);
    h.state.eventsByRun.set("run-first", [exitedEvent(3n)]);
    h.state.eventsByRun.set("run-second", [exitedEvent(13n)]);
    return Effect.gen(function* () {
      const service = yield* TourComposer;
      yield* service.compose({ changeId: first.change.id });
      yield* service.compose({ changeId: second.change.id });
      expect(h.tourWrites.map((row) => row.stops[0]?.evidence)).toEqual([
        [{ sealantRunId: "run-first", sequence: 3n, excerpt: "check exited 0" }],
        [{ sealantRunId: "run-second", sequence: 13n, excerpt: "check exited 0" }],
      ]);
      expect(h.tourWrites.map((row) => row.stops[0]?.grounded)).toEqual([true, true]);
      expect(
        h.recordCalls.filter((call) => call.kind === "timeline").map((call) => call.runId),
      ).toEqual(["run-first", "run-second"]);
    }).pipe(Effect.provide(TourComposer.layer.pipe(Layer.provide(h.layer))));
  });

  it("generated cited subsets retain exactly the sequences actually delivered", async () => {
    const pool = ["1", "3", "9007199254740993"],
      candidates = [...pool, "99"];
    await FastCheck.assert(
      FastCheck.asyncProperty(
        FastCheck.subarray(pool),
        FastCheck.subarray(candidates),
        async (seen, cited) => {
          const f = fixtureFor();
          const h = makeHarness(
            (request) =>
              Effect.gen(function* () {
                for (const sequence of seen)
                  yield* callTool(request, "read_recording", {
                    fromSequence: sequence,
                    toSequence: sequence,
                  });
                return {
                  summary: "generated",
                  approach: null,
                  stops: [
                    {
                      title: "Observation",
                      file: null,
                      narration: "Read the record.",
                      evidence: cited.map((sequence) => ({ sequence, excerpt: "selected event" })),
                    },
                  ],
                };
              }),
            f,
          );
          h.state.events = pool.map((sequence) => exitedEvent(BigInt(sequence)));
          await Effect.runPromise(
            compose(f.change.id).pipe(
              Effect.provide(TourComposer.layer.pipe(Layer.provide(h.layer))),
            ),
          );
          const expected = cited.filter((sequence) => seen.includes(sequence));
          expect(
            h.tourWrites[0]?.stops[0]?.evidence.map((pointer) => pointer.sequence.toString()),
          ).toEqual(expected);
          expect(h.tourWrites[0]?.stops[0]?.grounded).toBe(expected.length > 0);
        },
      ),
      { seed: 2032026, numRuns: 30 },
    );
  });
});
