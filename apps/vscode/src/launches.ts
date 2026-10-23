import { LaunchMovedOnReason } from "@mend/domain/workbench";
import { Option, Schema } from "effect";

import { MendApiError } from "./mend-http.js";
import { promptIssue, type LaunchRequest } from "./new-session.js";
import type { LaunchAttempt } from "./session-model.js";
import type { LaunchExpected, Session, SessionDetail } from "./types.js";

type LaunchRead = Pick<SessionDetail, "session" | "processes" | "currentAgent" | "launchAdmission">;

/** What a launch needs of the client. */
export interface LaunchClient {
  isCurrent?(): Promise<boolean>;
  launchSession(
    sessionId: string,
    start: LaunchRequest & { readonly expected?: LaunchExpected },
  ): Promise<unknown>;
  sessionDetail(sessionId: string): Promise<LaunchRead>;
}

export const agentStarted = (detail: LaunchRead): boolean =>
  detail.currentAgent !== null ||
  detail.processes.some(
    (process) => process.kind === "agent-pty" || process.kind === "agent-protocol",
  );

/** No agent ran and nothing settled since `after`: a launch Mend never answered was not taken. */
const untakenSince = (detail: LaunchRead, after: string | null): boolean =>
  detail.session.settledAt === after && !agentStarted(detail);

const refusesLateRetry = (detail: LaunchRead): boolean => detail.launchAdmission === "agentRan";

export class ConnectionChanged extends Error {
  constructor() {
    super("VS Code is now connected to another Mend server or account, so nothing was sent");
  }
}

/** Where each attempt is said: the store, whose model reads it. */
export interface AttemptSink {
  attempted(sessionId: string, attempt: LaunchAttempt): void;
  /**
   * Mend refused this window's launch over its precondition: the session moved on under another
   * launch, so nothing it does next is this window's.
   */
  forget(sessionId: string): void;
}

/** What a failed launch's toast offers, from a read of the session made just before. */
export type RetryOffer =
  /** It failed, or the server refused it and nothing started: Retry sends the same launch. */
  | { readonly kind: "retry"; readonly read: Session }
  /** Failed, but there is nothing this window can send again. */
  | { readonly kind: "none" }
  /** It reads `starting` or live now, or a launch is on its way: nothing failed to retry. */
  | { readonly kind: "moved"; readonly read: Session };

/**
 * Mend refused a launch over its precondition (#1094), `SessionMovedOn` or `SessionAgentLive`:
 * nothing launched and nothing was written. `said` is the server's sentence.
 */
type Precondition = {
  readonly kind: "movedOn" | "agentLive" | "alreadyRan";
  readonly said: string;
};

const MovedOnBody = Schema.Struct({ reason: LaunchMovedOnReason });

const preconditionOf = (cause: MendApiError): Precondition["kind"] | null => {
  if (cause.status !== 409) return null;
  if (cause.tag === "SessionAgentLive") return "agentLive";
  if (cause.tag !== "SessionMovedOn") return null;
  const body = Option.getOrNull(Schema.decodeUnknownOption(MovedOnBody)(cause.body));
  switch (body?.reason) {
    case "agentRan":
      return "alreadyRan";
    case "agentLive":
    case "underWay":
      return "agentLive";
    case "settled":
    case undefined:
      return "movedOn";
  }
};

/**
 * What a Retry came to. `read` is the session read after Mend refused it, null when that read
 * failed; `said` is the server's sentence, null when this window's own read found it moved on.
 */
export type RetryAnswer =
  /** Sent; the reads say how it went. */
  | { readonly kind: "sent" }
  /** Nothing sent: another Retry is on its way, or there is nothing this window can send. */
  | { readonly kind: "held" }
  /** The session moved on from the failure the toast saw. Nothing was sent again. */
  | { readonly kind: "movedOn"; readonly read: Session; readonly said: string | null }
  | { readonly kind: "movedOn"; readonly read: null; readonly said: string }
  /** Its agent is live or starting: Open attaches to it. */
  | { readonly kind: "agentLive"; readonly read: Session | null; readonly said: string }
  /** An agent ran in the session since the attempt the toast saw: Mend ran the prompt already. */
  | { readonly kind: "alreadyRan"; readonly read: Session | null; readonly said: string };

/**
 * The server's gate refuses a launch while another of the same session is under way
 * (`launch-gate.ts`, `session_starting`): that refusal means something is starting, not that
 * nothing did.
 */
