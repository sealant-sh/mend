import {
  type PreviewGrantKey,
  type PreviewGrantSecret,
  PreviewGrantsRepo,
  type PreviewGrantStanding,
  type PreviewGrantSubject,
  previewTicketScope,
  PreviewsRepo,
  type TicketCredential,
  UpgradeTicketsRepo,
} from "@mend/db";
import { PreviewId } from "@mend/domain";
import { canSeeProject, type Preview, type Viewer } from "@mend/domain/workbench";
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  type Scope,
} from "effect";
import * as Context from "effect/Context";

import {
  type Admission,
  makeAccessRecheck,
  type RecheckTiming,
  withinDeadline,
} from "./access-recheck.ts";
import { ProjectAccess } from "./access.ts";
import { EventBus } from "./events-bus.ts";
import {
  previewAtOrigin,
  previewOriginOf,
  type PreviewOrigin,
  type PreviewRouting,
} from "./preview-routing.ts";

export class PreviewConfig extends Context.Service<
  PreviewConfig,
  { readonly appUrl: string; readonly routing: PreviewRouting | null }
>()("@mend/api/PreviewConfig") {}

type KeptPreview = Extract<Preview, { readonly state: "kept" }>;

export interface SignedInAccount {
  readonly userId: string;
  readonly credential: TicketCredential;
}

export interface PreviewViewer {
  readonly viewer: Viewer;
  readonly preview: KeptPreview;
  readonly origin: PreviewOrigin;
}

export class PreviewNoIdentity extends Schema.TaggedError<PreviewNoIdentity>()(
  "PreviewNoIdentity",
  {
    reason: Schema.Literals([
      "missing-grant",
      "invalid-grant",
      "invalid-ticket",
      "credential-required",
      "membership-ended",
      "port-moved",
    ]),
    previewId: Schema.NullOr(PreviewId),
  },
) {}

export class PreviewNotFound extends Schema.TaggedError<PreviewNotFound>()("PreviewNotFound", {}) {}

export class PreviewUnavailable extends Schema.TaggedError<PreviewUnavailable>()(
  "PreviewUnavailable",
  { operation: Schema.Literals(["address", "admit"]) },
) {}

export class PreviewAccessEnded extends Schema.TaggedError<PreviewAccessEnded>()(
  "PreviewAccessEnded",
  { reason: Schema.Literals(["access-ended", "admission-unavailable"]) },
) {}

export class PreviewPoolFull extends Schema.TaggedError<PreviewPoolFull>()("PreviewPoolFull", {
  size: Schema.Number,
  nextFreeAt: Schema.Date,
}) {}

export type PreviewRefusal = PreviewNoIdentity | PreviewNotFound;

export class PreviewIdentity extends Context.Service<
  PreviewIdentity,
  {
    readonly issueTicket: (request: {
      readonly previewId: PreviewId;
      readonly opener: SignedInAccount;
    }) => Effect.Effect<
      { readonly origin: PreviewOrigin; readonly ticket: Redacted.Redacted<string> },
      PreviewNotFound | PreviewUnavailable | PreviewPoolFull
    >;
    /**
     * `presented` is the grant the browser already holds for the origin. `clearSiteData` says the
     * port held another preview before, and this browser has not signed in to this one on it.
     */
    readonly exchangeTicket: (request: {
      readonly origin: PreviewOrigin;
      readonly ticket: Redacted.Redacted<string>;
      readonly presented: PreviewGrantSecret | null;
    }) => Effect.Effect<
      {
        readonly origin: PreviewOrigin;
        readonly grant: PreviewGrantSecret;
        readonly clearSiteData: boolean;
      },
      PreviewRefusal | PreviewUnavailable
    >;
    readonly withViewer: <E, R>(
      request: { readonly origin: PreviewOrigin; readonly grant: PreviewGrantSecret | null },
      write: (admitted: PreviewViewer) => Effect.Effect<undefined, E, R>,
    ) => Effect.Effect<
      void,
      E | PreviewRefusal | PreviewUnavailable | PreviewAccessEnded,
      Exclude<R, Scope.Scope>
    >;
  }
>()("@mend/api/PreviewIdentity") {}

export interface PreviewTiming extends RecheckTiming {
  readonly admissionDeadline: Duration.Input;
  readonly cleanupEvery: Duration.Input;
}

export const PREVIEW_TIMING: PreviewTiming = {
  sweepEvery: "50 seconds",
  passDeadline: "5 seconds",
  admissionDeadline: "5 seconds",
  closeGrace: "1 second",
  cleanupEvery: "60 seconds",
};

