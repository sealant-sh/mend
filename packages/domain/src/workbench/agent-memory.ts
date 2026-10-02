import { Schema } from "effect";

import { Timestamp } from "../timestamp.ts";

/**
 * An agent's memory, kept per person per project (docs/adr/0009-agent-memory-per-person-per-
 * project.md): the files an agent writes about a repository as it works in it, which Mend delivers
 * into each session the person starts on the project and reads back when the agent ends.
 *
 * A file's `path` is relative to the harness home and lies under one of `AGENT_MEMORY_ROOTS`.
 */

/**
 * Where each harness keeps memory, relative to the harness home.
 * - Claude Code keys its auto memory by working directory, and every session's agent runs in
 *   `/workspace/repo`.
 * - Codex consolidates its memory into one folder: `MEMORY.md`, `memory_summary.md`,
 *   `rollout_summaries/`, `skills/` and the git baseline it diffs against (`.git`).
 */
export const AGENT_MEMORY_ROOTS = [
  { harness: "claude", root: ".claude/projects/-workspace-repo/memory" },
  { harness: "codex", root: ".codex/memories" },
  // Mend's own: the first line of each conversation Codex summarised on another machine
  // (`mend memory import`), so a session can list that conversation for Codex again.
  { harness: "codex", root: ".mend/codex-threads" },
] as const;

/**
 * Memory kept in single files outside a root: Codex's record of which conversations it has
 * summarised and what each summary said (`stage1_outputs`). Without it, every session would
 * summarise the same two newest conversations again and never get past them. Stored as one
 * consolidated file: its write-ahead log is folded in at read-back, never kept apart.
 */
export const AGENT_MEMORY_FILES = [{ harness: "codex", path: ".codex/memories_1.sqlite" }] as const;

/** Codex's summary database, as `AGENT_MEMORY_FILES` names it. */
export const CODEX_MEMORY_DATABASE = ".codex/memories_1.sqlite";

export const AGENT_MEMORY_MAX_FILES = 2000;
export const AGENT_MEMORY_MAX_FILE_BYTES = 1024 * 1024;
/** Codex's summary database holds every summary it keeps: its own, larger limit. */
export const AGENT_MEMORY_MAX_DATABASE_BYTES = 16 * 1024 * 1024;
export const AGENT_MEMORY_MAX_BYTES = 32 * 1024 * 1024;

/** The most a stored memory file at `filePath` may hold. */
export const agentMemoryMaxFileBytes = (filePath: string): number =>
  AGENT_MEMORY_FILES.some((file) => file.path === filePath)
    ? AGENT_MEMORY_MAX_DATABASE_BYTES
    : AGENT_MEMORY_MAX_FILE_BYTES;
const AGENT_MEMORY_MAX_PATH_LENGTH = 512;

/** One memory file, as delivered, read back or imported. */
export class AgentMemoryFile extends Schema.Class<AgentMemoryFile>("AgentMemoryFile")({
  path: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
  contents: Schema.String,
}) {}

/** One stored memory file, as a listing shows it. */
export class AgentMemoryEntry extends Schema.Class<AgentMemoryEntry>("AgentMemoryEntry")({
  path: Schema.String,
  /** Which harness keeps it. */
  harness: Schema.String,
  /** Its path under that harness's memory root: what a person calls it. */
  name: Schema.String,
  bytes: Schema.Int,
  digest: Schema.String,
  updatedAt: Timestamp,
  /** The session whose agent last wrote it, or null for an import. */
  updatedBySession: Schema.NullOr(Schema.String),
}) {}

/** `GET /projects/:id/memory`: the caller's memory in that project. */
export class AgentMemoryView extends Schema.Class<AgentMemoryView>("AgentMemoryView")({
  files: Schema.Array(AgentMemoryEntry),
}) {}

/** One file with its contents. */
export class AgentMemoryFileView extends Schema.Class<AgentMemoryFileView>("AgentMemoryFileView")({
  entry: AgentMemoryEntry,
  encoding: Schema.Literals(["utf8", "base64"]),
  contents: Schema.String,
}) {}

/** `POST /projects/:id/memory/import`: files from the person's own machine. */
export class AgentMemoryImport extends Schema.Class<AgentMemoryImport>("AgentMemoryImport")({
  files: Schema.Array(AgentMemoryFile),
}) {}

/** What an import did, path by path. */
export class AgentMemoryImported extends Schema.Class<AgentMemoryImported>("AgentMemoryImported")({
  added: Schema.Array(Schema.String),
  unchanged: Schema.Array(Schema.String),
  /** Already stored with other contents: left as stored. */
  conflicting: Schema.Array(Schema.String),
}) {}

/** `DELETE /projects/:id/memory/file`: whether there was one to remove. */
export class AgentMemoryRemoved extends Schema.Class<AgentMemoryRemoved>("AgentMemoryRemoved")({
  removed: Schema.Boolean,
}) {}

/** The harness and name of a memory path, or null when it lies under no memory root. */
export const agentMemoryNameOf = (
  filePath: string,
): { readonly harness: string; readonly name: string } | null => {
  for (const { harness, root } of AGENT_MEMORY_ROOTS) {
    if (filePath.startsWith(`${root}/`)) return { harness, name: filePath.slice(root.length + 1) };
  }
  for (const { harness, path: file } of AGENT_MEMORY_FILES) {
    if (filePath === file) return { harness, name: file.slice(file.lastIndexOf("/") + 1) };
  }
  return null;
};

/** A path Mend may store and write: under a memory root, relative, with no way out of it. */
export const validateAgentMemoryPath = (filePath: string): string | null => {
  if (filePath.length === 0) return "a file path is required";
  if (filePath.length > AGENT_MEMORY_MAX_PATH_LENGTH) {
    return `${filePath} is longer than ${AGENT_MEMORY_MAX_PATH_LENGTH} characters`;
  }
  if (filePath.startsWith("/") || filePath.includes("\\") || filePath.includes("\0")) {
    return `${filePath} is not a relative POSIX path`;
  }
  if (
    filePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return `${filePath} must not contain empty, "." or ".." segments`;
  }
  return agentMemoryNameOf(filePath) === null
    ? `${filePath} is not under a memory directory`
    : null;
};
