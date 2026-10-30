import { deviceIdOf } from "@mend/api-contracts";
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
import { PreviewId, type OrganizationId } from "@mend/domain";
import { canSeeProject, type Preview, type Viewer } from "@mend/domain/workbench";
import {
  Array as Arr,
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  type Scope,
  Stream,
} from "effect";
import * as Context from "effect/Context";

import { ProjectAccess } from "./access.ts";
import { type BusSignal, EventBus } from "./events-bus.ts";
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
      PreviewRefusal | PreviewUnavailable | PreviewPoolFull
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

export interface PreviewTiming {
  readonly sweepEvery: Duration.Input;
  readonly passDeadline: Duration.Input;
  readonly admissionDeadline: Duration.Input;
  readonly closeGrace: Duration.Input;
  readonly cleanupEvery: Duration.Input;
}

export const PREVIEW_TIMING: PreviewTiming = {
  sweepEvery: "50 seconds",
  passDeadline: "5 seconds",
  admissionDeadline: "5 seconds",
  closeGrace: "1 second",
  cleanupEvery: "60 seconds",
};

const STANDING_BATCH = 500;
const RECHECK_CONCURRENCY = 4;

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

type StopReason =
  | { readonly _tag: "Refused"; readonly refusal: PreviewRefusal }
  | { readonly _tag: "Unavailable" };

interface Registration {
  readonly key: PreviewGrantKey;
  readonly preview: KeptPreview;
  readonly subject: PreviewGrantSubject;
  readonly organizationId: OrganizationId;
  readonly stopped: Deferred.Deferred<StopReason>;
}

type Selection =
  | { readonly _tag: "Project"; readonly projectId: string }
  | { readonly _tag: "UserDevices"; readonly userId: string }
  | { readonly _tag: "User"; readonly userId: string }
  | { readonly _tag: "Organization"; readonly organizationId: string }
  | { readonly _tag: "All" };

const selectionOf = (signal: BusSignal): Selection | null => {
  if (signal.kind === "resync") return { _tag: "All" };
  const event = signal.event;
  switch (event.type) {
    case "project":
    case "worktree":
      return { _tag: "Project", projectId: event.projectId };
    case "user":
      if (event.facet === "devices") return { _tag: "UserDevices", userId: event.userId };
      return event.facet === "access" ? { _tag: "User", userId: event.userId } : null;
    case "organization":
      return { _tag: "Organization", organizationId: event.organizationId };
    default:
      return null;
  }
};

const selects = (selection: Selection, registration: Registration): boolean => {
  switch (selection._tag) {
    case "All":
      return true;
    case "Project":
      return registration.preview.projectId === selection.projectId;
    case "UserDevices":
      return (
        registration.subject.userId === selection.userId &&
        deviceIdOf(registration.subject.credential) !== undefined
      );
    case "User":
      return registration.subject.userId === selection.userId;
    case "Organization":
      return registration.organizationId === selection.organizationId;
  }
};

interface Admitted {
  readonly viewer: PreviewViewer;
  readonly subject: PreviewGrantSubject;
  readonly key: PreviewGrantKey;
}

interface GrantGroup {
  readonly key: PreviewGrantKey;
  readonly registrations: Array<Registration>;
}

const stop = (registration: Registration, reason: StopReason) =>
  Deferred.succeed(registration.stopped, reason).pipe(Effect.asVoid);

