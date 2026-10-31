import type {
  AgentConversationRepo,
  ClaimRelease,
  DispatchClaim,
  HarnessTurn,
  HarnessTurnEnd,
} from "@mend/db";
import {
  AgentTurnId,
  type DispatchAttemptId,
  type SessionId,
  type SessionProcessId,
} from "@mend/domain";
import { AgentTurn } from "@mend/domain/workbench";
import { Effect } from "effect";

type DispatchMethods = Pick<
  AgentConversationRepo["Service"],
  "claimNextTurn" | "openHarnessTurn" | "unsentClaim" | "bindOwnSend" | "putBackOwn" | "failOwn"
>;

/**
 * The repo's claim and its owner-only moves over in-memory turns, as Postgres keeps them: one
 * running turn per process, and an unsent turn moved only by the attempt that claimed it. A turn a
 * test puts in `turns` running by hand has no attempt, as one claimed before attempts were kept.
 */
export const makeDispatchStore = (
  turns: Map<AgentTurnId, AgentTurn>,
  nextOrdinal: () => number,
): DispatchMethods => {
  const attempts = new Map<AgentTurnId, DispatchAttemptId>();
  const ordered = () => [...turns.values()].toSorted((a, b) => a.ordinal - b.ordinal);
  const update = (id: AgentTurnId, patch: Partial<AgentTurn>) => {
    const current = turns.get(id);
    if (current === undefined) throw new Error(`unknown turn ${id}`);
    const next = new AgentTurn({ ...current, ...patch });
    turns.set(id, next);
    return next;
  };
  const runningOn = (processId: SessionProcessId) =>
    ordered().find((turn) => turn.processId === processId && turn.status === "running");
  const byProviderTurn = (providerTurnId: string) =>
    ordered().find((turn) => turn.providerTurnId === providerTurnId);
  const heldBy = (claim: DispatchClaim, turn: AgentTurn) =>
    turn.processId === claim.processId && (attempts.get(turn.id) ?? null) === claim.attempt;
  const insertHarness = (
    sessionId: SessionId,
    processId: SessionProcessId,
    harness: HarnessTurn,
    ended: HarnessTurnEnd | null,
  ) => {
    const ordinal = nextOrdinal();
    const turn = new AgentTurn({
      id: AgentTurnId.make(`turn-${ordinal}`),
      sessionId,
      processId,
      ordinal,
      author: null,
      origin: "harness",
      input: harness.reason,
      status: ended?.status ?? "running",
      providerTurnId: harness.providerTurnId,
      error: ended?.error ?? null,
      usage: ended?.usage ?? null,
      billedUserId: harness.payer.userId,
      billedAccountId: harness.payer.accountId,
      billedAccountName: harness.payer.accountName,
      createdAt: new Date(),
      startedAt: new Date(),
      endedAt: ended === null ? null : new Date(),
    });
    turns.set(turn.id, turn);
    return turn;
  };
  const releaseOwn = (claim: DispatchClaim, change: Partial<AgentTurn>, release: ClaimRelease) =>
    Effect.sync(() => {
      const bound = release.bound ?? null;
      const turn = ordered().find(
        (candidate) =>
          heldBy(claim, candidate) &&
          candidate.status === "running" &&
          (candidate.providerTurnId === null || candidate.providerTurnId === bound),
      );
      if (turn === undefined) return null;
      const moved = update(turn.id, { ...change, providerTurnId: null });
      const harness = release.harness ?? null;
      if (harness !== null && byProviderTurn(harness.providerTurnId) === undefined)
        insertHarness(claim.sessionId, claim.processId, harness, null);
      return moved;
    });
  return {
    claimNextTurn: (processId, attempt) =>
      Effect.sync(() => {
        if (runningOn(processId) !== undefined) return null;
        const queued = ordered().find(
          (turn) => turn.processId === processId && turn.status === "queued",
        );
        if (queued === undefined) return null;
        attempts.set(queued.id, attempt);
        return update(queued.id, { status: "running", startedAt: new Date() });
      }),
    openHarnessTurn: (sessionId, processId, providerTurnId, reason, payer, ended) =>
      Effect.sync(() => {
        const existing = byProviderTurn(providerTurnId);
        if (existing !== undefined) {
          const turn =
            ended !== undefined && existing.status === "running"
              ? update(existing.id, { ...ended, endedAt: new Date() })
              : existing;
          return { _tag: "Recorded", turn } as const;
        }
        if (ended === undefined && runningOn(processId) !== undefined)
          return { _tag: "SlotHeld" } as const;
        const turn = insertHarness(
          sessionId,
          processId,
          { providerTurnId, reason, payer },
          ended ?? null,
        );
        return { _tag: "Recorded", turn } as const;
      }),
    unsentClaim: (processId) =>
      Effect.sync(() => {
        const turn = runningOn(processId);
        return turn === undefined || turn.providerTurnId !== null
          ? null
          : { turn, attempt: attempts.get(turn.id) ?? null };
      }),
    bindOwnSend: (claim, providerTurnId, payer, replacing = null) =>
      Effect.sync(() => {
        const turn = ordered().find(
          (candidate) =>
            heldBy(claim, candidate) &&
            (candidate.providerTurnId === providerTurnId ||
              (candidate.status === "running" &&
                (candidate.providerTurnId === null || candidate.providerTurnId === replacing))),
        );
        return turn === undefined
          ? null
          : update(turn.id, {
              providerTurnId,
              billedUserId: payer.userId,
              billedAccountId: payer.accountId,
              billedAccountName: payer.accountName,
            });
      }),
    putBackOwn: (claim, release = {}) =>
      releaseOwn(claim, { status: "queued", startedAt: null }, release),
    failOwn: (claim, error, release = {}) =>
      releaseOwn(claim, { status: "failed", error, endedAt: new Date() }, release),
  };
};
