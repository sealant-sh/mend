import { createHash } from "node:crypto";

import {
  BudgetExceeded,
  ConversationImported,
  ConversationImportLookup,
  ConversationImportRefused,
  NotFound,
  StoreFailure,
} from "@mend/api-contracts";
import {
  AgentConversationRepo,
  AuditEventsRepo,
  ImportedConversationsRepo,
  RemovalFencesRepo,
  SessionProcessesRepo,
  SessionsRepo,
  type SignIn,
  WorktreesRepo,
  type BackfillTurnInput,
} from "@mend/db";
import type { ProjectId, SessionId, WorktreeId } from "@mend/domain";
import {
  type ConversationArchiveEntry,
  type ConversationArchiveHeader,
  decodeConversationArchive,
  type ImportedHarness,
  isAgentProcessKind,
  isConversationTranscript,
  isImportedConversationPath,
  isTextConversationFile,
  type Project,
} from "@mend/domain/workbench";
import { backfillFromNative, SessionEngine } from "@mend/sessions";
import { Deferred, Effect, Layer, Result } from "effect";
import * as Context from "effect/Context";

import { ProjectAccess } from "./access.ts";
import { budgetMessage, Budgets } from "./budgets.ts";
import { refuseStartWhileRemoving } from "./removal.ts";
import { budgetExceeded, requireSessionRoom } from "./session-budgets.ts";

/** Where the conversation lands, as the request's query names it: exactly one of the two. */
export interface ConversationImportQueryInput {
  readonly session?: SessionId;
  readonly worktree?: WorktreeId;
}

type ConversationImportTarget =
  | { readonly _tag: "Session"; readonly session: SessionId }
  | { readonly _tag: "Worktree"; readonly worktree: WorktreeId };

const targetOf = (query: ConversationImportQueryInput): ConversationImportTarget | null =>
  query.session !== undefined && query.worktree === undefined
    ? { _tag: "Session", session: query.session }
    : query.worktree !== undefined && query.session === undefined
      ? { _tag: "Worktree", worktree: query.worktree }
      : null;

type ImportError = NotFound | ConversationImportRefused | BudgetExceeded | StoreFailure;

const refused = (reason: ConversationImportRefused["reason"], message: string) =>
  new ConversationImportRefused({
    reason,
    message: `${message} · nothing was imported`,
  });

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

type JsonObject = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const objectOf = (value: unknown): JsonObject | null => (isObject(value) ? value : null);

/** Each record of a JSONL file, or the 1-based line that is not a JSON object. */
const recordsOf = (text: string): Result.Result<ReadonlyArray<JsonObject>, number> => {
  if (text === "") return Result.succeed([]);
  if (!text.endsWith("\n")) return Result.fail(text.split("\n").length);
  const records: Array<JsonObject> = [];
  const lines = text.slice(0, -1).split("\n");
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return Result.fail(index + 1);
    }
    const record = objectOf(parsed);
    if (record === null) return Result.fail(index + 1);
    records.push(record);
  }
  return Result.succeed(records);
};

export interface CheckedConversation {
  readonly header: ConversationArchiveHeader;
  readonly entries: ReadonlyArray<ConversationArchiveEntry>;
  /** The transcript's text, for the history the session shows. */
  readonly transcript: string;
  readonly byteLength: number;
}

/**
 * Everything the server checks of a conversation before it keeps a byte of it, as a refusal a
 * person can act on: the archive is whole, every path is one of the harness's conversation files
 * and appears once, each file matches its digest, text is UTF-8 and JSON where it should be, the
 * transcript is the conversation's own, and its paths are ones the rewrite at launch can move
 * (one Claude project folder; every Codex ancestor among the files). Pure.
 */
