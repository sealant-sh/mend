import type { AgentInputQuestion, AgentRequestKind } from "./agent-protocol.ts";
import type { SessionAsk } from "./inbox.ts";

// What an inbox row says about a session: plain rules, free of Effect, so a client that reads
// them loads no Schema (`./inbox.ts` holds the Schemas and re-exports these).

/** Tools that change a file, as Claude names them (`detail.toolName`). */
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

const SUBJECT_MAX = 80;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One line, at most `SUBJECT_MAX` characters; null for nothing to say. */
const oneLine = (text: string | null): string | null => {
  const line =
    text
      ?.split("\n")
      .find((part) => part.trim() !== "")
      ?.trim() ?? "";
  if (line === "") return null;
  return line.length > SUBJECT_MAX ? `${line.slice(0, SUBJECT_MAX - 1)}…` : line;
};

const textField = (record: Record<string, unknown>, ...names: ReadonlyArray<string>) => {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value !== "") return value;
    if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string"))
      return value.join(" ");
  }
  return null;
};

/**
 * What a request asks, from what the adapters record: Codex's command and file-change approvals
 * (`detail` is the provider's params, `title` the command), Claude's tool permissions (`detail`
 * carries `toolName` and the tool's input) and either one's questions.
 */
export const sessionAsk = (request: {
  readonly kind: AgentRequestKind;
  readonly title: string | null;
  readonly detail: unknown;
  readonly questions: ReadonlyArray<AgentInputQuestion> | null;
}): SessionAsk => {
  const detail = isRecord(request.detail) ? request.detail : {};
  const input = isRecord(detail["input"]) ? detail["input"] : detail;
  switch (request.kind) {
    case "user-input":
      return { kind: "question", subject: oneLine(request.questions?.[0]?.question ?? null) };
    case "command-approval":
      return {
        kind: "command",
        subject: oneLine(textField(input, "command") ?? request.title),
      };
    case "file-change-approval":
      return { kind: "edit", subject: oneLine(textField(input, "file_path", "path")) };
    case "tool-permission": {
      const tool = textField(detail, "toolName") ?? request.title;
      const command = textField(input, "command");
      if (command !== null) return { kind: "command", subject: oneLine(command) };
      const file = textField(input, "file_path", "notebook_path", "path");
      if (tool !== null && EDIT_TOOLS.has(tool)) return { kind: "edit", subject: oneLine(file) };
      return { kind: "tool", subject: oneLine(tool) };
    }
    case "unknown":
      return { kind: "decision", subject: oneLine(request.title) };
  }
};

/**
 * What a session is called wherever it is listed or opened: its label; else its worktree's name;
 * a worktree Mend named itself (`wt-…`) by its first labelled session's label, else by its first
 * session's id. A session whose worktree is unknown reads `session <id>`. `members` are the
 * worktree's sessions, newest first.
 */
export const sessionTitle = (
  session: { readonly id: string; readonly label: string | null },
  worktree: { readonly name: string } | undefined,
  members: ReadonlyArray<{ readonly id: string; readonly label: string | null }>,
): string => {
  if (session.label !== null) return session.label;
  if (worktree === undefined) return `session ${session.id.slice(0, 8)}`;
  return worktreeTitle(worktree, members);
};

/** A worktree's name as lists show it: see `sessionTitle`. */
export const worktreeTitle = (
  worktree: { readonly name: string },
  members: ReadonlyArray<{ readonly id: string; readonly label: string | null }>,
): string => {
  if (!worktree.name.startsWith("wt-")) return worktree.name;
  const labelled = members.find((member) => member.label !== null)?.label;
  if (labelled !== undefined && labelled !== null) return labelled;
  const first = members[0];
  return first === undefined ? worktree.name : `session ${first.id.slice(0, 8)}`;
};
