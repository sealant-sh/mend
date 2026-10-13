import { describe, expect, it } from "@effect/vitest";
import { BriefNotFoundError, BriefsRepo, RunNotFoundError, RunsRepo } from "@mend/db";
import {
  Brief,
  BriefDocument,
  BriefId,
  ChangeId,
  IssueId,
  RunId,
  type BriefVersion,
  type Run,
} from "@mend/domain";
import { Effect, Layer, Result, Schema } from "effect";

import { BriefCompiler, CompileBriefJob } from "./brief-compiler.ts";
import { publishBriefLayer } from "./live-tools.ts";
import {
  InferenceError,
  InferenceProvider,
  InferenceToolError,
  type InferenceRequest,
} from "./provider.ts";
import { IssueView, ReadBrief, ReadChange, ReadIssue, ReadRecording } from "./tools.ts";

const changeId = ChangeId.make("22222222-2222-2222-2222-222222222222");
const issueId = IssueId.make("33333333-3333-3333-3333-333333333333");
const runId = RunId.make("44444444-4444-4444-4444-444444444444");

const job = new CompileBriefJob({ issueId, changeId, runId });

/** A publish_brief input as the model would send it — sequences as strings. */
const wireDocument = {
  header: {
    repository: "acme/app",
    prRef: null,
    issueRef: "manual",
    checksCount: null,
    headSha: null,
    freshness: "current",
  },
  causalProof: {
    baseFails: null,
    headPasses: { runId, sequence: "42", excerpt: "exit 0" },
    revertFails: null,
  },
  issueRestated: "The total is off by one cent.",
  reproduction: null,
  whatWasDone: "Rounded once, after the discount.",
  statusNow: "The reported order reconciles on head.",
  monoFacts: "1 file · +4 / −1",
  questions: [
    {
      index: 1,
      question: "Does the reported reproduction pass?",
      disposition: "direct-evidence",
      evidence: [{ runId, sequence: "42", excerpt: "exit 0" }],
    },
  ],
  attention: [],
  evidenceUsed: [],
};

type Publication = { readonly changeId: ChangeId; readonly document: BriefDocument };

/** Recording repository for the compiler boundary; SQL version arithmetic is outside this test. */
const briefsMemoryLayer = (writes: Array<Publication>) =>
  Layer.sync(BriefsRepo, () => {
    const store = new Map<string, Brief>();
    return {
      byChange: (id: ChangeId) => {
        const brief = store.get(id);
        return brief === undefined
          ? Effect.fail(new BriefNotFoundError({ changeId: id }))
          : Effect.succeed(brief);
      },
      versions: () => Effect.succeed([] as ReadonlyArray<BriefVersion>),
      publish: (id: ChangeId, document: BriefDocument) =>
        Effect.sync(() => {
          writes.push({ changeId: id, document });
          const existing = store.get(id);
          const version = (existing?.currentVersion ?? 0) + 1;
          store.set(
            id,
            new Brief({
              id: existing?.id ?? BriefId.make(crypto.randomUUID()),
              changeId: id,
              currentVersion: version,
              document,
              createdAt: new Date(0),
              updatedAt: new Date(0),
            }),
          );
          return { version };
        }),
    };
  });

/** A RunsRepo with no runs — the compiler only lists recordings for the prompt. */
const runsEmptyLayer = Layer.succeed(RunsRepo, {
  create: () => Effect.die("not in this test"),
  byId: (id: RunId) => Effect.fail(new RunNotFoundError({ runId: id })),
  listForIssue: () => Effect.succeed([] as ReadonlyArray<Run>),
  listUnsettled: () => Effect.succeed([] as ReadonlyArray<Run>),
  setSealantIds: () => Effect.void,
  setStatus: () => Effect.void,
  linkChange: () => Effect.void,
  saveLastSeenSequence: () => Effect.void,
  settle: () => Effect.void,
  saveFailureBrief: () => Effect.void,
});

/** Tool services the compiler binds but these tests never exercise. */
const unusedToolLayers = Layer.mergeAll(
  Layer.succeed(ReadRecording, {
    read: () =>
      Effect.fail(new InferenceToolError({ tool: "read_recording", message: "not in this test" })),
  }),
  Layer.succeed(ReadIssue, {
    read: () => Effect.succeed(new IssueView({ title: "t", body: "b", comments: [], links: [] })),
  }),
  Layer.succeed(ReadChange, {
    read: () =>
      Effect.fail(new InferenceToolError({ tool: "read_change", message: "not in this test" })),
  }),
);

const readBriefLiveOnMemory = Layer.effect(
  ReadBrief,
  Effect.gen(function* () {
    const briefs = yield* BriefsRepo;
    return {
      read: (id: ChangeId) =>
        briefs
          .byChange(id)
          .pipe(
            Effect.mapError(
              () => new InferenceToolError({ tool: "read_brief", message: "no brief yet" }),
            ),
          ),
    };
  }),
);

/** A provider scripted to call the named tools in order, like the model would. */
const scriptedProviderLayer = (
  script: ReadonlyArray<{ name: string; input: unknown }>,
  results: Array<Result.Result<unknown, InferenceToolError>>,
) =>
  Layer.succeed(InferenceProvider, {
    respond: (request: InferenceRequest) =>
      Effect.gen(function* () {
        for (const call of script) {
          const tool = request.tools?.find((candidate) => candidate.name === call.name);
          if (tool === undefined) return yield* Effect.die(`Missing scripted tool: ${call.name}`);
          // A failed tool call comes back to the model as an error result — not a crash.
          results.push(yield* tool.handle(call.input).pipe(Effect.result));
        }
        return "done";
      }),
  });