type Verdict =
  | { readonly _tag: "Admitted"; readonly viewer: Viewer; readonly subject: PreviewGrantSubject }
  | { readonly _tag: "Refused"; readonly refusal: PreviewRefusal };

const refused = (refusal: PreviewRefusal): Verdict => ({ _tag: "Refused", refusal });

const judge = (standing: PreviewGrantStanding | null, previewId: PreviewId): Verdict => {
  if (standing === null) {
    return refused(new PreviewNoIdentity({ reason: "invalid-grant", previewId }));
  }
  if (standing.membership === null) {
    return refused(new PreviewNoIdentity({ reason: "membership-ended", previewId }));
  }
  if (!standing.previewKept) return refused(new PreviewNotFound());
  const viewer: Viewer = { userId: standing.subject.userId, ...standing.membership };
  return canSeeProject(standing.project, viewer)
    ? { _tag: "Admitted", viewer, subject: standing.subject }
    : refused(new PreviewNotFound());
};

/** An admitted viewer, as the shared recheck holds it while its stream is open. */
interface Admitted extends Admission {
  readonly subject: PreviewGrantSubject;
  readonly viewer: PreviewViewer;
  readonly key: PreviewGrantKey;
}

export const makePreviewIdentityLayer = (
  timing: PreviewTiming,
): Layer.Layer<
  PreviewIdentity,
  never,
  PreviewConfig | PreviewGrantsRepo | PreviewsRepo | UpgradeTicketsRepo | ProjectAccess | EventBus
