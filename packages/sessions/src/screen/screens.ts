import {
  type ScreenCallArguments,
  type ScreenNotFoundError,
  ScreensRepo,
  type SettledScreenCall,
} from "@mend/db";
import type {
  ScreenFrameId,
  ScreenId,
  SessionId,
  SessionProcessId,
  ViewerConnectionId,
} from "@mend/domain";
import {
  type Screen,
  type ScreenActParams,
  type ScreenActionNote,
  type ScreenLogBody,
  type ScreenLogEntry,
  screenActionNote,
} from "@mend/domain/workbench";
import { BlobStore } from "@mend/store";
import { Clock, Effect, Fiber, Layer, Scope } from "effect";
import * as Context from "effect/Context";

import { ForwardAdapter } from "../forward.ts";
import type { Caller } from "../mend-mcp/caller.ts";
import { readFrame, storeFrame } from "./frames.ts";
import { planActions, type Step } from "./hand-steps.ts";
import type { HandEnded } from "./hand.ts";
import { type Hands, dialScreen, makeHands } from "./hands.ts";
import type { Input } from "./rfb-client.ts";
import {
  makeScreenControl,
  type PersonLapse,
  type ScreenControl,
  type ScreenControlAnswer,
} from "./screen-control.ts";
import { ScreenHost, ScreenStartError } from "./screen-host.ts";
import { ScreenWorkers, type WorkerStopped } from "./screen-workers.ts";
import { type ViewerBytes, type WatchEnd, type Watcher, relayViewer } from "./viewer.ts";

export type ScreenCaller = Pick<Caller, "sessionId" | "accountId" | "agentProcess" | "callKey">;

export type ScreenRefusal =
  | "no_screen"
  | "held"
  | "busy"
  | "look_first"
  | "call_reused"
  | "observation_unavailable"
  | "unattributed_caller"
  /** A turn the screen's own person did not send: its keys would spend their logins (D3). */
  | "owner_only";

/** What links a call's log entry to the tool call that holds it. */
export interface ScreenReceipt {
  readonly screenId: ScreenId;
  readonly seq: number;
  readonly callKey: string;
}

export type ScreenCallAnswer =
  | { readonly _tag: "Refused"; readonly refusal: ScreenRefusal }
  /** A `key` action no keysym names, refused before any input. */
  | { readonly _tag: "UnsupportedKey"; readonly key: string }
  /** A call that left no entry: refused before, or its input may have partly landed. */
  | { readonly _tag: "NoEntry"; readonly outcome: "refused" | "outcome_unknown" }
  | {
      readonly _tag: "Answered";
      readonly outcome: "applied" | "interrupted";
      readonly receipt: ScreenReceipt;
      readonly png: Uint8Array;
      readonly observedAt: Date;
      /** Null when the frame was not stored; the agent still has its PNG. */
      readonly frameId: ScreenFrameId | null;
      readonly actions: ReadonlyArray<ScreenActionNote>;
      /** People's and Mend's entries since the agent's previous look. */
      readonly sinceLastLook: ReadonlyArray<ScreenLogEntry>;
    };

export type { PersonLapse, ScreenControlAnswer };

/** A session's screen as the agent's tools describe it. */
export interface ScreenState {
  readonly screen: Screen;
  /** When the person who holds the input took it; null while no person holds it. */
  readonly takenAt: Date | null;
}

/**
 * Every input on a screen passes here (ADR 0020): the agent's two calls, people's takeovers, and
 * the one hand per live screen this process holds.
 */
