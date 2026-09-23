import {
  CurrentUser,
  MendApi,
  NotFound,
  SlackAppStatus,
  SlackAppView,
  SlackLinkConfirmed,
  SlackLinkPreview,
  SlackLinkView,
  SlackManifestView,
  SlackMeView,
  SlackRejected,
  SlackUnavailable,
  SlackWorkspaceView,
} from "@mend/api-contracts";
import {
  AuditEventsRepo,
  SlackDefaultsRepo,
  SlackInstallsRepo,
  SlackLinksRepo,
  UsersRepo,
  type SealedSlackInstall,
  type SlackLink,
} from "@mend/db";
import type { OrganizationId } from "@mend/domain";
import {
  SLACK_LINKED_MENTION_JOB,
  type SlackInstallSettings,
  type SlackLinkedMentionJob,
} from "@mend/domain/workbench";
import { JobRunner } from "@mend/jobs";
import { NetworkConfig } from "@mend/network";
import {
  DEFAULT_MENTION_VOCABULARY,
  SLACK_APP_TOKEN_SCOPE,
  SLACK_SETUP_STEPS,
  slackManifestJson,
  slackToPlain,
} from "@mend/slack";
import { SLACK_TOKEN_REFUSALS, SlackApi, type SlackApiError } from "@mend/slack/client";
import { SecretCipher } from "@mend/store";
import { Effect } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { ProjectAccess } from "../access.ts";
import { configuredOriginForRequest } from "./devices.ts";
import { membership, ownership } from "./organization.ts";

/** The id an owner-only refusal names: the organization's Slack app. */
const SLACK = "slack";
/** The id a missing or foreign link code names; never the code itself. */
const LINK_CODE = "slack-link-code";
/** The id a missing link of the caller's names. */
const LINK = "slack-link";

/**
 * The caller's organization when they own it. Everyone else, an account in no organization
 * included, gets a 404 naming what they asked for.
 */
const owner = (id: string) =>
  ownership(id).pipe(Effect.catchTag("NotFound", () => Effect.fail(new NotFound({ id }))));

/** The harnesses a mention can start: the ones with a protocol mode. */
export const SLACK_HARNESSES: ReadonlyArray<string> = DEFAULT_MENTION_VOCABULARY.harnesses;

/**
 * What the owner pasted, checked for shape before Slack is asked. Both tokens are trimmed: a
 * copied token often carries a newline.
 */
export const tokenProblem = (appToken: string, botToken: string): string | null => {
  if (!appToken.startsWith("xapp-")) {
    return "The app-level token starts with xapp-. Generate one under Basic Information → App-Level Tokens.";
  }
  if (!botToken.startsWith("xoxb-")) {
    return "The bot token starts with xoxb-. It is the Bot User OAuth Token under OAuth & Permissions.";
  }
  return null;
};

/** A failed Slack call as the owner reads it: a refusal they can fix, or Slack not answering. */
export const slackFailure =
  (which: string) =>
  (error: SlackApiError): SlackRejected | SlackUnavailable => {
    if (SLACK_TOKEN_REFUSALS.has(error.code)) {
      return new SlackRejected({ message: `Slack refused the ${which} (${error.code}).` });
    }
    if (
      error.code === "request_failed" ||
      error.code === "ratelimited" ||
      error.code === "unexpected_response" ||
      error.code.startsWith("http_")
    ) {
      return new SlackUnavailable({
        message: `Slack did not answer for the ${which}: ${error.message}. Nothing was saved.`,
      });
    }
    return new SlackRejected({ message: `Slack answered ${error.code} for the ${which}.` });
  };

/** The settings that differ, for the audit entry; empty when nothing changed. */
export const changedSettings = (
  before: SlackInstallSettings,
  after: SlackInstallSettings,
): Record<string, string | boolean> => {
  const changed: Record<string, string | boolean> = {};
  if (before.defaultHarness !== after.defaultHarness)
    changed["defaultHarness"] = after.defaultHarness;
  if (before.showAgentMessages !== after.showAgentMessages) {
    changed["showAgentMessages"] = after.showAgentMessages;
  }
  if (before.showDiffs !== after.showDiffs) changed["showDiffs"] = after.showDiffs;
  if (before.externalChannels !== after.externalChannels) {
    changed["externalChannels"] = after.externalChannels;
  }
  if (before.landAutomatically !== after.landAutomatically) {
    changed["landAutomatically"] = after.landAutomatically;
  }
  return changed;
};

const nameOf = (userId: string) =>
  Effect.gen(function* () {
    return (yield* (yield* UsersRepo).byId(userId))?.name ?? null;
  });