export const checkConversation = (
  body: Uint8Array,
): Result.Result<CheckedConversation, ConversationImportRefused> => {
  const decoded = decodeConversationArchive(body);
  if (Result.isFailure(decoded))
    return Result.fail(
      refused("damaged", `this is not a conversation archive: ${decoded.failure}`),
    );
  const { header, entries } = decoded.success;
  const { harness, nativeId } = header;
  const seen = new Set<string>();
  for (const file of header.files) {
    if (seen.has(file.relativePath))
      return Result.fail(refused("path-duplicated", `${file.relativePath} is listed twice`));
    seen.add(file.relativePath);
    if (!isImportedConversationPath(harness, file.relativePath))
      return Result.fail(
        refused(
          "path-not-allowed",
          `${file.relativePath} is not a file of a ${harness} conversation Mend takes · leave it out`,
        ),
      );
  }
  const texts = new Map<string, string>();
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  for (const [index, entry] of entries.entries()) {
    const file = header.files[index];
    if (file === undefined || sha256(entry.bytes) !== file.sha256)
      return Result.fail(refused("damaged", `${entry.relativePath} differs from its digest`));
    if (!isTextConversationFile(entry.relativePath)) continue;
    let text: string;
    try {
      text = utf8.decode(entry.bytes);
    } catch {
      return Result.fail(refused("transcript-invalid", `${entry.relativePath} is not UTF-8 text`));
    }
    if (entry.relativePath.endsWith(".jsonl")) {
      const records = recordsOf(text);
      if (Result.isFailure(records))
        return Result.fail(
          refused(
            "transcript-invalid",
            `${entry.relativePath} line ${records.failure} is not a whole JSON record`,
          ),
        );
    } else if (entry.relativePath.endsWith(".json")) {
      try {
        JSON.parse(text);
      } catch {
        return Result.fail(refused("transcript-invalid", `${entry.relativePath} is not JSON`));
      }
    }
    texts.set(entry.relativePath, text);
  }
  const transcripts = header.files.filter((file) =>
    isConversationTranscript(harness, nativeId, file.relativePath),
  );
  const transcriptFile = transcripts[0];
  if (transcripts.length !== 1 || transcriptFile === undefined)
    return Result.fail(
      refused(
        "transcript-missing",
        transcripts.length === 0
          ? `no ${harness} transcript of conversation ${nativeId} is among the files`
          : `${transcripts.length} ${harness} transcripts of conversation ${nativeId} are among the files`,
      ),
    );
  const transcript = texts.get(transcriptFile.relativePath) ?? "";
  const records = Result.getOrElse(recordsOf(transcript), () => []);
  if (harness === "claude") {
    const ids = new Set(
      records.flatMap((record) =>
        typeof record["sessionId"] === "string" ? [record["sessionId"]] : [],
      ),
    );
    if (ids.size !== 1 || !ids.has(nativeId))
      return Result.fail(
        refused(
          "transcript-invalid",
          `${transcriptFile.relativePath} is not the transcript of Claude conversation ${nativeId}`,
        ),
      );
    const folders = new Set(
      header.files.flatMap((file) => {
        const parts = file.relativePath.split("/");
        return parts[1] === "projects" ? [parts[2] ?? ""] : [];
      }),
    );
    if (folders.size !== 1)
      return Result.fail(
        refused("not-rewritable", "the files come from more than one Claude project folder"),
      );
  } else {
    for (const file of header.files) {
      if (!file.relativePath.endsWith(".jsonl")) continue;
      const head = Result.getOrElse(recordsOf(texts.get(file.relativePath) ?? ""), () => [])[0];
      const payload = objectOf(head?.["payload"]);
      const id = payload?.["id"];
      if (
        head?.["type"] !== "session_meta" ||
        typeof id !== "string" ||
        !file.relativePath.endsWith(`-${id}.jsonl`)
      )
        return Result.fail(
          refused(
            "transcript-invalid",
            `${file.relativePath} does not open with the Codex session it is named for`,
          ),
        );
      const ancestor = objectOf(payload?.["history_base"])?.["thread_id"];
      if (
        typeof ancestor === "string" &&
        !header.files.some((candidate) => candidate.relativePath.endsWith(`-${ancestor}.jsonl`))
      )
        return Result.fail(
          refused(
            "not-rewritable",
            `Codex conversation ${id} continues ${ancestor}, whose rollout is not among the files`,
          ),
        );
    }
  }
  return Result.succeed({
    header,
    entries,
    transcript,
    byteLength: header.files.reduce((total, file) => total + file.byteLength, 0),
  });
};

/** The history the session shows before any launch: the transcript's turns, as a mode switch's. */
export const importedTurnsOf = (
  harness: ImportedHarness,
  nativeId: string,
  transcript: string,
): ReadonlyArray<BackfillTurnInput> =>
  backfillFromNative(harness, nativeId, transcript, null)?.turns ?? [];

export class ConversationImport extends Context.Service<
  ConversationImport,
  {
    readonly lookupAs: (
      caller: SignIn,
      projectId: ProjectId,
      query: { readonly harness: ImportedHarness; readonly nativeId: string },
    ) => Effect.Effect<ConversationImportLookup, NotFound>;
    readonly importAs: (
      caller: SignIn,
      projectId: ProjectId,
      query: ConversationImportQueryInput,
      body: Uint8Array,
    ) => Effect.Effect<ConversationImported, ImportError>;
  }
