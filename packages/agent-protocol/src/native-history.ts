import { createHash } from "node:crypto";

import {
  NativeFileRef,
  NativeHistorySeed,
  NativeSeedId,
  type NativeHistoryObservation,
} from "@mend/domain/workbench";
import { Effect, Schema } from "effect";

/** A provider file cannot prove the selected native response. No approximate cutoff is used. */
export class NativeHistoryError extends Schema.TaggedError<NativeHistoryError>()(
  "NativeHistoryError",
  { message: Schema.String },
) {}

/** Private provider bytes. Callers supply only files from the authorized conversation home. */
export interface NativeHistoryFile {
  readonly relativePath: string;
  readonly content: string;
}

type JsonObject = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const object = (value: unknown): JsonObject | null => (isObject(value) ? value : null);
const field = (value: unknown, key: string): unknown => object(value)?.[key];
const digest = (content: string): string => createHash("sha256").update(content).digest("hex");
const refuse = (message: string): never => {
  throw new NativeHistoryError({ message });
};

const auxiliaryTools = {
  claude: new Set(["Task", "Agent", "TaskOutput", "TaskStop", "ListAgents", "SendMessage"]),
  codex: new Set(["spawn_agent", "send_input", "resume_agent", "close_agent"]),
};
/** Native subagents need a separate identity and state contract. */
const usesAuxiliaryState = (value: unknown, provider: "claude" | "codex"): boolean => {
  if (Array.isArray(value)) return value.some((entry) => usesAuxiliaryState(entry, provider));
  if (!isObject(value)) return false;
  const name = value["name"];
  if (
    typeof name === "string" &&
    auxiliaryTools[provider].has(name) &&
    (provider === "codex" || value["type"] === "tool_use")
  )
    return true;
  const type = value["type"];
  if (provider === "codex" && typeof type === "string" && type.startsWith("collab_agent_"))
    return true;
  return Object.values(value).some((entry) => usesAuxiliaryState(entry, provider));
};

/** Only known conversation files may close a native reference, never an arbitrary home path. */
const validFilePath = (relativePath: string): boolean =>
  Schema.is(NativeFileRef)({ relativePath, sha256: "0".repeat(64), byteLength: 0 });

const stringsOf = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  return isObject(value) ? Object.values(value).flatMap(stringsOf) : [];
};

const usesTool = (value: unknown, name: string): boolean => {
  if (Array.isArray(value)) return value.some((entry) => usesTool(entry, name));
  return (
    isObject(value) &&
    ((value["type"] === "tool_use" && value["name"] === name) ||
      Object.values(value).some((entry) => usesTool(entry, name)))
  );
};

const claudeState = (values: ReadonlyArray<JsonObject>): ReadonlyArray<JsonObject> =>
  values.flatMap<JsonObject>((value) => {
    if (value["type"] === "assistant" || value["type"] === "user")
      return [
        {
          message: value["message"],
          toolUseResult: value["toolUseResult"],
          taskListId: value["taskListId"],
        },
      ];
    const attachment = object(value["attachment"]);
    return value["type"] === "attachment" &&
      typeof attachment?.["type"] === "string" &&
      attachment["type"].startsWith("plan_")
      ? [{ attachment }]
      : [];
  });

