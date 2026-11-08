import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

import type {
  ProjectPreviewView,
  ProofArtifactView,
  SessionDetail,
  WorktreePreviews,
} from "@mend/api-contracts";
import {
  parseDuration,
  type ResourcesPage,
  type ResourceStarted,
  type ServiceView,
} from "@mend/domain/workbench";
import type { Schema } from "effect";

import { sessionWebUrl, type ConversationBoundary } from "./agent-conversation-command.ts";
import {
  CommandInputError,
  needsInput,
  readinessResult,
  type CommandResult,
} from "./command-result.ts";
import { resolveOnboardingProject } from "./onboarding-command.ts";
import { takeFlagValue } from "./shared.ts";

export interface ObservationBoundary extends ConversationBoundary {
  readonly fetchMedia: (route: string, signal: AbortSignal) => Promise<Response>;
}

type Proof = Schema.Codec.Encoded<typeof ProofArtifactView>;
type Detail = Schema.Codec.Encoded<typeof SessionDetail>;

const wordsOf = (args: ReadonlyArray<string>, flags: ReadonlyArray<string>) =>
  args.filter((word, index) => !word.startsWith("--") && !flags.includes(args[index - 1] ?? ""));

class MediaFailure extends Error {
  readonly code: string;
  readonly fix: string;
  constructor(code: string, message: string, fix: string) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}

const timed = async (
  args: ReadonlyArray<string>,
  defaultMs: number,
  work: (signal: AbortSignal) => Promise<CommandResult<unknown>>,
): Promise<CommandResult<unknown>> => {
  const value = takeFlagValue(args, "--timeout");
  const timeout = value === null ? defaultMs : parseDuration(value);
  if (timeout === null) return needsInput("Invalid timeout.", "Pass --timeout 30s, 10m or 1h.");
  const pending = new AbortController();
  const timer = setTimeout(() => pending.abort(), timeout);
  try {
    return await work(pending.signal);
  } catch (error) {
    if (!pending.signal.aborted) {
      if (error instanceof MediaFailure)
        return {
          status: "failed",
          error: { code: error.code, message: error.message, fix: error.fix },
        };
      throw error;
    }
    return {
      status: "timeout",
      error: {
        code: "timeout",
        message: "The observation did not finish before the deadline.",
        fix: "Retry with a longer --timeout. Running sessions and resources keep running.",
      },
    };
  } finally {
    clearTimeout(timer);
  }
};

const sessionDetail = async (
  boundary: ConversationBoundary,
  word: string,
  signal?: AbortSignal,
): Promise<Detail> => {
  const session = await boundary.resolve(word, signal);
  return boundary.api<Detail>("GET", `/sessions/${session.id}`, undefined, signal);
};

export const previewCommand = async (
  boundary: ConversationBoundary,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  if (args[0] === "use" || args[0] === "start" || args[0] === "project")
    return projectPreviewCommand(boundary, args[0], args.slice(1));
  const [word, extra] = wordsOf(args, []);
  if (word === undefined || extra !== undefined)
    return needsInput("Name one session for the preview.", "Run mend preview <session> --json.");
  const detail = await sessionDetail(boundary, word);
  const worktreeId = detail.session.worktreeId;
  const previews = await boundary.api<Schema.Codec.Encoded<typeof WorktreePreviews>>(
    "GET",
    `/worktrees/${worktreeId}/previews`,
  );
  const data = {
    sessionId: detail.session.id,
    worktreeId,
    url: `${sessionWebUrl(boundary.url, detail.session.id)}/preview`,
    starting: previews.starting,
    routing: previews.routing,
    unprepared: previews.unprepared,
    previews: previews.previews.map((row) => ({
      id: row.preview.id,
      label: row.preview.label,
      serviceName: row.preview.serviceName,
      state: row.preview.state,
      status: row.status,
      binding:
        row.binding._tag === "Bound"
          ? { state: "bound", serviceId: row.binding.serviceId, attemptId: row.binding.attemptId }
          : { state: "unbound", reason: row.binding.reason },
    })),
  };
  return readinessResult(data, [
    {
      id: "preview",
      state: previews.previews.some((row) => row.preview.state === "kept" && row.open !== null)
        ? "ok"
        : "todo",
      detail:
        previews.unprepared ??
        (previews.starting
          ? "Preview preparation is running."
          : previews.previews.flatMap((row) => row.status).join("; ") ||
            "No prepared preview was observed."),
      fix: "Ask the session's agent to start the declared preview Service, then open the Preview tab with your own browser sign-in.",
    },
  ]);
};