const UNDER_WAY = /already under way/;

interface Launched {
  readonly start: LaunchRequest;
  readonly client: LaunchClient;
}

/**
 * The launches this window sent, by session: what Retry sends again, and each attempt's number. The
 * server holds a launch up to 30 s and runs it detached (`LAUNCH_ANSWER_WINDOW`), and keeps running
 * it when the caller goes away, so a launch with no answer may be running: only a read decides.
 */
export class Launches {
  readonly #launched = new Map<string, Launched>();
  readonly #confirmed = new Map<string, () => void>();
  readonly #attempts = new Map<string, LaunchAttempt>();
  /** Sessions with a launch or a Retry on its way, until it is answered: a second click sends nothing. */
  readonly #busy = new Map<string, Promise<void>>();

  constructor(private readonly sink: AttemptSink) {}

  /** Whether this window launched the session. */
  has(sessionId: string): boolean {
    return this.#launched.has(sessionId);
  }

  /**
   * The first launch of a session this window created, on `client`, which its Retry uses too.
   * `confirmed` hears when Mend answers this launch or a Retry of it with success.
   */
  async launch(
    sessionId: string,
    start: LaunchRequest,
    options: { readonly client: LaunchClient; readonly confirmed?: () => void },
  ): Promise<void> {
    if (this.#busy.has(sessionId)) return;
    const launched = { start, client: options.client };
    this.#launched.set(sessionId, launched);
    if (options.confirmed !== undefined) this.#confirmed.set(sessionId, options.confirmed);
    const sent = await this.#hold(sessionId, () => this.#send(sessionId, launched, null, null));
    // Said once nothing is on its way, so the toast it raises may offer Retry.
    if (sent.kind === "answered") await this.#say(sessionId, sent.attempt);
  }

  /**
   * Read the session once nothing is on its way: Retry is offered only for a launch that failed or
   * never started. A read that lands before the launch is answered waits for the answer, so the
   * toast it raised still offers Retry when that launch failed.
   */
  async offer(sessionId: string): Promise<RetryOffer> {
    for (let busy = this.#busy.get(sessionId); busy !== undefined; busy = this.#busy.get(sessionId))
      await busy;
    return this.#check(sessionId);
  }

  /**
   * Retry: the same launch on the same session, once a read just now says it may be sent. It names
   * `settledAt`, the failure its toast saw, as `expected`, so Mend launches it only over that
   * failure. Null, for a refusal the server never settled, names the session as never launched:
   * Mend refuses it once any agent ran there.
   */
  async relaunch(sessionId: string, settledAt: string | null): Promise<RetryAnswer> {
    const launched = this.#launched.get(sessionId);
    if (launched === undefined || this.#busy.has(sessionId)) return { kind: "held" };
    return this.#hold(sessionId, async (): Promise<RetryAnswer> => {
      const offer = await this.#check(sessionId);
      if (offer.kind === "none") return { kind: "held" };
      if (offer.kind === "moved") return { kind: "movedOn", read: offer.read, said: null };
      const sent = await this.#send(sessionId, launched, offer.read.settledAt, { settledAt });
      if (sent.kind === "answered") {
        await this.#say(sessionId, sent.attempt);
        return { kind: "sent" };
      }
      if (sent.kind === "unsent") return { kind: "held" };
      return { kind: sent.kind, read: await this.#read(sessionId), said: sent.said };
    });
  }

  async #hold<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const done = Promise.withResolvers<void>();
    this.#busy.set(sessionId, done.promise);
    try {
      return await work();
    } finally {
      this.#busy.delete(sessionId);
      done.resolve();
    }
  }

  async #read(sessionId: string): Promise<Session | null> {
    return (await this.#detail(sessionId))?.session ?? null;
  }

  async #detail(sessionId: string): Promise<LaunchRead | null> {
    const launched = this.#launched.get(sessionId);
    if (launched === undefined) return null;
    return launched.client.sessionDetail(sessionId).catch(() => null);
  }

