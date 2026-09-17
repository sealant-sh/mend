import { Auth } from "@mend/auth";
import type { MendEvent } from "@mend/db";
import { Effect, Option, Ref, Schedule, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { ProjectAccess } from "../access.ts";
import { EventBus, type BusSignal } from "../events-bus.ts";

const encoder = new TextEncoder();

/** Which part of the caller's view an event belongs to (docs/adr/0003-organizations-and-tenancy.md). */
export type EventAudience =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "organization"; readonly organizationId: string }
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "operator" };

export const audienceOf = (event: MendEvent): EventAudience => {
  switch (event.type) {
    case "project":
    case "session":
    case "session-progress":
    case "session-process":
    case "agent-conversation":
    case "worktree":
    case "session-change":
    case "review-comment":
      return { kind: "project", projectId: event.projectId };
    case "organization":
      return { kind: "organization", organizationId: event.organizationId };
    case "user":
      return { kind: "user", userId: event.userId };
    case "issue":
    case "run":
    case "run-progress":
    case "brief":
    case "brief-comment":
      // The retired queue has no project to scope by; it is the operator's.
      return { kind: "operator" };
  }
};

/** What one stream may deliver, refreshed when membership or visibility can have moved. */
export interface EventView {
  readonly userId: string;
  readonly organizationId: string | null;
  readonly projectIds: ReadonlySet<string>;
  readonly operator: boolean;
}

export const admits = (view: EventView, audience: EventAudience): boolean => {
  switch (audience.kind) {
    case "project":
      return view.projectIds.has(audience.projectId);
    case "organization":
      return view.organizationId === audience.organizationId;
    case "user":
      return view.userId === audience.userId;
    case "operator":
      return view.operator;
  }
};

/**
 * Live updates over SSE (ARCHITECTURE.md §4): pointer events from the shared event bus, filtered
 * to what the caller can see. A `project` or `organization` event re-reads the caller's view first,
 * since visibility or membership may be what changed, and is delivered when the project or
 * organization was visible before or after, so a client also learns that something left its view.
 * Clients re-read state through the API on receipt; the comment heartbeat keeps proxies from
 * closing the idle connection.
 */
export const EventsRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    const bus = yield* EventBus;
    const access = yield* ProjectAccess;

    const viewOf = (userId: string) =>
      Effect.gen(function* () {
        const viewer = yield* access.viewerOf(userId);
        const projects = yield* access.visibleProjectsOf(userId);
        const view: EventView = {
          userId,
          organizationId: viewer?.organizationId ?? null,
          projectIds: new Set<string>(projects.map((project) => project.id)),
          operator: yield* access.isOperator(userId),
        };
        return view;
      });

    yield* router.add("GET", "/api/events", (request) =>
      Effect.gen(function* () {
        const headers = new Headers(Object.entries(request.headers));
        const session = yield* auth.getSession(headers);
        if (Option.isNone(session)) return HttpServerResponse.empty({ status: 401 });
        const userId = session.value.user.id;
        const view = yield* Ref.make(yield* viewOf(userId));

        /** The SSE frame for one bus signal, or null when this caller must not see it. */
        const frameFor = (signal: BusSignal) =>
          Effect.gen(function* () {
            if (signal.kind === "resync") return `data: {"type":"resync"}\n\n`;
            const audience = audienceOf(signal.event);
            const before = yield* Ref.get(view);
            if (audience.kind === "project" && signal.event.type === "project") {
              const after = yield* viewOf(userId);
              yield* Ref.set(view, after);
              return admits(before, audience) || admits(after, audience)
                ? `data: ${signal.payload}\n\n`
                : null;
            }
            if (audience.kind === "organization") {
              if (!admits(before, audience)) return null;
              yield* Ref.set(view, yield* viewOf(userId));
              return `data: ${signal.payload}\n\n`;
            }
            return admits(before, audience) ? `data: ${signal.payload}\n\n` : null;
          });

        const events = Stream.unwrap(
          Effect.map(bus.subscribe, (subscription) => Stream.fromSubscription(subscription)),
        ).pipe(
          Stream.mapEffect(frameFor),
          Stream.filter((frame): frame is string => frame !== null),
        );
        const heartbeat = Stream.fromSchedule(Schedule.spaced("25 seconds")).pipe(
          Stream.map(() => ": ping\n\n"),
        );

        return HttpServerResponse.stream(
          Stream.merge(events, heartbeat).pipe(Stream.map((chunk) => encoder.encode(chunk))),
          {
            contentType: "text/event-stream",
            headers: { "cache-control": "no-cache", connection: "keep-alive" },
          },
        );
      }),
    );
  }),
);
