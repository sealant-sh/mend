import { setTimeout as wait } from "node:timers/promises";

import { HANDOFF_SEND_ATTEMPTS } from "@mend/domain/workbench";
import type { AgentShareHandle } from "@mend/local-git/agent-share";
import { originMatches } from "@mend/local-git/origin";

import type { HandoffIssue, HandoffReceipt, HandoffTerms } from "./handoff-client.js";
import type { AcceptedHandoff } from "./handoff-draft.js";
import type { HandoffBundle } from "./handoff-worker.js";
import { issueWords, localIssueWords, sizeWords } from "./handoff.js";
import { agentStarted, type Launches } from "./launches.js";
import { MendApiError } from "./mend-http.js";
import type { Project, SessionDetail } from "./types.js";

export type SubmissionOutcome =
  | {
      readonly kind: "done" | "workspace-pending" | "workspace-failed";
      readonly project: Project;
      readonly receipt: HandoffReceipt;
      readonly message: string | null;
    }
  | { readonly kind: "refused"; readonly message: string; readonly issue?: HandoffIssue }
  | {
      readonly kind: "unconfirmed";
      readonly stage: "adoption" | "receive";
      readonly message: string;
    };
export interface SubmissionDependencies {
  readonly launches: Pick<Launches, "launch">;
  readonly record: (project: Project, receipt: HandoffReceipt) => void;
  readonly progress: (message: string) => void;
  readonly launchConfirmed: () => void;
  readonly observe?: (sessionId: string, changed: () => void) => () => void;
  readonly holdTimeoutMs?: number;
  readonly pollMs?: number;
}
const termsEqual = (left: HandoffTerms, right: HandoffTerms): boolean =>
  left.fileBytes === right.fileBytes && left.bundleBytes === right.bundleBytes;

export const awaitsCheck = (outcome: SubmissionOutcome, accepted: AcceptedHandoff): boolean =>
  outcome.kind === "unconfirmed" ||
  (outcome.kind === "workspace-pending" && accepted.continuation.kind === "prompt");

export class HandoffSubmission {
  #operation: Promise<SubmissionOutcome> | null = null;
  #outcome: SubmissionOutcome | null = null;
  #bundle: HandoffBundle | null = null;
  #project: Project | null;
  #adoptionSent = false;
  #receiveSent = false;
  #receiveUnconfirmed = false;
  #receipt: HandoffReceipt | null = null;
  #disposed = false;
  constructor(
    readonly accepted: AcceptedHandoff,
    private readonly dependencies: SubmissionDependencies,
  ) {
    this.#project = accepted.target.kind === "project" ? accepted.target.project : null;
  }