  async #check(sessionId: string): Promise<RetryOffer> {
    const start = this.#launched.get(sessionId)?.start;
    if (start === undefined || promptIssue(start.prompt ?? "", "the agent") !== null)
      return { kind: "none" };
    const detail = await this.#detail(sessionId);
    if (detail === null) return { kind: "none" };
    const read = detail.session;
    const attempt = this.#attempts.get(sessionId);
    const refusal = attempt?.refusal ?? null;
    if (read.status === "failed") return { kind: "retry", read };
    if (
      (read.status === "starting" || read.status === "idle") &&
      refusal !== null &&
      !UNDER_WAY.test(refusal.line) &&
      untakenSince(detail, attempt?.after ?? null)
    )
      return refusal.unanswered && !refusesLateRetry(detail)
        ? { kind: "none" }
        : { kind: "retry", read };
    return { kind: "moved", read };
  }

  /**
   * Says the attempt and sends it. Gives back the attempt as answered, for its caller to say, or a
   * precondition refusal, after which the store holds no attempt of this window's for the session.
   */
  async #send(
    sessionId: string,
    { start, client }: Launched,
    after: string | null,
    expected: LaunchExpected | null,
  ): Promise<
    | { readonly kind: "answered"; readonly attempt: LaunchAttempt }
    | { readonly kind: "unsent" }
    | Precondition
  > {
    const before = this.#attempts.get(sessionId);
    const attempt: LaunchAttempt = { n: (before?.n ?? 0) + 1, after, refusal: null };
    await this.#say(sessionId, attempt);
    try {
      await client.launchSession(sessionId, expected === null ? start : { ...start, expected });
      this.#confirmed.get(sessionId)?.();
      return { kind: "answered", attempt };
    } catch (cause) {
      if (cause instanceof ConnectionChanged) {
        this.#restore(sessionId, before);
        return { kind: "unsent" };
      }
      // No answer, or a 5xx (an edge in front of the server answers 502/504 while the server
      // still runs the launch): it may be running. Saying it again reads the session, and the
      // reads say.
      if (!(cause instanceof MendApiError) || cause.status === null || cause.status >= 500) {
        const untaken = await this.#untakenRead(sessionId);
        if (untaken === null) return { kind: "answered", attempt };
        const said = cause instanceof Error ? cause.message : "Mend did not answer";
        return {
          kind: "answered",
          attempt: {
            ...attempt,
            refusal: {
              line: refusesLateRetry(untaken)
                ? `launch not answered · ${said}`
                : "launch not confirmed · Mend did not answer · check the session",
              at: new Date().toISOString(),
              confirmed: true,
              unanswered: true,
            },
          },
        };
      }
      const precondition = preconditionOf(cause);
      if (precondition !== null) {
        this.#restore(sessionId, before);
        if (await this.#current(sessionId)) this.sink.forget(sessionId);
        return { kind: precondition, said: cause.message };
      }
      // The server settles most refusals failed before it answers: then that failure, keyed by
      // its `settledAt` in every window, is the one toast, and the refusal is not said apart.
      const settled = await this.#settledSince(sessionId, after);
      if (settled === "settled") return { kind: "answered", attempt };
      return {
        kind: "answered",
        attempt: {
          ...attempt,
          refusal: {
            line: `launch refused · ${cause.message}`,
            at: new Date().toISOString(),
            confirmed: settled === "unsettled",
            unanswered: false,
          },
        },
      };
    }
  }

  #restore(sessionId: string, before: LaunchAttempt | undefined): void {
    if (before === undefined) this.#attempts.delete(sessionId);
    else this.#attempts.set(sessionId, before);
  }

  /**
   * The session still reads idle with no agent ever started, so it has not taken the launch: Retry
   * may send it again, and the server's launch gate refuses that if the launch is under way after
   * all.
   */
  async #untakenRead(sessionId: string): Promise<LaunchRead | null> {
    const read = await this.#detail(sessionId);
    return read !== null && read.session.status === "idle" && !agentStarted(read) ? read : null;
  }

  /** Whether the server settled the session failed since `after`; unknown when the read fails. */
  async #settledSince(
    sessionId: string,
    after: string | null,
  ): Promise<"settled" | "unsettled" | "unknown"> {
    const read = await this.#read(sessionId);
    if (read === null) return "unknown";
    return read.status === "failed" && read.settledAt !== after ? "settled" : "unsettled";
  }

  async #current(sessionId: string): Promise<boolean> {
    return (await this.#launched.get(sessionId)?.client.isCurrent?.()) ?? true;
  }

  async #say(sessionId: string, attempt: LaunchAttempt): Promise<void> {
    this.#attempts.set(sessionId, attempt);
    if (await this.#current(sessionId)) this.sink.attempted(sessionId, attempt);
  }
}
