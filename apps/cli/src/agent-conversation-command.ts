import { setTimeout as pause } from "node:timers/promises";

import type {
  AgentItem as DomainItem,
  AgentRequest as DomainRequest,
  ConversationTurn as DomainTurn,
} from "@mend/domain/workbench";
import { parseDuration } from "@mend/domain/workbench";

import { needsInput, type CommandResult } from "./command-result.ts";
import { resolveOnboardingProject } from "./onboarding-command.ts";
import { beforeDeadline } from "./run-scripts.ts";
import { parseLaunchArgs, takeFlagValue } from "./shared.ts";

type ConversationTurn = Pick<DomainTurn, "id" | "sessionId" | "ordinal" | "status" | "input"> & {
  readonly clientMessageId: DomainTurn["clientMessageId"];
  readonly steerSender: DomainTurn["steerSender"];
  readonly fromSteer: DomainTurn["fromSteer"];
  readonly steers: ReadonlyArray<ConversationSteer>;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
};
type ConversationSteer = Pick<
  DomainTurn["steers"][number],
  | "id"
  | "sessionId"
  | "turnId"
  | "author"
  | "ordinal"
  | "input"
  | "delivery"
  | "queuedTurnId"
  | "clientSteerId"
  | "clientMessageId"
> & { readonly createdAt: string; readonly updatedAt: string };
type AgentItem = Pick<
  DomainItem,
  "id" | "turnId" | "seq" | "kind" | "status" | "title" | "text" | "data"
> & {
  readonly createdAt: string;
  readonly updatedAt: string;
};
type AgentRequest = Pick<
  DomainRequest,
  | "id"
  | "sessionId"
  | "turnId"
  | "kind"
  | "status"
  | "title"
  | "questions"
  | "detail"
  | "decision"
  | "decidedBy"
  | "answers"
> & { readonly createdAt: string; readonly decidedAt: string | null };

export interface AgentSession {
  readonly id: string;
  readonly worktree: string;
  readonly branch: string;
  readonly status: string;
}

export interface ConversationBoundary {
  readonly api: <T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    route: string,
    body?: unknown,
    signal?: AbortSignal,
  ) => Promise<T>;
  readonly resolve: (word: string, signal?: AbortSignal) => Promise<AgentSession>;
  readonly url: string;
  readonly readStdin: () => Promise<string>;
}

const usage = (message: string, fix: string): CommandResult<never> => ({
  status: "usage",
  error: { code: "usage", message, fix },
});

export const sessionWebUrl = (url: string, id: string): string =>
  `${url.replace(/\/$/, "")}/sessions/${encodeURIComponent(id)}`;

const turnView = (turn: ConversationTurn) => ({
  id: turn.id,
  sessionId: turn.sessionId,
  ordinal: turn.ordinal,
  status: turn.status,
  input: turn.input,
  clientMessageId: turn.clientMessageId ?? null,
  steerSender: turn.steerSender ?? null,
  fromSteer: turn.fromSteer ?? null,
  steers: (turn.steers ?? []).map(steerView),
  createdAt: turn.createdAt,
  startedAt: turn.startedAt,
  endedAt: turn.endedAt,
});

const deliveryView = (delivery: ConversationSteer["delivery"]) => {
  switch (delivery._tag) {
    case "Sending":
      return { _tag: delivery._tag };
    case "Accepted":
      return { _tag: delivery._tag, evidence: delivery.evidence };
    case "Queued":
      return { _tag: delivery._tag, turnId: delivery.turnId, reason: delivery.reason };
    case "Unknown":
    case "NotSent":
      return { _tag: delivery._tag, reason: delivery.reason };
  }
};

const steerView = (steer: ConversationSteer) => ({
  id: steer.id,
  sessionId: steer.sessionId,
  turnId: steer.turnId,
  author: steer.author,
  ordinal: steer.ordinal,
  input: steer.input,
  delivery: deliveryView(steer.delivery),
  queuedTurnId: steer.queuedTurnId,
  clientSteerId: steer.clientSteerId,
  clientMessageId: steer.clientMessageId ?? null,
  createdAt: steer.createdAt,
  updatedAt: steer.updatedAt,
});

const DETAIL_FIELDS: ReadonlySet<string> = new Set([
  "command",
  "cwd",
  "path",
  "paths",
  "reason",
  "toolName",
  "tool_name",
  "input",
  "changes",
  "kind",
  "oldPath",
  "newPath",
  "description",
]);

const visibleDetail = (value: unknown, depth = 0): unknown => {
  if (depth > 5) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  )
    return value;
  if (Array.isArray(value)) return value.map((part: unknown) => visibleDetail(part, depth + 1));
  if (typeof value !== "object") return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => DETAIL_FIELDS.has(key))
      .map(([key, field]) => [key, visibleDetail(field, depth + 1)]),
  );
};