interface ClaudeReference {
  readonly path: string;
  readonly relativePath: string;
}
const claudeReferences = (values: ReadonlyArray<unknown>): ReadonlyArray<ClaudeReference> =>
  values.flatMap(stringsOf).flatMap((text) =>
    [
      ...text.matchAll(
        /(?:\/[^\s"'<>`]*|~\/)?\.claude\/(?:plans|tasks|todos|projects)\/[^\s"'<>`]+/g,
      ),
    ].flatMap(([at]) => {
      const relativePath = at.slice(at.indexOf(".claude/"));
      if (
        !relativePath.startsWith(".claude/plans/") &&
        !relativePath.startsWith(".claude/tasks/") &&
        !relativePath.startsWith(".claude/todos/") &&
        !relativePath.includes("/tool-results/")
      )
        return [];
      if (!validFilePath(relativePath))
        return refuse("Claude references an unsupported auxiliary conversation path.");
      return [{ path: at, relativePath }];
    }),
  );

/** Native 2.1.318 restores inline todos, copies Plan by slug, and keys task files by session. */
const claudeClosure = (
  values: ReadonlyArray<JsonObject>,
  sessionId: string,
  paths: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (
    claudeState(values).some((value) =>
      stringsOf(value).some((text) => text.includes("/subagents/")),
    )
  )
    return refuse("Claude subagent closure is not supported.");
  const refs = claudeReferences(claudeState(values));
  if (
    refs.some(
      (ref) =>
        ref.relativePath.startsWith(".claude/tasks/") &&
        !ref.relativePath.startsWith(`.claude/tasks/${sessionId}/`),
    )
  )
    return refuse("Claude references another native task list.");
  const required = new Set(refs.map((ref) => ref.relativePath));
  const todo = `.claude/todos/${sessionId}-agent-${sessionId}.json`;
  if (paths.includes(todo) && values.some((value) => usesTool(value, "TodoWrite")))
    required.add(todo);
  const watermark = `.claude/tasks/${sessionId}/.highwatermark`;
  if (
    paths.includes(watermark) &&
    values.some((value) =>
      ["TaskCreate", "TaskUpdate", "TaskGet", "TaskList"].some((name) => usesTool(value, name)),
    )
  )
    required.add(watermark);
  const taskIds = new Set<string>();
  let deletedTaskId = 0;
  const creations = values.flatMap((value) => {
    const blocks = field(value["message"], "content");
    return Array.isArray(blocks)
      ? blocks.filter(
          (block) => field(block, "type") === "tool_use" && field(block, "name") === "TaskCreate",
        )
      : [];
  });
  for (const creation of creations) {
    if (
      !values.some((value) => {
        const blocks = field(value["message"], "content");
        return (
          Array.isArray(blocks) &&
          blocks.some(
            (block) =>
              field(block, "type") === "tool_result" &&
              field(block, "tool_use_id") === field(creation, "id"),
          )
        );
      })
    )
      return refuse("Claude task creation has no persisted result.");
  }
  for (const value of values) {
    const result = object(value["toolUseResult"]);
    const taskId = field(result?.["task"], "id");
    if (typeof taskId === "string") taskIds.add(taskId);
    if (Array.isArray(result?.["tasks"])) {
      for (const task of result["tasks"]) {
        const id = field(task, "id");
        if (typeof id !== "string")
          return refuse("Claude task list contains an unsupported identity.");
        taskIds.add(id);
      }
    }
    const updatedId = result?.["taskId"];
    if (typeof updatedId === "string" && result?.["success"] === true) taskIds.add(updatedId);
    const deleted = result?.["statusChange"];
    if (field(deleted, "to") === "deleted" && typeof result?.["taskId"] === "string") {
      taskIds.delete(result["taskId"]);
      deletedTaskId = Math.max(deletedTaskId, Number(result["taskId"]));
    }
    // planExists:false records a native plan allocation, not a file that existed yet.
    const attachment = object(value["attachment"]);
    if (attachment?.["planExists"] === false && typeof attachment["planFilePath"] === "string") {
      const ref = claudeReferences([attachment["planFilePath"]])[0];
      if (
        ref !== undefined &&
        !paths.includes(ref.relativePath) &&
        !values.some((entry) => {
          const observed = object(entry["toolUseResult"]);
          return (
            (observed?.["filePath"] === ref.path &&
              (typeof observed["plan"] === "string" ||
                typeof observed["content"] === "string" ||
                typeof observed["newString"] === "string")) ||
            field(observed?.["file"], "filePath") === ref.path
          );
        })
      )
        required.delete(ref.relativePath);
    }
    const listId = value["taskListId"];
    if (listId !== undefined && listId !== sessionId)
      return refuse("Claude uses a shared native task list whose ownership is not retained.");
  }
  for (const id of taskIds) required.add(`.claude/tasks/${sessionId}/${id}.json`);
  if (deletedTaskId > Math.max(0, ...[...taskIds].map(Number))) required.add(watermark);
  for (const text of claudeState(values).flatMap(stringsOf)) {
    const persisted = [...text.matchAll(/<persisted-output>([\s\S]*?)<\/persisted-output>/g)];
    if (
      (text.match(/<persisted-output>/g)?.length ?? 0) !== persisted.length ||
      persisted.some(
        (match) =>
          !claudeReferences([match[1]]).some((ref) => ref.relativePath.includes("/tool-results/")),
      )
    )
      return refuse("Claude persisted output has no supported saved file reference.");
  }
  for (const at of required) {
    if (!validFilePath(at) || paths.filter((path) => path === at).length !== 1)
      return refuse(
        "Claude auxiliary history is missing or ambiguous in the selected saved state.",
      );
  }
  return [...required];
};

interface Line {
  readonly value: JsonObject;
  readonly endByte: number;
  readonly endChar: number;
}
const linesOf = (content: string): ReadonlyArray<Line> => {
  if (!content.endsWith("\n")) return refuse("Native history ends with an incomplete record.");
  let endChar = 0;
  let endByte = 0;
  return content
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      endChar += line.length + 1;
      endByte += Buffer.byteLength(line) + 1;
      const parsed: unknown = JSON.parse(line);
      const value = object(parsed);
      if (value === null) return refuse("Native history contains a non-object record.");
      return { value, endByte, endChar };
    });
};
const fileRef = (file: NativeHistoryFile): NativeFileRef =>
  Schema.decodeUnknownSync(NativeFileRef)({
    relativePath: file.relativePath,
    byteLength: Buffer.byteLength(file.content),
    sha256: digest(file.content),
  });

