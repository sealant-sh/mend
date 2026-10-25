import { createHash } from "node:crypto";

import { HANDOFF_FILE_BYTES_DEFAULT } from "@mend/domain/workbench";
import { makeWindowLimiter, type WindowLimiter } from "@mend/network";
import { Config, Effect, Layer, type Scope } from "effect";
import * as Context from "effect/Context";

/**
 * Budgets (docs/adr/0004-access-without-a-private-network.md, "Budgets"; MEND-05). A budget
 * refuses new work with a stated reason and a time to retry. It never stops a running session,
 * never closes a socket that is already open and never drops a capture, and every refusal happens
 * before the effect it guards. `0` turns one budget off; the public exposure gate needs them all.
 */
export interface BudgetLimits {
  /** Largest request body, in bytes, refused before a byte of it is decoded. */
  readonly bodyBytes: number;
  /** The same for the routes that take a file: a pasted image, a skills library, a folder upload. */
  readonly uploadBodyBytes: number;
  /** Largest WebSocket frame a terminal, tunnel or key bridge accepts from a client. */
  readonly frameBytes: number;
  /** Requests per minute from one client address, counted before authentication. */
  readonly addressRequestsPerMinute: number;
  /** Requests per minute presenting one credential (a session cookie or a bearer). */
  readonly credentialRequestsPerMinute: number;
  /** Sign-in, sign-up, password reset and invitation attempts per minute from one address. */
  readonly signInAttemptsPerMinute: number;
  /** Unsettled sessions one account may hold. */
  readonly accountLiveSessions: number;
  /** Unsettled sessions one organization may hold. */
  readonly organizationLiveSessions: number;
  /** Launches one account may have starting at once. */
  readonly accountLaunchesInFlight: number;
  /**
   * Largest git bundle in either direction: a `mend pull` answer, refused with its size above
   * it, and a `mend handoff` body, refused unread above it.
   */
  readonly bundleBytes: number;
  /** Largest file `mend handoff` carries; the CLI names a larger one and leaves it behind. */
  readonly handoffFileBytes: number;
  /** Handoffs one account may have admitted at once: each holds a bundle in memory and git work. */
  readonly accountHandoffsInFlight: number;
  /** Fetches of origin's branch one account asks for per minute ("Check origin"). */
  readonly accountOriginChecksPerMinute: number;
  /** Open long-lived connections one account may hold, by kind. */
  readonly accountEventStreams: number;
  readonly accountTerminals: number;
  readonly accountTunnels: number;
  readonly accountKeyBridges: number;
  /** Raw file reads one account may have open at once; each holds a descriptor until it ends. */
  readonly accountRawReads: number;
  /** Raw file reads open at once on this instance, whoever reads. */
  readonly rawReads: number;
  /** Requests and upgrades one account holds open on the preview gateway, a held one included. */
  readonly accountPreviewConnections: number;
  /** Request-triggered preview starts one account may have running at once. */
  readonly accountPreviewStartsInFlight: number;
}

export type BudgetName = keyof BudgetLimits;

/** Sized for a small team on one machine. Every one is configuration. */
export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  bodyBytes: 1024 * 1024,
  uploadBodyBytes: 24 * 1024 * 1024,
  frameBytes: 1024 * 1024,
  addressRequestsPerMinute: 1200,
  credentialRequestsPerMinute: 1200,
  signInAttemptsPerMinute: 20,
  accountLiveSessions: 24,
  organizationLiveSessions: 120,
  accountLaunchesInFlight: 4,
  bundleBytes: 64 * 1024 * 1024,
  handoffFileBytes: HANDOFF_FILE_BYTES_DEFAULT,
  accountHandoffsInFlight: 2,
  accountOriginChecksPerMinute: 30,
  accountEventStreams: 12,
  accountTerminals: 24,
  accountTunnels: 24,
  accountKeyBridges: 4,
  // Above all the t3code gateway reads at once (96), so a person meets its wait, never this.
  accountRawReads: 128,
  // Two descriptors each (the file and the socket): bounded well inside the process's table.
  rawReads: 512,
  accountPreviewConnections: 48,
  accountPreviewStartsInFlight: 4,
};