/** An install without its tokens, which never leave the database sealed or not. */
const appView = (install: SealedSlackInstall) =>
  Effect.gen(function* () {
    return new SlackAppView({
      teamId: install.teamId,
      teamName: install.teamName,
      appId: install.appId,
      botUserId: install.botUserId,
      webOrigin: install.webOrigin,
      settings: install.settings,
      installedByUserId: install.installedByUserId,
      installedByName: yield* nameOf(install.installedByUserId),
      installedAt: install.createdAt,
      updatedAt: install.updatedAt,
    });
  });

const linkView = (link: SlackLink) =>
  Effect.gen(function* () {
    return new SlackLinkView({
      teamId: link.teamId,
      slackUserId: link.slackUserId,
      userId: link.userId,
      userName: (yield* nameOf(link.userId)) ?? "a removed account",
      createdAt: link.createdAt,
    });
  });

const recordLinkRemoved = (organizationId: OrganizationId, actorUserId: string, link: SlackLink) =>
  Effect.gen(function* () {
    yield* (yield* AuditEventsRepo).record({
      organizationId,
      actorUserId,
      action: "slack.link_removed",
      subjectType: "member",
      subjectId: link.userId,
      data: { teamId: link.teamId, slackUserId: link.slackUserId },
    });
  });

/** The caller's Slack settings: the workspace, their link in it, and their default project. */
const meView = (organizationId: OrganizationId, userId: string) =>
  Effect.gen(function* () {
    const install = yield* (yield* SlackInstallsRepo).byOrganization(organizationId);
    const links = yield* (yield* SlackLinksRepo).listForUser(userId);
    const link = links.find((entry) => entry.teamId === install?.teamId) ?? null;
    return new SlackMeView({
      workspace:
        install === null
          ? null
          : new SlackWorkspaceView({ teamId: install.teamId, teamName: install.teamName }),
      link: link === null ? null : yield* linkView(link),
      defaultProjectId: yield* (yield* SlackDefaultsRepo).personalDefault(userId),
    });
  });

/**
 * Slack (docs/adr/0006-slack.md, "One Slack app per organization" and "A Slack user acts only
 * once they have linked their account"). Owners connect, configure and remove the app and remove
 * anyone's link; everyone manages their own link and default project, and confirms a link code
 * from a mention.
 */