/** Exact raw recovery closure for one native identity, including a fuller terminal transcript. */
export const nativeHistoryPaths = (input: {
  readonly provider: "claude" | "codex";
  readonly sessionId: string;
  readonly paths: ReadonlyArray<string>;
  readonly allowUnwritten: boolean;
  readonly read: (relativePath: string) => Effect.Effect<string, NativeHistoryError>;
}): Effect.Effect<
  {
    readonly nativePaths: ReadonlyArray<string>;
    readonly nativeRefs: ReadonlyArray<NativeFileRef>;
  },
  NativeHistoryError
> =>
  Effect.gen(function* () {
    const paths = input.paths.filter(validFilePath);
    const retained = new Set<string>();
    const refs: NativeFileRef[] = [];
    const pending: Array<{
      readonly id: string;
      readonly boundary?: { readonly bytes: number; readonly ordinal: number };
    }> = [{ id: input.sessionId }];
    while (pending.length > 0) {
      const next = pending.pop();
      if (next === undefined) break;
      const { id, boundary } = next;
      const candidates = paths.filter((at) =>
        input.provider === "claude"
          ? at.startsWith(".claude/projects/") && at.endsWith(`/${id}.jsonl`)
          : at.startsWith(".codex/") && at.endsWith(`-${id}.jsonl`),
      );
      const at = candidates[0];
      if (candidates.length === 0 && input.allowUnwritten && id === input.sessionId) {
        return {
          nativeRefs: [],
          nativePaths: paths.filter(
            (path) =>
              path.startsWith(`.claude/tasks/${id}/`) ||
              path === `.claude/todos/${id}-agent-${id}.json` ||
              path.startsWith(`.claude/plans/${id}-`) ||
              path.includes(`/${id}/tool-results/`),
          ),
        };
      }
      if (candidates.length !== 1 || at === undefined || retained.has(at))
        return yield* new NativeHistoryError({
          message:
            "The bound native history is missing, ambiguous or cyclic. Recovery is required.",
        });
      const content = yield* input.read(at);
      const additional = yield* Effect.try({
        try: () => {
          const records = linesOf(content);
          const end =
            boundary === undefined
              ? undefined
              : records.find((line) => line.endByte === boundary.bytes);
          if (
            boundary !== undefined &&
            (end === undefined || field(end.value, "ordinal") !== boundary.ordinal - 1)
          )
            return refuse("Codex ancestor byte and ordinal boundaries disagree.");
          const retainedContent = end === undefined ? content : content.slice(0, end.endChar);
          refs.push(fileRef({ relativePath: at, content: retainedContent }));
          const values = (
            end === undefined ? records : records.filter((line) => line.endChar <= end.endChar)
          ).map((line) => line.value);
          if (values.some((value) => usesAuxiliaryState(value, input.provider)))
            return refuse("This native history uses unsupported auxiliary agent state.");
          if (input.provider === "claude") {
            if (
              values.some((value) => value["sessionId"] !== undefined && value["sessionId"] !== id)
            )
              return refuse("The bound Claude transcript has a different native identity.");
            return { paths: claudeClosure(values, id, paths), ancestor: null };
          }
          const meta = values[0];
          if (meta?.["type"] !== "session_meta" || field(meta["payload"], "id") !== id)
            return refuse("The bound Codex transcript has a different native identity.");
          const base = field(meta["payload"], "history_base");
          if (base == null) return { paths: [], ancestor: null };
          const ancestor = field(base, "thread_id");
          const bytes = field(base, "end_byte_offset");
          const ordinal = field(base, "end_ordinal_exclusive");
          if (
            field(meta["payload"], "history_mode") !== "paginated" ||
            typeof ancestor !== "string" ||
            typeof bytes !== "number" ||
            !Number.isSafeInteger(bytes) ||
            bytes <= 0 ||
            typeof ordinal !== "number" ||
            !Number.isSafeInteger(ordinal) ||
            ordinal <= 0
          )
            return refuse("Codex history has an unsupported ancestor boundary.");
          return { paths: [], ancestor: { id: ancestor, boundary: { bytes, ordinal } } };
        },
        catch: (cause) =>
          cause instanceof NativeHistoryError
            ? cause
            : new NativeHistoryError({ message: "The bound native history could not be decoded." }),
      });
      retained.add(at);
      for (const path of additional.paths) retained.add(path);
      if (additional.ancestor !== null) pending.push(additional.ancestor);
    }
    return { nativePaths: [...retained].toSorted(), nativeRefs: refs };
  });