const projectPreviewCommand = async (
  boundary: ConversationBoundary,
  operation: "use" | "start" | "project",
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  const names = wordsOf(args, ["--project"]);
  const defaultTarget = args.includes("--default");
  if (
    operation === "use"
      ? defaultTarget
        ? names.length !== 0
        : names.length !== 1
      : names.length !== 0 || defaultTarget
  )
    return needsInput(
      "Choose one preview target.",
      "Run mend preview use <worktree> or mend preview use --default, with --project <project> if needed.",
    );
  const project = await resolveOnboardingProject(boundary.api, takeFlagValue(args, "--project"));
  if (project === null)
    return needsInput("No adopted project matched this checkout.", "Pass --project <id-or-name>.");
  const root = `/projects/${encodeURIComponent(project.id)}/preview`;
  if (operation === "project")
    return {
      status: "done",
      data: await boundary.api<Schema.Codec.Encoded<typeof ProjectPreviewView>>("GET", root),
    };
  if (operation === "start")
    return {
      status: "done",
      data: await boundary.api<Schema.Codec.Encoded<typeof ProjectPreviewView>>(
        "POST",
        `${root}/start`,
      ),
    };
  if (defaultTarget)
    return {
      status: "done",
      data: await boundary.api<Schema.Codec.Encoded<typeof ProjectPreviewView>>(
        "PUT",
        `${root}/target`,
        { _tag: "Default" },
      ),
    };
  const listing = await boundary.api<{
    readonly worktrees: ReadonlyArray<{ readonly id: string; readonly name: string | null }>;
  }>("GET", `/projects/${encodeURIComponent(project.id)}/worktrees`);
  const worktree = listing.worktrees.find((row) => row.id === names[0] || row.name === names[0]);
  if (worktree === undefined)
    return needsInput(
      "That worktree was not found in this project.",
      "Choose a worktree id or name from mend worktrees, or use --default.",
    );
  return {
    status: "done",
    data: await boundary.api<Schema.Codec.Encoded<typeof ProjectPreviewView>>(
      "PUT",
      `${root}/target`,
      { _tag: "Worktree", worktreeId: worktree.id },
    ),
  };
};

const proofView = ({ artifact, label }: Proof) => {
  const capture = artifact.capture;
  return {
    id: artifact.id,
    changeId: artifact.changeId,
    sessionId: artifact.sessionId,
    worktreeId: artifact.worktreeId,
    turnId: artifact.turnId,
    title: artifact.title,
    caption: artifact.caption,
    label,
    source:
      artifact.source._tag === "Checkpoint"
        ? {
            kind: "checkpoint",
            checkpointId: artifact.source.checkpointId,
            ordinal: artifact.source.ordinal,
            commit: artifact.source.commit,
          }
        : { kind: "unknown", reason: artifact.source.reason },
    observedFrom: artifact.observedFrom,
    observedTo: artifact.observedTo,
    launch: artifact.launch,
    differences: artifact.differences,
    capture:
      capture._tag === "Screenshot" || capture._tag === "Video"
        ? {
            kind: capture._tag === "Screenshot" ? "screenshot" : "video",
            state: "stored",
            media: {
              mimeType: capture.media.mimeType,
              bytes: capture.media.bytes,
              sha256: capture.media.sha256,
            },
            ...(capture._tag === "Video"
              ? { durationMs: capture.durationMs, ending: capture.ending }
              : {}),
          }
        : capture._tag === "Recording"
          ? { kind: "video", state: "recording" }
          : { kind: capture.kind, state: "not-captured", reason: capture.reason },
  };
};

export const proofList = async (
  boundary: ConversationBoundary,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  const [word, extra] = wordsOf(args, []);
  if (word === undefined || extra !== undefined)
    return needsInput(
      "Name one session whose proof to read.",
      "Run mend proof list <session> --json.",
    );
  const detail = await sessionDetail(boundary, word);
  const artifacts =
    detail.change === null
      ? []
      : await boundary.api<ReadonlyArray<Proof>>(
          "GET",
          `/changes/${detail.change.id}/proof-artifacts`,
        );
  return {
    status: "done",
    data: {
      sessionId: detail.session.id,
      changeId: detail.change?.id ?? null,
      artifacts: artifacts.map(proofView),
    },
  };
};

