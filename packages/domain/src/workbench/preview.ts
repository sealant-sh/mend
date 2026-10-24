import { Schema } from "effect";

import {
  PreviewId,
  PreviewLabel,
  ProjectId,
  ServiceId,
  SessionProcessId,
  WorktreeId,
} from "../ids.ts";
import type { Service } from "./service.ts";
import type { SessionProcess } from "./session-process.ts";

const identity = {
  id: PreviewId,
  serviceName: Schema.String,
  label: PreviewLabel,
};

export const Preview = Schema.Union([
  Schema.Struct({
    ...identity,
    projectId: ProjectId,
    worktreeId: WorktreeId,
    state: Schema.Literal("kept"),
  }),
  Schema.Struct({
    ...identity,
    projectId: Schema.NullOr(ProjectId),
    worktreeId: Schema.Null,
    state: Schema.Literal("removed"),
  }),
]);
export type Preview = typeof Preview.Type;

export const PreviewUnboundReason = Schema.Literals([
  "removed",
  "service-missing",
  "not-browser-service",
  "no-live-attempt",
  "no-recorded-command",
  "https-unsupported",
]);
export type PreviewUnboundReason = typeof PreviewUnboundReason.Type;

export const PreviewBinding = Schema.Union([
  Schema.TaggedStruct("Unbound", { reason: PreviewUnboundReason }),
  Schema.TaggedStruct("Bound", { serviceId: ServiceId, attemptId: SessionProcessId }),
]);
export type PreviewBinding = typeof PreviewBinding.Type;

export const PreviewView = Schema.Struct({ preview: Preview, binding: PreviewBinding });
export type PreviewView = typeof PreviewView.Type;

export interface PreviewTarget {
  readonly service: Service;
  readonly liveAttempt: SessionProcess | null;
  readonly recordedCommand: boolean;
}

const unbound = (reason: PreviewUnboundReason): PreviewBinding => ({ _tag: "Unbound", reason });

const oldestFirst = (
  a: { readonly createdAt: Date; readonly id: string },
  b: { readonly createdAt: Date; readonly id: string },
) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const resolvePreviewBinding = (
  preview: Preview,
  targets: ReadonlyArray<PreviewTarget>,
): PreviewBinding => {
  if (preview.state === "removed") return unbound("removed");
  const named = targets.filter((target) => target.service.name === preview.serviceName);
  const live = named
    .flatMap(({ service, liveAttempt }) =>
      service.browserScheme !== null && liveAttempt !== null
        ? [{ service, attempt: liveAttempt }]
        : [],
    )
    .toSorted((a, b) => oldestFirst(a.attempt, b.attempt))[0];
  if (live !== undefined) {
    if (live.service.browserScheme === "https") return unbound("https-unsupported");
    if (live.attempt.argv.length === 0) return unbound("no-recorded-command");
    return { _tag: "Bound", serviceId: live.service.id, attemptId: live.attempt.id };
  }
  const newest = named.toSorted((a, b) => oldestFirst(b.service, a.service))[0];
  if (newest === undefined) return unbound("service-missing");
  if (newest.service.browserScheme === null) return unbound("not-browser-service");
  if (newest.service.browserScheme === "https") return unbound("https-unsupported");
  const hasCommand = newest.recordedCommand || newest.service.declarationSource === "explicit-run";
  return unbound(hasCommand ? "no-live-attempt" : "no-recorded-command");
};
