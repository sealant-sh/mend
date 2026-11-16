/**
 * Rewrite one native Claude or Codex conversation so it reads as if it had always run in another
 * checkout and harness home: a person's conversation imported into a Mend session, whose worktree
 * is `/workspace/repo` and whose harness home is not the person's. Pure: no I/O, one pass over
 * each file, linear in its size.
 *
 * What changes, in every string and object key at any depth: the source checkout, as a whole path
 * prefix, becomes the target checkout; then the source home's harness state (`<home>/.claude/…`,
 * `<home>/.codex/…`, and the `~/.claude/{plans,tasks,todos,projects}/…` references Claude writes)
 * moves under the target home, Claude's project folder renamed with it. What never changes:
 * signed and encrypted content (Claude `thinking` and `redacted_thinking` blocks, any
 * `encrypted_content`), which the provider rejects on resume if a byte differs; ids, timestamps
 * and line order; and every other path, which the report lists when it is under the source home.
 */
import { Effect } from "effect";

import {
  type JsonObject,
  NativeHistoryError,
  type NativeHistoryFile,
  eachLine,
  field,
  isObject,
  object,
  refuse,
} from "./native-records.ts";

/** Claude names a project directory after the working directory: `/workspace/repo` → `-workspace-repo`. */
export const claudeProjectDirOf = (cwd: string): string => cwd.replaceAll(/[^A-Za-z0-9]/g, "-");

/** Where a conversation ran: absolute paths, no trailing slash. */
export interface NativeConversationPlace {
  readonly checkout: string;
  readonly home: string;
}

export interface NativeConversationRewriteInput {
  readonly provider: "claude" | "codex";
  /** Every file of the conversation, `relativePath` relative to `source.home`. */
  readonly files: ReadonlyArray<NativeHistoryFile>;
  readonly source: NativeConversationPlace;
  /** `gitBranch`, when given, replaces each Claude record's top-level `gitBranch`. */
  readonly target: NativeConversationPlace & { readonly gitBranch?: string };
}

/** The most distinct leftover paths a report lists. */
export const NATIVE_REWRITE_LEFTOVER_LIMIT = 50;

export interface NativeConversationRewriteReport {
  /** Path occurrences changed. Signed and encrypted content is never counted. */
  readonly rewritten: number;
  /**
   * Distinct absolute paths under `source.home` left as written, sorted, at most
   * `NATIVE_REWRITE_LEFTOVER_LIMIT`: what still points at the person's machine.
   */
  readonly leftovers: ReadonlyArray<string>;
  /** More distinct leftovers were found than `leftovers` lists. */
  readonly leftoversTruncated: boolean;
}

export interface NativeConversationRewrite {
  /** The input's files, in input order, with rewritten paths and content. */
  readonly files: ReadonlyArray<NativeHistoryFile>;
  readonly report: NativeConversationRewriteReport;
}

