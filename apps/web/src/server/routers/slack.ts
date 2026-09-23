import {
  ConnectSlackRequest,
  SlackDefaultProjectRequest,
  SlackLinkCodeRequest,
  SlackSettingsRequest,
} from "@mend/api-contracts";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/** Slack (docs/adr/0006-slack.md): the organization's app, and each person's link. */
export const slackRouter = router({
  // Owners only.
  app: procedure.query(({ ctx }) => run(ctx, (api) => api.slack.app())),
  manifest: procedure.query(({ ctx }) => run(ctx, (api) => api.slack.manifest())),
  links: procedure.query(({ ctx }) => run(ctx, (api) => api.slack.links())),
  connect: procedure
    .input(input(ConnectSlackRequest))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.slack.connect({ payload }))),
  disconnect: procedure.mutation(({ ctx }) => run(ctx, (api) => api.slack.disconnect())),
  setSettings: procedure
    .input(input(SlackSettingsRequest))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.slack.setSettings({ payload }))),
  removeLink: procedure
    .input(input(Schema.Struct({ slackUserId: Schema.String })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.slack.removeLink({ params: { slackUserId: i.slackUserId } })),
    ),
  // Anyone in the organization.
  me: procedure.query(({ ctx }) => run(ctx, (api) => api.slack.me())),
  unlink: procedure.mutation(({ ctx }) => run(ctx, (api) => api.slack.unlink())),
  setDefaultProject: procedure
    .input(input(SlackDefaultProjectRequest))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => api.slack.setDefaultProject({ payload })),
    ),
  // The /slack/link/<code> page.
  previewLink: procedure
    .input(input(SlackLinkCodeRequest))
    .query(({ ctx, input: payload }) => run(ctx, (api) => api.slack.previewLink({ payload }))),
  confirmLink: procedure
    .input(input(SlackLinkCodeRequest))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.slack.confirmLink({ payload }))),
});
