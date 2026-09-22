import { ProjectId } from "@mend/domain";
import { SlackInstallSettings } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";

/**
 * Slack (docs/adr/0006-slack.md): an organization's Slack app, and each person's Slack link. Only
 * an owner installs, replaces or removes the app or changes its settings; a member asking gets the
 * same 404 as anything else they cannot see. No answer here ever carries a token.
 */

/** Slack or Mend refused what was sent; the message says why, in words for the person. */
export class SlackRejected extends Schema.TaggedErrorClass<SlackRejected>()(
  "SlackRejected",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

/** Slack did not answer, so nothing was checked or saved. */
export class SlackUnavailable extends Schema.TaggedErrorClass<SlackUnavailable>()(
  "SlackUnavailable",
  { message: Schema.String },
  { httpApiStatus: 502 },
) {}

/** The organization's Slack app, as `auth.test` described it when an owner connected it. */
export class SlackAppView extends Schema.Class<SlackAppView>("SlackAppView")({
  teamId: Schema.String,
  teamName: Schema.String,
  appId: Schema.String,
  /** The bot user, the `@mend` people mention. */
  botUserId: Schema.String,
  /** The origin every link Mend posts into Slack starts with. */
  webOrigin: Schema.String,
  settings: SlackInstallSettings,
  installedByUserId: Schema.String,
  /** Null when the account is gone. */
  installedByName: Schema.NullOr(Schema.String),
  installedAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}

/** Settings → Slack for an owner: the app, if any, and the harnesses a mention may start. */
export class SlackAppStatus extends Schema.Class<SlackAppStatus>("SlackAppStatus")({
  app: Schema.NullOr(SlackAppView),
  harnesses: Schema.Array(Schema.String),
}) {}

/** Both tokens, checked with Slack before anything is saved. */
export class ConnectSlackRequest extends Schema.Class<ConnectSlackRequest>("ConnectSlackRequest")({
  /** `xapp-…`, scope `connections:write`: opens the socket. */
  appToken: Schema.String,
  /** `xoxb-…`: reads mentions and writes replies. */
  botToken: Schema.String,
}) {}

export class SlackSettingsRequest extends Schema.Class<SlackSettingsRequest>(
  "SlackSettingsRequest",
)({
  settings: SlackInstallSettings,
}) {}

/** The manifest an owner pastes into Slack, and what to do around it. */
export class SlackManifestView extends Schema.Class<SlackManifestView>("SlackManifestView")({
  /** JSON, ready to paste. */
  manifest: Schema.String,
  steps: Schema.Array(Schema.String),
  appTokenScope: Schema.String,
}) {}

/** One Slack user joined to one Mend account. */
export class SlackLinkView extends Schema.Class<SlackLinkView>("SlackLinkView")({
  teamId: Schema.String,
  slackUserId: Schema.String,
  userId: Schema.String,
  userName: Schema.String,
  createdAt: Schema.Date,
}) {}

/** The Slack workspace a member's organization is connected to. */
export class SlackWorkspaceView extends Schema.Class<SlackWorkspaceView>("SlackWorkspaceView")({
  teamId: Schema.String,
  teamName: Schema.String,
}) {}

/** Settings → Slack for anyone: the workspace, their link and their default project. */
export class SlackMeView extends Schema.Class<SlackMeView>("SlackMeView")({
  /** Null when the organization has no Slack app. */
  workspace: Schema.NullOr(SlackWorkspaceView),
  link: Schema.NullOr(SlackLinkView),
  /** The project a mention runs in when nothing else answers. */
  defaultProjectId: Schema.NullOr(ProjectId),
}) {}

export class SlackDefaultProjectRequest extends Schema.Class<SlackDefaultProjectRequest>(
  "SlackDefaultProjectRequest",
)({
  /** Null clears it. */
  projectId: Schema.NullOr(ProjectId),
}) {}

/** The code from a `/slack/link/<code>` page. */
export class SlackLinkCodeRequest extends Schema.Class<SlackLinkCodeRequest>(
  "SlackLinkCodeRequest",
)({
  code: Schema.String,
}) {}

/** What the link page shows before the person confirms: who in which workspace is asking. */
export class SlackLinkPreview extends Schema.Class<SlackLinkPreview>("SlackLinkPreview")({
  teamId: Schema.String,
  teamName: Schema.String,
  slackUserId: Schema.String,
  /** Looked up in Slack; null when Slack did not answer. */
  slackUserName: Schema.NullOr(Schema.String),
  slackRealName: Schema.NullOr(Schema.String),
  /** The mention that runs once the link is made, as plain text. */
  requestText: Schema.String,
  expiresAt: Schema.Date,
  /** The Slack user this account is linked to now, which confirming replaces; null for none. */
  replacesSlackUserId: Schema.NullOr(Schema.String),
}) {}

export class SlackLinkConfirmed extends Schema.Class<SlackLinkConfirmed>("SlackLinkConfirmed")({
  link: SlackLinkView,
  /** Whether the waiting mention was handed to the runner. */
  requestQueued: Schema.Boolean,
}) {}

export const slackGroup = HttpApiGroup.make("slack")
  .add(
    // Owners only, like everything under /organization/slack.
    HttpApiEndpoint.get("app", "/organization/slack", {
      success: SlackAppStatus,
      error: NotFound,
    }),
  )
  .add(
    // Install, or replace the tokens. The request's web origin is recorded with them.
    HttpApiEndpoint.put("connect", "/organization/slack", {
      payload: ConnectSlackRequest,
      success: SlackAppView,
      error: [NotFound, SlackRejected, SlackUnavailable],
    }),
  )
  .add(
    // Deletes the tokens, the links and the channel defaults. Sessions and their threads stay.
    HttpApiEndpoint.delete("disconnect", "/organization/slack", {
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.patch("setSettings", "/organization/slack/settings", {
      payload: SlackSettingsRequest,
      success: SlackAppView,
      error: [NotFound, SlackRejected],
    }),
  )
  .add(
    HttpApiEndpoint.get("manifest", "/organization/slack/manifest", {
      success: SlackManifestView,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("links", "/organization/slack/links", {
      success: Schema.Array(SlackLinkView),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeLink", "/organization/slack/links/:slackUserId", {
      params: Schema.Struct({ slackUserId: Schema.String }),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("me", "/slack/me", {
      success: SlackMeView,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.delete("unlink", "/slack/me/link", {
      error: NotFound,
    }),
  )
  .add(
    // The project must be one the caller can see.
    HttpApiEndpoint.put("setDefaultProject", "/slack/me/default-project", {
      payload: SlackDefaultProjectRequest,
      success: SlackMeView,
      error: NotFound,
    }),
  )
  .add(
    // POSTs, so the code stays out of request lines. An unknown, spent or expired code, or one
    // from another organization's workspace, is 404.
    HttpApiEndpoint.post("previewLink", "/slack/link/preview", {
      payload: SlackLinkCodeRequest,
      success: SlackLinkPreview,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("confirmLink", "/slack/link/confirm", {
      payload: SlackLinkCodeRequest,
      success: SlackLinkConfirmed,
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);
