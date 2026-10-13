import { SessionNotFoundError, type SessionControlEventsRepo } from "@mend/db";
import { Deferred, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { CAROL_SESSION_IN_SHARED_A, ids } from "../../test/support/tenancy-harness.ts";

type ControlEvent = Parameters<SessionControlEventsRepo["Service"]["record"]>[0];
const stopPath = `/api/sessions/${CAROL_SESSION_IN_SHARED_A}/services/stop`;

describe("service Stop control recording through the HTTP route", () => {
  it.each(["carol", "alice"] as const)(
    "records the actual %s caller after the engine completes, including an organization owner stopping another person's Services",
    async (caller) => {
      const entered = Effect.runSync(Deferred.make<void>());
      const release = Effect.runSync(Deferred.make<void>());
      const events: Array<ControlEvent> = [];
      const timeline: Array<string> = [];
      const api = await createTenancyApi(
        {},
        {
          implement: {
            engine: {
              launchUnderWay: () => false,
              stopServices: (sessionId) =>
                Effect.gen(function* () {
                  timeline.push(`stopping:${sessionId}`);
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  timeline.push(`stopped:${sessionId}`);
                  return 3;
                }),
            },
            controlEvents: {
              record: (event) =>
                Effect.sync(() => {
                  events.push(event);
                  timeline.push(`recorded:${event.sessionId}`);
                }),
            },
          },
        },
      );
      let pending: Promise<Response> | undefined;
      try {
        pending = api.request(caller, "POST", stopPath);
        await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout("3 seconds")));
        expect(timeline).toEqual([`stopping:${CAROL_SESSION_IN_SHARED_A}`]);
        expect(events).toEqual([]);
        await Effect.runPromise(Deferred.succeed(release, undefined));
        const response = await pending;
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          session: { id: CAROL_SESSION_IN_SHARED_A },
          stopped: 3,
        });
        expect(events).toEqual([
          {
            sessionId: CAROL_SESSION_IN_SHARED_A,
            actorUserId: caller,
            kind: "services-stop",
            refId: null,
          },
        ]);
        expect(timeline).toEqual([
          `stopping:${CAROL_SESSION_IN_SHARED_A}`,
          `stopped:${CAROL_SESSION_IN_SHARED_A}`,
          `recorded:${CAROL_SESSION_IN_SHARED_A}`,
        ]);
      } finally {
        await Effect.runPromise(Deferred.succeed(release, undefined));
        try {
          await pending;
        } finally {
          await api.dispose();
        }
      }
    },
  );

  it("does not record a successful control when the engine refuses the Stop", async () => {
    const events: Array<ControlEvent> = [];
    const stopped: Array<string> = [];
    const api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            stopServices: (sessionId) =>
              Effect.sync(() => stopped.push(sessionId)).pipe(
                Effect.andThen(Effect.fail(new SessionNotFoundError({ sessionId }))),
              ),
          },
          controlEvents: {
            record: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          },
        },
      },
    );
    try {
      const response = await api.request("carol", "POST", stopPath);
      expect(response.status).toBe(404);
      expect(stopped).toEqual([CAROL_SESSION_IN_SHARED_A]);
      expect(events).toEqual([]);
    } finally {
      await api.dispose();
    }
  });

  it.each([
    { caller: "carol", sessionId: ids("shared-a").session, status: 403 },
    { caller: "bob", sessionId: CAROL_SESSION_IN_SHARED_A, status: 404 },
  ] as const)(
    "refuses $caller with $status before engine Stop or control recording",
    async ({ caller, sessionId, status }) => {
      const calls: Array<string> = [];
      const api = await createTenancyApi(
        {},
        {
          implement: {
            engine: {
              launchUnderWay: () => false,
              stopServices: (id) =>
                Effect.sync(() => {
                  calls.push(`stop:${id}`);
                  return 0;
                }),
            },
            controlEvents: {
              record: (event) =>
                Effect.sync(() => {
                  calls.push(`record:${event.sessionId}`);
                }),
            },
          },
        },
      );
      try {
        const response = await api.request(
          caller,
          "POST",
          `/api/sessions/${sessionId}/services/stop`,
        );
        expect(response.status).toBe(status);
        expect(calls).toEqual([]);
      } finally {
        await api.dispose();
      }
    },
  );
});
