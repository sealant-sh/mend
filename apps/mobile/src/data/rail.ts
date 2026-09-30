// The session rail of a wide session screen: the sessions worth a tap from any other — the ones
// waiting on a person, then the live ones, then the one on screen if it is neither.

export interface RailSession {
  readonly id: string;
  readonly status: string;
  readonly label: string | null;
  readonly harness: string;
}

const LIVE = new Set(["starting", "running", "idle"]);

export const railSessions = <S extends RailSession>(
  sessions: ReadonlyArray<S>,
  currentId: string,
): Array<S> => {
  const waiting = sessions.filter((session) => session.status === "waiting");
  const live = sessions.filter((session) => LIVE.has(session.status));
  const current = sessions.filter(
    (session) => session.id === currentId && !waiting.includes(session) && !live.includes(session),
  );
  return [...waiting, ...live, ...current];
};

/** Two letters for a rail button: the label's first two words, else the harness. */
export const initialsOf = (session: Pick<RailSession, "label" | "harness">): string => {
  const words = (session.label ?? "").split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");
  if (words.length >= 2) return `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase();
  const single = words[0] ?? session.harness;
  return single.slice(0, 2).toUpperCase();
};