const saveMedia = async (
  response: Response,
  out: string,
  signal: AbortSignal,
  expected: { readonly mimeType: string; readonly bytes?: number; readonly sha256?: string },
) => {
  if (
    response.headers.get("content-type")?.split(";")[0] !== expected.mimeType ||
    response.body === null
  )
    throw new MediaFailure(
      "media_unavailable",
      "Mend did not return the expected media.",
      "Retry the observation or proof download; do not use this response as an image or video.",
    );
  const destination = resolve(out);
  const file = await open(destination, "wx", 0o600).catch(async (error: unknown) => {
    await response.body?.cancel().catch(() => undefined);
    throw new CommandInputError(
      "output_unavailable",
      error instanceof Error && "code" in error && error.code === "EEXIST"
        ? "The output path already exists."
        : "The output path could not be opened.",
      "Choose a new --out path in an existing writable directory.",
    );
  });
  let complete = false;
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
      bytes += chunk.value.byteLength;
      await file.writeFile(chunk.value);
    }
    signal.throwIfAborted();
    const sha256 = hash.digest("hex");
    if (
      (expected.bytes !== undefined && bytes !== expected.bytes) ||
      (expected.sha256 !== undefined && sha256 !== expected.sha256)
    )
      throw new MediaFailure(
        "media_incomplete",
        "The downloaded media does not match its recorded size or digest.",
        "Retry mend proof get with a new --out path.",
      );
    if (bytes === 0)
      throw new MediaFailure(
        "media_empty",
        "The media response was empty.",
        "Retry the observation or download.",
      );
    await file.close();
    complete = true;
    return { out: destination, bytes, sha256, mimeType: expected.mimeType };
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    if (!complete) {
      await file.close().catch(() => undefined);
      await unlink(destination);
    }
  }
};

export const screenLook = async (
  boundary: ObservationBoundary,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  const out = takeFlagValue(args, "--out");
  const [word, extra] = wordsOf(args, ["--out", "--timeout"]);
  if (word === undefined || extra !== undefined || out === null)
    return needsInput(
      "Name one session and an output path.",
      "Run mend screen look <session> --out shot.png --json [--timeout 30s].",
    );
  return timed(args, 30_000, async (signal) => {
    const session = await boundary.resolve(word, signal);
    const response = await boundary.fetchMedia(`/sessions/${session.id}/screen/look`, signal);
    const saved = await saveMedia(response, out, signal, { mimeType: "image/png" });
    return {
      status: "done",
      data: {
        sessionId: session.id,
        screenId: response.headers.get("x-mend-screen-id"),
        observedAt: response.headers.get("x-mend-observed-at"),
        ...saved,
        url: sessionWebUrl(boundary.url, session.id),
      },
    };
  });
};

export const proofGet = async (
  boundary: ObservationBoundary,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  const out = takeFlagValue(args, "--out");
  const [id, extra] = wordsOf(args, ["--out", "--timeout"]);
  if (id === undefined || extra !== undefined || out === null)
    return needsInput(
      "Name one proof artifact and an output path.",
      "Run mend proof get <id> --out proof.png --json [--timeout 5m].",
    );
  return timed(args, 300_000, async (signal) => {
    const proof = await boundary.api<Proof>(
      "GET",
      `/proof-artifacts/${encodeURIComponent(id)}`,
      undefined,
      signal,
    );
    const capture = proof.artifact.capture;
    if (capture._tag !== "Screenshot" && capture._tag !== "Video")
      return readinessResult({ artifact: proofView(proof) }, [
        {
          id: "proof",
          state: "todo",
          detail:
            capture._tag === "NotCaptured" ? capture.reason : "The video is still being captured.",
          fix: "Ask the session's agent to finish or capture the proof, then list it again.",
        },
      ]);
    const response = await boundary.fetchMedia(
      `/proof-artifacts/${encodeURIComponent(id)}/media`,
      signal,
    );
    const saved = await saveMedia(response, out, signal, capture.media);
    return { status: "done", data: { artifact: proofView(proof), ...saved } };
  });
};