/**
 * Seal a native response and its immutable ancestor closure. This module alone knows provider
 * layout, history_base byte/ordinal cutoffs and persisted assistant UUIDs. It never edits source
 * bytes, copies configuration or uses timestamps to infer a boundary.
 */
export const sealNativeHistory = (input: {
  readonly observation: NativeHistoryObservation;
  readonly files: ReadonlyArray<NativeHistoryFile>;
}): Effect.Effect<
  {
    readonly manifest: NativeHistorySeed;
    readonly files: ReadonlyArray<NativeHistoryFile>;
  },
  NativeHistoryError
> =>
  Effect.try({
    try: () => {
      const { cutoff, providerVersion } = input.observation;
      const candidates = input.files.filter((file) => {
        const valid = Schema.is(NativeFileRef)({
          relativePath: file.relativePath,
          sha256: "0".repeat(64),
          byteLength: 0,
        });
        return (
          valid &&
          (cutoff.provider === "claude"
            ? file.relativePath.endsWith(`/${cutoff.sessionId}.jsonl`) &&
              file.relativePath.startsWith(".claude/projects/")
            : file.relativePath.endsWith(`-${cutoff.threadId}.jsonl`) &&
              file.relativePath.startsWith(".codex/"))
        );
      });
      if (candidates.length !== 1)
        return refuse("Exactly one native conversation file must match the selected identity.");
      const source = candidates[0];
      if (source === undefined) return refuse("The native conversation file is missing.");
      const records = linesOf(source.content);
      const retained: NativeHistoryFile[] = [];
      if (cutoff.provider === "claude") {
        const selected = records.filter(
          ({ value }) =>
            value["type"] === "assistant" &&
            value["uuid"] === cutoff.throughMessageId &&
            value["isSidechain"] !== true,
        );
        if (selected.length !== 1)
          return refuse("The exact root assistant message is missing or ambiguous.");
        const end = selected[0];
        if (
          end === undefined ||
          end.value["sessionId"] !== cutoff.sessionId ||
          end.value["version"] !== providerVersion
        )
          return refuse(
            "Claude transcript identity or version differs from the observed response.",
          );
        const prefix = records.filter((line) => line.endChar <= end.endChar);
        const byId = new Map<string, JsonObject>();
        for (const { value } of prefix) {
          const uuid = value["uuid"];
          if (typeof uuid === "string") {
            if (byId.has(uuid))
              return refuse("Claude history contains an ambiguous message identity.");
            byId.set(uuid, value);
          }
        }
        let current: JsonObject | undefined = end.value;
        const visited = new Set<string>();
        while (current !== undefined) {
          const uuid = current["uuid"];
          if (typeof uuid !== "string" || visited.has(uuid))
            return refuse("Claude history contains an invalid parent chain.");
          visited.add(uuid);
          const parent = current["parentUuid"];
          if (parent === null) break;
          if (typeof parent !== "string" || !byId.has(parent))
            return refuse("Claude history is missing a retained parent message.");
          current = byId.get(parent);
        }
        if (
          claudeState(prefix.map((line) => line.value)).some((value) =>
            usesAuxiliaryState(value, "claude"),
          )
        )
          return refuse(
            "This Claude history uses auxiliary native state whose complete closure is not supported.",
          );
        const content = source.content.slice(0, end.endChar);
        const auxiliary = claudeClosure(
          prefix.map((line) => line.value),
          cutoff.sessionId,
          input.files.map((file) => file.relativePath),
        );
        if (auxiliary.length > 0 && providerVersion !== "2.1.318")
          return refuse("This Claude auxiliary history version has not been verified.");
        for (const at of auxiliary) {
          const file = input.files.find((candidate) => candidate.relativePath === at);
          if (file !== undefined) {
            if (/\.claude\/tasks\/[^/]+\/[0-9]+\.json$/.test(at)) {
              const task = object(JSON.parse(file.content));
              if (typeof task?.["id"] !== "string" || !at.endsWith(`/${task["id"]}.json`))
                return refuse("Claude saved task identity differs from its native file.");
            }
            if (at.endsWith("/.highwatermark") && !/^[0-9]+\s*$/.test(file.content))
              return refuse("Claude saved task high-water mark is incomplete.");
            retained.push(file);
          }
        }
        retained.push({ relativePath: source.relativePath, content });
      } else {
        const selected = records.filter(
          ({ value }) =>
            value["type"] === "event_msg" &&
            field(value["payload"], "type") === "task_complete" &&
            field(value["payload"], "turn_id") === cutoff.throughTurnId,
        );
        if (selected.length !== 1)
          return refuse("The exact completed native turn marker is missing or ambiguous.");
        const end = selected[0];
        if (end === undefined) return refuse("The native turn marker is missing.");
        const visited = new Set<string>();
        const retain = (file: NativeHistoryFile, content: string, expectedId: string): void => {
          if (visited.has(expectedId)) return refuse("Codex history contains a cycle.");
          visited.add(expectedId);
          const retainedRecords = linesOf(content);
          if (retainedRecords.some(({ value }) => usesAuxiliaryState(value, "codex")))
            return refuse(
              "This Codex history uses subagent state whose complete closure is not supported.",
            );
          const meta = retainedRecords[0]?.value;
          const payload = field(meta, "payload");
          if (
            field(meta, "type") !== "session_meta" ||
            field(payload, "id") !== expectedId ||
            field(payload, "history_mode") !== cutoff.historyMode
          )
            return refuse("Codex native metadata does not match the selected history.");
          if (expectedId === cutoff.threadId && field(payload, "cli_version") !== providerVersion)
            return refuse("Codex history version differs from the observed response.");
          retained.push({ relativePath: file.relativePath, content });
          const base = field(payload, "history_base");
          if (base == null) return;
          if (cutoff.historyMode !== "paginated")
            return refuse("Legacy Codex history unexpectedly has a paginated ancestor.");
          const id = field(base, "thread_id");
          const bytes = field(base, "end_byte_offset");
          const ordinal = field(base, "end_ordinal_exclusive");
          if (
            typeof id !== "string" ||
            typeof bytes !== "number" ||
            !Number.isSafeInteger(bytes) ||
            bytes <= 0 ||
            typeof ordinal !== "number" ||
            !Number.isSafeInteger(ordinal)
          )
            return refuse("Codex history has an unsupported ancestor boundary.");
          const ancestors = input.files.filter(
            (candidate) =>
              candidate.relativePath.startsWith(".codex/") &&
              candidate.relativePath.endsWith(`-${id}.jsonl`),
          );
          if (ancestors.length !== 1)
            return refuse("Codex native history is missing an unambiguous ancestor.");
          const ancestor = ancestors[0];
          if (ancestor === undefined) return refuse("Codex native ancestor is missing.");
          fileRef(ancestor);
          const ancestorRecords = linesOf(ancestor.content);
          const last = ancestorRecords.find((line) => line.endByte === bytes);
          if (last === undefined || field(last.value, "ordinal") !== ordinal - 1)
            return refuse("Codex ancestor byte and ordinal boundaries disagree.");
          retain(ancestor, ancestor.content.slice(0, last.endChar), id);
        };
        retain(source, source.content.slice(0, end.endChar), cutoff.threadId);
      }
      const files = retained.toSorted((a, b) => a.relativePath.localeCompare(b.relativePath));
      const refs = files.map(fileRef);
      const selectedFile = refs.find((ref) => ref.relativePath === source.relativePath);
      if (selectedFile === undefined) return refuse("The selected native file was not retained.");
      const manifestDigest = digest(
        JSON.stringify({ format: 1, providerVersion, cutoff, selectedFile, files: refs }),
      );
      const manifest: NativeHistorySeed = {
        id: NativeSeedId.make(`seed-${manifestDigest}`),
        format: 1,
        providerVersion,
        cutoff,
        selectedFile,
        manifestDigest,
        files: refs,
      };
      return {
        manifest,
        files,
      };
    },
    catch: (cause) =>
      cause instanceof NativeHistoryError
        ? cause
        : new NativeHistoryError({
            message: "Native history could not be decoded as a supported complete conversation.",
          }),
  });

