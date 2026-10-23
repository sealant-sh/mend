import type { AgentInputQuestionDto, AgentRequestDto } from "@mend/agent-conversation";
import { LaunchAdmissionRule } from "@mend/domain/workbench";
import { Option, Schema } from "effect";

import { parseLivePeople, parseRetirementState } from "./session-lines.js";
import type { LandingFact } from "./session-model.js";
import {
  SESSION_STATUSES,
  HandoffProvenance,
  type Effort,
  type HarnessModelCatalog,
  type Project,
  type ProjectDetail,
  type Session,
  type SessionDetail,
  type SessionProcess,
  type SessionStatus,
  type AgentWaitView,
  type Worktree,
} from "./types.js";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const stringField = (value: Record<string, unknown>, field: string): string => {
  const found = value[field];
  if (typeof found !== "string") throw new Error(`Mend returned an invalid ${field}.`);
  return found;
};

const nullableStringField = (value: Record<string, unknown>, field: string): string | null => {
  const found = value[field];
  if (found === null) return null;
  if (typeof found !== "string") throw new Error(`Mend returned an invalid ${field}.`);
  return found;
};

export const parseProject = (value: unknown): Project => {
  if (!isRecord(value)) throw new Error("Mend returned an invalid project.");
  return {
    id: stringField(value, "id"),
    name: stringField(value, "name"),
    originUrl: nullableStringField(value, "originUrl"),
    storePath: stringField(value, "storePath"),
    defaultBranch: stringField(value, "defaultBranch"),
  };
};

const parseSessionStatus = (value: unknown): SessionStatus => {
  const status = SESSION_STATUSES.find((candidate) => candidate === value);
  if (status !== undefined) return status;
  throw new Error("Mend returned an invalid session status.");
};

export const parseSession = (value: unknown): Session => {
  if (!isRecord(value)) throw new Error("Mend returned an invalid session.");
  return {
    id: stringField(value, "id"),
    projectId: stringField(value, "projectId"),
    // Present once the server is worktree-aware; older servers omit it.
    ...(typeof value["worktreeId"] === "string" ? { worktreeId: value["worktreeId"] } : {}),
    ...(typeof value["sealantRunId"] === "string" ? { sealantRunId: value["sealantRunId"] } : {}),
    harness: stringField(value, "harness"),
    // Recorded since the server owns the model catalog; older servers omit it.
    model: typeof value["model"] === "string" ? value["model"] : null,
    label: nullableStringField(value, "label"),
    worktree: stringField(value, "worktree"),
    branch: stringField(value, "branch"),
    status: parseSessionStatus(value["status"]),
    // Tolerant: an older server may omit the field; editor open can resume to obtain an id.
    sealantWorkspaceId:
      typeof value["sealantWorkspaceId"] === "string" ? value["sealantWorkspaceId"] : null,
    summary: typeof value["summary"] === "string" ? value["summary"] : null,
    createdAt: stringField(value, "createdAt"),
    settledAt: typeof value["settledAt"] === "string" ? value["settledAt"] : null,
    ownerUserId: typeof value["ownerUserId"] === "string" ? value["ownerUserId"] : null,
    livePeople: parseLivePeople(value["livePeople"]),
    sharedControlEnabledAt:
      typeof value["sharedControlEnabledAt"] === "string" ? value["sharedControlEnabledAt"] : null,
    workspaceRetirement: parseRetirementState(value["workspaceRetirement"]),
    workspaceLauncherUserId:
      typeof value["workspaceLauncherUserId"] === "string"
        ? value["workspaceLauncherUserId"]
        : null,
  };
};

export const parseArray = <T>(
  value: unknown,
  parse: (item: unknown) => T,
  label: string,
): ReadonlyArray<T> => {
  if (!Array.isArray(value)) throw new Error(`Mend returned invalid ${label}.`);
  return value.map(parse);
};

const EFFORTS: ReadonlyArray<Effort> = ["low", "medium", "high", "xhigh", "max", "ultra"];

const parseEfforts = (value: unknown): ReadonlyArray<Effort> => {
  if (!Array.isArray(value)) throw new Error("Mend returned invalid efforts.");
  return value.map((item) => {
    const effort = EFFORTS.find((candidate) => candidate === item);
    if (effort === undefined) throw new Error("Mend returned an invalid effort.");
    return effort;
  });
};

