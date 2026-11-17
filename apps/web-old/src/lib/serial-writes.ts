import type { QueryClient } from "@tanstack/react-query";

// Per query client: the last write sent on each chain, so writes on one chain leave in order.
const chainsOf = new WeakMap<QueryClient, Map<string, Promise<unknown>>>();

/**
 * Sends `leave` once every earlier write on the same chain has settled, whatever its outcome, and
 * stores its answer with `store` before the next write on the chain leaves, so that write builds
 * on what the server answered rather than on an optimistic copy. A chain is one setting or one
 * document: project settings chain per setting (`lib/project-settings.ts`), settings documents per
 * document (`lib/optimistic.ts`).
 */
export const sendInTurn = <A>(
  queryClient: QueryClient,
  key: string,
  leave: () => Promise<A>,
  store: (answer: A) => void,
): Promise<A> => {
  const chains = chainsOf.get(queryClient) ?? new Map<string, Promise<unknown>>();
  chainsOf.set(queryClient, chains);
  const go = () =>
    leave().then((answer) => {
      store(answer);
      return answer;
    });
  const before = chains.get(key) ?? Promise.resolve();
  const sent = before.then(go, go);
  chains.set(key, sent);
  const forget = () => {
    if (chains.get(key) === sent) chains.delete(key);
  };
  sent.then(forget, forget);
  return sent;
};