/** Provider CLI switches, applied after the ordinary conversation-home command line. */
export function nativeBootstrapArgv(
  argv: ReadonlyArray<string>,
  input:
    | {
        readonly sourcePath: string;
        readonly childSessionId: string;
        readonly cutoff: NativeHistoryObservation["cutoff"];
      }
    | { readonly kind: "emptyOrigin"; readonly childSessionId: string },
): ReadonlyArray<string> {
  if (!("cutoff" in input)) {
    const result: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "--resume" || arg === "--session-id") {
        i++;
        continue;
      }
      if (arg !== undefined) result.push(arg);
    }
    return argv[0] === "claude" ? [...result, "--session-id", input.childSessionId] : result;
  }
  if (input.cutoff.provider === "codex") return argv;
  const result: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--resume" || arg === "--session-id") {
      i++;
      continue;
    }
    if (arg !== undefined) result.push(arg);
  }
  return [
    ...result,
    "--resume",
    input.sourcePath,
    "--fork-session",
    "--session-id",
    input.childSessionId,
    "--resume-session-at",
    input.cutoff.throughMessageId,
  ];
}

/** Read only the selected conversation and its native ancestor closure from an authorized home. */
export const readNativeHistorySeed = (input: {
  readonly observation: NativeHistoryObservation;
  readonly paths: ReadonlyArray<string>;
  readonly read: (relativePath: string) => Effect.Effect<string, NativeHistoryError>;
}) =>
  Effect.gen(function* () {
    const { cutoff } = input.observation;
    const files: NativeHistoryFile[] = [];
    const seen = new Set<string>();
    const id = cutoff.provider === "codex" ? cutoff.threadId : cutoff.sessionId;
    let next: string | null = id;
    while (next !== null) {
      const current: string = next;
      if (seen.has(current))
        return yield* new NativeHistoryError({
          message: "Native history contains an ancestor cycle.",
        });
      seen.add(current);
      const candidates = input.paths.filter(
        (relativePath) =>
          Schema.is(NativeFileRef)({ relativePath, sha256: "0".repeat(64), byteLength: 0 }) &&
          (cutoff.provider === "codex"
            ? relativePath.startsWith(".codex/") && relativePath.endsWith(`-${current}.jsonl`)
            : relativePath.startsWith(".claude/projects/") &&
              relativePath.endsWith(`/${current}.jsonl`)),
      );
      const relativePath = candidates[0];
      if (candidates.length !== 1 || relativePath === undefined)
        return yield* new NativeHistoryError({
          message: "The selected native conversation or an ancestor is missing or ambiguous.",
        });
      const content = yield* input.read(relativePath);
      files.push({ relativePath, content });
      const ancestor = yield* Effect.try({
        try: () =>
          field(field(field(linesOf(content)[0]?.value, "payload"), "history_base"), "thread_id"),
        catch: () =>
          new NativeHistoryError({ message: "The native ancestor could not be decoded." }),
      });
      next = cutoff.provider === "codex" && typeof ancestor === "string" ? ancestor : null;
    }
    if (cutoff.provider === "claude") {
      const auxiliary = yield* Effect.try({
        try: () => {
          const records = linesOf(files[0]?.content ?? "");
          const end = records.find(
            (line) =>
              line.value["uuid"] === cutoff.throughMessageId && line.value["type"] === "assistant",
          );
          if (end === undefined) return refuse("The selected Claude response is missing.");
          return claudeClosure(
            records.filter((line) => line.endChar <= end.endChar).map((line) => line.value),
            cutoff.sessionId,
            input.paths,
          );
        },
        catch: (cause) =>
          cause instanceof NativeHistoryError
            ? cause
            : new NativeHistoryError({ message: "Claude auxiliary history could not be decoded." }),
      });
      for (const relativePath of auxiliary)
        files.push({ relativePath, content: yield* input.read(relativePath) });
    }
    return yield* sealNativeHistory({ observation: input.observation, files });
  });

