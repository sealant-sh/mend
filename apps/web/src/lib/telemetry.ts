import type { AnyRouter } from "@tanstack/react-router";

import { type BrowserTelemetry, pageTelemetry } from "./telemetry-config.ts";

/**
 * What the app reports to Sentry, and the one door to it (SLNT-1349). The SDK is its own chunk,
 * fetched only on a page served with a DSN (`telemetry-config.ts`): a page without one loads none
 * of it and sends nothing. Everything here is a no-op on the server and when telemetry is off.
 */

type Reporter = typeof import("./telemetry-sentry.ts");

let reporter: Reporter | null = null;
let started = false;

/** Errors caught before the SDK arrived: reported when it does, the first few only. */
const early: Array<unknown> = [];
const EARLY_LIMIT = 10;

const load = async (telemetry: BrowserTelemetry, router: AnyRouter): Promise<void> => {
  try {
    const loaded = await import("./telemetry-sentry.ts");
    loaded.start(telemetry, router);
    reporter = loaded;
    for (const error of early.splice(0)) loaded.reportCaught(error);
  } catch {
    // A chunk that does not load leaves the page as it was: reporting is never in the way.
    early.length = 0;
  }
};

/** Start reporting for this page, once, if it was served with a DSN. */
export const startTelemetry = (router: AnyRouter): void => {
  const telemetry = pageTelemetry();
  if (telemetry === null || started) return;
  started = true;
  void load(telemetry, router);
};

/**
 * Report an error a boundary caught (a route's error screen, a tab's or a session's), which
 * React hands to no page-wide handler. A refusal or failure Mend's server answered with is
 * reported there, with its cause, and not again here.
 */
export const reportCaught = (error: unknown): void => {
  if (reporter !== null) reporter.reportCaught(error);
  else if (started && early.length < EARLY_LIMIT) early.push(error);
};

// ─── Actions: a person's start or send, as the root of its own trace ────────────────────────

/** Where a later span links back to: the trace and span an action ran as. */
export interface TraceRef {
  readonly traceId: string;
  readonly spanId: string;
}

/** An action as it runs: what it learns, and the calls it makes after an await. */
export interface Action {
  /** Ids and enums only (CONTRACT.md, Traces): `mend.session_id`, `mend.turn_id`. */
  readonly annotate: (attributes: Readonly<Record<string, string>>) => void;
  /**
   * Make `call` part of this action. A tRPC call made in the action's first, synchronous step is
   * already; one made after an await (the outbox sends in turn) is not, unless it goes through here.
   */
  readonly within: <A>(call: () => A) => A;
  /** The action's trace, for a span that comes after it; null when telemetry is off. */
  readonly ref: TraceRef | null;
}

const UNTRACED: Action = { annotate: () => undefined, within: (call) => call(), ref: null };

/**
 * Run `run` as an action named `name` (`mend.web.<area>.<operation>`): the root span of a trace of
 * its own, which its calls to Mend's server carry on (lib/trpc.ts). With telemetry off, `run` runs
 * as it would have.
 */
export const traceAction = <A>(
  name: string,
  attributes: Readonly<Record<string, string>>,
  run: (action: Action) => Promise<A>,
): Promise<A> => (reporter === null ? run(UNTRACED) : reporter.traceAction(name, attributes, run));

/** The tRPC operation context key, and the request header, that name a call's action. */
const ACTION_CONTEXT = "mendAction";
const ACTION_HEADER = "x-mend-action";

/** What a tRPC operation made now carries in its context: the action it is part of, if any. */
export const actionContext = (): Readonly<Record<string, string>> => {
  const key = reporter?.currentAction() ?? null;
  return key === null ? {} : { [ACTION_CONTEXT]: key };
};

/**
 * The header that names a request's action, from its operations' contexts: a batch names the
 * first action any of its calls was made in. It never leaves the browser (`actionFetch`).
 */
export const actionHeaders = (
  contexts: ReadonlyArray<Readonly<Record<string, unknown>>>,
): Record<string, string> => {
  const key = contexts
    .map((context) => context[ACTION_CONTEXT])
    .find((each) => typeof each === "string");
  return typeof key === "string" ? { [ACTION_HEADER]: key } : {};
};

/**
 * `fetch` for Mend's tRPC links: a request that names an action goes out with that action's span
 * active, so its `http.client` span and trace headers are the action's, and without the header.
 */
export const actionFetch =
  <U, I extends { readonly headers?: HeadersInit | undefined } | undefined, R>(
    fetch: (url: U, init?: I) => R,
  ) =>
  (url: U, init?: I): R => {
    const headers = new Headers(init?.headers);
    const key = headers.get(ACTION_HEADER);
    if (init === undefined || key === null) return fetch(url, init);
    headers.delete(ACTION_HEADER);
    const send = () => fetch(url, { ...init, headers });
    return reporter === null ? send() : reporter.withinAction(key, send);
  };

// ─── A turn's first visible output ──────────────────────────────────────────────────────────

/** A turn this tab waits to see the agent answer, since when, and the send it came from. */
export interface Awaiting {
  readonly sessionId: string;
  readonly since: number;
  readonly from: "send" | "event";
  readonly ref: TraceRef | null;
}

const awaiting = new Map<string, Awaiting>();
/** Turns whose output this tab already showed: never measured again. */
const shown = new Set<string>();
const AWAITING_LIMIT = 50;

/** The oldest entries go first once there are more than `AWAITING_LIMIT`: a tab open for days. */
const keepRecent = (held: Map<string, Awaiting> | Set<string>): void => {
  for (const key of held.keys()) {
    if (held.size <= AWAITING_LIMIT) return;
    held.delete(key);
  }
};

/**
 * This tab waits for `turnId`'s first output: since this tab sent it (`send`, linked to the send's
 * trace, and it wins over an event that saw the turn first), or since an event showed the turn open
 * with nothing of the agent's yet (`event`).
 */
export const awaitTurnOutput = (
  sessionId: string,
  turnId: string,
  from: "send" | "event",
  ref: TraceRef | null = null,
  since: number = Date.now(),
): void => {
  if (reporter === null || shown.has(turnId)) return;
  const held = awaiting.get(turnId);
  if (held !== undefined && (from === "event" || held.from === "send")) return;
  awaiting.set(turnId, { sessionId, since: Math.min(held?.since ?? since, since), from, ref });
  keepRecent(awaiting);
};

/** The agent's first output for these turns is on the page now: each waited-for one is measured. */
export const turnOutputShown = (turnIds: Iterable<string>): void => {
  if (reporter === null) return;
  for (const turnId of turnIds) {
    if (shown.has(turnId)) continue;
    shown.add(turnId);
    keepRecent(shown);
    const waited = awaiting.get(turnId);
    if (waited === undefined) continue;
    awaiting.delete(turnId);
    reporter.firstVisibleOutput(turnId, waited);
  }
};