export class Screens extends Context.Service<
  Screens,
  {
    readonly authorize: (caller: ScreenCaller) => Effect.Effect<ScreenRefusal | null>;
    readonly look: (caller: ScreenCaller) => Effect.Effect<ScreenCallAnswer, ScreenStartError>;
    readonly act: (
      caller: ScreenCaller,
      params: ScreenActParams,
    ) => Effect.Effect<ScreenCallAnswer, ScreenStartError>;
    /** The screen holding the session's display; null when it holds none. */
    readonly state: (sessionId: SessionId) => Effect.Effect<ScreenState | null>;
    readonly take: (
      sessionId: SessionId,
      userId: string,
      connection: ViewerConnectionId,
    ) => Effect.Effect<ScreenControlAnswer>;
    readonly handBack: (sessionId: SessionId, userId: string) => Effect.Effect<ScreenControlAnswer>;
    readonly lapse: (
      sessionId: SessionId,
      connection: ViewerConnectionId,
      reason: PersonLapse,
    ) => Effect.Effect<ScreenControlAnswer>;
    readonly heartbeat: (
      sessionId: SessionId,
      connection: ViewerConnectionId,
    ) => Effect.Effect<boolean>;
    readonly input: (
      sessionId: SessionId,
      connection: ViewerConnectionId,
      inputs: ReadonlyArray<Input>,
    ) => Effect.Effect<boolean>;
    /**
     * Relays the session's live screen to one viewer until either side ends. It starts no screen:
     * viewers do not keep one running (D7).
     */
    readonly watch: (watcher: Watcher, viewer: ViewerBytes) => Effect.Effect<WatchEnd>;
  }
>()("@mend/sessions/Screens") {}

const NO_SCREEN: WatchEnd = { _tag: "NoScreen" };
const STARTED_WITHIN_MS = 15_000;
const STARTED_POLL_MS = 200;

const refused = (refusal: ScreenRefusal): ScreenCallAnswer => ({ _tag: "Refused", refusal });
const noEntry = (outcome: "refused" | "outcome_unknown"): ScreenCallAnswer => ({
  _tag: "NoEntry",
  outcome,
});

/** The entries before `seq` that came after the agent's last look, the agent's own left out. */
const sinceLastLook = (
  log: ReadonlyArray<ScreenLogEntry>,
  seq: number,
): ReadonlyArray<ScreenLogEntry> => {
  const before = log.filter((entry) => entry.seq < seq);
  const looked = before.findLast(
    (entry) => entry.actor._tag === "Agent" && entry.body._tag === "Looked",
  );
  return before.filter((entry) => entry.seq > (looked?.seq ?? 0) && entry.actor._tag !== "Agent");
};

const answeredOf = (
  log: ReadonlyArray<ScreenLogEntry>,
  entry: ScreenLogEntry,
  outcome: "applied" | "interrupted",
  callKey: string,
  png: Uint8Array,
): ScreenCallAnswer => ({
  _tag: "Answered",
  outcome,
  receipt: { screenId: entry.screenId, seq: entry.seq, callKey },
  observedAt: entry.at,
  png,
  frameId: entry.frame?.id ?? null,
  actions: entry.body._tag === "Acted" ? entry.body.notes : [],
  sinceLastLook: sinceLastLook(log, entry.seq),
});

interface Attributed {
  readonly processId: SessionProcessId;
  readonly callKey: string;
}

/** Only the session's current agent process, naming its call, may look or act. */
const attributed = (caller: ScreenCaller): Attributed | null =>
  caller.agentProcess?._tag === "Current" && caller.callKey !== null
    ? { processId: caller.agentProcess.id, callKey: caller.callKey }
    : null;

export const ScreensLive: Layer.Layer<
  Screens,
  never,
  ScreensRepo | ScreenHost | ForwardAdapter | BlobStore | ScreenWorkers
