import { Auth } from "@mend/auth";
import { ProjectsRepo, type MendEvent } from "@mend/db";
import { ProjectId } from "@mend/domain";
import { Deferred, Effect, Option, Ref, Schedule, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { ProjectAccess } from "../access.ts";
import { Budgets } from "../budgets.ts";
import { ConnectionRegistry } from "../connections.ts";
import { EventBus, type BusSignal } from "../events-bus.ts";
import { connectionRefusal } from "../socket-budgets.ts";

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
    case "shared-control-off":
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

/** How often a stream re-reads its view even without a membership or visibility event. */
const VIEW_REFRESH = "25 seconds";

/**
 * Live updates over SSE (ARCHITECTURE.md §4): pointer events from the shared event bus, filtered
 * to what the caller can see (docs/adr/0003). The caller's view is re-read when a `project` event
 * concerns their organization, when an `organization` event concerns them (including joining
 * one), after a `resync`, and on every heartbeat, so a pointer the sliding bus buffer dropped
 * cannot keep a project visible for long. A `project` event is delivered when the project was
 * visible before or after the refresh, so a client also learns that something left its view.
 * Clients re-read state through the API on receipt; the comment heartbeat keeps proxies from
 * closing the idle connection.
 */
export const EventsRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    const bus = yield* EventBus;
    const access = yield* ProjectAccess;
    const projects = yield* ProjectsRepo;
    const connections = yield* ConnectionRegistry;
    const budgets = yield* Budgets;

    const viewOf = (userId: string) =>
      Effect.gen(function* () {
        const viewer = yield* access.viewerOf(userId);
        const visible = yield* access.visibleProjectsOf(userId);
        const view: EventView = {
          userId,
          organizationId: viewer?.organizationId ?? null,
          projectIds: new Set<string>(visible.map((project) => project.id)),
          operator: yield* access.isOperator(userId),
        };
        return view;
      });

    /** Whether a `project` event can change this view: its project is visible or in their organization. */
    const concerns = (view: EventView, projectId: string) =>
      Effect.gen(function* () {
        if (view.projectIds.has(projectId)) return true;
        if (view.organizationId === null) return false;
        const row = yield* projects
          .byId(ProjectId.make(projectId))
          .pipe(Effect.catchTag("ProjectNotFoundError", () => Effect.succeed(null)));
        return row !== null && row.organizationId === view.organizationId;
      });

    yield* router.add("GET", "/api/events", (request) =>
      Effect.gen(function* () {
        const headers = new Headers(Object.entries(request.headers));
        const session = yield* auth.getSession(headers);
        if (Option.isNone(session)) return HttpServerResponse.empty({ status: 401 });
        const userId = session.value.user.id;
        // One account holds a bounded number of streams; a refused one subscribes to nothing.
        const overBudget = yield* connectionRefusal(budgets, connections, userId, "event-stream");
        if (overBudget !== null) return overBudget;
        const view = yield* Ref.make(yield* viewOf(userId));
        const refresh = Effect.gen(function* () {
          const next = yield* viewOf(userId);
          yield* Ref.set(view, next);
          return next;
        });

        /** The SSE frame for one signal, or null when this caller must not see it. */
        const frameFor = (signal: BusSignal | { readonly kind: "tick" }) =>
          Effect.gen(function* () {
            if (signal.kind === "tick") {
              yield* refresh;
              return ": ping\n\n";
            }
            if (signal.kind === "resync") {
              yield* refresh;
              return `data: {"type":"resync"}\n\n`;
            }
            const frame = `data: ${signal.payload}\n\n`;
            const audience = audienceOf(signal.event);
            const before = yield* Ref.get(view);
            if (signal.event.type === "project" && audience.kind === "project") {
              if (!(yield* concerns(before, audience.projectId))) return null;
              const after = yield* refresh;
              return admits(before, audience) || admits(after, audience) ? frame : null;
            }
            if (audience.kind === "organization") {
              // A member's own organization, or any organization for an account in none yet:
              // it may have just joined this one.
              if (!admits(before, audience) && before.organizationId !== null) return null;
              const after = yield* refresh;
              return admits(before, audience) || admits(after, audience) ? frame : null;
            }
            return admits(before, audience) ? frame : null;
          });

        // Removing the account ends the stream; the client's reconnect is then refused.
        const revoked = yield* Deferred.make<void>();
        const events = Stream.unwrap(
          Effect.gen(function* () {
            const end = Deferred.succeed(revoked, undefined).pipe(Effect.asVoid);
            yield* connections.register(userId, end, undefined, "event-stream");
            // A removal that landed between sign-in and registration ends the stream too.
            if (Option.isNone(yield* auth.getSession(headers))) yield* end;
            const subscription = yield* bus.subscribe;
            return Stream.fromSubscription(subscription);
          }),
        );
        const ticks = Stream.fromSchedule(Schedule.spaced(VIEW_REFRESH)).pipe(
          Stream.map(() => ({ kind: "tick" as const })),
        );

        return HttpServerResponse.stream(
          Stream.merge(events, ticks).pipe(
            Stream.interruptWhen(Deferred.await(revoked)),
            Stream.mapEffect(frameFor),
            Stream.filter((frame): frame is string => frame !== null),
            Stream.map((chunk) => encoder.encode(chunk)),
          ),
          {
            contentType: "text/event-stream",
            headers: { "cache-control": "no-cache", connection: "keep-alive" },
          },
        );
      }),
    );
  }),
);
