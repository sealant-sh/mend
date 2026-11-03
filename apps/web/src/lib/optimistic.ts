import type { DataTag, MutationKey, QueryClient, QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { sendInTurn } from "./serial-writes.ts";

/**
 * Optimistic writes to one cached settings document (the instance's settings, an organization's
 * defaults, a Slack app's settings…), safe when they overlap:
 *
 * - The cache keeps the server's document only. What the person sees is that document with every
 *   write still on its way laid over it, oldest first (`useVisible`), so a refetch that lands
 *   meanwhile (a focus refetch, an event) cannot erase a pending value.
 * - A write that fails stops being pending: only its own change falls back to the server's value;
 *   a newer write to another field keeps showing.
 * - Writes to one document leave one at a time, and each sends the server's latest document with
 *   its own change applied (`send` gets that document), never a copy assembled from optimistic
 *   state.
 * - The document, and `related` reads that resolve through it, are read again once no write to it
 *   is still on its way.
 *
 * Make one writer per document, at module level, and use it from every control that writes it:
 *
 * ```ts
 * const instanceSettings = documentWriter<SettingsDto, Partial<SettingsDto>, SettingsDto>({
 *   overlay: (server, patch) => ({ ...server, ...patch }),
 *   saved: (_server, result) => result,
 * });
 * const visible = instanceSettings.useVisible(useQuery(trpc.settings.get.queryOptions()).data);
 * const save = useMutation(instanceSettings.options({ queryClient, documentKey, mutationKey,
 *   send: (patch, server) => client.settings.put.mutate({ ...server, ...patch }) }));
 * ```
 */
export interface DocumentWriter<TDoc extends object, TVars, TResult> {
  /** The server's document with every pending write laid over it; undefined until it is read. */
  readonly useVisible: (server: TDoc | undefined) => TDoc | undefined;
  /** Mutation options for one control's `useMutation`; the variables are the change. */
  readonly options: (config: WriteConfig<TDoc, TVars, TResult>) => WriteOptions<TVars, TResult>;
  /** The writes still on their way, oldest first (for tests and "saving…" lines). */
  readonly pending: (queryClient: QueryClient) => ReadonlyArray<TVars>;
}

export interface WriteConfig<TDoc extends object, TVars, TResult> {
  readonly queryClient: QueryClient;
  readonly documentKey: DataTag<QueryKey, TDoc, unknown>;
  readonly mutationKey: MutationKey;
  /** Send one change, given the server's latest document. */
  readonly send: (change: TVars, server: TDoc) => Promise<TResult>;
  /** Reads that resolve through this document, read again with it. */
  readonly related?: ReadonlyArray<QueryKey>;
}

export interface WriteOptions<TVars, TResult> {
  readonly mutationKey: MutationKey;
  readonly mutationFn: (change: TVars) => Promise<TResult>;
  readonly onSettled: () => Promise<unknown>;
}

interface Pending<TVars> {
  readonly id: number;
  readonly change: TVars;
}

interface WriterState<TVars> {
  pending: ReadonlyArray<Pending<TVars>>;
  readonly listeners: Set<() => void>;
}

const setPending = <TVars>(state: WriterState<TVars>, next: ReadonlyArray<Pending<TVars>>) => {
  state.pending = next;
  for (const listener of state.listeners) listener();
};

export const documentWriter = <TDoc extends object, TVars, TResult>({
  overlay,
  saved,
}: {
  /** The document with one pending change applied. */
  readonly overlay: (document: TDoc, change: TVars) => TDoc;
  /** The server's document after a change it accepted, from what it answered. */
  readonly saved: (server: TDoc, result: TResult, change: TVars) => TDoc;
}): DocumentWriter<TDoc, TVars, TResult> => {
  const states = new WeakMap<QueryClient, WriterState<TVars>>();
  let nextId = 0;

  const stateOf = (queryClient: QueryClient): WriterState<TVars> => {
    const known = states.get(queryClient);
    if (known !== undefined) return known;
    const made: WriterState<TVars> = {
      pending: [],
      listeners: new Set(),
    };
    states.set(queryClient, made);
    return made;
  };

  return {
    pending: (queryClient) => stateOf(queryClient).pending.map((entry) => entry.change),

    useVisible: (server) => {
      const state = stateOf(useQueryClient());
      const pending = useSyncExternalStore(
        (onChange) => {
          state.listeners.add(onChange);
          return () => state.listeners.delete(onChange);
        },
        () => state.pending,
        () => state.pending,
      );
      return server === undefined
        ? undefined
        : pending.reduce<TDoc>((document, entry) => overlay(document, entry.change), server);
    },

    options: ({ queryClient, documentKey, mutationKey, send, related = [] }) => {
      const state = stateOf(queryClient);
      return {
        mutationKey,
        mutationFn: async (change) => {
          const entry: Pending<TVars> = { id: (nextId += 1), change };
          setPending(state, [...state.pending, entry]);
          // One chain per document: the turn is taken before anything is awaited, so writes leave in
          // the order made, and each reads the document the last one stored.
          const sent = sendInTurn(
            queryClient,
            JSON.stringify(documentKey),
            async () => {
              await queryClient.cancelQueries({ queryKey: documentKey });
              const server = queryClient.getQueryData(documentKey);
              if (server === undefined) throw new Error("This setting has not been read yet.");
              return { server, result: await send(change, server) };
            },
            ({ server, result }) =>
              queryClient.setQueryData(documentKey, saved(server, result, change)),
          ).then(({ result }) => result);
          try {
            return await sent;
          } finally {
            setPending(
              state,
              state.pending.filter((candidate) => candidate.id !== entry.id),
            );
          }
        },
        onSettled: () =>
          state.pending.length > 0
            ? Promise.resolve()
            : Promise.all(
                [documentKey, ...related].map((queryKey) =>
                  queryClient.invalidateQueries({ queryKey }),
                ),
              ),
      };
    },
  };
};

/** The writer for a document whose changes are field patches: the usual case. */
export const fieldWriter = <TDoc extends object, TResult = TDoc>(
  saved: (server: TDoc, result: TResult, patch: Partial<TDoc>) => TDoc,
) =>
  documentWriter<TDoc, Partial<TDoc>, TResult>({
    overlay: (document, patch) => ({ ...document, ...patch }),
    saved,
  });
