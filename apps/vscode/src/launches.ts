import { MendApiError } from "./mend-http.js";
import { promptIssue, type LaunchRequest } from "./new-session.js";
import type { LaunchAttempt } from "./session-model.js";
import type { LaunchExpected, Session } from "./types.js";

/** What a launch needs of the client. */
export interface LaunchClient {
  isCurrent?(): Promise<boolean>;
  launchSession(
    sessionId: string,
    start: LaunchRequest & { readonly expected?: LaunchExpected },
  ): Promise<unknown>;
  sessionDetail(sessionId: string): Promise<{ readonly session: Session }>;
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
type Precondition = { readonly kind: "movedOn" | "agentLive"; readonly said: string };

const PRECONDITIONS: Readonly<Record<string, Precondition["kind"]>> = {
  SessionMovedOn: "movedOn",
  SessionAgentLive: "agentLive",
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
  | { readonly kind: "agentLive"; readonly read: Session | null; readonly said: string };

/**
 * The server's gate refuses a launch while another of the same session is under way
 * (`launch-gate.ts`, `session_starting`): that refusal means something is starting, not that
 * nothing did.
 */
const UNDER_WAY = /already under way/;

/**
 * The launches this window sent, by session: what Retry sends again, and each attempt's number. The
 * server holds a launch up to 30 s and runs it detached (`LAUNCH_ANSWER_WINDOW`), and keeps running
 * it when the caller goes away, so a launch with no answer may be running: only a read decides.
 */
export class Launches {
  readonly #sent = new Map<string, LaunchRequest>();
  readonly #clients = new Map<string, LaunchClient>();
  readonly #attempts = new Map<string, LaunchAttempt>();
  /** Sessions with a launch or a Retry on its way, until it is answered: a second click sends nothing. */
  readonly #busy = new Map<string, Promise<void>>();

  constructor(
    private readonly client: LaunchClient,
    private readonly sink: AttemptSink,
  ) {}

  /** Whether this window launched the session. */
  has(sessionId: string): boolean {
    return this.#sent.has(sessionId);
  }

  /** The first launch of a session this window created. */
  async launch(
    sessionId: string,
    start: LaunchRequest,
    client: LaunchClient = this.client,
  ): Promise<void> {
    if (this.#busy.has(sessionId)) return;
    this.#clients.set(sessionId, client);
    const sent = await this.#hold(sessionId, () => this.#send(sessionId, start, null, null));
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
   * failure. Null, for a refusal the server never settled, names none: Mend then refuses it only
   * over a live agent.
   */
  async relaunch(sessionId: string, settledAt: string | null): Promise<RetryAnswer> {
    const start = this.#sent.get(sessionId);
    if (start === undefined || this.#busy.has(sessionId)) return { kind: "held" };
    return this.#hold(sessionId, async (): Promise<RetryAnswer> => {
      const offer = await this.#check(sessionId);
      if (offer.kind === "none") return { kind: "held" };
      if (offer.kind === "moved") return { kind: "movedOn", read: offer.read, said: null };
      const expected = settledAt === null ? null : { settledAt };
      const sent = await this.#send(sessionId, start, offer.read.settledAt, expected);
      if (sent.kind === "answered") {
        await this.#say(sessionId, sent.attempt);
        return { kind: "sent" };
      }
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
    return (this.#clients.get(sessionId) ?? this.client).sessionDetail(sessionId).then(
      ({ session }) => session,
      () => null,
    );
  }

  async #check(sessionId: string): Promise<RetryOffer> {
    const start = this.#sent.get(sessionId);
    if (start === undefined || promptIssue(start.prompt ?? "", "the agent") !== null)
      return { kind: "none" };
    const read = await this.#read(sessionId);
    if (read === null) return { kind: "none" };
    const refusal = this.#attempts.get(sessionId)?.refusal ?? null;
    if (read.status === "failed") return { kind: "retry", read };
    if (
      (read.status === "starting" || read.status === "idle") &&
      refusal !== null &&
      !UNDER_WAY.test(refusal.line)
    )
      return { kind: "retry", read };
    return { kind: "moved", read };
  }

  /**
   * Says the attempt and sends it. Gives back the attempt as answered, for its caller to say, or a
   * precondition refusal, after which the store holds no attempt of this window's for the session.
   */
  async #send(
    sessionId: string,
    start: LaunchRequest,
    after: string | null,
    expected: LaunchExpected | null,
  ): Promise<{ readonly kind: "answered"; readonly attempt: LaunchAttempt } | Precondition> {
    const before = this.#attempts.get(sessionId);
    const attempt: LaunchAttempt = { n: (before?.n ?? 0) + 1, after, refusal: null };
    this.#sent.set(sessionId, start);
    await this.#say(sessionId, attempt);
    try {
      await (this.#clients.get(sessionId) ?? this.client).launchSession(
        sessionId,
        expected === null ? start : { ...start, expected },
      );
      return { kind: "answered", attempt };
    } catch (cause) {
      // No answer, or a 5xx (an edge in front of the server answers 502/504 while the server
      // still runs the launch): it may be running. Saying it again reads the session, and the
      // reads say.
      if (!(cause instanceof MendApiError) || cause.status === null || cause.status >= 500)
        return { kind: "answered", attempt };
      const precondition = cause.status === 409 ? PRECONDITIONS[cause.tag ?? ""] : undefined;
      if (precondition !== undefined) {
        if (before === undefined) this.#attempts.delete(sessionId);
        else this.#attempts.set(sessionId, before);
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
          },
        },
      };
    }
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
    return (this.#clients.get(sessionId) ?? this.client).isCurrent?.() ?? true;
  }

  async #say(sessionId: string, attempt: LaunchAttempt): Promise<void> {
    this.#attempts.set(sessionId, attempt);
    if (await this.#current(sessionId)) this.sink.attempted(sessionId, attempt);
  }
}