export const serviceListJson = async (
  boundary: ConversationBoundary,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  const [word, extra] = wordsOf(args, []);
  if (extra !== undefined)
    return needsInput("Name at most one session.", "Run mend service list [session] --json.");
  const session = word === undefined ? null : await boundary.resolve(word);
  const rows = await boundary.api<ReadonlyArray<Schema.Codec.Encoded<typeof ServiceView>>>(
    "GET",
    "/services",
  );
  return {
    status: "done",
    data: {
      sessionId: session?.id ?? null,
      services: rows
        .filter((row) => session === null || row.service.sessionId === session.id)
        .map((row) => ({
          id: row.service.id,
          sessionId: row.service.sessionId,
          name: row.service.name,
          workspacePort: row.service.workspacePort,
          transport: row.service.transport,
          processId: row.service.currentAttemptId,
          attemptState:
            row.attempts.find((attempt) => attempt.id === row.service.currentAttemptId)?.status ??
            null,
          forwardState: row.currentForward?.state ?? null,
          observation:
            row.latestObservation === null
              ? null
              : {
                  state: row.latestObservation.state,
                  observedAt: row.latestObservation.lastObservedAt,
                  error: row.latestObservation.error,
                },
          endpoints: row.endpoints.map((endpoint) => ({
            authority: endpoint.authority,
            browserUrl: endpoint.browserUrl,
          })),
        })),
    },
  };
};

export const resourceStartJson = async (
  boundary: ConversationBoundary,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  const [name, extra] = wordsOf(args, ["--project-id", "--worktree-id", "--timeout"]);
  const worktreeId = takeFlagValue(args, "--worktree-id");
  const projectName = takeFlagValue(args, "--project-id");
  const level = args.includes("--project")
    ? "project"
    : args.includes("--worktree")
      ? "worktree"
      : null;
  if (
    name === undefined ||
    extra !== undefined ||
    level === null ||
    worktreeId === null ||
    (args.includes("--project") && args.includes("--worktree"))
  )
    return needsInput(
      "Name a resource, its level and source worktree.",
      "Run mend resource start db --project|--worktree --project-id <id> --worktree-id <id> --wait --json.",
    );
  return timed(args, 600_000, async (signal) => {
    const call: ConversationBoundary["api"] = (method, route, body) =>
      boundary.api(method, route, body, signal);
    const project = await resolveOnboardingProject(call, projectName);
    if (project === null)
      throw new CommandInputError(
        "project_not_found",
        "The selected project was not found.",
        "Pass an adopted --project-id from mend change <session> --json, or run in an adopted checkout.",
      );
    const route = `/projects/${project.id}/resources`;
    const start = await call<Schema.Codec.Encoded<typeof ResourceStarted>>(
      "POST",
      `${route}/${encodeURIComponent(name.replace(/^@/, ""))}/start?timeZone=UTC`,
      { level, worktreeId, restart: args.includes("--restart") },
    );
    if (start.kind === "needs-restart")
      return readinessResult(
        {
          kind: start.kind,
          statusLine: start.statusLine,
          worktrees: start.worktrees.map((worktree) => ({ id: worktree.id, name: worktree.name })),
        },
        [
          {
            id: "resource",
            state: "todo",
            detail: start.statusLine,
            fix: `${start.hint} Pass --restart only after the person agrees to restart the named resource.`,
          },
        ],
      );
    let instance = start.instance;
    let statusLine = start.statusLine;
    if (args.includes("--wait")) {
      while (
        instance === "starting" ||
        instance === "not-observed" ||
        instance === "none" ||
        instance === "not-started"
      ) {
        await pause(500, undefined, { signal });
        const page = await call<Schema.Codec.Encoded<typeof ResourcesPage>>(
          "GET",
          `${route}?timeZone=UTC&worktreeId=${encodeURIComponent(worktreeId)}`,
        );
        const row = page.settings.find(
          (setting) =>
            setting.spec.name === name.replace(/^@/, "") &&
            setting.level === level &&
            (level === "project" || setting.worktreeId === worktreeId),
        );
        if (row !== undefined) {
          instance = row.instance;
          statusLine = row.statusLine;
        }
      }
    }
    return readinessResult(
      {
        projectId: project.id,
        worktreeId,
        name,
        level,
        instance,
        statusLine,
        message: start.message,
      },
      [
        {
          id: "resource",
          state:
            instance === "running"
              ? "ok"
              : ["failed", "exited", "unsupported"].includes(instance)
                ? "failed"
                : "todo",
          detail: statusLine,
          fix: "Read the resource's reported failure in Mend and repair its definition or image, then retry the explicit start.",
        },
      ],
    );
  });
};