/** Resolve sealed bytes into one child's home, without touching or rereading the source. */
export const prepareNativeHistorySeed = (input: {
  readonly manifest: NativeHistorySeed;
  readonly files: ReadonlyArray<NativeHistoryFile>;
  readonly home: string;
  readonly childSessionId: string;
  /** Shared holder homes need candidate-owned native identities and paths; source files stay live. */
  readonly isolateNativeState?: boolean;
}): Effect.Effect<
  {
    readonly files: ReadonlyArray<NativeHistoryFile>;
    readonly refs: ReadonlyArray<NativeFileRef>;
    readonly cutoff: NativeHistorySeed["cutoff"];
    readonly selectedFile: NativeFileRef;
  },
  NativeHistoryError
> =>
  Effect.try({
    try: () => {
      const { manifest } = input;
      if (
        input.files.length !== manifest.files.length ||
        !input.home.startsWith("/") ||
        input.home.endsWith("/")
      )
        return refuse("The retained native seed or child home is invalid.");
      for (const ref of manifest.files) {
        const matches = input.files.filter((file) => file.relativePath === ref.relativePath);
        const file = matches[0];
        if (
          matches.length !== 1 ||
          file === undefined ||
          fileRef(file).sha256 !== ref.sha256 ||
          Buffer.byteLength(file.content) !== ref.byteLength
        )
          return refuse("The retained native seed differs from its sealed manifest.");
      }
      const cutoff = manifest.cutoff;
      if (cutoff.provider === "codex") {
        if (input.isolateNativeState !== true)
          return {
            files: input.files,
            refs: manifest.files,
            cutoff,
            selectedFile: manifest.selectedFile,
          };
        // Paginated Codex IDs are indexed by path. Shared homes need independent seed IDs,
        // including ancestors, so importing a retained prefix cannot alias the fuller source.
        const aliases = new Map<string, string>([[cutoff.threadId, input.childSessionId]]);
        const aliasOf = (id: string) => {
          const known = aliases.get(id);
          if (known !== undefined) return known;
          const hash = digest(`${input.childSessionId}:${id}`);
          const alias = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
          aliases.set(id, alias);
          return alias;
        };
        const prepared = new Map<string, NativeHistoryFile>();
        const visiting = new Set<string>();
        const rebind = (id: string): NativeHistoryFile => {
          const known = prepared.get(id);
          if (known !== undefined) return known;
          if (visiting.has(id)) return refuse("Codex history contains a cycle.");
          visiting.add(id);
          const source = input.files.find((file) => file.relativePath.endsWith(`-${id}.jsonl`));
          if (source === undefined) return refuse("The retained Codex ancestor is missing.");
          const meta = linesOf(source.content)[0];
          const payload = object(meta?.value["payload"]);
          if (meta === undefined || payload === null || payload["id"] !== id)
            return refuse("The retained Codex metadata differs from its identity.");
          const base = object(payload["history_base"]);
          const ancestorId = base?.["thread_id"];
          if (base !== null && typeof ancestorId !== "string")
            return refuse("The retained Codex ancestor has no identity.");
          const ancestor = typeof ancestorId === "string" ? rebind(ancestorId) : null;
          const alias = aliasOf(id);
          const file = {
            relativePath: source.relativePath.replace(`-${id}.jsonl`, `-${alias}.jsonl`),
            content:
              JSON.stringify({
                ...meta.value,
                payload: {
                  ...payload,
                  id: alias,
                  ...(payload["session_id"] === id ? { session_id: alias } : {}),
                  ...(ancestor === null || typeof ancestorId !== "string"
                    ? {}
                    : {
                        history_base: {
                          ...base,
                          thread_id: aliasOf(ancestorId),
                          end_byte_offset: Buffer.byteLength(ancestor.content),
                        },
                      }),
                },
              }) +
              "\n" +
              source.content.slice(meta.endChar),
          };
          visiting.delete(id);
          prepared.set(id, file);
          return file;
        };
        const selectedFile = fileRef(rebind(cutoff.threadId));
        const files = [...prepared.values()].toSorted((a, b) =>
          a.relativePath.localeCompare(b.relativePath),
        );
        return {
          files,
          refs: files.map(fileRef),
          selectedFile,
          cutoff: { ...cutoff, threadId: input.childSessionId },
        };
      }
      const sourceId = cutoff.sessionId;
      const targetPath = (at: string) => {
        const renamed = at
          .replace(`.claude/tasks/${sourceId}/`, `.claude/tasks/${input.childSessionId}/`)
          .replace(
            `.claude/todos/${sourceId}-agent-${sourceId}.json`,
            `.claude/todos/${input.childSessionId}-agent-${input.childSessionId}.json`,
          );
        return input.isolateNativeState === true
          ? renamed
              .replace(".claude/plans/", `.claude/plans/${input.childSessionId}-`)
              .replace(`/${sourceId}/tool-results/`, `/${input.childSessionId}/tool-results/`)
          : renamed;
      };
      const transcript = input.files.find(
        (file) => file.relativePath === manifest.selectedFile.relativePath,
      );
      if (transcript === undefined) return refuse("The selected native transcript is missing.");
      const refs = claudeReferences(
        claudeState(linesOf(transcript.content).map((line) => line.value)),
      );
      const files = input.files.map((file) => ({
        relativePath: targetPath(file.relativePath),
        content:
          file.relativePath === manifest.selectedFile.relativePath
            ? linesOf(file.content)
                .map(
                  (line) =>
                    JSON.stringify(line.value, (_key, value: unknown) => {
                      if (typeof value !== "string") return value;
                      return value.replace(
                        /(?:\/[^\s"'<>`]*|~\/)?\.claude\/(?:plans|tasks|todos|projects)\/[^\s"'<>`]+/g,
                        (at) => {
                          const ref = refs.find((candidate) => candidate.path === at);
                          return ref === undefined
                            ? at
                            : `${input.home}/${targetPath(ref.relativePath)}`;
                        },
                      );
                    }) + "\n",
                )
                .join("")
            : file.content,
      }));
      const refsByPath = files.map(fileRef);
      const selectedFile = refsByPath.find(
        (ref) => ref.relativePath === targetPath(manifest.selectedFile.relativePath),
      );
      if (selectedFile === undefined) return refuse("The selected native transcript is missing.");
      return { files, refs: refsByPath, cutoff, selectedFile };
    },
    catch: (cause) =>
      cause instanceof NativeHistoryError
        ? cause
        : new NativeHistoryError({
            message: "Native history could not be prepared for the child.",
          }),
  });
