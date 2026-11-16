/**
 * A person's own Claude or Codex conversation, carried from their machine into one Mend session
 * (SLNT-895): which of a harness home's files belong to it, and how they travel in one request.
 *
 * The body is a conversation archive: one line of JSON, the header, then each file's bytes in the
 * header's order with nothing between them. A handoff's git bundle has the same shape (a header,
 * then a pack), and like the bundle the bytes are never base64'd or held twice.
 */
import { Result, Schema } from "effect";

import { EFFORT_LEVELS, PERMISSION_MODES } from "./harness-launch.ts";

/** The largest conversation a server takes when its operator sets nothing, in bytes. */
export const CONVERSATION_BYTES_DEFAULT = 64 * 1024 * 1024;

export const CONVERSATION_ARCHIVE_CONTENT_TYPE = "application/vnd.mend.conversation";

/** The harnesses whose own conversations Mend can take and resume. */
export const IMPORTED_HARNESSES = ["claude", "codex"] as const;
export const ImportedHarness = Schema.Literals(IMPORTED_HARNESSES);
export type ImportedHarness = typeof ImportedHarness.Type;

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const NAME = "[A-Za-z0-9_-][A-Za-z0-9_.-]*";
const AGENT = "agent-[A-Za-z0-9_-]+\\.(?:jsonl|meta\\.json)";

const CLAUDE_PATHS: ReadonlyArray<RegExp> = [
  new RegExp(`^\\.claude/projects/[^/]+/${UUID}\\.jsonl$`),
  // What a tool saved instead of printing: text, JSON, and the screenshots it was shown.
  new RegExp(
    `^\\.claude/projects/[^/]+/${UUID}/tool-results/${NAME}\\.(?:txt|json|png|jpe?g|gif|webp)$`,
  ),
  // A subagent's own transcript and its sidecar, and those of a workflow's agents.
  new RegExp(`^\\.claude/projects/[^/]+/${UUID}/subagents/${AGENT}$`),
  new RegExp(
    `^\\.claude/projects/[^/]+/${UUID}/subagents/workflows/${NAME}/(?:${AGENT}|journal\\.jsonl)$`,
  ),
  /^\.claude\/plans\/[A-Za-z0-9_-]+\.md$/,
  new RegExp(`^\\.claude/tasks/${UUID}/(?:[1-9][0-9]*\\.json|\\.highwatermark)$`),
  new RegExp(`^\\.claude/todos/${UUID}-agent-${UUID}\\.json$`),
];

const ROLLOUT = "rollout-[A-Za-z0-9T:_.-]+\\.jsonl";
const CODEX_PATHS: ReadonlyArray<RegExp> = [
  new RegExp(`^\\.codex/(?:sessions|archived_sessions)/\\d{4}/\\d{2}/\\d{2}/${ROLLOUT}$`),
  // Codex archives a conversation by moving its rollout into one flat directory.
  new RegExp(`^\\.codex/archived_sessions/${ROLLOUT}$`),
];

/**
 * Whether `relativePath`, relative to the person's home, is a file of a `harness` conversation
 * Mend takes. A superset of the fork seal's allowlist (`NativeFileRef`): an imported conversation
 * also carries its subagents, saved screenshots and archived rollouts, which a fork refuses.
 * Never a login, a setting or anything else of the home.
 */
export const isImportedConversationPath = (
  harness: ImportedHarness,
  relativePath: string,
): boolean =>
  !relativePath.split("/").some((part) => part === "" || part === "." || part === "..") &&
  (harness === "claude" ? CLAUDE_PATHS : CODEX_PATHS).some((pattern) => pattern.test(relativePath));

/** The conversation's own transcript among its files, by its harness's naming. */
export const isConversationTranscript = (
  harness: ImportedHarness,
  nativeId: string,
  relativePath: string,
): boolean =>
  harness === "claude"
    ? relativePath.startsWith(".claude/projects/") &&
      relativePath.split("/").length === 4 &&
      relativePath.endsWith(`/${nativeId}.jsonl`)
    : relativePath.startsWith(".codex/") && relativePath.endsWith(`-${nativeId}.jsonl`);