>()("@mend/api/ConversationImport") {}

export const makeConversationImport = Effect.gen(function* () {
  const access = yield* ProjectAccess;
  const engine = yield* SessionEngine;
  const budgets = yield* Budgets;
  const sessions = yield* SessionsRepo;
  const worktrees = yield* WorktreesRepo;
  const processes = yield* SessionProcessesRepo;
  const conversations = yield* AgentConversationRepo;
  const imports = yield* ImportedConversationsRepo;
  const audit = yield* AuditEventsRepo;
  const removalFences = yield* RemovalFencesRepo;
  const inFlight = new Map<string, Deferred.Deferred<ConversationImported, ImportError>>();

  const sessionOrNull = (id: SessionId) =>
    sessions.byId(id).pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));

  const lookupAs = Effect.fn("ConversationImport.lookupAs")(function* (
    caller: SignIn,
    projectId: ProjectId,
    query: { readonly harness: ImportedHarness; readonly nativeId: string },
  ) {
    const project = yield* access.projectAs(caller, projectId);
    const earlier = yield* imports.sessionOf({
      ownerUserId: caller.userId,
      projectId: project.id,
      harness: query.harness,
      nativeId: query.nativeId,
    });
    return new ConversationImportLookup({
      session: earlier === null ? null : yield* sessionOrNull(earlier),
    });
  });

  /** An earlier import's answer: the session it made, as it stands now. */
  const replayOf = (sessionId: SessionId, project: Project) =>
    Effect.gen(function* () {
      const session = yield* sessionOrNull(sessionId);
      if (session === null) return yield* new NotFound({ id: project.id });
      const turns = (yield* conversations.listTurns(sessionId)).filter((turn) => turn.imported);
      return new ConversationImported({
        session,
        replayed: true,
        turns: turns.length,
      });
    });

  /** The un-launched session the caller owns in this project, refused in words otherwise. */
  const existingTarget = Effect.fn("ConversationImport.existingTarget")(function* (
    project: Project,
    sessionId: SessionId,
    userId: string,
    harness: ImportedHarness,
  ) {
    const session = yield* sessionOrNull(sessionId);
    // Another person's session is not named to the caller, as access answers elsewhere.
    if (session === null || session.ownerUserId !== userId)
      return yield* new NotFound({ id: sessionId });
    if (session.projectId !== project.id)
      return yield* refused("wrong-target", `session ${sessionId} is not in project ${project.id}`);
    if (session.harness !== harness)
      return yield* refused(
        "harness-mismatch",
        `session ${sessionId} runs ${session.harness}, and this is a ${harness} conversation · import it into a ${harness} session`,
      );
    const launched =
      session.sealantRunId !== null ||
      (yield* processes.listForSession(sessionId)).some((process) =>
        isAgentProcessKind(process.kind),
      ) ||
      (yield* conversations.listTurns(sessionId)).some((turn) => !turn.imported);
    if (launched)
      return yield* refused(
        "session-launched",
        `an agent already started in session ${sessionId}, and its conversation is its own · import into a new session in its worktree`,
      );
    return session;
  });

  /** A new session of the caller's in the worktree, which must be this project's. */
  const newTarget = Effect.fn("ConversationImport.newTarget")(function* (
    project: Project,
    worktreeId: WorktreeId,
    userId: string,
    header: ConversationArchiveHeader,
  ) {
    const worktree = yield* worktrees
      .byId(worktreeId)
      .pipe(
        Effect.catchTag("WorktreeNotFoundError", () =>
          Effect.fail(new NotFound({ id: worktreeId })),
        ),
      );
    if (worktree.projectId !== project.id)
      return yield* refused(
        "wrong-target",
        `worktree ${worktreeId} is not in project ${project.id}`,
      );
    yield* refuseStartWhileRemoving({ projectId: project.id, worktreeId }).pipe(
      Effect.provideService(RemovalFencesRepo, removalFences),
    );
    yield* requireSessionRoom(userId, project.organizationId).pipe(
      Effect.provideService(Budgets, budgets),
      Effect.provideService(SessionsRepo, sessions),
    );
    return yield* engine
      .provisionSessionIn(worktreeId, {
        harness: header.harness,
        label: header.title ?? null,
        ownerUserId: userId,
        origin: "mend",
      })
      .pipe(
        Effect.catchTags({
          WorktreeNotFoundError: () => Effect.fail(new NotFound({ id: worktreeId })),
          ProjectNotFoundError: () => Effect.fail(new NotFound({ id: project.id })),
          GitError: (error) => Effect.fail(new StoreFailure({ message: error.stderr })),
        }),
      );
  });

  const land = Effect.fn("ConversationImport.land")(function* (
    project: Project,
    userId: string,
    target: ConversationImportTarget,
    checked: CheckedConversation,
  ) {
    const { header } = checked;
    const earlier = yield* imports.sessionOf({
      ownerUserId: userId,
      projectId: project.id,
      harness: header.harness,
      nativeId: header.nativeId,
    });
    if (earlier !== null) return yield* replayOf(earlier, project);
    const session =
      target._tag === "Session"
        ? yield* existingTarget(project, target.session, userId, header.harness)
        : yield* newTarget(project, target.worktree, userId, header);
    const turns = importedTurnsOf(header.harness, header.nativeId, checked.transcript);
    const saved = yield* imports.save(
      {
        sessionId: session.id,
        projectId: project.id,
        ownerUserId: userId,
        harness: header.harness,
        nativeId: header.nativeId,
        source: header.source,
        files: header.files,
        byteLength: checked.byteLength,
        permissionMode: header.permissionMode ?? null,
      },
      checked.entries,
      turns,
    );
    if (saved._tag === "AlreadyImported") return yield* replayOf(saved.sessionId, project);
    if (saved._tag === "SessionTaken")
      return yield* refused(
        "session-holds-another",
        `session ${session.id} already holds another imported conversation · import into a new session in its worktree`,
      );
    if (target._tag === "Session" && header.title != null)
      yield* sessions.setLabel(session.id, header.title);
    if (header.model != null || header.effort != null)
      yield* sessions.setLaunchOptions(session.id, {
        model: header.model ?? null,
        effort: header.effort ?? null,
      });
    // The event says an import happened and how much arrived; never a path or a byte of it.
    yield* audit.record({
      organizationId: project.organizationId,
      actorUserId: userId,
      action: "session.conversation_imported",
      subjectType: "session",
      subjectId: session.id,
      data: {
        projectId: project.id,
        harness: header.harness,
        files: header.files.length,
        bytes: checked.byteLength,
        turns: saved.turns,
      },
    });
    return new ConversationImported({
      session: (yield* sessionOrNull(session.id)) ?? session,
      replayed: false,
      turns: saved.turns,
    });
  });

  const importAs = Effect.fn("ConversationImport.importAs")(function* (
    caller: SignIn,
    projectId: ProjectId,
    query: ConversationImportQueryInput,
    body: Uint8Array,
  ) {
    const userId = caller.userId;
    const project = yield* access.projectAs(caller, projectId);
    const target = targetOf(query);
    if (target === null)
      return yield* refused(
        "wrong-target",
        "name the session (?session=) or the worktree (?worktree=) the conversation lands in, not both",
      );
    const limit = budgets.limits.conversationBytes;
    if (limit > 0 && body.byteLength > limit)
      return yield* new BudgetExceeded({
        budget: "conversationBytes",
        limit,
        retryAfterSeconds: null,
        message: `this conversation is ${body.byteLength} bytes, over the ${budgetMessage("conversationBytes", limit)} · nothing was imported`,
      });
    const checked = yield* Effect.fromResult(checkConversation(body));
    // One import of a native conversation per person and project at a time: the database keys
    // on the same, and this join answers the second request with the first one's session.
    const key = `${userId}:${project.id}:${checked.header.harness}:${checked.header.nativeId}`;
    const joined = inFlight.get(key);
    if (joined !== undefined) {
      const first = yield* Deferred.await(joined);
      return new ConversationImported({ ...first, replayed: true });
    }
    const deferred = Deferred.makeUnsafe<ConversationImported, ImportError>();
    inFlight.set(key, deferred);
    yield* engine.detach(
      budgets.withHandoffSlot(userId, land(project, userId, target, checked)).pipe(
        Effect.flatMap((landed) =>
          landed === null
            ? budgetExceeded("accountHandoffsInFlight", budgets.limits)
            : Effect.succeed(landed),
        ),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            inFlight.delete(key);
            Deferred.doneUnsafe(deferred, exit);
          }),
        ),
      ),
    );
    return yield* Deferred.await(deferred);
  });

  return { lookupAs, importAs };
});

export const ConversationImportLive: Layer.Layer<
  ConversationImport,
  never,
  | AgentConversationRepo
  | AuditEventsRepo
  | Budgets
  | RemovalFencesRepo
  | ImportedConversationsRepo
  | ProjectAccess
  | SessionEngine
  | SessionProcessesRepo
  | SessionsRepo
  | WorktreesRepo
> = Layer.effect(ConversationImport, makeConversationImport);