const ENV: Readonly<Record<BudgetName, string>> = {
  bodyBytes: "MEND_BUDGET_BODY_BYTES",
  uploadBodyBytes: "MEND_BUDGET_UPLOAD_BODY_BYTES",
  frameBytes: "MEND_BUDGET_FRAME_BYTES",
  addressRequestsPerMinute: "MEND_BUDGET_ADDRESS_REQUESTS_PER_MINUTE",
  credentialRequestsPerMinute: "MEND_BUDGET_CREDENTIAL_REQUESTS_PER_MINUTE",
  signInAttemptsPerMinute: "MEND_BUDGET_SIGN_IN_ATTEMPTS_PER_MINUTE",
  accountLiveSessions: "MEND_BUDGET_ACCOUNT_LIVE_SESSIONS",
  organizationLiveSessions: "MEND_BUDGET_ORGANIZATION_LIVE_SESSIONS",
  accountLaunchesInFlight: "MEND_BUDGET_ACCOUNT_LAUNCHES_IN_FLIGHT",
  bundleBytes: "MEND_BUDGET_BUNDLE_BYTES",
  handoffFileBytes: "MEND_BUDGET_HANDOFF_FILE_BYTES",
  accountHandoffsInFlight: "MEND_BUDGET_ACCOUNT_HANDOFFS_IN_FLIGHT",
  accountOriginChecksPerMinute: "MEND_BUDGET_ACCOUNT_ORIGIN_CHECKS_PER_MINUTE",
  accountEventStreams: "MEND_BUDGET_ACCOUNT_EVENT_STREAMS",
  accountTerminals: "MEND_BUDGET_ACCOUNT_TERMINALS",
  accountTunnels: "MEND_BUDGET_ACCOUNT_TUNNELS",
  accountKeyBridges: "MEND_BUDGET_ACCOUNT_KEY_BRIDGES",
  accountRawReads: "MEND_BUDGET_ACCOUNT_RAW_READS",
  rawReads: "MEND_BUDGET_RAW_READS",
  accountPreviewConnections: "MEND_BUDGET_ACCOUNT_PREVIEW_CONNECTIONS",
  accountPreviewStartsInFlight: "MEND_BUDGET_ACCOUNT_PREVIEW_STARTS_IN_FLIGHT",
};

export const budgetEnvName = (name: BudgetName): string => ENV[name];

const WORDS: Readonly<Record<BudgetName, string>> = {
  bodyBytes: "bytes in one request body",
  uploadBodyBytes: "bytes in one uploaded body",
  frameBytes: "bytes in one WebSocket frame",
  addressRequestsPerMinute: "requests per minute from one address",
  credentialRequestsPerMinute: "requests per minute for one credential",
  signInAttemptsPerMinute: "sign-in attempts per minute from one address",
  accountLiveSessions: "unsettled sessions for one account",
  organizationLiveSessions: "unsettled sessions for one organization",
  accountLaunchesInFlight: "launches starting at once for one account",
  bundleBytes: "bytes in one git bundle",
  handoffFileBytes: "bytes in one handed-off file",
  accountHandoffsInFlight: "handoffs admitted at once for one account",
  accountOriginChecksPerMinute: "fetches of origin per minute for one account",
  accountEventStreams: "open event streams for one account",
  accountTerminals: "open terminals for one account",
  accountTunnels: "open service tunnels for one account",
  accountKeyBridges: "open key bridges for one account",
  accountRawReads: "open raw file reads for one account",
  rawReads: "open raw file reads on this instance",
  accountPreviewConnections: "open preview requests for one account",
  accountPreviewStartsInFlight: "preview starts at once for one account",
};

/** What a refusal at any ceiling says: its limit, what it counts, and that nothing was touched. */
export const ceilingMessage = (limit: number, words: string): string =>
  `budget reached · ${limit} ${words} · nothing running was stopped`;

/** What a refusal says. Plain facts: which budget, its limit, and that nothing running was touched. */
export const budgetMessage = (name: BudgetName, limit: number): string =>
  ceilingMessage(limit, WORDS[name]);

/** The budgets that are off on this instance (`0`), for the gate and the start-up log. */
export const budgetsOff = (limits: BudgetLimits): ReadonlyArray<BudgetName> =>
  (Object.keys(ENV) as Array<BudgetName>).filter((name) => limits[name] <= 0);

/** A credential's subject: a digest, so a window never holds a cookie or a bearer. */
export const credentialSubject = (credential: string): string =>
  createHash("sha256").update(credential).digest("hex").slice(0, 24);

/** A ceiling read against a current count. Off at `0`. */
export const overCeiling = (current: number, limit: number): boolean =>
  limit > 0 && current >= limit;