const stopAll = (registrations: Iterable<Registration>, reason: StopReason) =>
  Effect.forEach(registrations, (registration) => stop(registration, reason), { discard: true });

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
      const bus = yield* EventBus;
      const scope = yield* Effect.scope;
      const registry = new Set<Registration>();
      let passesStarted = 0;

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

      /**
       * `effect`, given up on at `deadline` without waiting for it to stop: a query parked on a
       * pool connection cannot be interrupted, and must not hold an answer past its bound.
       */
      const withinDeadline = <A, E>(deadline: Duration.Input, effect: Effect.Effect<A, E>) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const work = yield* Effect.forkIn(effect, scope);
            return yield* restore(Effect.timeoutOption(Fiber.join(work), deadline)).pipe(
              Effect.ensuring(Effect.sync(() => work.interruptUnsafe())),
            );
          }),
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

      /** The ports the previews hold now; none to read off the tailnet default. */
      const heldPorts = (routed: PreviewRouting, ids: ReadonlyArray<PreviewId>) =>
        routed.mode !== "tailnet-https"
          ? Effect.succeed(Option.some(new Map<PreviewId, number>()))
          : withinDeadline(timing.passDeadline, previews.tailnetPorts(ids)).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("preview: the held ports could not be read").pipe(
                      Effect.annotateLogs({ cause: Cause.pretty(cause) }),
                      Effect.as(Option.none()),
                    ),
              ),
            );

      const recheck = (selection: Selection) =>
        Effect.gen(function* () {
          passesStarted += 1;
          const selected = [...registry].filter((registration) => selects(selection, registration));
          if (selected.length === 0) return;
          const routed = config.routing;
          if (routed === null) return yield* stopAll(selected, { _tag: "Unavailable" });
          const held = yield* heldPorts(
            routed,
            selected.map((registration) => registration.preview.id),
          );
          if (Option.isNone(held)) return yield* stopAll(selected, { _tag: "Unavailable" });
          const byGrant = new Map<string, GrantGroup>();
          for (const registration of selected) {
            const place = {
              label: registration.preview.label,
              tailnetPort: held.value.get(registration.preview.id) ?? null,
            };
            if (previewOriginOf(routed, place) !== registration.key.origin) {
              yield* stop(registration, { _tag: "Refused", refusal: new PreviewNotFound() });
              continue;
            }
            const secret = Redacted.value(registration.key.grant);
            const group = byGrant.get(secret);
            if (group === undefined) {
              byGrant.set(secret, { key: registration.key, registrations: [registration] });
            } else {
              group.registrations.push(registration);
            }
          }
          const unjudged = new Set(byGrant.values());
          const judgeBatch = (batch: ReadonlyArray<GrantGroup>) =>
            grants.standing(batch.map((group) => group.key)).pipe(
              Effect.flatMap((answers) =>
                Effect.forEach(
                  batch,
                  (group, index) => {
                    unjudged.delete(group);
                    const verdict = judge(answers[index] ?? null, group.key.previewId);
                    return verdict._tag === "Refused"
                      ? stopAll(group.registrations, { _tag: "Refused", refusal: verdict.refusal })
                      : Effect.void;
                  },
                  { discard: true },
                ),
              ),
            );
          const judged = yield* withinDeadline(
            timing.passDeadline,
            Effect.forEach(Arr.chunksOf([...unjudged], STANDING_BATCH), judgeBatch, {
              concurrency: RECHECK_CONCURRENCY,
              discard: true,
            }),
          ).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("preview: an open stream's recheck failed").pipe(
                    Effect.annotateLogs({ cause: Cause.pretty(cause) }),
                    Effect.as(Option.none()),
                  ),
            ),
          );
          if (Option.isNone(judged)) {
            yield* stopAll(
              [...unjudged].flatMap((group) => group.registrations),
              { _tag: "Unavailable" },
            );
          }
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
        return stampUsed([...new Set([...registry].map(({ preview }) => preview.id))]);
      });
      const stampClosed = (id: PreviewId) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const last = lastStamped.get(id);
          if (last !== undefined && now - last < Duration.toMillis(timing.sweepEvery)) return;
          yield* stampUsed([id]);
        });

      const closeWriter = <A, E>(writer: Fiber.Fiber<A, E>) =>
        Fiber.interrupt(writer).pipe(Effect.timeoutOption(timing.closeGrace), Effect.asVoid);

      const runWriter = <E, R>(
        stopped: Deferred.Deferred<StopReason>,
        write: Effect.Effect<undefined, E, R>,
      ): Effect.Effect<void, E | PreviewAccessEnded, R> =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const writer = yield* Effect.forkDetach(write);
            return yield* restore(
              Effect.gen(function* () {
                const ended = yield* Effect.raceFirst(
                  Effect.map(Fiber.await(writer), () => null),
                  Deferred.await(stopped),
                );
                if (ended === null) return yield* Fiber.join(writer);
                return yield* new PreviewAccessEnded({
                  reason: ended._tag === "Refused" ? "access-ended" : "admission-unavailable",
                });
              }),
            ).pipe(Effect.ensuring(closeWriter(writer)));
          }),
        );

      /** A pass that started during `first`'s admission may have missed it: admit it again. */
      const admittedAfterPassesSince = (
        passesBefore: number,
        first: Admitted,
        request: { readonly origin: PreviewOrigin; readonly grant: PreviewGrantSecret | null },
      ) => (passesStarted === passesBefore ? Effect.succeed(first) : admit(request));

      const withViewer = <E, R>(
        request: { readonly origin: PreviewOrigin; readonly grant: PreviewGrantSecret | null },
        write: (admitted: PreviewViewer) => Effect.Effect<undefined, E, R>,
      ): Effect.Effect<
        void,
        E | PreviewRefusal | PreviewUnavailable | PreviewAccessEnded,
        Exclude<R, Scope.Scope>
      > =>
        Effect.gen(function* () {
          const passesBefore = passesStarted;
          const first = yield* admit(request);
          const registration: Registration = {
            key: first.key,
            preview: first.viewer.preview,
            subject: first.subject,
            organizationId: first.viewer.viewer.organizationId,
            stopped: yield* Deferred.make<StopReason>(),
          };
          registry.add(registration);
          return yield* Effect.gen(function* () {
            const admitted = yield* admittedAfterPassesSince(passesBefore, first, request);
            if (yield* Deferred.isDone(registration.stopped)) {
              const reason = yield* Deferred.await(registration.stopped);
              return yield* reason._tag === "Refused"
                ? Effect.fail(reason.refusal)
                : Effect.fail(unavailable());
            }
            return yield* runWriter(registration.stopped, Effect.scoped(write(admitted.viewer)));
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => void registry.delete(registration)).pipe(
                Effect.andThen(Effect.forkIn(stampClosed(registration.preview.id), scope)),
              ),
            ),
          );
        });

      const supervisedRecheck = (selection: Selection) =>
        recheck(selection).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logError("preview: a recheck pass failed").pipe(
                  Effect.annotateLogs({ cause: Cause.pretty(cause) }),
                ),
          ),
        );

      const subscription = yield* bus.subscribe;
      yield* Stream.fromSubscription(subscription).pipe(
        Stream.runForEach((signal) => {
          const selection = selectionOf(signal);
          return selection === null ? Effect.void : supervisedRecheck(selection);
        }),
        Effect.forkScoped,
      );
      yield* supervisedRecheck({ _tag: "All" }).pipe(
        Effect.repeat(Schedule.fixed(timing.sweepEvery)),
        Effect.forkScoped,
      );
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
      yield* Effect.addFinalizer(() => stopAll(registry, { _tag: "Unavailable" }));

      return { issueTicket, exchangeTicket, withViewer };
    }),
  );

export const PreviewIdentityLive: Layer.Layer<
  PreviewIdentity,
  never,
  PreviewConfig | PreviewGrantsRepo | PreviewsRepo | UpgradeTicketsRepo | ProjectAccess | EventBus
> = makePreviewIdentityLayer(PREVIEW_TIMING);