> =>
  Layer.effect(
    PreviewIdentity,
    Effect.gen(function* () {
      const config = yield* PreviewConfig;
      const grants = yield* PreviewGrantsRepo;
      const previews = yield* PreviewsRepo;
      const tickets = yield* UpgradeTicketsRepo;
      const access = yield* ProjectAccess;
      const scope = yield* Effect.scope;

      const unavailable = () => new PreviewUnavailable({ operation: "admit" });

      const undecidedOnDefect = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.catchDefect((defect) =>
            Effect.logWarning("preview: admission could not be decided").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(Cause.die(defect)) }),
              Effect.andThen(Effect.fail(unavailable())),
            ),
          ),
        );

      const routing = Effect.suspend(() =>
        config.routing === null
          ? Effect.fail(new PreviewUnavailable({ operation: "address" }))
          : Effect.succeed(config.routing),
      );

      /** The preview at `origin`, and its tailnet port when an admission renews it before serving. */
      const previewAt = Effect.fn("PreviewIdentity.previewAt")(function* (origin: PreviewOrigin) {
        const routed = yield* routing;
        const at = previewAtOrigin(routed, origin);
        if (at === null) return yield* new PreviewNotFound();
        const held = "label" in at ? null : yield* previews.byTailnetPort(at.tailnetPort);
        const preview = "label" in at ? yield* previews.byLabel(at.label) : (held?.preview ?? null);
        if (preview === null || preview.state === "removed") return yield* new PreviewNotFound();
        const tailnetPort = "tailnetPort" in at ? at.tailnetPort : null;
        if (previewOriginOf(routed, { label: preview.label, tailnetPort }) !== origin) {
          return yield* new PreviewNotFound();
        }
        return { preview, renewPort: held?.renewDue === true ? tailnetPort : null };
      });

      const canSee = (userId: string, preview: KeptPreview) =>
        access.projectAs(userId, preview.projectId).pipe(
          Effect.asVoid,
          Effect.mapError(() => new PreviewNotFound()),
        );

      const admit = (request: {
        readonly origin: PreviewOrigin;
        readonly grant: PreviewGrantSecret | null;
      }): Effect.Effect<Admitted, PreviewRefusal | PreviewUnavailable> =>
        withinDeadline(
          scope,
          timing.admissionDeadline,
          Effect.gen(function* () {
            const { preview, renewPort } = yield* previewAt(request.origin);
            if (request.grant === null) {
              return yield* new PreviewNoIdentity({
                reason: "missing-grant",
                previewId: preview.id,
              });
            }
            const key = { grant: request.grant, previewId: preview.id, origin: request.origin };
            const [standing = null] = yield* grants
              .standing([key])
              .pipe(Effect.mapError(unavailable));
            const verdict = judge(standing, preview.id);
            if (verdict._tag === "Refused") return yield* Effect.fail(verdict.refusal);
            if (
              renewPort !== null &&
              (yield* previews.renewTailnetPort(renewPort, preview.id)) === "Moved"
            ) {
              return yield* new PreviewNoIdentity({ reason: "port-moved", previewId: preview.id });
            }
            return {
              viewer: { viewer: verdict.viewer, preview, origin: request.origin },
              subject: verdict.subject,
              key,
              projectId: preview.projectId,
              organizationId: verdict.viewer.organizationId,
            };
          }).pipe(undecidedOnDefect),
        ).pipe(
          Effect.flatMap(
            Option.match({ onNone: () => Effect.fail(unavailable()), onSome: Effect.succeed }),
          ),
        );

      /** A preview gets its port on the tailnet default when it is first opened, never sooner. */
      const assignedPort = (
        previewId: PreviewId,
        ports: ReadonlyArray<number>,
      ): Effect.Effect<number, PreviewNotFound | PreviewPoolFull> =>
        Effect.gen(function* () {
          const assignment = yield* previews.assignTailnetPort(previewId, ports);
          switch (assignment._tag) {
            case "Assigned":
              return assignment.port;
            case "PoolFull":
              return yield* new PreviewPoolFull({
                size: assignment.size,
                nextFreeAt: assignment.nextFreeAt,
              });
            case "Removed":
              return yield* new PreviewNotFound();
          }
        });

      const issueTicket = Effect.fn("PreviewIdentity.issueTicket")(function* (request: {
        readonly previewId: PreviewId;
        readonly opener: SignedInAccount;
      }) {
        const routed = yield* routing;
        const preview = yield* previews.byId(request.previewId);
        if (preview === null || preview.state === "removed") return yield* new PreviewNotFound();
        yield* canSee(request.opener.userId, preview);
        const tailnetPort =
          routed.mode === "tailnet-https" ? yield* assignedPort(preview.id, routed.ports) : null;
        const origin = previewOriginOf(routed, { label: preview.label, tailnetPort });
        if (origin === null) return yield* new PreviewUnavailable({ operation: "address" });
        const minted = yield* tickets.mint({
          userId: request.opener.userId,
          credential: request.opener.credential,
          target: "preview",
          scope: previewTicketScope({ previewId: preview.id, origin }),
        });
        return { origin, ticket: Redacted.make(minted.ticket) };
      }, undecidedOnDefect);

      /**
       * A browser's first open of a preview on a port that held another one: the earlier preview's
       * storage and cache at this origin are still the browser's (ADR 0017, decision 6).
       */
      const firstOnReusedPort = (
        preview: KeptPreview,
        origin: PreviewOrigin,
        presented: PreviewGrantSecret | null,
      ) =>
        Effect.gen(function* () {
          const routed = yield* routing;
          const at = previewAtOrigin(routed, origin);
          if (at === null || !("tailnetPort" in at)) return false;
          if (!(yield* previews.tailnetPortReused(at.tailnetPort, preview.id))) return false;
          if (presented === null) return true;
          const [standing = null] = yield* grants
            .standing([{ grant: presented, previewId: preview.id, origin }])
            .pipe(Effect.mapError(unavailable));
          return judge(standing, preview.id)._tag === "Refused";
        });

      const exchangeTicket = Effect.fn("PreviewIdentity.exchangeTicket")(function* (request: {
        readonly origin: PreviewOrigin;
        readonly ticket: Redacted.Redacted<string>;
        readonly presented: PreviewGrantSecret | null;
      }) {
        const { preview } = yield* previewAt(request.origin);
        const spent = yield* tickets.consume({
          ticket: Redacted.value(request.ticket),
          target: "preview",
          scope: previewTicketScope({ previewId: preview.id, origin: request.origin }),
        });
        if (spent === null) {
          return yield* new PreviewNoIdentity({ reason: "invalid-ticket", previewId: preview.id });
        }
        if (spent.credential === null) {
          return yield* new PreviewNoIdentity({
            reason: "credential-required",
            previewId: preview.id,
          });
        }
        yield* canSee(spent.userId, preview);
        const clearSiteData = yield* firstOnReusedPort(preview, request.origin, request.presented);
        const grant = yield* grants
          .create({
            subject: { userId: spent.userId, credential: spent.credential },
            previewId: preview.id,
            origin: request.origin,
          })
          .pipe(Effect.mapError(unavailable));
        return { origin: request.origin, grant, clearSiteData };
      }, undecidedOnDefect);

      /** A stream whose preview moved to another port is gone, before any grant is read. */
      const moved = (batch: ReadonlyArray<Admitted>) =>
        Effect.gen(function* () {
          const routed = config.routing;
          if (routed === null) return yield* unavailable();
          const held =
            routed.mode === "tailnet-https"
              ? yield* previews.tailnetPorts(batch.map(({ viewer }) => viewer.preview.id))
              : new Map<PreviewId, number>();
          return batch.map(({ viewer, key }): PreviewRefusal | null =>
            previewOriginOf(routed, {
              label: viewer.preview.label,
              tailnetPort: held.get(viewer.preview.id) ?? null,
            }) === key.origin
              ? null
              : new PreviewNotFound(),
          );
        });

      /** The rest of a pass: each stream stands while its grant does. */
      const standing = (batch: ReadonlyArray<Admitted>) =>
        Effect.map(grants.standing(batch.map(({ key }) => key)), (answers) =>
          batch.map(({ key }, at): PreviewRefusal | null => {
            const verdict = judge(answers[at] ?? null, key.previewId);
            return verdict._tag === "Refused" ? verdict.refusal : null;
          }),
        );

      const recheck = yield* makeAccessRecheck<Admitted, PreviewRefusal>({
        name: "preview",
        timing,
        groupOf: ({ key }) => Redacted.value(key.grant),
        known: moved,
        standing,
      });

      // Each pass stamps every preview with a connection open; a close stamps its own preview
      // unless this process stamped it within the last pass, so short requests cost no write each.
      const lastStamped = new Map<PreviewId, number>();
      const stampUsed = (ids: ReadonlyArray<PreviewId>) =>
        Effect.gen(function* () {
          if (config.routing?.mode !== "tailnet-https" || ids.length === 0) return;
          const now = yield* Clock.currentTimeMillis;
          for (const id of ids) lastStamped.set(id, now);
          yield* previews.touchTailnetPorts(ids);
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("preview: a port's last use could not be stamped").pipe(
                  Effect.annotateLogs({ cause: Cause.pretty(cause) }),
                ),
          ),
        );
      const stampOpen = Effect.suspend(() => {
        lastStamped.clear();
        return stampUsed([...new Set(recheck.held().map(({ viewer }) => viewer.preview.id))]);
      });
      const stampClosed = (id: PreviewId) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const last = lastStamped.get(id);
          if (last !== undefined && now - last < Duration.toMillis(timing.sweepEvery)) return;
          yield* stampUsed([id]);
        });

      const withViewer = <E, R>(
        request: { readonly origin: PreviewOrigin; readonly grant: PreviewGrantSecret | null },
        write: (admitted: PreviewViewer) => Effect.Effect<undefined, E, R>,
      ): Effect.Effect<
        void,
        E | PreviewRefusal | PreviewUnavailable | PreviewAccessEnded,
        Exclude<R, Scope.Scope>
      > =>
        Effect.suspend(() => {
          let opened: PreviewId | null = null;
          return recheck
            .hold({
              admit: Effect.tap(admit(request), (first) =>
                Effect.sync(() => {
                  opened ??= first.viewer.preview.id;
                }),
              ),
              use: (admitted) => Effect.scoped(write(admitted.viewer)),
              stopped: (stop, during) =>
                during === "admission"
                  ? stop._tag === "Refused"
                    ? stop.refusal
                    : unavailable()
                  : new PreviewAccessEnded({
                      reason: stop._tag === "Refused" ? "access-ended" : "admission-unavailable",
                    }),
            })
            .pipe(
              Effect.ensuring(
                Effect.suspend(() =>
                  opened === null ? Effect.void : Effect.forkIn(stampClosed(opened), scope),
                ),
              ),
            );
        });

      yield* stampOpen.pipe(Effect.delay(timing.sweepEvery), Effect.forever, Effect.forkScoped);
      yield* grants.cleanup().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("preview: grant cleanup failed; it runs again").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
        Effect.repeat(Schedule.fixed(timing.cleanupEvery)),
        Effect.forkScoped,
      );
      return { issueTicket, exchangeTicket, withViewer };
    }),
  );

export const PreviewIdentityLive: Layer.Layer<
  PreviewIdentity,
  never,
  PreviewConfig | PreviewGrantsRepo | PreviewsRepo | UpgradeTicketsRepo | ProjectAccess | EventBus
> = makePreviewIdentityLayer(PREVIEW_TIMING);
