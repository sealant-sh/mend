import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type MutationKey,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import type { SessionInboxMarkDto } from "./api.ts";
import type { InboxMark } from "./inbox.ts";
import { useTRPC, useTRPCClient } from "./trpc.ts";

/** A mark as a caller sends it: `until` may still be its wire string. */
export type MarkChange =
  | { readonly _tag: "Snoozed"; readonly until: Date | string }
  | { readonly _tag: "Settled" }
  | { readonly _tag: "Inbox" };

export interface MarkRequest {
  readonly id: string;
  readonly mark: MarkChange;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Narrows a mutation's stored variables back to a mark request. */
export const isMarkRequest = (value: unknown): value is MarkRequest => {
  if (!isRecord(value) || typeof value["id"] !== "string") return false;
  const mark = value["mark"];
  if (!isRecord(mark)) return false;
  if (mark["_tag"] === "Settled" || mark["_tag"] === "Inbox") return true;
  return (
    mark["_tag"] === "Snoozed" &&
    (typeof mark["until"] === "string" || mark["until"] instanceof Date)
  );
};

const markFrom = (request: MarkRequest, now: Date): InboxMark => {
  const sessionId = request.id;
  switch (request.mark._tag) {
    case "Snoozed":
      return {
        sessionId,
        state: "snoozed",
        snoozedUntil: new Date(request.mark.until),
        markedAt: now,
      };
    case "Settled":
      return { sessionId, state: "settled", snoozedUntil: null, markedAt: now };
    case "Inbox":
      return { sessionId, state: "inbox", snoozedUntil: null, markedAt: now };
  }
};

/**
 * The marks the person sees: the server's, with every mark still on its way laid over its own
 * session, the latest request winning. A request that fails stops being pending, so only its own
 * session falls back to the server's mark; a refetch that lands meanwhile cannot erase a mark that
 * is still on its way.
 */
export const visibleMarks = (
  server: ReadonlyArray<InboxMark>,
  pending: ReadonlyArray<MarkRequest>,
  now: Date,
): ReadonlyArray<InboxMark> => {
  if (pending.length === 0) return server;
  const bySession = new Map<string, InboxMark>(server.map((mark) => [mark.sessionId, mark]));
  for (const request of pending) bySession.set(request.id, markFrom(request, now));
  return [...bySession.values()];
};

// Per query client: the last write sent for each session, so writes to one session leave in order.
const chainsOf = new WeakMap<QueryClient, Map<string, Promise<unknown>>>();

/**
 * The mark mutation, apart from React so its ordering can be tested. Writes to one session go one
 * after another; on success the server's mark replaces that session's entry only, and the list is
 * read again once no other mark is still on its way.
 */
export const markMutationOptions = ({
  queryClient,
  marksKey,
  mutationKey,
  send,
}: {
  readonly queryClient: QueryClient;
  readonly marksKey: QueryKey;
  readonly mutationKey: MutationKey;
  readonly send: (request: MarkRequest) => Promise<SessionInboxMarkDto>;
}) => {
  const chains = chainsOf.get(queryClient) ?? new Map<string, Promise<unknown>>();
  chainsOf.set(queryClient, chains);
  return {
    mutationKey,
    mutationFn: (request: MarkRequest): Promise<SessionInboxMarkDto> => {
      const before = chains.get(request.id) ?? Promise.resolve();
      const sent = before.then(
        () => send(request),
        () => send(request),
      );
      chains.set(request.id, sent);
      const forget = () => {
        if (chains.get(request.id) === sent) chains.delete(request.id);
      };
      sent.then(forget, forget);
      return sent;
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: marksKey });
    },
    onSuccess: (saved: SessionInboxMarkDto) => {
      queryClient.setQueryData<ReadonlyArray<SessionInboxMarkDto>>(marksKey, (current) => [
        ...(current ?? []).filter((mark) => mark.sessionId !== saved.sessionId),
        saved,
      ]);
    },
    // This mutation still counts as in flight while it settles.
    onSettled: () =>
      queryClient.isMutating({ mutationKey }) <= 1
        ? queryClient.invalidateQueries({ queryKey: marksKey })
        : undefined,
  };
};

const usePendingMarks = (): ReadonlyArray<MarkRequest> => {
  const trpc = useTRPC();
  return useMutationState({
    filters: { mutationKey: trpc.sessions.setInboxMark.mutationKey(), status: "pending" },
    select: (mutation) => mutation.state.variables,
  }).filter(isMarkRequest);
};

/**
 * The signed-in person's inbox marks, with the ones still on their way laid over: settled and
 * kept sessions, and snoozes not yet over.
 */
export const useInboxMarks = () => {
  const trpc = useTRPC();
  const server = useQuery(trpc.sessions.inboxMarks.queryOptions(undefined, { staleTime: 30_000 }));
  const pending = usePendingMarks();
  return {
    data: server.data === undefined ? undefined : visibleMarks(server.data, pending, new Date()),
    isPending: server.isPending,
    isError: server.isError,
    refetch: server.refetch,
  };
};

/** Sessions whose mark is still on its way: their rows say so while it saves. */
export const useMarksInFlight = (): ReadonlySet<string> =>
  new Set(usePendingMarks().map((request) => request.id));

/**
 * Marks the server refused, newest last. Read from the mutation cache, so a refusal is reported
 * even after its row moved to another group and unmounted. `dismiss` forgets one.
 */
export const useMarkFailures = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // The selected values are copies, so a failure is forgotten by its id, not by the object.
  const failed = useMutationState({
    filters: { mutationKey: trpc.sessions.setInboxMark.mutationKey(), status: "error" },
    select: (mutation) => ({
      id: mutation.mutationId,
      request: mutation.state.variables,
      message: mutation.state.error?.message ?? "refused",
    }),
  });
  return {
    failures: failed.flatMap(({ id, request, message }) =>
      isMarkRequest(request) ? [{ id, request, message }] : [],
    ),
    dismiss: (id: number) => {
      const cache = queryClient.getMutationCache();
      const mutation = cache.getAll().find((entry) => entry.mutationId === id);
      if (mutation !== undefined) cache.remove(mutation);
    },
  };
};

/** Snooze, settle, or keep a session in the inbox. Own it once, above the rows that move. */
export const useSetInboxMark = () => {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  return useMutation(
    markMutationOptions({
      queryClient,
      marksKey: trpc.sessions.inboxMarks.queryKey(),
      mutationKey: trpc.sessions.setInboxMark.mutationKey(),
      send: (request) => client.sessions.setInboxMark.mutate(request),
    }),
  );
};