// A character that continues a path segment. A path prefix ends anywhere else; a `.` ends it too
// unless another segment character follows (`shop.` at a sentence's end, not `shop.git`).
const SEGMENT = String.raw`\p{L}\p{N}_~+@%=-`;
const START = String.raw`(?<![\p{L}\p{N}_.~-])`;
const END = String.raw`(?![${SEGMENT}]|\.[${SEGMENT}])`;
const LEFTOVER_REST = String.raw`[^\s"'\x60<>\\:,;|()\[\]{}]*`;
const escapeRegExp = (text: string): string => text.replaceAll(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

const placeIsValid = (path: string): boolean =>
  path.startsWith("/") && path.length > 1 && !path.endsWith("/");

/** One rewriting pass's string rewrite and its running report. */
const textRewriter = (input: {
  readonly source: NativeConversationPlace;
  readonly target: NativeConversationPlace;
  readonly sourceProjectDirs: ReadonlyArray<string>;
  readonly targetProjectDir: string;
}) => {
  const { source, target } = input;
  // `~` already names the target home when the homes are the same, and expanding it would change
  // a conversation that is not moving.
  const tilde = source.home !== target.home;
  const home = escapeRegExp(source.home);
  const dirs = input.sourceProjectDirs.map(escapeRegExp).join("|");
  const pattern = new RegExp(
    START +
      "(?:" +
      [
        `(${escapeRegExp(source.checkout)})${END}`,
        `(${home}/\\.claude/projects/(?:${dirs}))${END}`,
        `(${home}/\\.(?:claude|codex))${END}`,
        ...(tilde
          ? [
              `(~/\\.claude/projects/(?:${dirs}))${END}`,
              `(~/\\.claude/(?:plans|tasks|todos|projects)/)(?=[^\\s"'<>\\x60])`,
            ]
          : // Keep the group numbers: an empty group that never matches.
            ["()(?!)", "()(?!)"]),
        `(${home}${END}${LEFTOVER_REST})`,
      ].join("|") +
      ")",
    "gu",
  );
  const triggers = [source.checkout, source.home, ...(tilde ? ["~/.claude/"] : [])];
  const targetProject = `${target.home}/.claude/projects/${input.targetProjectDir}`;
  let rewritten = 0;
  const leftovers = new Set<string>();
  let leftoversTruncated = false;

  const replace = (
    match: string,
    checkout: string | undefined,
    project: string | undefined,
    state: string | undefined,
    tildeProject: string | undefined,
    tildeState: string | undefined,
  ): string => {
    const next =
      checkout !== undefined
        ? target.checkout
        : project !== undefined || tildeProject !== undefined
          ? targetProject
          : state !== undefined
            ? target.home + state.slice(source.home.length)
            : tildeState !== undefined
              ? target.home + tildeState.slice(1)
              : null;
    if (next === null) {
      const leftover = match.replace(/\.+$/, "");
      if (leftovers.has(leftover)) return match;
      if (leftovers.size < NATIVE_REWRITE_LEFTOVER_LIMIT) leftovers.add(leftover);
      else leftoversTruncated = true;
      return match;
    }
    if (next !== match) rewritten++;
    return next;
  };

  return {
    text: (value: string): string =>
      triggers.some((trigger) => value.includes(trigger)) ? value.replace(pattern, replace) : value,
    report: (): NativeConversationRewriteReport => ({
      rewritten,
      leftovers: [...leftovers].toSorted(),
      leftoversTruncated,
    }),
  };
};

/**
 * Rewrite a parsed JSON value, returning the same reference when nothing changed so an untouched
 * record keeps its original bytes.
 */
const jsonRewriter = (text: (value: string) => string) => {
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((entry: unknown) => {
        const rewritten = rewrite(entry);
        if (rewritten !== entry) changed = true;
        return rewritten;
      });
      return changed ? next : value;
    }
    if (!isObject(value)) return value;
    // Signed by the provider: one changed byte and the resumed conversation is refused.
    if (value["type"] === "thinking" || value["type"] === "redacted_thinking") return value;
    let changed = false;
    const keys = new Set<string>();
    const entries = Object.entries(value).map(([key, entry]): [string, unknown] => {
      const nextKey = text(key);
      const next = key === "encrypted_content" ? entry : rewrite(entry);
      if (nextKey !== key || next !== entry) changed = true;
      if (keys.has(nextKey))
        return refuse("Native conversation has two keys that become one path when rewritten.");
      keys.add(nextKey);
      return [nextKey, next];
    });
    return changed ? Object.fromEntries(entries) : value;
  };
  return rewrite;
};

type FileKind = "jsonl" | "json" | "text" | "opaque";
const kindOf = (relativePath: string): FileKind => {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  if (name.endsWith(".jsonl")) return "jsonl";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".txt") || name.endsWith(".md") || name === ".highwatermark") return "text";
  // Images and other bytes a tool saved travel as they are.
  return "opaque";
};

interface RewrittenJsonl {
  readonly lines: Array<string>;
  /** Codex only: where each source line ended, in bytes, to place an ancestor boundary. */
  readonly sourceEndBytes: ReadonlyArray<number>;
  /** The rewritten first record, to rebind a Codex ancestor boundary. */
  readonly head: unknown;
}

