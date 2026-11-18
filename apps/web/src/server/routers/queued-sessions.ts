import { QueueSessionRequest, StartQueuedSessionRequest } from "@mend/api-contracts";
import { QueuedSessionId } from "@mend/domain";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

const byId = input(Schema.Struct({ id: QueuedSessionId }));

/**
 * Sessions started while their project still clones (SLNT-1099). One waits for the clone
 * (`state: "waiting"`, the clone's progress in `clone`), starts by itself once it finishes, and
 * then is a session (`sessionId`). A failed one says which step failed and why.
 */
export const queuedSessionsRouter = router({
  /** Start a session in the project the caller's adoption is still cloning. */
  queue: procedure
    .input(input(QueueSessionRequest))
    .mutation(({ ctx, input: i }) => run(ctx, (api) => api.queuedSessions.queue({ payload: i }))),
  /** The caller's that have not started yet, in their current organization. */
  list: procedure.query(({ ctx }) => run(ctx, (api) => api.queuedSessions.list())),
  read: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.queuedSessions.read({ params: { id: i.id } })),
    ),
  /** Start a failed one again: in a project cloned now, or on a new clone of it. */
  start: procedure
    .input(input(Schema.Struct({ id: QueuedSessionId, target: StartQueuedSessionRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.queuedSessions.start({ params: { id: i.id }, payload: i.target })),
    ),
  cancel: procedure
    .input(byId)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.queuedSessions.cancel({ params: { id: i.id } })),
    ),
});
