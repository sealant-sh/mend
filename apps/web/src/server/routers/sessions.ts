import {
  CheckpointRequest,
  DeliverFollowUpRequest,
  DiscardUnsavedRequest,
  EndBackgroundWorkRequest,
  LaunchRequest,
  NewWorkbenchSession,
  PastedImageUpload,
  ReplaceWorkspaceRequest,
  ResumeRequest,
  SendSessionMessageRequest,
  SharedControlRequest,
} from "@mend/api-contracts";
import { ProjectId, SessionId } from "@mend/domain";
import { TRPCError } from "@trpc/server";
import { Schema } from "effect";

import { ApiRefusal } from "../api/errors.ts";
import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

const byId = input(Schema.Struct({ id: SessionId }));

const servicePayload = {
  port: Schema.Int,
  name: Schema.NullOr(Schema.String),
  protocol: Schema.optional(Schema.Literals(["tcp", "udp"])),
  browserScheme: Schema.optional(Schema.NullOr(Schema.Literals(["http", "https"]))),
};

/** Sessions · processes · session services. */
export const sessionsRouter = router({
  listActive: procedure.query(({ ctx }) =>
    run(ctx, (api) => api.sessions.listActive({ query: {} })),
  ),
  detail: procedure
    .input(byId)
    .query(({ ctx, input: i }) => run(ctx, (api) => api.sessions.detail({ params: { id: i.id } }))),
  create: procedure
    .input(input(Schema.Struct({ projectId: ProjectId, session: NewWorkbenchSession })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.create({ params: { id: i.projectId }, payload: i.session })),
    ),
  launch: procedure
    .input(input(Schema.Struct({ id: SessionId, request: LaunchRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.launch({ params: { id: i.id }, payload: i.request })),
    ),
  pasteImage: procedure
    .input(input(Schema.Struct({ id: SessionId, upload: PastedImageUpload })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.pasteImage({ params: { id: i.id }, payload: i.upload })),
    ),
  // Never `queue`: Send steers or starts a turn as the sender's message setting says. The browser
  // cannot know which account its cookie now names, so the words go only if it is still the one
  // they were written as (`expectedUserId`), read with this request's own credentials.
  sendMessage: procedure
    .input(
      input(
        Schema.Struct({
          id: SessionId,
          input: SendSessionMessageRequest.fields.input,
          clientMessageId: SendSessionMessageRequest.fields.clientMessageId,
          expectedUserId: Schema.String,
        }),
      ),
    )
    .mutation(async ({ ctx, input: { id, expectedUserId, ...message } }) => {
      const signedIn = await run(ctx, (api) => api.organization.current());
      if (signedIn.userId !== expectedUserId)
        throw new TRPCError({
          code: "CONFLICT",
          message: "another account is signed in now · this message was not sent",
          cause: new ApiRefusal("MessageAuthorChanged"),
        });
      return run(ctx, (api) =>
        api.sessions.sendMessage({
          params: { id },
          payload: new SendSessionMessageRequest(message),
        }),
      );
    }),
  setSharedControl: procedure
    .input(input(Schema.Struct({ id: SessionId, enabled: Schema.Boolean })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessions.sharedControl({
          params: { id: i.id },
          payload: new SharedControlRequest({ enabled: i.enabled }),
        }),
      ),
    ),
  stop: procedure
    .input(byId)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.stop({ params: { id: i.id } })),
    ),
  // The owner's "discard unsaved and stop" (docs/adr/0002): the page arms it with a second click.
  discardUnsaved: procedure.input(byId).mutation(({ ctx, input: i }) =>
    run(ctx, (api) =>
      api.sessions.discardUnsaved({
        params: { id: i.id },
        payload: new DiscardUnsavedRequest({ confirm: "discard unsaved" }),
      }),
    ),
  ),
  stopServices: procedure
    .input(byId)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.stopServices({ params: { id: i.id } })),
    ),
  resume: procedure
    .input(input(Schema.Struct({ id: SessionId, request: ResumeRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.resume({ params: { id: i.id }, payload: i.request })),
    ),
  remove: procedure
    .input(byId)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.remove({ params: { id: i.id } })),
    ),
  setLabel: procedure
    .input(input(Schema.Struct({ id: SessionId, label: Schema.NullOr(Schema.String) })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.label({ params: { id: i.id }, payload: { label: i.label } })),
    ),
  checkpoint: procedure
    .input(input(Schema.Struct({ id: SessionId, request: CheckpointRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.checkpoint({ params: { id: i.id }, payload: i.request })),
    ),
  transcript: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.transcript({ params: { id: i.id } })),
    ),
  pages: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.pages.listForSession({ params: { id: i.id } })),
    ),
  processes: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.listProcesses({ params: { id: i.id } })),
    ),
  recipes: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.listRecipes({ params: { id: i.id } })),
    ),
  // docs/adr/0016, decision 6: what holds the next sender's turn; null when nothing waits.
  conversationWait: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.conversationWait({ params: { id: i.id } })),
    ),
  // The waiting line's action: end one piece of the previous sender's background work.
  endBackgroundWork: procedure
    .input(input(Schema.Struct({ id: SessionId, work: EndBackgroundWorkRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.endBackgroundWork({ params: { id: i.id }, payload: i.work })),
    ),
  // docs/adr/0016, decision 14: the executor's retirement; null while none is under way.
  workspaceRetirement: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.workspaceRetirement({ params: { id: i.id } })),
    ),
  // "Replace this workspace now", naming the retirement the owner was shown (`seen`): refused in
  // words (`WorkspaceReplaceRefused`) the page shows.
  replaceWorkspace: procedure
    .input(input(Schema.Struct({ id: SessionId, seen: Schema.String })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessions.replaceWorkspace({
          params: { id: i.id },
          payload: new ReplaceWorkspaceRequest({ seen: i.seen }),
        }),
      ),
    ),
  pendingFollowUp: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.followUpPending({ params: { id: i.id } })),
    ),
  deliverFollowUp: procedure
    .input(input(Schema.Struct({ id: SessionId, request: DeliverFollowUpRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.followUpDeliver({ params: { id: i.id }, payload: i.request })),
    ),
  runServiceRecipe: procedure
    .input(input(Schema.Struct({ id: SessionId, name: Schema.String })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessions.runServiceRecipe({ params: { id: i.id }, payload: { name: i.name } }),
      ),
    ),
  runService: procedure
    .input(
      input(Schema.Struct({ id: SessionId, argv: Schema.Array(Schema.String), ...servicePayload })),
    )
    .mutation(({ ctx, input: { id, ...payload } }) =>
      run(ctx, (api) => api.sessions.runService({ params: { id }, payload })),
    ),
  addService: procedure
    .input(input(Schema.Struct({ id: SessionId, ...servicePayload })))
    .mutation(({ ctx, input: { id, ...payload } }) =>
      run(ctx, (api) => api.sessions.addService({ params: { id }, payload })),
    ),
});
