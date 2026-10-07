/**
 * The restart path of a shared conversation (docs/adr/0016-per-person-harness-homes.md, decision 6,
 * Delivery 17), against the platform: the conversation home `H` handed from one agent process to
 * the next, each running as its sender's own user on their own login. A hand-over is two Core
 * calls, DELETE then POST, one stop and one start: the next process's seed is staged in `H.next`
 * while the old process stops; once its process group is empty `H`'s login is released, the two
 * directories are exchanged, Core writes the sender's login into `H`, and the agent starts.
 * Nothing here runs outside a person-layout executor.
 */
import { MEND_GROUP, type LinuxIdentity } from "@mend/domain/workbench";
import {
  type LoginProvider,
  type PersonLayoutPlatform,
  SealantPlatformError,
  type SealantClientShape,
} from "@mend/sealant";
import type { Workspace } from "@sealant/sdk";
import { Effect } from "effect";
import * as Semaphore from "effect/Semaphore";

import {
  type ConversationHarness,
  type ConversationPlaces,
  type ConversationReport,
  conversationHomeOf,
  conversationProcessEnv,
  exchangeConversationHomeScript,
  parseConversationReport,
  stageConversationHomeScript,
} from "./conversation-home.ts";
import { loginRefusal, loginRefused, refusedAccountOf } from "./harness-layout-steps.ts";

/** The provider whose login a conversation home holds: the harness's own, and nothing else. */
export const conversationProviderOf = (harness: ConversationHarness): LoginProvider =>
  harness === "claude" ? "claude" : "codex";

/** What a resume that cannot find its conversation says: the turn fails, and nothing was sent. */
export const conversationMissingWords = (harness: ConversationHarness): string =>
  harness === "codex"
    ? "Codex could not find this conversation's thread. Nothing was sent."
    : "Claude could not find this conversation's transcript. Nothing was sent.";

/** A hand-over that could not finish: nothing started, and the conversation is untouched. */
export const handOverFailed = (code: string, message: string, cause: unknown = null) =>
  new SealantPlatformError({ code, status: null, message, cause });

export interface HandOverInput {
  readonly workspace: Workspace;
  readonly sessionId: string;
  readonly harness: ConversationHarness;
  /** The session's owner: `C` is in their saved directory. */
  readonly owner: LinuxIdentity;
  /** Whose turn the next process runs: their user, their login. */
  readonly sender: LinuxIdentity;
  /** The conversation's provider id; null for a conversation the next process starts. */
  readonly providerSessionId: string | null;
  readonly model: string | null;
  /** The conversation has not moved into `C` yet: the move runs, as the owner, first. */
  readonly move: boolean;
  /**
   * The old process's stop (close its input, wait for it to exit), run beside the staging; null
   * when no process of the conversation runs in this executor.
   */
  readonly stop: Effect.Effect<void, SealantPlatformError> | null;
  /** The sender's own person environment (`personProcessEnv`), which the conversation's wins over. */
  readonly personEnv: Readonly<Record<string, string>>;
  /**
   * Take the conversation's one live agent process (decision 6), from the process this start
   * replaces, before anything is stopped or touched: its fence. A take that fails stops the
   * hand-over there, with the old process still running.
   */
  readonly take?: Effect.Effect<number, SealantPlatformError>;
  /** Give a take back when the hand-over fails after it. */
  readonly untake?: (fence: number) => Effect.Effect<void>;
}

export interface HandedOver {
  /** The next process's environment: its harness directory at `H`, the neutral switches. */
  readonly env: Readonly<Record<string, string>>;
  /** The transcript a resume continues, under `H`; null for a new conversation. */
  readonly resumePath: string | null;
  /** This hand-over moved the conversation into `C`. */
  readonly moved: boolean;
  readonly staged: ConversationReport;
  /** The take's fence, which the started process binds to; null without a take. */
  readonly fence: number | null;
}

