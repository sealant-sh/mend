import { AuditEventsRepo } from "@mend/db";
import type { LandingTrigger, Project, Session } from "@mend/domain/workbench";
import { Landing, type LandingNotStartedError, type LandingReport } from "@mend/landing";
import { asSealantUser } from "@mend/sealant";
import { AgentBridge, MendKeys, SourcePolicy } from "@mend/store";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { ProjectAccess } from "./access.ts";
import { auditLanding, remoteEnvFor } from "./landing-state.ts";
import { withSignerContext } from "./routes/workbench.ts";

/**
 * Landing a session's change as its owner, from somewhere that is not the owner's own HTTP
 * request (docs/adr/0007-landing.md, "Who lands"): a completed turn, or the owner's press of "Push
 * and open pull request" in a Slack thread. The push uses the owner's credentials under the
 * project's `gitAuthMode` (a signer context for the bridge), the pull request step runs as the
 * owner's Sealant principal, and every landing is audited, whatever its outcome.
 *
 * The caller has already decided that the owner is the one landing; `Landing.land` checks it
 * again.
 */

export interface OwnerLandingInput {
  readonly session: Session;
  readonly project: Project;
  /** The change's owner (`changeOwnerOfWorktree`), who lands: the caller has checked it. */
  readonly ownerUserId: string;
  readonly trigger: LandingTrigger;
  /** Where the pull request description's links point. */
  readonly webOrigin: string;
}

export class OwnerLanding extends Context.Service<
  OwnerLanding,
  {
    readonly land: (
      input: OwnerLandingInput,
    ) => Effect.Effect<LandingReport, LandingNotStartedError>;
  }
>()("@mend/api/OwnerLanding") {}

export const OwnerLandingLive: Layer.Layer<
  OwnerLanding,
  never,
  AgentBridge | AuditEventsRepo | Landing | MendKeys | ProjectAccess | SourcePolicy
> = Layer.effect(
  OwnerLanding,
  Effect.gen(function* () {
    const landing = yield* Landing;
    // What the push and the audit read, captured once so a landing needs nothing more.
    const context = yield* Effect.context<
      AgentBridge | AuditEventsRepo | MendKeys | ProjectAccess | SourcePolicy
    >();

    const land = Effect.fn("OwnerLanding.land")(function* (input: OwnerLandingInput) {
      const { session, project, ownerUserId } = input;
      const remoteEnv = yield* remoteEnvFor(project, ownerUserId, "push");
      const report = yield* withSignerContext(
        project.gitAuthMode,
        ownerUserId,
        `land ${session.label ?? session.id} → origin`,
        landing.land({
          sessionId: session.id,
          actorUserId: ownerUserId,
          trigger: input.trigger,
          remoteBranch: null,
          pullRequest: true,
          title: null,
          body: null,
          webOrigin: input.webOrigin,
          remoteEnv,
        }),
      ).pipe(asSealantUser(ownerUserId));
      yield* auditLanding(report.landing, project.organizationId, ownerUserId);
      return report;
    });

    return {
      land: (input: OwnerLandingInput) => land(input).pipe(Effect.provide(context)),
    };
  }),
);
