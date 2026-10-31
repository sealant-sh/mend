import { SessionId, ViewerConnectionId } from "@mend/domain";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/**
 * A session's screen (docs/adr/0020-guis-in-sessions.md): who holds its input, and the owner's
 * Take over and Hand back. Watching is the `/api/screen-socket` WebSocket, outside tRPC.
 */
export const screensRouter = router({
  read: procedure
    .input(input(Schema.Struct({ id: SessionId })))
    .query(({ ctx, input: i }) => run(ctx, (api) => api.screens.read({ params: { id: i.id } }))),
  wake: procedure
    .input(input(Schema.Struct({ id: SessionId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.wakeScreen({ params: { id: i.id } })),
    ),
  take: procedure
    .input(input(Schema.Struct({ id: SessionId, connection: ViewerConnectionId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.screens.take({ params: { id: i.id }, payload: { connection: i.connection } }),
      ),
    ),
  handBack: procedure
    .input(input(Schema.Struct({ id: SessionId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.screens.handBack({ params: { id: i.id } })),
    ),
});
