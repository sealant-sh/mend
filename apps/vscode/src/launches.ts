import { MendApiError } from "./mend-http.js";
import type { LaunchRequest } from "./new-session.js";

/** What a launch needs of the client. */
export interface LaunchClient {
  launchSession(sessionId: string, start: LaunchRequest): Promise<unknown>;
}

/** Where a refused launch is said: the store, whose model reads the session failed. */
export interface RefusalSink {
  /** The launch was refused with `line`; null when it is sent again. */
  refused(sessionId: string, line: string | null): void;
}

/** A refused launch in the words the server's own refusals use (`launch refused · …`). */
const refusalLine = (cause: unknown): string =>
  cause instanceof MendApiError && cause.status !== null
    ? `launch refused · ${cause.message}`
    : cause instanceof Error
      ? cause.message
      : "Mend did not answer the launch.";

/**
 * The launches this window sent, by session: what Retry sends again. The server holds a launch up
 * to 30 s and runs it detached (`LAUNCH_ANSWER_WINDOW`), so nobody awaits one before the row shows.
 */
export class Launches {
  readonly #sent = new Map<string, LaunchRequest>();

  constructor(
    private readonly client: LaunchClient,
    private readonly sink: RefusalSink,
  ) {}

  /** Whether this window launched the session: only then does its failure offer Retry. */
  has(sessionId: string): boolean {
    return this.#sent.has(sessionId);
  }

  async launch(sessionId: string, start: LaunchRequest): Promise<void> {
    this.#sent.set(sessionId, start);
    try {
      await this.client.launchSession(sessionId, start);
    } catch (cause) {
      this.sink.refused(sessionId, refusalLine(cause));
    }
  }

  /** Retry: the same start on the same session, which a failed launch leaves to launch again. */
  async relaunch(sessionId: string): Promise<void> {
    const start = this.#sent.get(sessionId);
    if (start === undefined) return;
    this.sink.refused(sessionId, null);
    await this.launch(sessionId, start);
  }
}