export const SlackGroupLive = HttpApiBuilder.group(MendApi, "slack", (handlers) =>
  handlers
    .handle("app", () =>
      Effect.gen(function* () {
        const found = yield* owner(SLACK);
        const install = yield* (yield* SlackInstallsRepo).byOrganization(found.organization.id);
        return new SlackAppStatus({
          app: install === null ? null : yield* appView(install),
          harnesses: SLACK_HARNESSES,
        });
      }),
    )
    .handle("connect", ({ payload }) =>
      Effect.gen(function* () {
        const found = yield* owner(SLACK);
        const caller = yield* CurrentUser;
        const appToken = payload.appToken.trim();
        const botToken = payload.botToken.trim();
        const problem = tokenProblem(appToken, botToken);
        if (problem !== null) return yield* new SlackRejected({ message: problem });

        const slack = yield* SlackApi;
        const bot = yield* slack
          .authTest(botToken)
          .pipe(Effect.mapError(slackFailure("bot token")));
        if (bot.botId === null) {
          return yield* new SlackRejected({ message: "Slack says the xoxb- token has no bot." });
        }
        const botApp =
          bot.appId ??
          (yield* slack
            .botsInfo(botToken, bot.botId)
            .pipe(Effect.mapError(slackFailure("bot token")))).appId;
        const connection = yield* slack
          .appsConnectionsOpen(appToken)
          .pipe(Effect.mapError(slackFailure("app-level token")));
        if (botApp !== null && connection.appId !== null && botApp !== connection.appId) {
          return yield* new SlackRejected({
            message:
              "The two tokens belong to different Slack apps. Use the app-level token and the bot token of the same app.",
          });
        }
        const appId = botApp ?? connection.appId;
        if (appId === null) {
          return yield* new SlackRejected({
            message: "Slack did not say which app these tokens belong to.",
          });
        }

        const cipher = yield* SecretCipher;
        const seal = (value: string) =>
          cipher.encrypt(value).pipe(Effect.catchTag("SecretCipherError", Effect.die));
        // Links Mend posts into Slack start with the origin the owner is using now, chosen from
        // the configured origins: a request header can pick one but never introduce one.
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webOrigin = configuredOriginForRequest(yield* NetworkConfig, request.headers);
        const saved = yield* (yield* SlackInstallsRepo)
          .save({
            organizationId: found.organization.id,
            teamId: bot.teamId,
            teamName: bot.teamName,
            botUserId: bot.userId,
            appId,
            sealedAppToken: yield* seal(appToken),
            sealedBotToken: yield* seal(botToken),
            webOrigin,
            installedByUserId: caller.user.id,
          })
          .pipe(
            Effect.catchTag(
              "SlackTeamTakenError",
              () =>
                new SlackRejected({
                  message:
                    "That Slack workspace is connected to another organization on this Mend, and a workspace belongs to one organization only.",
                }),
            ),
          );
        const previous = saved.previous;
        yield* (yield* AuditEventsRepo).record({
          organizationId: found.organization.id,
          actorUserId: caller.user.id,
          action: previous === null ? "slack.installed" : "slack.replaced",
          subjectType: "slack",
          subjectId: bot.teamId,
          data: {
            teamName: bot.teamName,
            ...(previous === null
              ? {}
              : {
                  previousTeamId: previous.teamId,
                  // A different workspace starts over: its links and channel defaults are gone.
                  linksKept: previous.teamId === bot.teamId,
                }),
          },
        });
        return yield* appView(saved.install);
      }),
    )
    .handle("disconnect", () =>
      Effect.gen(function* () {
        const found = yield* owner(SLACK);
        const caller = yield* CurrentUser;
        const removed = yield* (yield* SlackInstallsRepo).remove(found.organization.id);
        if (removed === null) return yield* new NotFound({ id: SLACK });
        yield* (yield* AuditEventsRepo).record({
          organizationId: found.organization.id,
          actorUserId: caller.user.id,
          action: "slack.removed",
          subjectType: "slack",
          subjectId: removed.teamId,
          data: { teamName: removed.teamName },
        });
      }),
    )
    .handle("setSettings", ({ payload }) =>
      Effect.gen(function* () {
        const found = yield* owner(SLACK);
        const caller = yield* CurrentUser;
        const settings = payload.settings;
        if (!SLACK_HARNESSES.includes(settings.defaultHarness)) {
          return yield* new SlackRejected({
            message: `A mention starts ${SLACK_HARNESSES.join(" or ")}, not ${settings.defaultHarness}.`,
          });
        }
        const installs = yield* SlackInstallsRepo;
        const before = yield* installs.byOrganization(found.organization.id);
        if (before === null) return yield* new NotFound({ id: SLACK });
        const updated = yield* installs
          .updateSettings(found.organization.id, settings)
          .pipe(Effect.catchTag("SlackInstallNotFoundError", () => new NotFound({ id: SLACK })));
        const changed = changedSettings(before.settings, updated.settings);
        if (Object.keys(changed).length > 0) {
          yield* (yield* AuditEventsRepo).record({
            organizationId: found.organization.id,
            actorUserId: caller.user.id,
            action: "slack.settings_changed",
            subjectType: "slack",
            subjectId: updated.teamId,
            data: changed,
          });
        }
        return yield* appView(updated);
      }),
    )
    .handle("manifest", () =>
      Effect.gen(function* () {
        yield* owner(SLACK);
        return new SlackManifestView({
          manifest: slackManifestJson(),
          steps: SLACK_SETUP_STEPS,
          appTokenScope: SLACK_APP_TOKEN_SCOPE,
        });
      }),
    )
    .handle("links", () =>
      Effect.gen(function* () {
        const found = yield* owner(SLACK);
        const links = yield* (yield* SlackLinksRepo).listForOrganization(found.organization.id);
        return yield* Effect.forEach(links, linkView);
      }),
    )
    .handle("removeLink", ({ params }) =>
      Effect.gen(function* () {
        const found = yield* owner(params.slackUserId);
        const caller = yield* CurrentUser;
        const install = yield* (yield* SlackInstallsRepo).byOrganization(found.organization.id);
        if (install === null) return yield* new NotFound({ id: params.slackUserId });
        const removed = yield* (yield* SlackLinksRepo).unlink(install.teamId, params.slackUserId);
        if (removed === null) return yield* new NotFound({ id: params.slackUserId });
        yield* recordLinkRemoved(found.organization.id, caller.user.id, removed);
      }),
    )
    .handle("me", () =>
      Effect.gen(function* () {
        const found = yield* membership;
        const caller = yield* CurrentUser;
        return yield* meView(found.organization.id, caller.user.id);
      }),
    )
    .handle("unlink", () =>
      Effect.gen(function* () {
        const found = yield* membership;
        const caller = yield* CurrentUser;
        const links = yield* SlackLinksRepo;
        const mine = yield* links.listForUser(caller.user.id);
        if (mine.length === 0) return yield* new NotFound({ id: LINK });
        for (const link of mine) {
          const removed = yield* links.unlink(link.teamId, link.slackUserId);
          if (removed !== null)
            yield* recordLinkRemoved(found.organization.id, caller.user.id, removed);
        }
      }),
    )
    .handle("setDefaultProject", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        // A project the caller cannot see does not exist for them here either; asked first, so
        // the refusal names the project whoever asks.
        if (payload.projectId !== null) {
          yield* (yield* ProjectAccess).projectAs(caller.user.id, payload.projectId);
        }
        const found = yield* membership;
        yield* (yield* SlackDefaultsRepo).setPersonalDefault(caller.user.id, payload.projectId);
        return yield* meView(found.organization.id, caller.user.id);
      }),
    )
    .handle("previewLink", ({ payload }) =>
      Effect.gen(function* () {
        const found = yield* membership;
        const caller = yield* CurrentUser;
        const pending = yield* (yield* SlackLinksRepo).peekCode(payload.code);
        // Another organization's code is as unknown as a made-up one.
        if (pending === null || pending.organizationId !== found.organization.id) {
          return yield* new NotFound({ id: LINK_CODE });
        }
        const install = yield* (yield* SlackInstallsRepo).byTeam(pending.teamId);
        if (install === null) return yield* new NotFound({ id: LINK_CODE });
        // The person must see who they are linking: a code handed to them by someone else
        // would otherwise join that someone's Slack user to their account.
        const slack = yield* SlackApi;
        const person = yield* (yield* SecretCipher).decrypt(install.sealedBotToken).pipe(
          Effect.flatMap((token) => slack.usersInfo(token, pending.slackUserId)),
          Effect.option,
        );
        const existing = (yield* (yield* SlackLinksRepo).listForUser(caller.user.id)).find(
          (link) => link.teamId === pending.teamId && link.slackUserId !== pending.slackUserId,
        );
        return new SlackLinkPreview({
          teamId: pending.teamId,
          teamName: pending.teamName,
          slackUserId: pending.slackUserId,
          slackUserName: person._tag === "Some" ? person.value.displayName : null,
          slackRealName: person._tag === "Some" ? person.value.realName : null,
          requestText: slackToPlain(pending.request.text, (id) =>
            id === install.botUserId ? "mend" : undefined,
          ),
          expiresAt: pending.expiresAt,
          replacesSlackUserId: existing?.slackUserId ?? null,
        });
      }),
    )
    .handle("confirmLink", ({ payload }) =>
      Effect.gen(function* () {
        const found = yield* membership;
        const caller = yield* CurrentUser;
        const links = yield* SlackLinksRepo;
        const redeemed = yield* links
          .redeemCode({ code: payload.code, userId: caller.user.id })
          .pipe(Effect.catchTag("SlackLinkNotMemberError", () => new NotFound({ id: LINK_CODE })));
        if (redeemed === null) return yield* new NotFound({ id: LINK_CODE });
        const { link, request } = redeemed;
        // The caller's own earlier link is named on the new one; another account's link to this
        // Slack user was removed, and says so on its own.
        const replaced = redeemed.replaced.find(
          (entry) => entry.userId === caller.user.id && entry.slackUserId !== link.slackUserId,
        );
        for (const removed of redeemed.replaced) {
          if (removed.userId === caller.user.id) continue;
          yield* recordLinkRemoved(found.organization.id, caller.user.id, removed);
        }
        yield* (yield* AuditEventsRepo).record({
          organizationId: found.organization.id,
          actorUserId: caller.user.id,
          action: "slack.link_created",
          subjectType: "member",
          subjectId: caller.user.id,
          data: {
            teamId: link.teamId,
            slackUserId: link.slackUserId,
            ...(replaced === undefined ? {} : { replacedSlackUserId: replaced.slackUserId }),
          },
        });
        // The mention that waited for this link runs now, in the worker. A failed enqueue leaves
        // the link made; the person mentions Mend again.
        const job: SlackLinkedMentionJob = {
          organizationId: link.organizationId,
          teamId: link.teamId,
          slackUserId: link.slackUserId,
          userId: link.userId,
          request,
          linkedAt: link.createdAt.toISOString(),
        };
        const queued = yield* (yield* JobRunner)
          .enqueue({
            name: SLACK_LINKED_MENTION_JOB,
            payload: job,
            idempotencyKey: `${SLACK_LINKED_MENTION_JOB}:${link.teamId}:${request.channelId}:${request.messageTs}`,
            // A claimed Slack event is done even if its work fails; so is this one.
            retryLimit: 0,
          })
          .pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("slack link: the waiting mention was not queued").pipe(
                Effect.annotateLogs({ teamId: link.teamId, cause: String(cause) }),
                Effect.as(false),
              ),
            ),
          );
        return new SlackLinkConfirmed({ link: yield* linkView(link), requestQueued: queued });
      }),
    ),
);
