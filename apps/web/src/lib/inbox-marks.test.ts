import { SessionId } from "@mend/domain";
import { MutationObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import type { SessionInboxMarkDto } from "./api.ts";
import {
  isMarkRequest,
  markMutationOptions,
  visibleMarks,
  type MarkRequest,
} from "./inbox-marks.ts";

const marksKey = ["sessions", "inboxMarks"];
const mutationKey = ["sessions", "setInboxMark"];
const now = new Date("2026-11-02T14:00:00Z");

const saved = (id: string, state: SessionInboxMarkDto["state"]): SessionInboxMarkDto => ({
  sessionId: SessionId.make(id),
  state,
  snoozedUntil: null,
  markedAt: now,
});

const deferred = <T>() => {
  const settlers: { resolve?: (value: T) => void; reject?: (reason: Error) => void } = {};
  const promise = new Promise<T>((resolve, reject) => {
    settlers.resolve = resolve;
    settlers.reject = reject;
  });
  return {
    promise,
    resolve: (value: T) => settlers.resolve?.(value),
    reject: (reason: Error) => settlers.reject?.(reason),
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let client: QueryClient | null = null;
afterEach(() => {
  client?.clear();
  client = null;
});

/** A query client with a live marks query backed by `server`, and the mark mutation. */
const world = (send: (request: MarkRequest) => Promise<SessionInboxMarkDto>) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client = queryClient;
  const server: Array<SessionInboxMarkDto> = [];
  const query = new QueryObserver(queryClient, {
    queryKey: marksKey,
    queryFn: () => Promise.resolve([...server]),
  });
  const unsubscribe = query.subscribe(() => undefined);
  const options = markMutationOptions({ queryClient, marksKey, mutationKey, send });
  const mark = (request: MarkRequest) =>
    new MutationObserver(queryClient, options).mutate(request).catch(() => undefined);
  const visible = () =>
    visibleMarks(
      queryClient.getQueryData<ReadonlyArray<SessionInboxMarkDto>>(marksKey) ?? [],
      queryClient
        .getMutationCache()
        .findAll({ mutationKey, status: "pending" })
        .map((mutation) => mutation.state.variables)
        .filter(isMarkRequest),
      now,
    )
      .map((row) => `${row.sessionId}:${row.state}`)
      .toSorted();
  return { queryClient, server, mark, visible, unsubscribe };
};

describe("overlapping inbox marks", () => {
  it("rolls back only the mark that failed, and keeps the other through its refetch", async () => {
    const first = deferred<SessionInboxMarkDto>();
    const second = deferred<SessionInboxMarkDto>();
    const { server, mark, visible, queryClient, unsubscribe } = world((request) =>
      request.id === "a" ? first.promise : second.promise,
    );
    await queryClient.refetchQueries({ queryKey: marksKey });

    const a = mark({ id: "a", mark: { _tag: "Settled" } });
    const b = mark({ id: "b", mark: { _tag: "Settled" } });
    await settle();
    expect(visible()).toEqual(["a:settled", "b:settled"]);

    first.reject(new Error("the server is down"));
    await a;
    await settle();
    expect(visible()).toEqual(["b:settled"]);

    server.push(saved("b", "settled"));
    second.resolve(saved("b", "settled"));
    await b;
    await settle();
    expect(visible()).toEqual(["b:settled"]);
    expect(queryClient.getQueryData(marksKey)).toEqual([saved("b", "settled")]);
    unsubscribe();
  });

  it("keeps a success's mark when a refetch lands before the other mark is saved", async () => {
    const second = deferred<SessionInboxMarkDto>();
    const { server, mark, visible, queryClient, unsubscribe } = world((request) =>
      request.id === "a"
        ? Promise.resolve().then(() => {
            server.push(saved("a", "settled"));
            return saved("a", "settled");
          })
        : second.promise,
    );
    await queryClient.refetchQueries({ queryKey: marksKey });

    const b = mark({ id: "b", mark: { _tag: "Inbox" } });
    await mark({ id: "a", mark: { _tag: "Settled" } });
    await queryClient.refetchQueries({ queryKey: marksKey });
    expect(visible()).toEqual(["a:settled", "b:inbox"]);

    server.push(saved("b", "inbox"));
    second.resolve(saved("b", "inbox"));
    await b;
    expect(visible()).toEqual(["a:settled", "b:inbox"]);
    unsubscribe();
  });

  it("sends marks for one session in the order they were made", async () => {
    const slow = deferred<SessionInboxMarkDto>();
    const sent: Array<string> = [];
    const { server, mark, visible, unsubscribe } = world((request) => {
      sent.push(request.mark._tag);
      if (request.mark._tag === "Snoozed") return slow.promise;
      server.splice(0, server.length, saved("a", "settled"));
      return Promise.resolve(saved("a", "settled"));
    });

    const snooze = mark({ id: "a", mark: { _tag: "Snoozed", until: new Date(now.getTime() + 1) } });
    const settled = mark({ id: "a", mark: { _tag: "Settled" } });
    await settle();
    expect(sent).toEqual(["Snoozed"]);
    expect(visible()).toEqual(["a:settled"]);

    slow.resolve({ ...saved("a", "snoozed"), snoozedUntil: new Date(now.getTime() + 1) });
    await snooze;
    await settled;
    expect(sent).toEqual(["Snoozed", "Settled"]);
    expect(visible()).toEqual(["a:settled"]);
    unsubscribe();
  });
});