const requestView = (request: AgentRequest) => ({
  id: request.id,
  turnId: request.turnId,
  kind: request.kind,
  status: request.status,
  title: request.title,
  questions: request.questions,
  detail: visibleDetail(request.detail),
  decision: request.decision ?? null,
  decidedBy: request.decidedBy ?? null,
  answers: request.answers ?? null,
  createdAt: request.createdAt,
  decidedAt: request.decidedAt ?? null,
});

const itemView = (item: AgentItem) => ({
  id: item.id,
  turnId: item.turnId,
  seq: item.seq,
  kind: item.kind,
  status: item.status,
  title: item.title,
  text: item.text,
  detail: visibleDetail(item.data),
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
});

export const launchConversation = async (
  boundary: ConversationBoundary,
  harness: string,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  const parsed = parseLaunchArgs(args);
  if (parsed.error !== null) return usage(parsed.error, `Run mend help ${harness}.`);
  if (!parsed.conversation || !parsed.detach || parsed.foreground || parsed.custom.length > 0)
    return usage(
      "A shell conversation launch requires --conversation and --detach.",
      `Run mend ${harness} --detach --conversation --json "<prompt>".`,
    );
  if (!["claude", "codex", "pi"].includes(harness))
    return usage("This harness has no conversation mode.", "Choose claude, codex or pi.");
  const project = await resolveOnboardingProject(boundary.api, parsed.project);
  if (project === null && parsed.project !== null)
    return {
      status: "usage",
      error: {
        code: "project_not_found",
        message: `No adopted project has the id or name "${parsed.project}".`,
        fix: "Run mend projects and choose an existing project, or adopt the repository first.",
      },
    };
  if (project === null)
    return needsInput(
      "No adopted project was selected.",
      "Pass --project <name>, or run mend adopt --json in the checkout first.",
    );
  let name = parsed.name;
  if (parsed.worktree !== null) {
    const detail = await boundary.api<{
      readonly worktrees?: ReadonlyArray<{ readonly name: string }>;
    }>("GET", `/projects/${project.id}`);
    const matches = (detail.worktrees ?? []).filter(
      (worktree) =>
        worktree.name === parsed.worktree || worktree.name.startsWith(parsed.worktree ?? ""),
    );
    const exact = matches.find((worktree) => worktree.name === parsed.worktree);
    name = exact?.name ?? (matches.length === 1 ? (matches[0]?.name ?? null) : null);
    if (name === null)
      return usage(
        "The worktree name is missing or ambiguous.",
        "Pass the full existing --worktree <name>.",
      );
  }
  const session = await boundary.api<AgentSession>("POST", `/projects/${project.id}/sessions`, {
    harness,
    label: null,
    name,
    base: parsed.base,
    ...(parsed.autoLand === null ? {} : { autoLand: parsed.autoLand }),
  });
  await boundary.api("POST", `/sessions/${session.id}/launch`, {
    mode: "protocol",
    ...(parsed.prompt === null ? {} : { prompt: parsed.prompt }),
    ...(parsed.model === null ? {} : { model: parsed.model }),
    ...(parsed.effort === null ? {} : { effort: parsed.effort }),
    ...(parsed.ask ? { permissionMode: "ask" } : {}),
    ...(parsed.fast ? { speed: "fast" } : {}),
  });
  return {
    status: "done",
    data: {
      sessionId: session.id,
      worktree: session.worktree,
      branch: session.branch,
      url: sessionWebUrl(boundary.url, session.id),
    },
  };
};