const rewriteJsonl = (
  content: string,
  rewriteRecord: (value: JsonObject) => unknown,
  keepEndBytes: boolean,
): RewrittenJsonl => {
  if (content === "") return { lines: [], sourceEndBytes: [], head: undefined };
  const sourceEndBytes: Array<number> = [];
  let head: unknown;
  let start = 0;
  const lines = eachLine(content, (line) => {
    const raw = content.slice(start, line.endChar - 1);
    start = line.endChar;
    if (keepEndBytes) sourceEndBytes.push(line.endByte);
    const next = rewriteRecord(line.value);
    if (head === undefined) head = next;
    return next === line.value ? raw : JSON.stringify(next);
  });
  return { lines, sourceEndBytes, head };
};

const jsonlContent = (lines: ReadonlyArray<string>): string =>
  lines.length === 0 ? "" : lines.join("\n") + "\n";

/** Parse a whole-file JSON value or fail with the file named; JSON.parse throws a SyntaxError. */
const decoded = <A>(relativePath: string, decode: () => A): A => {
  try {
    return decode();
  } catch (cause) {
    if (cause instanceof NativeHistoryError)
      throw new NativeHistoryError({ message: `${cause.message} (${relativePath})` });
    return refuse(`Native conversation file is not valid JSON: ${relativePath}.`);
  }
};

const checkRelativePath = (provider: "claude" | "codex", relativePath: string): void => {
  const parts = relativePath.split("/");
  if (
    parts[0] !== `.${provider}` ||
    parts.length < 2 ||
    parts.some((part) => part === "" || part === "." || part === "..")
  )
    refuse(`Native conversation file is outside the ${provider} home: ${relativePath}.`);
};

/**
 * Rewrite one native conversation for a new checkout and home. Fails, returning nothing, on input
 * it cannot rewrite safely: a file that is not valid JSONL or JSON where one is expected, a path
 * outside the provider's home, a Codex ancestor that is missing or whose boundary falls inside a
 * record, or Claude files from more than one project folder.
 */