export const parseHarnessModelCatalog = (value: unknown): HarnessModelCatalog => {
  if (!isRecord(value)) throw new Error("Mend returned an invalid model catalog.");
  return {
    harness: stringField(value, "harness"),
    models: parseArray(
      value["models"],
      (item) => {
        if (!isRecord(item)) throw new Error("Mend returned an invalid model.");
        return {
          id: stringField(item, "id"),
          label: stringField(item, "label"),
          isDefault: item["isDefault"] === true,
          efforts: item["efforts"] === null ? null : parseEfforts(item["efforts"]),
        };
      },
      "models",
    ),
    defaultModel: nullableStringField(value, "defaultModel"),
    efforts: parseEfforts(value["efforts"]),
    fastCapable: value["fastCapable"] === true,
  };
};

const decodeHandoffProvenance = Schema.decodeUnknownOption(HandoffProvenance);

const parseHandoffProvenance = (value: unknown): HandoffProvenance | null => {
  if (value === undefined || value === null) return null;
  return Option.getOrThrowWith(
    decodeHandoffProvenance(value),
    () => new Error("Mend returned an invalid handoff."),
  );
};

export const parseWorktree = (value: unknown): Worktree => {
  if (!isRecord(value)) throw new Error("Mend returned an invalid worktree.");
  return {
    id: stringField(value, "id"),
    name: stringField(value, "name"),
    directory: stringField(value, "directory"),
    branch: stringField(value, "branch"),
    baseSha: stringField(value, "baseSha"),
    baseRef: nullableStringField(value, "baseRef"),
    createdAt: stringField(value, "createdAt"),
    handoff: parseHandoffProvenance(value["handoff"]),
  };
};

export const parseProjectDetail = (value: unknown): ProjectDetail => {
  if (!isRecord(value)) throw new Error("Mend returned an invalid project detail.");
  return {
    project: parseProject(value["project"]),
    sessions: parseArray(value["sessions"], parseSession, "sessions"),
    // The worktree tier is the capability signal: absent on a pre-worktree server.
    ...(Array.isArray(value["worktrees"])
      ? { worktrees: parseArray(value["worktrees"], parseWorktree, "worktrees") }
      : {}),
  };
};

export const parseSessionProcess = (value: unknown): SessionProcess => {
  if (!isRecord(value)) throw new Error("Mend returned an invalid session process.");
  const exitedAt = value["exitedAt"];
  return {
    id: stringField(value, "id"),
    kind: stringField(value, "kind"),
    harness: nullableStringField(value, "harness"),
    status: stringField(value, "status"),
    exitedAt: exitedAt === null || exitedAt === undefined ? null : String(exitedAt),
    providerSessionId: nullableStringField(value, "providerSessionId"),
    label: typeof value["label"] === "string" ? value["label"] : null,
    runsAs: typeof value["runsAs"] === "string" ? value["runsAs"] : null,
    waiting: parseAgentWait(value["waiting"]),
  };
};

const WAIT_KINDS: ReadonlyArray<AgentWaitView["kind"]> = ["permission", "question", "prompt"];

/** A terminal agent's reported wait (G4); absent, malformed and older servers read as none. */
const parseAgentWait = (value: unknown): AgentWaitView | null => {
  if (!isRecord(value) || typeof value["since"] !== "string") return null;
  const kind = WAIT_KINDS.find((candidate) => candidate === value["kind"]);
  if (kind === undefined) return null;
  return {
    kind,
    tool: typeof value["tool"] === "string" ? value["tool"] : null,
    since: value["since"],
  };
};

/** A conversation's pending request: what it asks, and which of the session's processes asks. */
export interface PendingRequest extends AgentRequestDto {
  readonly sessionId: string;
  readonly processId: string;
}

const parseQuestion = (value: unknown): AgentInputQuestionDto => {
  if (!isRecord(value)) throw new Error("Mend returned an invalid question.");
  return {
    id: stringField(value, "id"),
    header: nullableStringField(value, "header"),
    question: stringField(value, "question"),
    options: parseArray(
      value["options"],
      (option) => {
        if (!isRecord(option)) throw new Error("Mend returned an invalid option.");
        return {
          label: stringField(option, "label"),
          description: nullableStringField(option, "description"),
        };
      },
      "options",
    ),
    multiSelect: value["multiSelect"] === true,
  };
};