const positional = (
  args: ReadonlyArray<string>,
  valued: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  args.filter((word, index) => !word.startsWith("-") && !valued.includes(args[index - 1] ?? ""));

export const waitConversation = async (
  boundary: ConversationBoundary,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  const words = positional(args, ["--timeout", "--process"]);
  if (!args.includes("--turn") || args.includes("--process") || words.length > 1)
    return usage(
      "Turn waiting takes one session and no --process.",
      "Run mend wait <session> --turn --json [--timeout 10m].",
    );
  const word = words[0];
  if (word === undefined)
    return needsInput("Name the session to wait for.", "Pass <session> to mend wait --turn.");
  const duration = takeFlagValue(args, "--timeout");
  const timeout = duration === null ? 600_000 : parseDuration(duration);
  if (timeout === null) return usage("Invalid timeout.", "Pass --timeout 90s, 10m or 1h.");
  const clock = {
    now: Date.now,
    sleep: async (ms: number, signal?: AbortSignal) => {
      await pause(ms, undefined, { signal }).catch((error: unknown) => {
        if (!(error instanceof Error) || error.name !== "AbortError") throw error;
      });
    },
  };
  const deadline = clock.now() + timeout;
  const pending = new AbortController();
  const resolved = await beforeDeadline(boundary.resolve(word, pending.signal), clock, deadline);
  const timedOut = (): CommandResult<never> => {
    pending.abort();
    return {
      status: "timeout",
      error: {
        code: "timeout",
        message: "The turn did not end before the deadline.",
        fix: "Run mend wait <session> --turn --json again; the session keeps running.",
      },
    };
  };
  if (!resolved.done) return timedOut();
  const session = resolved.value;
  const url = sessionWebUrl(boundary.url, session.id);
  let target: string | null = null;
  for (;;) {
    const observation = await beforeDeadline(
      Promise.all([
        boundary.api<ReadonlyArray<ConversationTurn>>(
          "GET",
          `/sessions/${session.id}/turns`,
          undefined,
          pending.signal,
        ),
        boundary.api<ReadonlyArray<AgentRequest>>(
          "GET",
          `/sessions/${session.id}/requests?pending=1`,
          undefined,
          pending.signal,
        ),
        boundary.api<{ readonly session: AgentSession }>(
          "GET",
          `/sessions/${session.id}`,
          undefined,
          pending.signal,
        ),
      ]),
      clock,
      deadline,
    );
    if (!observation.done) return timedOut();
    const [turns, requests, detail] = observation.value;
    const latest = turns.reduce<ConversationTurn | null>(
      (newest, turn) => (newest === null || turn.ordinal > newest.ordinal ? turn : newest),
      null,
    );
    target ??= latest?.id ?? null;
    const turn = turns.find((candidate) => candidate.id === target) ?? null;
    const data = {
      sessionId: session.id,
      url,
      turn: turn === null ? null : turnView(turn),
      requests: requests.map(requestView),
    };
    if (requests.length > 0)
      return {
        status: "waiting",
        url,
        data,
        error: {
          code: "needs_human",
          message: "The session is waiting for a person's answer.",
          fix: "Show the requests to the person, then pass their explicit response with mend respond. Never grant permission yourself.",
        },
      };
    if (turn !== null && turn.status !== "running" && turn.status !== "queued")
      return turn.status === "completed"
        ? { status: "done", data }
        : {
            status: "failed",
            data,
            error: {
              code: `turn_${turn.status}`,
              message: `Turn ${turn.status} · observed.`,
              fix: "Read mend history <session> --json before sending another message.",
            },
          };
    if (["completed", "stopped", "failed"].includes(detail.session.status))
      return {
        status: "failed",
        data,
        error: {
          code: "session_ended",
          message: "The session ended before the turn completed.",
          fix: "Read its history; pass --resume to mend message to continue a stopped conversation.",
        },
      };
    if (clock.now() >= deadline) return timedOut();
    await clock.sleep(Math.min(1000, deadline - clock.now()));
  }
};

export const conversationHistory = async (
  boundary: ConversationBoundary,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  const words = positional(args, ["--since"]);
  if (words.length > 1)
    return usage(
      "History takes one session.",
      "Run mend history <session> --json [--since <turn>].",
    );
  const word = words[0];
  if (word === undefined)
    return needsInput("Name the session to read.", "Pass <session> to mend history.");
  const session = await boundary.resolve(word);
  const since = takeFlagValue(args, "--since");
  const turns = new Map<string, ConversationTurn>();
  const items = new Map<string, AgentItem>();
  const requests = new Map<string, AgentRequest>();
  let before: string | null = null;
  let from: ConversationTurn | undefined;
  const cursors = new Set<string>();
  do {
    const query: string = `?limit=100${before === null ? "" : `&before=${encodeURIComponent(before)}`}`;
    const [itemPage, turnPage, requestPage] = await Promise.all([
      boundary.api<{ readonly items: ReadonlyArray<AgentItem>; readonly next: string | null }>(
        "GET",
        `/sessions/${session.id}/history/items${query}`,
      ),
      boundary.api<{ readonly turns: ReadonlyArray<ConversationTurn> }>(
        "GET",
        `/sessions/${session.id}/history/turns${query}`,
      ),
      boundary.api<{ readonly requests: ReadonlyArray<AgentRequest> }>(
        "GET",
        `/sessions/${session.id}/history/requests${query}`,
      ),
    ]);
    for (const item of itemPage.items) items.set(item.id, item);
    for (const turn of turnPage.turns) turns.set(turn.id, turn);
    for (const request of requestPage.requests) requests.set(request.id, request);
    if (since !== null) from = turns.get(since);
    before = itemPage.next;
    if (before !== null && cursors.has(before)) throw new Error("Repeated history cursor");
    if (before !== null) cursors.add(before);
    // A turn can span windows. Read until a strictly older turn is present.
    const ordinal = from?.ordinal;
    if (ordinal !== undefined && turnPage.turns.some((turn) => turn.ordinal < ordinal)) break;
  } while (before !== null);
  if (since !== null && from === undefined)
    return usage(
      "The starting turn does not belong to this session.",
      "Pass a full turn id from mend history <session> --json.",
    );
  const selected = [...turns.values()]
    .filter((turn) => from === undefined || turn.ordinal >= from.ordinal)
    .toSorted((a, b) => a.ordinal - b.ordinal);
  const ids = new Set(selected.map((turn) => turn.id));
  return {
    status: "done",
    data: {
      sessionId: session.id,
      url: sessionWebUrl(boundary.url, session.id),
      turns: selected.map(turnView),
      items: [...items.values()]
        .filter((item) => ids.has(item.turnId))
        .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq)
        .map(itemView),
      requests: [...requests.values()]
        .filter((request) => ids.has(request.turnId))
        .map(requestView),
    },
  };
};