export const rewriteNativeConversation = (
  input: NativeConversationRewriteInput,
): Effect.Effect<NativeConversationRewrite, NativeHistoryError> =>
  Effect.try({
    try: (): NativeConversationRewrite => {
      const { provider, source, target } = input;
      for (const path of [source.checkout, source.home, target.checkout, target.home])
        if (!placeIsValid(path))
          refuse("Native conversation places must be absolute paths with no trailing slash.");
      // A target inside its source would match again on a second pass.
      if (target.checkout !== source.checkout && target.checkout.startsWith(`${source.checkout}/`))
        refuse("Native conversation target checkout is inside its source checkout.");

      const seen = new Set<string>();
      const projectDirs = new Set<string>();
      for (const file of input.files) {
        checkRelativePath(provider, file.relativePath);
        if (seen.has(file.relativePath))
          refuse(`Native conversation lists a file twice: ${file.relativePath}.`);
        seen.add(file.relativePath);
        const parts = file.relativePath.split("/");
        if (provider === "claude" && parts[1] === "projects" && parts.length > 3)
          projectDirs.add(parts[2] ?? "");
      }
      if (projectDirs.size > 1)
        refuse("Native conversation files come from more than one Claude project folder.");
      const targetProjectDir = claudeProjectDirOf(target.checkout);
      const strings = textRewriter({
        source,
        target,
        // Claude shortens a long folder name, so the files' own folder is the one to rename.
        sourceProjectDirs: [...new Set([claudeProjectDirOf(source.checkout), ...projectDirs])],
        targetProjectDir,
      });
      const rewriteJson = jsonRewriter(strings.text);
      const branch = target.gitBranch;
      const rewriteRecord = (value: JsonObject): unknown => {
        const next = rewriteJson(value);
        if (
          provider !== "claude" ||
          branch === undefined ||
          typeof value["gitBranch"] !== "string" ||
          object(next)?.["gitBranch"] === branch
        )
          return next;
        return { ...object(next), gitBranch: branch };
      };

      const results = input.files.map((file) => {
        const parts = file.relativePath.split("/");
        const relativePath =
          provider === "claude" && parts[1] === "projects" && parts.length > 3
            ? [parts[0], parts[1], targetProjectDir, ...parts.slice(3)].join("/")
            : file.relativePath;
        const kind = kindOf(file.relativePath);
        if (kind === "jsonl") {
          const jsonl = decoded(file.relativePath, () =>
            rewriteJsonl(file.content, rewriteRecord, provider === "codex"),
          );
          return { source: file, relativePath, kind, jsonl, content: file.content };
        }
        const content =
          kind === "text"
            ? strings.text(file.content)
            : kind === "opaque"
              ? file.content
              : decoded(file.relativePath, () => {
                  const parsed: unknown = JSON.parse(file.content);
                  const next = rewriteJson(parsed);
                  if (next === parsed) return file.content;
                  const indent = /^[[{]\r?\n([ \t]+)/.exec(file.content)?.[1];
                  return (
                    JSON.stringify(next, null, indent) + (file.content.endsWith("\n") ? "\n" : "")
                  );
                });
        return { source: file, relativePath, kind, jsonl: null, content };
      });

      if (provider === "codex") {
        // A rollout that continues an ancestor names the byte where the ancestor's history ends.
        // Rewriting changes the ancestor's length, so each boundary moves to the same record's end
        // in the rewritten ancestor, ancestors first so a chain settles in order.
        const rollouts = results.flatMap((result) =>
          result.jsonl === null
            ? []
            : [{ relativePath: result.source.relativePath, ...result.jsonl }],
        );
        const settled = new Set<string>();
        const visiting = new Set<string>();
        const settle = (rollout: (typeof rollouts)[number]): void => {
          if (settled.has(rollout.relativePath)) return;
          if (visiting.has(rollout.relativePath)) refuse("Codex history contains a cycle.");
          visiting.add(rollout.relativePath);
          const payload = field(rollout.head, "payload");
          const base = field(payload, "history_base");
          if (base != null) {
            const id = field(base, "thread_id");
            const bytes = field(base, "end_byte_offset");
            if (
              field(rollout.head, "type") !== "session_meta" ||
              typeof id !== "string" ||
              typeof bytes !== "number" ||
              !Number.isSafeInteger(bytes)
            )
              refuse(
                `Codex history has an unsupported ancestor boundary: ${rollout.relativePath}.`,
              );
            const ancestors = rollouts.filter((candidate) =>
              candidate.relativePath.endsWith(`-${String(id)}.jsonl`),
            );
            const ancestor = ancestors[0];
            if (ancestors.length !== 1 || ancestor === undefined)
              return refuse(
                `Codex rollout names an ancestor that is not among the files: ${String(id)}.`,
              );
            settle(ancestor);
            const index = ancestor.sourceEndBytes.indexOf(Number(bytes));
            if (index === -1)
              refuse(`Codex ancestor boundary falls inside a record: ${ancestor.relativePath}.`);
            let offset = 0;
            for (const line of ancestor.lines.slice(0, index + 1))
              offset += Buffer.byteLength(line) + 1;
            if (offset !== bytes) {
              const head = { ...object(rollout.head) };
              head["payload"] = {
                ...object(payload),
                history_base: { ...object(base), end_byte_offset: offset },
              };
              rollout.lines[0] = JSON.stringify(head);
            }
          }
          visiting.delete(rollout.relativePath);
          settled.add(rollout.relativePath);
        };
        for (const rollout of rollouts) settle(rollout);
      }

      return {
        files: results.map((result) => ({
          relativePath: result.relativePath,
          content: result.jsonl === null ? result.content : jsonlContent(result.jsonl.lines),
        })),
        report: strings.report(),
      };
    },
    catch: (cause) =>
      cause instanceof NativeHistoryError
        ? cause
        : new NativeHistoryError({ message: "Native conversation could not be rewritten." }),
  });
