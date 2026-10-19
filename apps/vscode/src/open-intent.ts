/**
 * Which session an Open meant, carried to the window it opens. A worktree's workspace can hold
 * several sessions, and the folder a window opens names only the workspace, so the opening
 * window writes the session here and the workspace window takes it when it starts or gains focus.
 * The store is the extension's `globalState`: it lives on this machine, outside any one window,
 * so it survives the window reloading into the workspace.
 */
export interface IntentStore {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** As long as an open may take: an intent no window took by then names no open in flight. */
export const OPEN_INTENT_TTL_MS = 10 * 60 * 1000;

const keyOf = (workspaceId: string): string => `mend.openIntent.${workspaceId}`;

export const writeOpenIntent = async (
  store: IntentStore,
  intent: { readonly workspaceId: string; readonly sessionId: string; readonly at: number },
): Promise<void> => {
  await store.update(keyOf(intent.workspaceId), { sessionId: intent.sessionId, at: intent.at });
};

/** The session the latest open into this workspace meant, once; null when none is fresh. */
export const takeOpenIntent = async (
  store: IntentStore,
  workspaceId: string,
  now: number,
): Promise<string | null> => {
  const key = keyOf(workspaceId);
  const value = store.get(key);
  if (value === undefined) return null;
  await store.update(key, undefined);
  if (typeof value !== "object" || value === null) return null;
  const sessionId: unknown = Reflect.get(value, "sessionId");
  const at: unknown = Reflect.get(value, "at");
  return typeof sessionId === "string" && typeof at === "number" && now - at < OPEN_INTENT_TTL_MS
    ? sessionId
    : null;
};