const answersOf = (raw: unknown): raw is Readonly<Record<string, ReadonlyArray<string>>> =>
  typeof raw === "object" &&
  raw !== null &&
  !Array.isArray(raw) &&
  Object.values(raw).every(
    (value: unknown) =>
      Array.isArray(value) && value.every((answer: unknown) => typeof answer === "string"),
  );

export const respondConversation = async (
  boundary: ConversationBoundary,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  const words = positional(args, ["--decision", "--answers"]);
  const id = words[0];
  if (id === undefined)
    return needsInput(
      "Name the pending request.",
      "Pass <request> and --decision or --answers containing the person's response.",
    );
  const decision = takeFlagValue(args, "--decision");
  const answers = takeFlagValue(args, "--answers");
  if (words.length !== 1 || (decision === null) === (answers === null))
    return usage(
      "Pass exactly one response.",
      "Use --decision accept|accept-for-session|decline|cancel, or --answers '<question-id to string-array JSON>'. Forward only the person's explicit answer.",
    );
  let body: object;
  if (decision !== null) {
    if (!["accept", "accept-for-session", "decline", "cancel"].includes(decision))
      return usage("Unknown decision.", "Pass accept, accept-for-session, decline or cancel.");
    body = { decision };
  } else {
    let raw: unknown;
    try {
      raw = JSON.parse(answers === "-" ? await boundary.readStdin() : (answers ?? ""));
    } catch {
      return usage(
        "Answers must be JSON.",
        "Pass --answers '<question-id to string-array JSON>', or --answers - to read stdin.",
      );
    }
    if (!answersOf(raw))
      return usage(
        "Each question id needs an array of answers.",
        `Use --answers '{"question-id":["the person's answer"]}'.`,
      );
    body = { answers: raw };
  }
  const response = await boundary.api<AgentRequest>(
    "POST",
    `/requests/${encodeURIComponent(id)}/respond`,
    body,
  );
  return {
    status: "done",
    data: { request: requestView(response), url: sessionWebUrl(boundary.url, response.sessionId) },
  };
};

export const interruptConversation = async (
  boundary: ConversationBoundary,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  const words = positional(args, []);
  if (words.length !== 1)
    return needsInput("Name one session to interrupt.", "Run mend interrupt <session> --json.");
  const session = await boundary.resolve(words[0] ?? "");
  const turns = await boundary.api<ReadonlyArray<ConversationTurn>>(
    "GET",
    `/sessions/${session.id}/turns`,
  );
  const running = turns.filter((turn) => turn.status === "running");
  if (running.length !== 1)
    return usage(
      "There is no single running turn to interrupt.",
      "Read mend history <session> --json.",
    );
  const turn = running[0];
  if (turn === undefined) throw new Error("Missing running turn");
  await boundary.api("POST", `/turns/${encodeURIComponent(turn.id)}/interrupt`);
  return {
    status: "done",
    data: {
      sessionId: session.id,
      turnId: turn.id,
      interruptRequested: true,
      url: sessionWebUrl(boundary.url, session.id),
    },
  };
};

export const stopAgentJson = async (
  boundary: ConversationBoundary,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  if (args.some((word) => word.startsWith("-") && !["--json", "--services"].includes(word)))
    return usage("JSON stop takes one session.", "Run mend stop <session> [--services] --json.");
  const words = positional(args, []);
  if (words.length !== 1)
    return needsInput("Name one session to stop.", "Run mend stop <session> --json.");
  const session = await boundary.resolve(words[0] ?? "");
  if (args.includes("--services")) {
    const result = await boundary.api<{ readonly stopped: number }>(
      "POST",
      `/sessions/${session.id}/services/stop`,
    );
    return {
      status: "done",
      data: {
        sessionId: session.id,
        stopped: result.stopped,
        url: sessionWebUrl(boundary.url, session.id),
      },
    };
  }
  const stopped = await boundary.api<AgentSession>("POST", `/sessions/${session.id}/stop`);
  return {
    status: "done",
    data: {
      sessionId: session.id,
      status: stopped.status,
      url: sessionWebUrl(boundary.url, session.id),
    },
  };
};
