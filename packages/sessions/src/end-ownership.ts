import { Deferred, Effect, Exit } from "effect";

export interface EndHolder {
  readonly kind: "holder";
  readonly token: symbol;
}

export type EndAuthority = EndHolder | { readonly kind: "stop" };

export interface Continuation extends EndHolder {
  readonly processIds: ReadonlyArray<string>;
}

export type Observed<A> =
  | { readonly kind: "observed"; readonly value: A }
  | { readonly kind: "held"; readonly by: "observer" | "continuation" };

export type Continued<A> =
  | { readonly kind: "continued"; readonly value: A }
  | { readonly kind: "ending"; readonly ended: Effect.Effect<void> }
  | { readonly kind: "held" };

export type Grant = "unowned" | "granted" | "refused";

/**
 * Who records an agent process's end. An observer of its exit holds it until its end has run,
 * harvest and sweep included. A continuation (a hand-over or a mode switch) holds it from before
 * its stop until its next process exists, with the workspaces it ran in held in use. Only a Stop
 * records over a continuation, and it never waits for one: that continuation is stopped at once.
 */
export interface EndOwnership<W> {
  readonly observe: <A, E, R>(
    processId: string,
    use: (holder: EndHolder) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<Observed<A>, E, R>;
  readonly continueFrom: <A, E, R>(
    agents: ReadonlyArray<{ readonly id: string; readonly sealantWorkspaceId: W }>,
    waitingOn: ReadonlyArray<string>,
    use: (continuation: Continuation) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<Continued<A>, E, R>;
  readonly release: (continuation: Continuation) => Effect.Effect<void>;
  readonly grant: (processId: string, authority: EndAuthority) => Grant;
  readonly stopContinuations: (processIds: ReadonlyArray<string>) => void;
  readonly pinsLiveness: (processId: string) => boolean;
  readonly heldByContinuation: (processId: string) => boolean;
  readonly released: (processId: string) => Effect.Effect<void>;
}

interface ContinuationEntry<W> {
  readonly continuation: Continuation;
  readonly workspaceIds: ReadonlyArray<W>;
  state: "active" | "stopped" | "released";
  readonly released: Deferred.Deferred<void>;
}

type Owner<W> =
  | { readonly kind: "observer"; readonly token: symbol; readonly done: Deferred.Deferred<void> }
  | { readonly kind: "continuation"; readonly entry: ContinuationEntry<W> };

export const makeEndOwnership = <W>(holds: {
  readonly enter: (workspaceId: W) => void;
  readonly leave: (workspaceId: W) => void;
}): EndOwnership<W> => {
  const owners = new Map<string, Owner<W>>();
  const entries = new Map<symbol, ContinuationEntry<W>>();

  const leaveHolds = (entry: ContinuationEntry<W>) => {
    for (const workspaceId of entry.workspaceIds) holds.leave(workspaceId);
  };
  const stopEntry = (entry: ContinuationEntry<W>) => {
    if (entry.state !== "active") return;
    entry.state = "stopped";
    leaveHolds(entry);
  };
  const releaseEntry = (entry: ContinuationEntry<W>) => {
    if (entry.state === "released") return;
    if (entry.state === "active") leaveHolds(entry);
    entry.state = "released";
    entries.delete(entry.continuation.token);
    for (const processId of entry.continuation.processIds) {
      const owner = owners.get(processId);
      if (owner?.kind === "continuation" && owner.entry === entry) owners.delete(processId);
    }
    Deferred.doneUnsafe(entry.released, Exit.void);
  };

  const observe = <A, E, R>(
    processId: string,
    use: (holder: EndHolder) => Effect.Effect<A, E, R>,
  ): Effect.Effect<Observed<A>, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const owner = owners.get(processId);
        if (owner !== undefined) return { kind: "held", by: owner.kind } as const;
        const claim = {
          kind: "observer",
          token: Symbol("observer"),
          done: Deferred.makeUnsafe<void>(),
        } as const;
        owners.set(processId, claim);
        return { kind: "claimed", claim } as const;
      }),
      (acquired): Effect.Effect<Observed<A>, E, R> =>
        acquired.kind === "held"
          ? Effect.succeed(acquired)
          : use({ kind: "holder", token: acquired.claim.token }).pipe(
              Effect.map((value) => ({ kind: "observed", value }) as const),
            ),
      (acquired) =>
        Effect.sync(() => {
          if (acquired.kind === "held") return;
          if (owners.get(processId) === acquired.claim) owners.delete(processId);
          Deferred.doneUnsafe(acquired.claim.done, Exit.void);
        }),
    );

  const continueFrom = <A, E, R>(
    agents: ReadonlyArray<{ readonly id: string; readonly sealantWorkspaceId: W }>,
    waitingOn: ReadonlyArray<string>,
    use: (continuation: Continuation) => Effect.Effect<A, E, R>,
  ): Effect.Effect<Continued<A>, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const current = [...new Set([...agents.map((agent) => agent.id), ...waitingOn])].flatMap(
          (id) => {
            const owner = owners.get(id);
            return owner === undefined ? [] : [owner];
          },
        );
        if (current.some((owner) => owner.kind === "continuation")) {
          return { kind: "held" } as const;
        }
        const done = current.flatMap((owner) => (owner.kind === "observer" ? [owner.done] : []));
        if (done.length > 0) {
          return {
            kind: "ending",
            ended: Effect.forEach(done, Deferred.await, { discard: true }),
          } as const;
        }
        const entry: ContinuationEntry<W> = {
          continuation: {
            kind: "holder",
            token: Symbol("continuation"),
            processIds: agents.map((agent) => agent.id),
          },
          workspaceIds: [...new Set(agents.map((agent) => agent.sealantWorkspaceId))],
          state: "active",
          released: Deferred.makeUnsafe<void>(),
        };
        entries.set(entry.continuation.token, entry);
        for (const agent of agents) owners.set(agent.id, { kind: "continuation", entry });
        for (const workspaceId of entry.workspaceIds) holds.enter(workspaceId);
        return { kind: "claimed", entry } as const;
      }),
      (acquired): Effect.Effect<Continued<A>, E, R> =>
        acquired.kind !== "claimed"
          ? Effect.succeed(acquired)
          : use(acquired.entry.continuation).pipe(
              Effect.map((value) => ({ kind: "continued", value }) as const),
            ),
      (acquired) =>
        Effect.sync(() => {
          if (acquired.kind === "claimed") releaseEntry(acquired.entry);
        }),
    );

  const grant = (processId: string, authority: EndAuthority): Grant => {
    const owner = owners.get(processId);
    if (owner === undefined) return "unowned";
    if (owner.kind === "observer") {
      return authority.kind === "holder" && authority.token === owner.token ? "granted" : "refused";
    }
    const { entry } = owner;
    if (authority.kind === "stop") {
      stopEntry(entry);
      return "granted";
    }
    return entry.state === "active" && authority.token === entry.continuation.token
      ? "granted"
      : "refused";
  };

  return {
    observe,
    continueFrom,
    release: (continuation) =>
      Effect.sync(() => {
        const entry = entries.get(continuation.token);
        if (entry !== undefined) releaseEntry(entry);
      }),
    grant,
    stopContinuations: (processIds) => {
      for (const processId of processIds) {
        const owner = owners.get(processId);
        if (owner?.kind === "continuation") stopEntry(owner.entry);
      }
    },
    pinsLiveness: (processId) => {
      const owner = owners.get(processId);
      return owner?.kind === "continuation" && owner.entry.state === "active";
    },
    heldByContinuation: (processId) => owners.get(processId)?.kind === "continuation",
    released: (processId) =>
      Effect.suspend(() => {
        const owner = owners.get(processId);
        return owner?.kind === "continuation" ? Deferred.await(owner.entry.released) : Effect.void;
      }),
  };
};