export interface ConversationSteps {
  /**
   * Hand the conversation to the next agent process, as `sender` (decision 6). Refused, with no
   * login written for anyone, when the sender has not connected the harness's provider or it needs
   * reconnecting; failed, with nothing started, when the conversation cannot be found in `C`.
   */
  readonly handOver: (input: HandOverInput) => Effect.Effect<HandedOver, SealantPlatformError>;
  /**
   * The process that started on a hand-over: the login in `H` is now its own, released when it
   * exits (`release`).
   */
  readonly started: (workspaceId: string, sessionId: string, processId: string) => void;
  /**
   * A conversation's process exited, or a start after a hand-over failed (`processId` null):
   * `H`'s login is released, unless a newer start owns the home. Never fails.
   */
  readonly release: (input: {
    readonly workspace: Effect.Effect<Workspace, SealantPlatformError>;
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly processId: string | null;
  }) => Effect.Effect<void>;
  /** Whose login a conversation home holds in an executor, as Mend knows it. */
  readonly holderOf: (workspaceId: string, sessionId: string) => string | null | "unknown";
  /** At startup: a conversation home Core lists holds a login nobody here started. */
  readonly noteHeld: (workspaceId: string, sessionId: string) => void;
  /** An executor ended: what Mend kept about its conversation homes goes with it. */
  readonly forgetExecutor: (workspaceId: string) => void;
}

interface HomeState {
  /** Whose login `H` holds: an account, null for none, `unknown` after a restart. */
  holder: string | null | "unknown";
  /** The process that runs in `H`; null while a hand-over is in flight or none started. */
  process: string | null;
}

/** A conversation home in one executor. */
const keyOf = (workspaceId: string, sessionId: string) => `${workspaceId}\u0000${sessionId}`;