export class Budgets extends Context.Service<
  Budgets,
  {
    readonly limits: BudgetLimits;
    /** One window per concern, so a flood of sign-ins does not spend the address's page loads. */
    readonly addresses: WindowLimiter;
    readonly credentials: WindowLimiter;
    readonly signIns: WindowLimiter;
    /** Fetches of origin's branch a viewer asks for, by account. */
    readonly originChecks: WindowLimiter;
    /**
     * Hold one launch slot for the account while `effect` runs, or null when the account has
     * `accountLaunchesInFlight` starting already. The slot is released however `effect` ends.
     */
    readonly withLaunchSlot: <A, E, R>(
      userId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A | null, E, R>;
    readonly withHandoffSlot: <A, E, R>(
      userId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A | null, E, R>;
    /**
     * Hold a raw read slot of the account and of the instance until the scope closes, or name
     * the budget that is full.
     */
    readonly rawReadSlot: (
      userId: string,
    ) => Effect.Effect<"accountRawReads" | "rawReads" | null, never, Scope.Scope>;
    /** A request-triggered preview start, paid by the account whose request triggered it. */
    readonly withPreviewStartSlot: <A, E, R>(
      userId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A | null, E, R>;
  }
>()("@mend/api/Budgets") {}

const makeSlots = (ceiling: number) => {
  const held = new Map<string, number>();
  return <A, E, R>(userId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const current = held.get(userId) ?? 0;
      if (overCeiling(current, ceiling)) return Effect.succeed(null);
      held.set(userId, current + 1);
      return effect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            const now = (held.get(userId) ?? 1) - 1;
            if (now <= 0) held.delete(userId);
            else held.set(userId, now);
          }),
        ),
      );
    });
};

const makeRawReadSlots = (limits: BudgetLimits) => {
  const held = new Map<string, number>();
  let open = 0;
  return (userId: string) =>
    Effect.uninterruptible(
      Effect.suspend(() => {
        const current = held.get(userId) ?? 0;
        if (overCeiling(current, limits.accountRawReads))
          return Effect.succeed("accountRawReads" as const);
        if (overCeiling(open, limits.rawReads)) return Effect.succeed("rawReads" as const);
        held.set(userId, current + 1);
        open++;
        return Effect.as(
          Effect.addFinalizer(() =>
            Effect.sync(() => {
              open--;
              const now = (held.get(userId) ?? 1) - 1;
              if (now <= 0) held.delete(userId);
              else held.set(userId, now);
            }),
          ),
          null,
        );
      }),
    );
};

export const makeBudgets = (limits: BudgetLimits) => ({
  limits,
  addresses: makeWindowLimiter(),
  credentials: makeWindowLimiter(),
  signIns: makeWindowLimiter(),
  originChecks: makeWindowLimiter(),
  withLaunchSlot: makeSlots(limits.accountLaunchesInFlight),
  withHandoffSlot: makeSlots(limits.accountHandoffsInFlight),
  rawReadSlot: makeRawReadSlots(limits),
  withPreviewStartSlot: makeSlots(limits.accountPreviewStartsInFlight),
});

const limit = (name: BudgetName) =>
  Config.Int(ENV[name]).pipe(Config.withDefault(DEFAULT_BUDGET_LIMITS[name]));

export const budgetLimitsConfig = Config.all({
  bodyBytes: limit("bodyBytes"),
  uploadBodyBytes: limit("uploadBodyBytes"),
  frameBytes: limit("frameBytes"),
  addressRequestsPerMinute: limit("addressRequestsPerMinute"),
  credentialRequestsPerMinute: limit("credentialRequestsPerMinute"),
  signInAttemptsPerMinute: limit("signInAttemptsPerMinute"),
  accountLiveSessions: limit("accountLiveSessions"),
  organizationLiveSessions: limit("organizationLiveSessions"),
  accountLaunchesInFlight: limit("accountLaunchesInFlight"),
  bundleBytes: limit("bundleBytes"),
  handoffFileBytes: limit("handoffFileBytes"),
  accountHandoffsInFlight: limit("accountHandoffsInFlight"),
  accountOriginChecksPerMinute: limit("accountOriginChecksPerMinute"),
  accountEventStreams: limit("accountEventStreams"),
  accountTerminals: limit("accountTerminals"),
  accountTunnels: limit("accountTunnels"),
  accountKeyBridges: limit("accountKeyBridges"),
  accountRawReads: limit("accountRawReads"),
  rawReads: limit("rawReads"),
  accountPreviewConnections: limit("accountPreviewConnections"),
  accountPreviewStartsInFlight: limit("accountPreviewStartsInFlight"),
});

export const BudgetsLive: Layer.Layer<Budgets, Config.ConfigError> = Layer.effect(
  Budgets,
  Effect.gen(function* () {
    const limits = yield* budgetLimitsConfig;
    const off = budgetsOff(limits);
    yield* Effect.logInfo("budgets").pipe(
      Effect.annotateLogs({
        off: off.length === 0 ? "none" : off.map(budgetEnvName).join(","),
      }),
    );
    return makeBudgets(limits);
  }),
);