/** A request row; null for one no longer pending, which nothing here may answer. */
const parsePendingRequest = (value: unknown): PendingRequest | null => {
  if (!isRecord(value)) throw new Error("Mend returned an invalid request.");
  if (value["status"] !== "pending") return null;
  const questions = value["questions"];
  return {
    id: stringField(value, "id"),
    sessionId: stringField(value, "sessionId"),
    processId: stringField(value, "processId"),
    turnId: stringField(value, "turnId"),
    kind: stringField(value, "kind"),
    title: typeof value["title"] === "string" ? value["title"] : null,
    detail: value["detail"] ?? null,
    questions:
      questions === null || questions === undefined
        ? null
        : parseArray(questions, parseQuestion, "questions"),
    status: "pending",
    decision: null,
    answers: null,
    createdAt: stringField(value, "createdAt"),
  };
};

export const parsePendingRequests = (value: unknown): ReadonlyArray<PendingRequest> =>
  parseArray(value, parsePendingRequest, "requests").filter((request) => request !== null);

const LANDED_OUTCOMES: ReadonlySet<unknown> = new Set(["pushed", "pull-request", "adopted"]);
const PULL_REQUEST_STATES: ReadonlyArray<"open" | "closed" | "merged"> = [
  "open",
  "closed",
  "merged",
];

/** The newest landing that reached origin (or adopted a pull request); null when none did. */
export const parseLanding = (value: unknown): LandingFact | null => {
  if (!isRecord(value) || !Array.isArray(value["landings"])) return null;
  for (const landing of value["landings"]) {
    if (!isRecord(landing) || !LANDED_OUTCOMES.has(landing["outcome"])) continue;
    const pullRequest = landing["pullRequest"];
    const state = isRecord(pullRequest)
      ? PULL_REQUEST_STATES.find((candidate) => candidate === pullRequest["state"])
      : undefined;
    return {
      id: stringField(landing, "id"),
      userId: stringField(landing, "userId"),
      createdAt: stringField(landing, "createdAt"),
      remoteBranch: stringField(landing, "remoteBranch"),
      pullRequest:
        isRecord(pullRequest) && typeof pullRequest["number"] === "number" && state !== undefined
          ? { number: pullRequest["number"], state }
          : null,
    };
  }
  return null;
};

/** What `/api/events` says changed: a pointer the store re-reads, never data. */
export interface EventPointer {
  readonly type: string;
  readonly sessionId: string | null;
  readonly projectId: string | null;
  /** The change a `session-change` or `review-comment` frame is about. */
  readonly changeId: string | null;
  /** A `user` frame's part of the account: `access` when it was removed or lost its sign-in. */
  readonly facet: string | null;
}

export const parseEventPointer = (data: string): EventPointer | null => {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value["type"] !== "string") return null;
  return {
    type: value["type"],
    sessionId: typeof value["sessionId"] === "string" ? value["sessionId"] : null,
    projectId: typeof value["projectId"] === "string" ? value["projectId"] : null,
    changeId: typeof value["changeId"] === "string" ? value["changeId"] : null,
    facet: typeof value["facet"] === "string" ? value["facet"] : null,
  };
};

/** What the event stream tells its subscriber. */
export type StreamSignal =
  /** A stream opened: whatever changed while none was open was never announced. */
  | { readonly kind: "opened" }
  /** Any bytes, the heartbeat included: Mend was heard now. */
  | { readonly kind: "heard" }
  | { readonly kind: "event"; readonly event: EventPointer }
  /** Mend itself refused the stream's sign-in (401 or 403): it answers, but not to this sign-in. */
  | { readonly kind: "refused" }
  /** The stream failed or went quiet past the heartbeat; it is tried again. */
  | { readonly kind: "lost" };

export const parseSessionDetail = (value: unknown): SessionDetail => {
  if (!isRecord(value)) throw new Error("Mend returned an invalid session detail.");
  const currentAgent = value["currentAgent"];
  const change = value["change"];
  return {
    session: parseSession(value["session"]),
    processes: parseArray(value["processes"], parseSessionProcess, "processes"),
    currentAgent:
      currentAgent === null || currentAgent === undefined
        ? null
        : parseSessionProcess(currentAgent),
    changeId: isRecord(change) && typeof change["id"] === "string" ? change["id"] : null,
    launchAdmission: Option.getOrNull(
      Schema.decodeUnknownOption(LaunchAdmissionRule)(value["launchAdmission"]),
    ),
  };
};
