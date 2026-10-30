import {
  type ScreenCallArguments,
  type ScreenNotFoundError,
  ScreensRepo,
  type SettledScreenCall,
} from "@mend/db";
import type { ScreenFrameId, ScreenId, SessionProcessId } from "@mend/domain";
import type { Screen, ScreenLogBody, ScreenLogEntry } from "@mend/domain/workbench";
import { BlobStore } from "@mend/store";
import { Effect, Fiber, Layer, Scope } from "effect";
import * as Context from "effect/Context";

import { ForwardAdapter } from "../forward.ts";
import type { Caller } from "../mend-mcp/caller.ts";
import { readFrame, storeFrame } from "./frames.ts";
import type { HandEnded } from "./hand.ts";
import { type Hands, makeHands } from "./hands.ts";
import { ScreenHost, ScreenStartError } from "./screen-host.ts";
import { ScreenWorkers, type WorkerStopped } from "./screen-workers.ts";

export type ScreenCaller = Pick<Caller, "sessionId" | "agentProcess" | "callKey">;

export type ScreenRefusal =
  | "no_screen"
  | "held"
  | "busy"
  | "look_first"
  | "call_reused"
  | "observation_unavailable"
  | "unattributed_caller";

/** What links a call's log entry to the tool call that holds it. */
export interface ScreenReceipt {
  readonly screenId: ScreenId;
  readonly seq: number;
  readonly callKey: string;
}

export type ScreenCallAnswer =
  | { readonly _tag: "Refused"; readonly refusal: ScreenRefusal }
  /** A call that left no entry: refused before, or its input may have partly landed. */
  | { readonly _tag: "NoEntry"; readonly outcome: "refused" | "outcome_unknown" }
  | {
      readonly _tag: "Answered";
      readonly outcome: "applied" | "interrupted";
      readonly receipt: ScreenReceipt;
      readonly png: Uint8Array;
      /** Null when the frame was not stored; the agent still has its PNG. */
      readonly frameId: ScreenFrameId | null;
      /** People's and Mend's entries since the agent's previous look. */
      readonly sinceLastLook: ReadonlyArray<ScreenLogEntry>;
    };

/**
 * Every input on a screen passes here (ADR 0020): the agent's two calls, people's takeovers, and
 * the one hand per live screen this process holds.
 */
export class Screens extends Context.Service<
  Screens,
  {
    readonly look: (caller: ScreenCaller) => Effect.Effect<ScreenCallAnswer, ScreenStartError>;
  }
>()("@mend/sessions/Screens") {}

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
  png,
  frameId: entry.frame?.id ?? null,
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
    const hands: Hands = yield* makeHands((screen) =>
      Effect.ignore(screens.control(screen.id, { _tag: "Ended" }, null)),
    );

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
        const admitted = yield* screens.control(screen.id, { _tag: "AgentLooked" }, null);
        if (admitted._tag === "Refused") return yield* settle(screen, who, "refused", "held");
        const hand = yield* hands.of(screen);
        if (hand === null) return yield* settle(screen, who, "outcome_unknown", null);
        return yield* answer(screen, who, { _tag: "Looked" }, yield* hand.look, "applied");
      });

    /**
     * Claims the call before any input, then runs it where the caller's going away cannot leave
     * the claim open behind input already sent.
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
        const reserved = yield* screens.ofSession(caller.sessionId);
        if (reserved === null) return refused("no_screen");
        const screen = yield* started(reserved);
        const claim = yield* screens.claim({ screenId: screen.id, callKey: who.callKey, args });
        switch (claim._tag) {
          case "CallReused":
            return refused("call_reused");
          case "Open":
            return refused("busy");
          case "Settled":
            return yield* replay(screen, who, claim.call);
          case "Claimed": {
            const ran = run(screen, who).pipe(
              Effect.catchTags({
                HandEnded: () => settle(screen, who, "outcome_unknown", null),
                WorkerStopped: () => settle(screen, who, "outcome_unknown", null),
              }),
            );
            return yield* Effect.flatMap(Effect.forkIn(ran, scope), Fiber.join);
          }
        }
      }).pipe(Effect.catchTag("ScreenNotFoundError", () => Effect.succeed(refused("no_screen"))));

    return {
      look: (caller) => call(caller, { tool: "screen_look" }, look),
    };
  }),
);
