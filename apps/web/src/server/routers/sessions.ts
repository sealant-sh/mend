import {
  CheckpointRequest,
  DeliverFollowUpRequest,
  DiscardUnsavedRequest,
  EndBackgroundWorkRequest,
  LaunchRequest,
  NewWorkbenchSession,
  PastedImageUpload,
  ReplaceWorkspaceRequest,
  RespondAgentRequest,
  ResumeRequest,
  SendSessionMessageRequest,
  SessionInboxMarkRequest,
  SharedControlRequest,
} from "@mend/api-contracts";
import { AgentRequestId, AgentTurnId, ProjectId, SessionId, SessionProcessId } from "@mend/domain";
import { TRPCError } from "@trpc/server";
import { Schema } from "effect";

import { ApiRefusal } from "../api/errors.ts";
import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

const byId = input(Schema.Struct({ id: SessionId }));
/** One person in a session's shared control: who asked, or who holds it. */
const byPerson = input(Schema.Struct({ id: SessionId, userId: Schema.String }));

const historyInput = input(
  Schema.Struct({
    id: SessionId,
    cursor: Schema.NullOr(Schema.String),
    limit: Schema.Int,
  }),
);
const historyQueryOf = (i: { readonly cursor: string | null; readonly limit: number }) => ({
  ...(i.cursor === null ? {} : { before: i.cursor }),
  limit: String(i.limit),
});

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
  // Every session the person can see, as the inbox lists it: Mend's own records, no git.
  inbox: procedure.query(({ ctx }) => run(ctx, (api) => api.sessions.inbox())),
  inboxRow: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.inboxRow({ params: { id: i.id } })),
    ),
  inboxMarks: procedure.query(({ ctx }) => run(ctx, (api) => api.sessions.inboxMarks())),
  setInboxMark: procedure
    .input(input(Schema.Struct({ id: SessionId, mark: SessionInboxMarkRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessions.setInboxMark({ params: { id: i.id }, payload: { mark: i.mark } }),
      ),
    ),
  // Without the worktree's resource lines: their read can restore a capture or exec into the
  // workspace, and the page reads them beside the session (`resourceStatus`).
  detail: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessions.detail({ params: { id: i.id }, query: { resources: "omit" } }),
      ),
    ),
  resourceStatus: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.resourceStatus({ params: { id: i.id } })),
    ),
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
  // Never `queue`: Send goes into the sender's own running turn (while their message setting is on,
  // as it is unless they turned it off), else starts their next turn, and with `resume` a stopped
  // conversation comes back to take it. `selection` is the model, thinking, speed and permission
  // the next turn runs with; a steer keeps its turn's. The browser
  // cannot know which account its cookie now names, so the words go only if it is still the one
  // they were written as (`expectedUserId`), read with this request's own credentials.
  sendMessage: procedure
    .input(
      input(
        Schema.Struct({
          id: SessionId,
          input: SendSessionMessageRequest.fields.input,
          clientMessageId: SendSessionMessageRequest.fields.clientMessageId,
          resume: SendSessionMessageRequest.fields.resume,
          selection: SendSessionMessageRequest.fields.selection,
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
  // The switch for everyone (docs/adr/0003): on lets everyone who can see the project steer; off
  // leaves only the owner, ending every grant to one person too.
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
  // Shared control for one person (docs/adr/0026, decision 7). `sharedControl` reads who holds it
  // and who asks (the owner reads every ask, anyone else only their own) and what the viewer may
  // do (`acts`); each step answers the same read as it stands after. A step the session no longer
  // allows is `SharedControlRefused` (409) with `data.sharedControl.reason`.
  sharedControl: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.sharedControlPeople({ params: { id: i.id } })),
    ),
  askSharedControl: procedure
    .input(byId)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.askSharedControl({ params: { id: i.id } })),
    ),
  withdrawSharedControl: procedure
    .input(byId)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.withdrawSharedControl({ params: { id: i.id } })),
    ),
  grantSharedControl: procedure
    .input(byPerson)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessions.grantSharedControl({ params: { id: i.id, userId: i.userId } }),
      ),
    ),
  declineSharedControl: procedure
    .input(byPerson)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessions.declineSharedControl({ params: { id: i.id, userId: i.userId } }),
      ),
    ),
  takeBackSharedControl: procedure
    .input(byPerson)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessions.takeBackSharedControl({ params: { id: i.id, userId: i.userId } }),
      ),
    ),
  // Stop session (docs/adr/0026, decision 7): when no other session in the workspace is
  // running, the workspace and its Services stop with it. `stopPreview` says which, first.
  stop: procedure
    .input(byId)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.stop({ params: { id: i.id } })),
    ),
  // What Stop session would do now, for its dialog: `workspace` is `stops`, `keeps-running`
  // (with the `runningSessions` that keep it up) or `none`, beside the workspace's live Services.
  stopPreview: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.stopPreview({ params: { id: i.id } })),
    ),
  // Who interrupted, attached, opened a shell, stopped or shared control; oldest first. The
  // stopped session's line names who stopped it.
  controlEvents: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.controlEvents({ params: { id: i.id } })),
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
  items: procedure
    .input(input(Schema.Struct({ id: SessionId, after: Schema.Int, limit: Schema.Int })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessions.listItems({
          params: { id: i.id },
          query: { after: String(i.after), limit: String(i.limit) },
        }),
      ),
    ),
  // The conversation's history newest first, a window at a time: items, turns and requests each
  // read for the same window (`cursor`: the newer window's `next`; null: from the newest).
  historyItems: procedure
    .input(historyInput)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessions.historyItems({ params: { id: i.id }, query: historyQueryOf(i) }),
      ),
    ),
  historyTurns: procedure
    .input(historyInput)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessions.historyTurns({ params: { id: i.id }, query: historyQueryOf(i) }),
      ),
    ),
  historyRequests: procedure
    .input(historyInput)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessions.historyRequests({ params: { id: i.id }, query: historyQueryOf(i) }),
      ),
    ),
  respondRequest: procedure
    .input(input(Schema.Struct({ requestId: AgentRequestId, response: RespondAgentRequest })))
    .mutation(({ ctx, input: { requestId, response } }) =>
      run(ctx, (api) =>
        api.sessions.respondAgentRequest({
          params: { id: requestId },
          // The derived client types this union's payload as always carrying `answers`. A
          // decision goes with empty answers, which the union's first member (the decision)
          // drops as it encodes, so the server reads the decision alone.
          payload: "decision" in response ? { decision: response.decision, answers: {} } : response,
        }),
      ),
    ),
  // Stop turn: the running turn ends where it is; the session and its workspace keep running.
  interruptTurn: procedure
    .input(input(Schema.Struct({ turnId: AgentTurnId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.interruptTurn({ params: { id: i.turnId } })),
    ),
  // A shell beside the agent in the session's workspace: the owner's alone (docs/adr/0013).
  openShell: procedure
    .input(byId)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.openShell({ params: { id: i.id } })),
    ),
  stopShell: procedure
    .input(input(Schema.Struct({ processId: SessionProcessId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.stopShell({ params: { id: i.processId } })),
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
