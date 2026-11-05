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
        const content = source.content.slice(0, end.endChar);
        // These formats depend on separately persisted files. Admit them only once their native
        // closure can be proved, rather than silently losing tool output or subagent history.
        if (/<persisted-output>|\/tool-results\/|\/subagents\//.test(content))
          return refuse(
            "This Claude history references auxiliary conversation files that are not yet supported.",
          );
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
          const records = linesOf(content);
          const meta = records[0]?.value;
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
export function nativeForkArgv(
  argv: ReadonlyArray<string>,
  input: {
    readonly sourcePath: string;
    readonly childSessionId: string;
    readonly cutoff: NativeHistoryObservation["cutoff"];
  },
): ReadonlyArray<string> {
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