> = Layer.effect(
  Screens,
  Effect.gen(function* () {
    const screens = yield* ScreensRepo;
    const host = yield* ScreenHost;
    const scope = yield* Scope.Scope;
    const blobs = yield* Effect.context<BlobStore>();
    const dialling = yield* Effect.context<ScreenHost | ForwardAdapter>();
    const hands: Hands = yield* makeHands(
      (screen): Effect.Effect<void> => Effect.asVoid(control.ended(screen.id)),
    );
    const control: ScreenControl = yield* makeScreenControl(hands).pipe(
      Effect.provideContext(blobs),
    );
    const acting = new Set<ScreenId>();

    /** The screen, Live with passwords this process holds: started on demand (D7). */
    const started = (screen: Screen) =>
      Effect.gen(function* () {
        if (screen.life._tag === "Live" && (yield* host.passwords(screen.sessionId)) !== null) {
          return screen;
        }
        const { id } = yield* host.start(screen.sessionId);
        for (let waited = 0; ; waited += STARTED_POLL_MS) {
          const now = yield* screens.byId(id);
          if (now?.life._tag === "Live") return now;
          if (now === null || now.life._tag === "Ended" || waited >= STARTED_WITHIN_MS) {
            return yield* new ScreenStartError({ message: "the screen did not start" });
          }
          yield* Effect.sleep(STARTED_POLL_MS);
        }
      });

    const settle = (
      screen: Screen,
      who: Attributed,
      outcome: "refused" | "outcome_unknown",
      refusal: ScreenRefusal | null,
    ): Effect.Effect<ScreenCallAnswer> =>
      Effect.as(
        screens.settle({ screenId: screen.id, callKey: who.callKey, outcome, answer: null }),
        refusal === null ? noEntry(outcome) : refused(refusal),
      );

    const answer = (
      screen: Screen,
      who: Attributed,
      body: Extract<ScreenLogBody, { readonly _tag: "Looked" | "Acted" }>,
      png: Uint8Array,
      outcome: "applied" | "interrupted",
    ) =>
      Effect.gen(function* () {
        const frame = yield* storeFrame(screen.id, png).pipe(Effect.provideContext(blobs));
        const turnId = yield* host.turnOf(screen.sessionId, who.processId);
        const settled = yield* screens.settle({
          screenId: screen.id,
          callKey: who.callKey,
          outcome,
          answer: { processId: who.processId, turnId, body, frame },
        });
        const log = yield* screens.log(screen.id);
        const entry = log.find((each) => each.seq === settled.seq);
        if (entry === undefined) return yield* Effect.die("a settled call without its entry");
        return answeredOf(log, entry, outcome, who.callKey, png);
      });

    /** A retry: what the first call answered, with no input sent again. */
    const replay = (screen: Screen, who: Attributed, call: SettledScreenCall) =>
      Effect.gen(function* () {
        const { outcome, seq } = call;
        if (seq === null || outcome === "refused" || outcome === "outcome_unknown") {
          return noEntry(outcome === "refused" ? outcome : "outcome_unknown");
        }
        const log = yield* screens.log(screen.id);
        const entry = log.find((each) => each.seq === seq);
        const png =
          entry?.frame == null
            ? null
            : yield* readFrame(screen.id, entry.frame.digest).pipe(Effect.provideContext(blobs));
        if (entry === undefined || png === null) return refused("observation_unavailable");
        return answeredOf(log, entry, outcome, who.callKey, png);
      });

    const look = (screen: Screen, who: Attributed) =>
      Effect.gen(function* () {
        const hand = yield* hands.of(screen);
        if (hand === null) return yield* settle(screen, who, "outcome_unknown", null);
        const admitted = yield* control.serially(
          screen.id,
          Effect.suspend(() =>
            hands.open(screen.id) === hand
              ? screens.control(screen.id, { _tag: "AgentLooked" }, null)
              : Effect.succeed(null),
          ),
        );
        if (admitted === null) return yield* settle(screen, who, "outcome_unknown", null);
        if (admitted._tag === "Refused") return yield* settle(screen, who, "refused", "held");
        return yield* answer(screen, who, { _tag: "Looked" }, yield* hand.look, "applied");
      });

    /** One batch at a time per screen: a second answers `busy` while the first runs. */
    const act = (
      screen: Screen,
      who: Attributed,
      params: ScreenActParams,
      steps: ReadonlyArray<Step>,
    ) =>
      Effect.suspend(() => {
        if (acting.has(screen.id)) return settle(screen, who, "refused", "busy");
        acting.add(screen.id);
        return runBatch(screen, who, params, steps).pipe(
          Effect.ensuring(Effect.sync(() => acting.delete(screen.id))),
        );
      });

    const runBatch = (
      screen: Screen,
      who: Attributed,
      params: ScreenActParams,
      steps: ReadonlyArray<Step>,
    ) =>
      Effect.gen(function* () {
        const admitted = yield* screens.control(screen.id, { _tag: "AgentActed" }, null);
        if (admitted._tag === "Refused") {
          const why = admitted.why === "look-first" ? "look_first" : "held";
          return yield* settle(screen, who, "refused", why);
        }
        const now = yield* screens.byId(screen.id);
        if (now === null || now.input._tag !== "Agent") {
          return yield* settle(screen, who, "refused", "held");
        }
        const hand = yield* hands.of(now);
        if (hand === null) return yield* settle(screen, who, "outcome_unknown", null);
        const { results, png } = yield* hand.act(steps, now.input.epoch);
        const notes = params.actions.map((action, at) =>
          screenActionNote(action, results[at] ?? "skipped: time limit"),
        );
        const outcome = results.every((result) => result === "done") ? "applied" : "interrupted";
        return yield* answer(now, who, { _tag: "Acted", notes }, png, outcome);
      });

    /**
     * Claims the call before it starts anything, so a retry answers from the claim alone, then
     * runs it where the caller's going away cannot leave the claim open behind input already sent.
     */
    const call = (
      caller: ScreenCaller,
      args: ScreenCallArguments,
      run: (
        screen: Screen,
        who: Attributed,
      ) => Effect.Effect<ScreenCallAnswer, HandEnded | WorkerStopped | ScreenNotFoundError>,
    ): Effect.Effect<ScreenCallAnswer, ScreenStartError> =>
      Effect.gen(function* () {
        const who = attributed(caller);
        if (who === null) return refused("unattributed_caller");
        const owner = yield* host.ownerOf(caller.sessionId);
        if (owner === null || caller.accountId !== owner) return refused("owner_only");
        const reserved = yield* screens.ofSession(caller.sessionId);
        if (reserved === null) return refused("no_screen");
        const claim = yield* screens.claim({ screenId: reserved.id, callKey: who.callKey, args });
        switch (claim._tag) {
          case "CallReused":
            return refused("call_reused");
          case "Open":
            return refused("busy");
          case "Settled":
            return yield* replay(reserved, who, claim.call);
          case "Claimed": {
            const ran = Effect.gen(function* () {
              // A screen still booting is signed for again first, never started over.
              yield* control.booted(reserved.id);
              const screen = yield* started(reserved).pipe(
                Effect.tapError(() => settle(reserved, who, "refused", null)),
              );
              // The start moved the session to another workspace's screen: the call is its own there.
              if (screen.id !== reserved.id) {
                yield* settle(reserved, who, "refused", null);
                return yield* call(caller, args, run);
              }
              return yield* run(screen, who).pipe(
                Effect.catchTags({
                  HandEnded: () => settle(screen, who, "outcome_unknown", null),
                  WorkerStopped: () => settle(screen, who, "outcome_unknown", null),
                }),
              );
            });
            return yield* Effect.flatMap(Effect.forkIn(ran, scope), Fiber.join);
          }
        }
      }).pipe(Effect.catchTag("ScreenNotFoundError", () => Effect.succeed(refused("no_screen"))));

    /**
     * A screen its rekey failed for, started over with fresh passwords: the old one stops, its
     * apps with it, and the log says why. One whose process would not stop keeps no passwords
     * here, so it gets no hand and is not said to have restarted.
     */
    const restarted = (screen: Screen) =>
      Effect.gen(function* () {
        const now = yield* started(screen);
        if ((yield* host.passwords(now.sessionId)) === null) {
          return yield* Effect.logWarning(
            "screen: not started over · its process would not stop",
          ).pipe(Effect.annotateLogs({ screenId: screen.id }));
        }
        yield* control.note(now, { _tag: "Restarted", reason: "rekey-failed" });
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("screen: not started over after its rekey failed").pipe(
            Effect.annotateLogs({ screenId: screen.id, cause: error.message }),
          ),
        ),
      );

    /**
     * A screen that outlived the last process keeps running: its person writes fresh passwords
     * over the ones that process held, and Xvnc signs the next connection in with them. When that
     * fails it is started over. The boot waits for that no longer than a start may take; a restart
     * still running then goes on, and logs once it is done.
     */
    const recovered = (screen: Screen) =>
      screen.life._tag !== "Live"
        ? Effect.void
        : Effect.gen(function* () {
            if (yield* host.rekey(screen.sessionId)) return;
            yield* Effect.logWarning(
              "screen: not signed for again at boot · starting it over",
            ).pipe(Effect.annotateLogs({ screenId: screen.id }));
            const restart = yield* Effect.forkIn(restarted(screen), scope);
            yield* Effect.asVoid(Effect.timeoutOption(Fiber.await(restart), STARTED_WITHIN_MS));
          });

    yield* screens.boot();
    const at = new Date(yield* Clock.currentTimeMillis);
    for (const screen of yield* screens.held()) {
      yield* control.boot(screen, at, recovered(screen));
    }

    return {
      authorize: (caller) =>
        Effect.gen(function* () {
          if (attributed(caller) === null) return "unattributed_caller";
          const owner = yield* host.ownerOf(caller.sessionId);
          if (owner === null || caller.accountId !== owner) return "owner_only";
          return (yield* screens.ofSession(caller.sessionId)) === null ? "no_screen" : null;
        }),
      look: (caller) => call(caller, { tool: "screen_look" }, look),
      act: (caller, params) => {
        const plan = planActions(params.actions);
        if (plan._tag === "Unsupported") {
          return Effect.succeed<ScreenCallAnswer>({ _tag: "UnsupportedKey", key: plan.key });
        }
        return call(caller, { tool: "screen_act", params }, (screen, who) =>
          act(screen, who, params, plan.steps),
        );
      },
      state: (sessionId) =>
        Effect.gen(function* () {
          const screen = yield* screens.ofSession(sessionId);
          if (screen === null) return null;
          if (screen.input._tag !== "Person") return { screen, takenAt: null };
          const log = yield* screens.log(screen.id);
          return {
            screen,
            takenAt: log.findLast((entry) => entry.body._tag === "Taken")?.at ?? null,
          };
        }),
      take: control.take,
      handBack: control.handBack,
      lapse: control.lapse,
      heartbeat: control.heartbeat,
      input: control.input,
      watch: (watcher, viewer) =>
        Effect.scoped(
          relayViewer(watcher, viewer, {
            dial: Effect.gen(function* () {
              const screen = yield* screens.ofSession(watcher.sessionId);
              if (screen?.life._tag !== "Live") return yield* Effect.fail(NO_SCREEN);
              const dialled = yield* dialScreen(screen).pipe(
                Effect.provideContext(dialling),
                Effect.mapError(
                  (failure): WatchEnd => ({
                    _tag: "Unreachable",
                    reason: failure.record.issue.reason,
                  }),
                ),
              );
              if (dialled === null) return yield* Effect.fail(NO_SCREEN);
              return { bytes: dialled.bytes, password: dialled.passwords.viewOnly };
            }),
            input: (inputs) => control.input(watcher.sessionId, watcher.connection, inputs),
            paste: (text) => control.paste(watcher.sessionId, watcher.connection, text),
          }),
        ),
    };
  }),
);
