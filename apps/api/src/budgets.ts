import { createHash } from "node:crypto";

import { makeWindowLimiter, type WindowLimiter } from "@mend/network";
import { Config, Effect, Layer } from "effect";
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
  /** Open long-lived connections one account may hold, by kind. */
  readonly accountEventStreams: number;
  readonly accountTerminals: number;
  readonly accountTunnels: number;
  readonly accountKeyBridges: number;
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
  accountEventStreams: 12,
  accountTerminals: 24,
  accountTunnels: 24,
  accountKeyBridges: 4,
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
  accountEventStreams: "MEND_BUDGET_ACCOUNT_EVENT_STREAMS",
  accountTerminals: "MEND_BUDGET_ACCOUNT_TERMINALS",
  accountTunnels: "MEND_BUDGET_ACCOUNT_TUNNELS",
  accountKeyBridges: "MEND_BUDGET_ACCOUNT_KEY_BRIDGES",
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
  accountEventStreams: "open event streams for one account",
  accountTerminals: "open terminals for one account",
  accountTunnels: "open service tunnels for one account",
  accountKeyBridges: "open key bridges for one account",
};

/** What a refusal says. Plain facts: which budget, its limit, and that nothing running was touched. */
export const budgetMessage = (name: BudgetName, limit: number): string =>
  `budget reached · ${limit} ${WORDS[name]} · nothing running was stopped`;

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
    /**
     * Hold one launch slot for the account while `effect` runs, or null when the account has
     * `accountLaunchesInFlight` starting already. The slot is released however `effect` ends.
     */
    readonly withLaunchSlot: <A, E, R>(
      userId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A | null, E, R>;
  }
>()("@mend/api/Budgets") {}

export const makeBudgets = (limits: BudgetLimits) => {
  const launching = new Map<string, number>();
  return {
    limits,
    addresses: makeWindowLimiter(),
    credentials: makeWindowLimiter(),
    signIns: makeWindowLimiter(),
    withLaunchSlot: <A, E, R>(userId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const held = launching.get(userId) ?? 0;
        if (overCeiling(held, limits.accountLaunchesInFlight)) return Effect.succeed(null);
        launching.set(userId, held + 1);
        return effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              const now = (launching.get(userId) ?? 1) - 1;
              if (now <= 0) launching.delete(userId);
              else launching.set(userId, now);
            }),
          ),
        );
      }),
  };
};

const limit = (name: BudgetName) =>
  Config.int(ENV[name]).pipe(Config.withDefault(DEFAULT_BUDGET_LIMITS[name]));

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
  accountEventStreams: limit("accountEventStreams"),
  accountTerminals: limit("accountTerminals"),
  accountTunnels: limit("accountTunnels"),
  accountKeyBridges: limit("accountKeyBridges"),
});

export const BudgetsLive: Layer.Layer<Budgets, Config.ConfigError> = Layer.effect(
  Budgets,
  Effect.gen(function* () {
    const limits = yield* budgetLimitsConfig;
    const off = budgetsOff(limits);
    yield* Effect.logInfo("budgets").pipe(
      Effect.annotateLogs({ off: off.length === 0 ? "none" : off.map(budgetEnvName).join(",") }),
    );
    return makeBudgets(limits);
  }),
);