/**
 * Files whose bytes are text the path rewrite reads (UTF-8); every other file (a screenshot)
 * travels byte for byte. The rewrite in `@mend/agent-protocol` draws the same line.
 */
export const isTextConversationFile = (relativePath: string): boolean => {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  return /\.(?:jsonl|json|txt|md)$/.test(name) || name === ".highwatermark";
};

const AbsolutePath = Schema.String.check(
  Schema.makeFilter((value: string) =>
    value.startsWith("/") && value.length > 1 && !value.endsWith("/") && !value.includes("\0")
      ? undefined
      : "an absolute path with no trailing slash",
  ),
);

/** A native conversation id: Claude's session uuid or Codex's thread id. */
export const ImportedNativeId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,128}$/));

export const ConversationArchiveFile = Schema.Struct({
  relativePath: Schema.String.check(Schema.isMaxLength(1024)),
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type ConversationArchiveFile = typeof ConversationArchiveFile.Type;

/** The most files one conversation may carry. */
export const CONVERSATION_FILES_MAX = 20_000;

export const ConversationArchiveHeader = Schema.Struct({
  format: Schema.Literal(1),
  harness: ImportedHarness,
  nativeId: ImportedNativeId,
  /** Where the conversation ran on the person's machine. */
  source: Schema.Struct({ checkout: AbsolutePath, home: AbsolutePath }),
  /** The session's label. */
  title: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
  /** What the session's first launch runs on. */
  model: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
  effort: Schema.optionalKey(Schema.NullOr(Schema.Literals(EFFORT_LEVELS))),
  permissionMode: Schema.optionalKey(Schema.NullOr(Schema.Literals(PERMISSION_MODES))),
  files: Schema.Array(ConversationArchiveFile).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CONVERSATION_FILES_MAX),
  ),
});
export type ConversationArchiveHeader = typeof ConversationArchiveHeader.Type;

/** The header line is small: a path list, never a file's bytes. */
const HEADER_BYTES_MAX = 8 * 1024 * 1024;

export interface ConversationArchiveEntry {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

/** One request body: the header line, then each entry's bytes in the header's order. */
export const encodeConversationArchive = (
  header: ConversationArchiveHeader,
  entries: ReadonlyArray<ConversationArchiveEntry>,
): Uint8Array => {
  const line = new TextEncoder().encode(
    JSON.stringify(Schema.encodeSync(ConversationArchiveHeader)(header)) + "\n",
  );
  const body = new Uint8Array(
    line.byteLength + entries.reduce((total, entry) => total + entry.bytes.byteLength, 0),
  );
  body.set(line, 0);
  let at = line.byteLength;
  for (const entry of entries) {
    body.set(entry.bytes, at);
    at += entry.bytes.byteLength;
  }
  return body;
};

/**
 * Split a body into its header and its files' bytes, which are views into `body`, not copies.
 * Fails with words when the header is not one, or the bytes after it are not exactly the files
 * it names. Digests are the receiver's to check.
 */
export const decodeConversationArchive = (
  body: Uint8Array,
): Result.Result<
  {
    readonly header: ConversationArchiveHeader;
    readonly entries: ReadonlyArray<ConversationArchiveEntry>;
  },
  string
> => {
  const newline = body.subarray(0, HEADER_BYTES_MAX).indexOf(0x0a);
  if (newline === -1) return Result.fail("the body has no conversation header line");
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, newline)),
    );
  } catch {
    return Result.fail("the conversation header is not JSON");
  }
  const decoded = Schema.decodeUnknownResult(ConversationArchiveHeader)(parsed);
  if (Result.isFailure(decoded))
    return Result.fail("the conversation header is not one Mend reads");
  const header = decoded.success;
  const total = header.files.reduce((sum, file) => sum + file.byteLength, 0);
  if (body.byteLength - newline - 1 !== total)
    return Result.fail(
      `the header names ${total} bytes of files and the body carries ${body.byteLength - newline - 1}`,
    );
  let at = newline + 1;
  const entries = header.files.map((file) => {
    const bytes = body.subarray(at, at + file.byteLength);
    at += file.byteLength;
    return { relativePath: file.relativePath, bytes };
  });
  return Result.succeed({ header, entries });
};