const testLayer = (
  script: ReadonlyArray<{ name: string; input: unknown }>,
  writes: Array<Publication> = [],
  results: Array<Result.Result<unknown, InferenceToolError>> = [],
) =>
  BriefCompiler.layer.pipe(
    Layer.provideMerge(scriptedProviderLayer(script, results)),
    Layer.provideMerge(runsEmptyLayer),
    Layer.provideMerge(
      Layer.mergeAll(unusedToolLayers, readBriefLiveOnMemory, publishBriefLayer).pipe(
        Layer.provideMerge(briefsMemoryLayer(writes)),
      ),
    ),
  );

describe("BriefCompiler", () => {
  it.effect("succeeds when the loop publishes a valid document", () =>
    Effect.gen(function* () {
      const compiler = yield* BriefCompiler;
      const briefs = yield* BriefsRepo;

      yield* compiler.compile(job);

      const brief = yield* briefs.byChange(changeId);
      expect(brief.currentVersion).toBe(1);
      expect(brief.document.questions).toHaveLength(1);
      // The wire's decimal string decoded to a domain bigint.
      expect(brief.document.causalProof.headPasses?.sequence).toBe(42n);
    }).pipe(
      Effect.provide(
        testLayer([{ name: "publish_brief", input: { change: changeId, document: wireDocument } }]),
      ),
    ),
  );

  it.effect("fails into retry when the loop never publishes", () =>
    Effect.gen(function* () {
      const compiler = yield* BriefCompiler;
      const outcome = yield* compiler.compile(job).pipe(Effect.flip);
      expect(outcome).toBeInstanceOf(InferenceError);
      expect(outcome.message).toContain("without publishing");
    }).pipe(Effect.provide(testLayer([]))),
  );

  it.effect("refuses malformed publication at the tool boundary without a repository write", () => {
    const writes: Array<Publication> = [];
    const results: Array<Result.Result<unknown, InferenceToolError>> = [];
    return Effect.gen(function* () {
      const compiler = yield* BriefCompiler;
      const outcome = yield* compiler.compile(job).pipe(Effect.flip);
      expect(outcome).toMatchObject({
        _tag: "InferenceError",
        message: "the compile finished without publishing (version stayed at 0)",
      });
      expect(results).toHaveLength(1);
      const result = results[0];
      if (result === undefined || Result.isSuccess(result))
        throw new Error("Malformed publication must return a tool failure");
      expect(result.failure).toMatchObject({
        _tag: "InferenceToolError",
        tool: "publish_brief",
        message: expect.stringContaining("input did not match the schema:"),
      });
      expect(writes).toEqual([]);
      const absent = yield* (yield* BriefsRepo).byChange(changeId).pipe(Effect.flip);
      expect(absent).toEqual(new BriefNotFoundError({ changeId }));
    }).pipe(
      Effect.provide(
        testLayer(
          [{ name: "publish_brief", input: { change: changeId, document: { nonsense: true } } }],
          writes,
          results,
        ),
      ),
    );
  });

  it.effect("a recompile publishes distinct replacement content through the live tool", () => {
    const replacement = {
      ...wireDocument,
      whatWasDone: "Rounded each invoice at its currency boundary.",
      statusNow: "Both invoice cases have recorded results.",
      causalProof: {
        ...wireDocument.causalProof,
        headPasses: { runId, sequence: "84", excerpt: "second exit 0" },
      },
    };
    const script = [{ name: "publish_brief", input: { change: changeId, document: wireDocument } }];
    const writes: Array<Publication> = [];
    const results: Array<Result.Result<unknown, InferenceToolError>> = [];
    return Effect.gen(function* () {
      const compiler = yield* BriefCompiler;
      const briefs = yield* BriefsRepo;
      yield* compiler.compile(job);
      const first = yield* briefs.byChange(changeId);
      expect(first.document.whatWasDone).toBe("Rounded once, after the discount.");
      script[0] = { name: "publish_brief", input: { change: changeId, document: replacement } };
      yield* compiler.compile(job);
      const second = yield* briefs.byChange(changeId);
      expect(
        writes.map((write) => ({
          change: write.changeId,
          whatWasDone: write.document.whatWasDone,
          sequence: write.document.causalProof.headPasses?.sequence,
        })),
      ).toEqual([
        { change: changeId, whatWasDone: "Rounded once, after the discount.", sequence: 42n },
        {
          change: changeId,
          whatWasDone: "Rounded each invoice at its currency boundary.",
          sequence: 84n,
        },
      ]);
      expect(results).toHaveLength(2);
      expect(results.map((result) => (Result.isSuccess(result) ? result.success : null))).toEqual([
        { version: 1 },
        { version: 2 },
      ]);
      expect(second.document).toEqual(Schema.decodeUnknownSync(BriefDocument)(replacement));
      expect(second.document).not.toEqual(first.document);
    }).pipe(Effect.provide(testLayer(script, writes, results)));
  });
});

describe("the publish_brief wire codec", () => {
  it("decodes the encoded document the tool schema advertises", () => {
    const decoded = Schema.decodeUnknownSync(BriefDocument)(wireDocument);
    expect(decoded.footer).toEqual({ total: 1, directEvidence: 1, needJudgment: 0 });
    const encoded = Schema.encodeSync(BriefDocument)(decoded);
    expect(encoded.causalProof.headPasses?.sequence).toBe("42");
  });
});