  run(): Promise<SubmissionOutcome> {
    if (this.#operation !== null) return this.#operation;
    if (this.#outcome !== null) return Promise.resolve(this.#outcome);
    if (this.#disposed)
      return Promise.resolve({
        kind: "refused",
        message: "This snapshot was released. Start another handoff.",
      });
    this.#operation = this.#send()
      .then((outcome) => {
        this.#outcome = outcome;
        return outcome;
      })
      .finally(() => {
        this.#operation = null;
      });
    return this.#operation;
  }
  checkAgain(): Promise<SubmissionOutcome> {
    if (this.#outcome !== null && awaitsCheck(this.#outcome, this.accepted)) this.#outcome = null;
    return this.run();
  }
  async dispose(): Promise<void> {
    await this.#operation;
    this.#disposed = true;
    await this.accepted.worker.dispose();
  }
  #refused(message: string, issue?: HandoffIssue): SubmissionOutcome {
    const arrived = "Mend hasn't confirmed the handoff. It may have arrived. ";
    if (this.#receiveUnconfirmed && issue?.kind !== "signed-out") {
      const later =
        issue?.kind === "refused" && issue.retryAfterSeconds !== null
          ? `; try again in ${issue.retryAfterSeconds} seconds`
          : "";
      return {
        kind: "unconfirmed",
        stage: "receive",
        message: `${arrived}Mend refused the next try${later}. Check again to read what arrived.`,
      };
    }
    const unknown = this.#receiveUnconfirmed
      ? arrived
      : issue?.kind === "signed-out" && this.#adoptionSent && this.#project === null
        ? "Mend hasn't confirmed whether the project was adopted. "
        : "";
    return {
      kind: "refused",
      message:
        this.#adoptionSent && this.#project !== null
          ? `${this.#project.name} stays adopted. ${this.#receiveSent ? unknown : "Nothing was handed off. "}${message}`
          : `${unknown}${message}`,
      ...(issue === undefined ? {} : { issue }),
    };
  }
  async #checkSource(): Promise<SubmissionOutcome | null> {
    if (!(await this.accepted.client.isCurrent()))
      return this.#refused(issueWords({ kind: "server-changed" }), { kind: "server-changed" });
    const current = await this.accepted.worker.discover();
    if (!(await this.accepted.client.isCurrent()))
      return this.#refused(issueWords({ kind: "server-changed" }), { kind: "server-changed" });
    if (!("kind" in current))
      return this.#refused(
        current._tag === "refused"
          ? localIssueWords(current)
          : "The checkout could not be read. Try again.",
      );
    if (
      current.value.top !== this.accepted.checkout.top ||
      current.value.originUrl !== this.accepted.checkout.originUrl
    )
      return this.#refused(
        "This checkout's origin changed. Nothing was handed off. Refresh the snapshot, then try again.",
      );
    return null;
  }
  async #send(): Promise<SubmissionOutcome> {
    const { client, worker, summary, terms, checkout, target } = this.accepted;
    let share: AgentShareHandle | null = null;
    try {
      if (this.#receipt !== null && this.#project !== null)
        return await this.#received(this.#project, this.#receipt);
      if (this.#bundle === null) {
        const { commitsAhead, uncommitted, untracked } = summary.facts;
        this.dependencies.progress(
          `bundling ${commitsAhead} commits · ${uncommitted + untracked} files`,
        );
        const packed = await worker.pack();
        if (!("kind" in packed))
          return this.#refused(
            packed._tag === "cancelled"
              ? "The snapshot could not be prepared. Try again."
              : localIssueWords(packed),
          );
        this.#bundle = packed.value;
      }
      const bundle = this.#bundle;
      if (bundle.bytes > terms.bundleBytes) {
        const issue: HandoffIssue = {
          kind: "bundle-too-large",
          bytes: bundle.bytes,
          limit: terms.bundleBytes,
        };
        return this.#refused(issueWords(issue), issue);
      }
      if (!this.#adoptionSent && !this.#receiveSent) {
        const changed = await this.#checkSource();
        if (changed !== null) return changed;
      }
      if (this.accepted.needsAgentShare) {
        share = await client.shareAgent();
        if (share === null || (await share.ready(15_000)) !== "connected")
          return this.#refused(issueWords({ kind: "bridge-unavailable" }), {
            kind: "bridge-unavailable",
          });
      }
      if (this.#project === null && target.kind === "adopt") {
        if (!this.#adoptionSent) {
          const fresh = await client.handoffTerms(null);
          if (fresh.kind === "refused") return this.#refused(issueWords(fresh.issue), fresh.issue);
          if (!termsEqual(terms, fresh.terms))
            return this.#refused(
              "Handoff limits changed. Nothing was handed off. Refresh the snapshot, then try again.",
            );
          const changed = await this.#checkSource();
          if (changed !== null) return changed;
          this.dependencies.progress(`adopting ${target.name}`);
          this.#adoptionSent = true;
          try {
            this.#project = await client.adoptProject(target.name, target.origin);
          } catch (cause) {
            if (
              cause instanceof MendApiError &&
              cause.status !== null &&
              cause.status < 500 &&
              cause.status !== 401
            )
              return this.#refused(cause.message);
          }
        }
        if (this.#project === null) {
          const before = new Set(this.accepted.projectsBefore.map((project) => project.id));
          const candidates = (await client.listProjects()).filter(
            (project) =>
              !before.has(project.id) &&
              originMatches(target.origin, project.originUrl, checkout.top),
          );
          if (candidates.length === 1) this.#project = candidates[0] ?? null;
          if (this.#project === null)
            return {
              kind: "unconfirmed",
              stage: "adoption",
              message: `Mend hasn't confirmed whether ${target.name} was adopted. Check again to read its project list.`,
            };
        }
      }
      if (target.kind === "project" && !this.#receiveSent) {
        this.#project =
          (await client.listProjects()).find((project) => project.id === target.project.id) ?? null;
      }
      const project = this.#project;
      if (project === null) return this.#refused("Mend did not identify the project. Try again.");
      if (
        checkout.originUrl === null ||
        !originMatches(checkout.originUrl, project.originUrl, checkout.top)
      )
        return this.#refused(`This checkout's origin isn't ${project.name}'s`);
      const fresh = await client.handoffTerms(project.id);
      if (fresh.kind === "refused") return this.#refused(issueWords(fresh.issue), fresh.issue);
      if (project.defaultBranch !== summary.defaultBranch || !termsEqual(terms, fresh.terms))
        return this.#refused("Its default branch or handoff limits changed. Try again.");
      if (!this.#adoptionSent && !this.#receiveSent) {
        const changed = await this.#checkSource();
        if (changed !== null) return changed;
      }
      for (let attempt = 0; attempt < HANDOFF_SEND_ATTEMPTS; attempt++) {
        this.dependencies.progress(`uploading ${sizeWords(bundle.bytes)}`);
        this.#receiveSent = true;
        const outcome = await client.receiveBranchHandoff(project.id, bundle, () =>
          this.dependencies.progress("creating worktree"),
        );
        if (outcome.kind === "refused")
          return this.#refused(issueWords(outcome.issue), outcome.issue);
        if (outcome.kind === "unconfirmed") {
          this.#receiveUnconfirmed = true;
          continue;
        }
        const receipt = outcome.receipt;
        if (receipt.worktree.handoff?.checkpoint !== summary.worktree) {
          this.#receiveUnconfirmed = true;
          return {
            kind: "unconfirmed",
            stage: "receive",
            message: "Mend hasn't confirmed this snapshot. It may have arrived.",
          };
        }
        this.#receipt = receipt;
        if (await client.isCurrent()) this.dependencies.record(project, receipt);
        return await this.#received(project, receipt);
      }
      return {
        kind: "unconfirmed",
        stage: "receive",
        message: "Mend hasn't confirmed the handoff. It may have arrived.",
      };
    } catch (cause) {
      if (this.#receipt !== null && this.#project !== null)
        return {
          kind: "workspace-pending",
          project: this.#project,
          receipt: this.#receipt,
          message: `Handed off as ${this.#receipt.worktree.name}. Mend hasn't confirmed its workspace is ready yet.`,
        };
      if (cause instanceof MendApiError && cause.status === 401)
        return this.#refused(issueWords({ kind: "signed-out" }), { kind: "signed-out" });
      if (this.#receiveSent) this.#receiveUnconfirmed = true;
      if (this.#receiveSent || this.#adoptionSent)
        return {
          kind: "unconfirmed",
          stage: this.#receiveSent ? "receive" : "adoption",
          message: "Mend hasn't confirmed the handoff. It may have arrived.",
        };
      return this.#refused(
        cause instanceof Error ? cause.message : "Mend could not prepare the handoff. Try again.",
      );
    } finally {
      await share?.close();
    }
  }

  async #received(project: Project, receipt: HandoffReceipt): Promise<SubmissionOutcome> {
    const { client, continuation } = this.accepted;
    const deadline = Date.now() + (this.dependencies.holdTimeoutMs ?? 30_000);
    let detail: SessionDetail | null = null;
    do {
      const changed = new AbortController();
      const stop = this.dependencies.observe?.(receipt.session.id, () => changed.abort());
      try {
        detail = await client.sessionDetail(receipt.session.id).catch(() => null);
        if (
          detail !== null &&
          detail.session.status !== "starting" &&
          detail.session.status !== "stopping"
        )
          break;
        await wait(this.dependencies.pollMs ?? 750, undefined, { signal: changed.signal }).catch(
          () => undefined,
        );
      } finally {
        stop?.();
      }
    } while (Date.now() < deadline);
    if (
      detail === null ||
      detail.session.status === "starting" ||
      detail.session.status === "stopping"
    )
      return {
        kind: "workspace-pending",
        project,
        receipt,
        message: `Handed off as ${receipt.worktree.name}. Mend hasn't confirmed its workspace is ready yet${continuation.kind === "prompt" ? ", so your prompt has not been sent. Check again sends it once the workspace is idle" : ""}.`,
      };
    const status = detail.session.status;
    if (status === "failed" || status === "stopped" || status === "completed")
      return {
        kind: "workspace-failed",
        project,
        receipt,
        message: `Handed off as ${receipt.worktree.name}, but its workspace ${status === "failed" ? "did not start" : `is ${status}`}: ${detail.session.summary ?? "open the session to continue"}.`,
      };
    const launch = continuation.kind === "prompt" && status === "idle" && !agentStarted(detail);
    if (launch)
      await this.dependencies.launches.launch(
        receipt.session.id,
        { mode: "pty", prompt: continuation.prompt },
        { client, confirmed: this.dependencies.launchConfirmed },
      );
    this.dependencies.progress("ready");
    return {
      kind: "done",
      project,
      receipt,
      message:
        continuation.kind === "prompt" && !launch
          ? `Handed off as ${receipt.worktree.name}. An agent already ran in that session, so your prompt was not sent.`
          : null,
    };
  }
}
