import { PgClient } from "@effect/sql-pg";
import { CurrentUser } from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import { MEND_EVENTS_CHANNEL, MendEvent, TeamsRepo } from "@mend/db";
import { Effect, Option, Schedule, Schema, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { ProjectAccess } from "../access.ts";

const encoder = new TextEncoder();
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(MendEvent));

/**
 * Live updates over SSE (ARCHITECTURE.md §4): one stream carrying pointer
 * events from the `mend_events` NOTIFY channel — queue changes, run status,
 * run progress. Clients re-read state through the API on receipt; the comment
 * heartbeat keeps proxies from closing the idle connection.
 *
 * Every pointer is filtered for the subscriber (docs/adr/0002): project-scoped
 * events reach accounts that can see the project, `user` events reach their own
 * account, `team` events reach the team's members. The subscriber's view is
 * re-read when a team or project pointer arrives, so a seat granted mid-stream
 * takes effect without a reconnect. A payload the decoder rejects is dropped —
 * the channel is Mend's own, so that is a defect in an emitter, not a client's
 * concern.
 */
export const EventsRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const auth = yield* Auth;
    const access = yield* ProjectAccess;
    const teams = yield* TeamsRepo;

    yield* router.add("GET", "/api/events", (request) =>
      Effect.gen(function* () {
        const headers = new Headers(Object.entries(request.headers));
        const session = yield* auth.getSession(headers);
        if (Option.isNone(session)) return HttpServerResponse.empty({ status: 401 });
        const userId = session.value.user.id;

        const readView = Effect.gen(function* () {
          const projects = yield* access.visibleProjects();
          const standing = yield* teams.standing(userId);
          return {
            projectIds: new Set<string>(projects.map((project) => project.id)),
            teamIds: new Set<string>(standing.memberOf),
          };
        }).pipe(Effect.provideService(CurrentUser, session.value));

        // One view per connection, refreshed on the pointers that can change it.
        let view = yield* readView;
        const admits = (payload: string) =>
          Effect.gen(function* () {
            const decoded = decodeEvent(payload);
            if (Option.isNone(decoded)) return false;
            const event = decoded.value;
            switch (event.type) {
              case "team": {
                view = yield* readView;
                return view.teamIds.has(event.teamId);
              }
              case "project": {
                // A new or re-scoped project: what the subscriber can see may have moved.
                view = yield* readView;
                return view.projectIds.has(event.projectId);
              }
              case "user":
                return event.userId === userId;
              case "session":
              case "session-progress":
              case "session-process":
              case "agent-conversation":
              case "worktree":
              case "session-change":
              case "review-comment":
                return view.projectIds.has(event.projectId);
              default:
                // Queue-era pointers (issues, runs, briefs) carry no project.
                return true;
            }
          });

        const events = sql.listen(MEND_EVENTS_CHANNEL).pipe(
          Stream.filterEffect(admits),
          Stream.map((payload) => `data: ${payload}\n\n`),
          Stream.orDie,
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