export const makeConversationSteps = (deps: {
  readonly platform: Pick<PersonLayoutPlatform["Service"], "postCredentials" | "deleteCredentials">;
  readonly sealant: Pick<SealantClientShape, "exec">;
  readonly places: ConversationPlaces;
}): ConversationSteps => {
  const { platform, sealant, places } = deps;
  const homes = new Map<string, HomeState>();
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockOf = (key: string) => {
    const known = locks.get(key);
    if (known !== undefined) return known;
    const made = Semaphore.makeUnsafe(1);
    locks.set(key, made);
    return made;
  };
  const stateOf = (key: string): HomeState => {
    const known = homes.get(key);
    if (known !== undefined) return known;
    const made: HomeState = { holder: null, process: null };
    homes.set(key, made);
    return made;
  };
  const home = (sessionId: string) => conversationHomeOf(sessionId, places.homesRoot);

  /** `DELETE { home: H }`: a home Core does not know (after a restart) is released already. */
  const releaseHome = (workspace: Workspace, sessionId: string) =>
    platform
      .deleteCredentials(workspace, { home: home(sessionId) })
      .pipe(
        Effect.catch((error) =>
          error.status === 404 || error.code === "home-not-held" ? Effect.void : Effect.fail(error),
        ),
      );

  const handOver: ConversationSteps["handOver"] = Effect.fn("ConversationSteps.handOver")(
    function* (input) {
      const key = keyOf(input.workspace.id, input.sessionId);
      return yield* lockOf(key).withPermit(
        Effect.gen(function* () {
          const state = stateOf(key);
          // The conversation's one live process is taken first, from the process this start
          // replaces: a second start, racing this one, is refused before anything is stopped
          // or killed (review of mend#572, P3-2).
          const fence = input.take === undefined ? null : yield* input.take;
          const untake = Effect.suspend(() =>
            fence === null || input.untake === undefined ? Effect.void : input.untake(fence),
          );
          // From here the old process no longer owns `H`: its exit releases nothing.
          state.process = null;
          return yield* Effect.gen(function* () {
            // The seed staged as the sender while the old process stops (decision 6,
            // Performance): only the two Core calls, the exchange and the start wait for its
            // exit.
            const stage = sealant.exec(input.workspace, [
              "sh",
              "-c",
              stageConversationHomeScript({
                sessionId: input.sessionId,
                harness: input.harness,
                owner: input.owner,
                sender: input.sender,
                providerSessionId: input.providerSessionId,
                model: input.model,
                move: input.move,
                places,
              }),
            ]);
            // A move into `C` takes the conversation's files from under the owner's personal
            // process, so that one stops first (once per session); every later hand-over stages
            // beside the stop.
            const [, staged] = input.move
              ? yield* Effect.all([input.stop ?? Effect.void, stage], { concurrency: 1 })
              : yield* Effect.all([input.stop ?? Effect.void, stage], { concurrency: 2 });
            if (staged.exitCode !== 0) {
              return yield* handOverFailed(
                "conversation_not_staged",
                `This conversation's next process could not be prepared: ${staged.stderr.trim() || `exit ${staged.exitCode}`}`,
              );
            }
            const report = parseConversationReport(staged.stdout);
            if (report.missing) {
              return yield* handOverFailed(
                "conversation_missing",
                conversationMissingWords(input.harness),
              );
            }
            if (!report.empty) {
              return yield* handOverFailed(
                "conversation_busy",
                "This conversation's previous process did not end, so nothing was started. Try again.",
              );
            }
            return yield* handTo(input, state, report, fence);
          }).pipe(Effect.tapError(() => untake));
        }),
      );
    },
  );

  /** From the staged home on: `H`'s login released, the exchange, the sender's login written. */
  const handTo = (
    input: HandOverInput,
    state: HomeState,
    report: ConversationReport,
    fence: number | null,
  ): Effect.Effect<HandedOver, SealantPlatformError> =>
    Effect.gen(function* () {
      // DELETE first: Core refuses a POST for another person on a held home.
      if (state.holder !== null) {
        yield* releaseHome(input.workspace, input.sessionId).pipe(
          Effect.mapError((error) =>
            handOverFailed(
              "conversation_login_not_released",
              `The previous sender's login could not be taken out of this conversation's home, so nothing was started: ${error.message}`,
              error,
            ),
          ),
        );
        state.holder = null;
      }
      const exchanged = yield* sealant.exec(input.workspace, [
        "sh",
        "-c",
        exchangeConversationHomeScript({
          sessionId: input.sessionId,
          owner: input.owner,
          places,
        }),
      ]);
      if (exchanged.exitCode !== 0) {
        return yield* handOverFailed(
          "conversation_not_exchanged",
          `This conversation's home could not be handed over: ${exchanged.stderr.trim() || `exit ${exchanged.exitCode}`}`,
        );
      }
      // The sender's own login, written by Core into `H` as them (`H` is theirs now). Nobody
      // else's login is ever written for them.
      const provider = conversationProviderOf(input.harness);
      yield* platform
        .postCredentials(input.workspace, {
          onBehalfOf: input.sender.accountId,
          home: home(input.sessionId),
          owner: { uid: input.sender.uid, gid: MEND_GROUP.gid },
          logins: { [provider]: true },
        })
        .pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              // Core may have written it: a release reaches it.
              state.holder = "unknown";
            }),
          ),
          Effect.catch((error) => {
            const refused = refusedAccountOf(error);
            return refused !== null && refused.provider === provider
              ? Effect.fail(loginRefused(loginRefusal(provider, refused.reason)))
              : Effect.fail(error);
          }),
        );
      state.holder = input.sender.accountId;
      return {
        env: conversationProcessEnv({
          harness: input.harness,
          sessionId: input.sessionId,
          personEnv: input.personEnv,
          ...(places.homesRoot === undefined ? {} : { root: places.homesRoot }),
        }),
        resumePath: report.resume,
        moved: report.moved !== null,
        staged: report,
        fence,
      };
    });

  const started: ConversationSteps["started"] = (workspaceId, sessionId, processId) => {
    stateOf(keyOf(workspaceId, sessionId)).process = processId;
  };

  const release: ConversationSteps["release"] = (input) =>
    Effect.gen(function* () {
      const key = keyOf(input.workspaceId, input.sessionId);
      const known = homes.get(key);
      if (known === undefined || known.holder === null) return;
      yield* lockOf(key).withPermit(
        Effect.gen(function* () {
          const state = stateOf(key);
          // A newer start owns the home, or nothing is held any more.
          if (state.holder === null || state.process !== input.processId) return;
          const workspace = yield* input.workspace;
          yield* releaseHome(workspace, input.sessionId);
          state.holder = null;
          state.process = null;
          yield* Effect.logInfo(
            "session engine: a conversation home's login released · observed",
          ).pipe(
            Effect.annotateLogs({ workspaceId: input.workspaceId, sessionId: input.sessionId }),
          );
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "session engine: a conversation home's login was not released; it goes with the executor",
        ).pipe(Effect.annotateLogs({ sessionId: input.sessionId, cause: String(cause) })),
      ),
    );

  return {
    handOver,
    started,
    release,
    holderOf: (workspaceId, sessionId) => homes.get(keyOf(workspaceId, sessionId))?.holder ?? null,
    noteHeld: (workspaceId, sessionId) => {
      const state = stateOf(keyOf(workspaceId, sessionId));
      if (state.holder === null) state.holder = "unknown";
    },
    forgetExecutor: (workspaceId) => {
      for (const key of homes.keys()) {
        if (key.startsWith(`${workspaceId}\u0000`)) {
          homes.delete(key);
          locks.delete(key);
        }
      }
    },
  };
};
