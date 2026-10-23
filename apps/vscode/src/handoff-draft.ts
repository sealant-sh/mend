import type { CaptureSummary, EnvFiles, LocalCheckout } from "@mend/local-git/handoff";

import type { HandoffClient, HandoffTerms } from "./handoff-client.js";
import type { CheckoutWorker, LocalResult } from "./handoff-worker.js";
import { continuation, type Continuation, type HandoffTarget } from "./handoff.js";
import type { Project } from "./types.js";

export interface AcceptedHandoff {
  readonly checkout: LocalCheckout;
  readonly target: HandoffTarget;
  readonly terms: HandoffTerms;
  readonly summary: CaptureSummary;
  readonly continuation: Continuation;
  readonly client: HandoffClient;
  readonly worker: CheckoutWorker;
  readonly projectsBefore: ReadonlyArray<Project>;
  readonly needsAgentShare: boolean;
}

export class HandoffDraft {
  #generation = 0;
  #reading: AbortController | null = null;
  #summary: CaptureSummary | null = null;
  #accepted: AcceptedHandoff | null = null;
  #discarded = false;
  constructor(private readonly options: Omit<AcceptedHandoff, "summary" | "continuation">) {}

  async withEnv(env: EnvFiles): Promise<LocalResult<CaptureSummary>> {
    if (this.#accepted !== null || this.#discarded) return { _tag: "cancelled" };
    const generation = ++this.#generation;
    this.#reading?.abort();
    const reading = new AbortController();
    this.#reading = reading;
    this.#summary = null;
    const { target, terms, worker } = this.options;
    const result = await worker.capture(
      target.kind === "project" ? target.project.defaultBranch : null,
      terms.fileBytes,
      env,
      reading.signal,
    );
    if (generation !== this.#generation || this.#discarded) return { _tag: "cancelled" };
    if ("kind" in result) this.#summary = result.value;
    return result;
  }

  accept(prompt: string): AcceptedHandoff | null {
    if (this.#accepted !== null) return this.#accepted;
    if (this.#discarded || this.#summary === null) return null;
    const parsed = continuation(prompt);
    if (parsed.kind === "invalid") return null;
    this.#accepted = { ...this.options, summary: this.#summary, continuation: parsed };
    return this.#accepted;
  }

  async discard(): Promise<void> {
    if (this.#accepted !== null) return;
    this.#discarded = true;
    ++this.#generation;
    this.#reading?.abort();
    await this.options.worker.dispose();
  }
}
