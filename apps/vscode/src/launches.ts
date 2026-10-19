import { MendApiError } from "./mend-http.js";
import { promptIssue, type LaunchRequest } from "./new-session.js";
import type { LaunchAttempt } from "./session-model.js";
import type { Session } from "./types.js";

/** What a launch needs of the client. */
export interface LaunchClient {
  launchSession(sessionId: string, start: LaunchRequest): Promise<unknown>;
  sessionDetail(sessionId: string): Promise<{ readonly session: Session }>;
}

/** Where each attempt is said: the store, whose model reads it. */
export interface AttemptSink {
  attempted(sessionId: string, attempt: LaunchAttempt): void;
}

/** What a failed launch's toast offers, from a read of the session made just before. */
export type RetryOffer =
  /** It failed, or the server refused it and nothing started: Retry sends the same launch. */
  | { readonly kind: "retry"; readonly read: Session }
  /** Failed, but there is nothing this window can send again. */
  | { readonly kind: "none" }
  /** It reads `starting` or live now, or a launch is on its way: nothing failed to retry. */
  | { readonly kind: "moved" };

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
  async launch(sessionId: string, start: LaunchRequest): Promise<void> {
    if (this.#busy.has(sessionId)) return;
    const answered = await this.#hold(sessionId, () => this.#send(sessionId, start, null));
    // Said once nothing is on its way, so the toast it raises may offer Retry.
    this.#say(sessionId, answered);
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

  /** Retry: the same launch on the same session, once a read just now says it may be sent. */
  async relaunch(sessionId: string): Promise<void> {
    const start = this.#sent.get(sessionId);
    if (start === undefined || this.#busy.has(sessionId)) return;
    const answered = await this.#hold(sessionId, async () => {
      const offer = await this.#check(sessionId);
      return offer.kind === "retry" ? this.#send(sessionId, start, offer.read.settledAt) : null;
    });
    if (answered !== null) this.#say(sessionId, answered);
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

  async #check(sessionId: string): Promise<RetryOffer> {
    const start = this.#sent.get(sessionId);
    if (start === undefined || promptIssue(start.prompt ?? "", "the agent") !== null)
      return { kind: "none" };
    const read = await this.client.sessionDetail(sessionId).then(
      ({ session }) => session,
      () => null,
    );
    if (read === null) return { kind: "none" };
    const refusal = this.#attempts.get(sessionId)?.refusal ?? null;
    if (read.status === "failed") return { kind: "retry", read };
    if (read.status === "starting" && refusal !== null && !UNDER_WAY.test(refusal.line))
      return { kind: "retry", read };
    return { kind: "moved" };
  }

  /** Says the attempt, sends it, and gives back the attempt as answered, for its caller to say. */
  async #send(
    sessionId: string,
    start: LaunchRequest,
    after: string | null,
  ): Promise<LaunchAttempt> {
    const attempt: LaunchAttempt = {
      n: (this.#attempts.get(sessionId)?.n ?? 0) + 1,
      after,
      refusal: null,
    };
    this.#sent.set(sessionId, start);
    this.#say(sessionId, attempt);
    try {
      await this.client.launchSession(sessionId, start);
      return attempt;
    } catch (cause) {
      // No answer: it may be running. Saying it again reads the session, and the reads say.
      if (!(cause instanceof MendApiError) || cause.status === null) return attempt;
      // The server settles most refusals failed before it answers: then that failure, keyed by
      // its `settledAt` in every window, is the one toast, and the refusal is not said apart.
      if (await this.#settledSince(sessionId, after)) return attempt;
      return {
        ...attempt,
        refusal: { line: `launch refused · ${cause.message}`, at: new Date().toISOString() },
      };
    }
  }

  async #settledSince(sessionId: string, after: string | null): Promise<boolean> {
    const read = await this.client.sessionDetail(sessionId).then(
      ({ session }) => session,
      () => null,
    );
    return read !== null && read.status === "failed" && read.settledAt !== after;
  }

  #say(sessionId: string, attempt: LaunchAttempt): void {
    this.#attempts.set(sessionId, attempt);
    this.sink.attempted(sessionId, attempt);
  }
}
