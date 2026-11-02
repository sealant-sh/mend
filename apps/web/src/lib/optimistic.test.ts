import { MutationObserver, QueryClient, queryOptions } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { fieldWriter } from "./optimistic.ts";

interface Switches {
  readonly tour: boolean;
  readonly name: boolean;
}

const KEY = queryOptions<Switches>({ queryKey: ["settings"] }).queryKey;

/** A send the test answers by hand, in whatever order it likes. */
const controlledSend = () => {
  const calls: Array<{
    readonly change: Partial<Switches>;
    readonly server: Switches;
    readonly answer: (saved: Switches) => void;
    readonly refuse: (message: string) => void;
  }> = [];
  const send = (change: Partial<Switches>, server: Switches) =>
    new Promise<Switches>((resolve, reject) => {
      calls.push({ change, server, answer: resolve, refuse: (m) => reject(new Error(m)) });
    });
  return { calls, send };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("overlapping writes to one settings document", () => {
  it("keeps a newer change when an older one is refused, and sends no stale optimistic value", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(KEY, { tour: false, name: false });
    let invalidations = 0;
    const invalidate = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = (...args) => {
      invalidations += 1;
      return invalidate(...args);
    };
    const writer = fieldWriter<Switches>((_server, saved) => saved);
    const { calls, send } = controlledSend();
    const options = writer.options({
      queryClient,
      documentKey: KEY,
      mutationKey: ["settings", "put"],
      send,
    });
    const tour = new MutationObserver(queryClient, options);
    const name = new MutationObserver(queryClient, options);

    const tourDone = tour.mutate({ tour: true }).catch(() => "refused");
    const nameDone = name.mutate({ name: true });
    await flush();

    // Both show at once; only the first has left, carrying the server's document.
    expect(writer.pending(queryClient)).toEqual([{ tour: true }, { name: true }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.server).toEqual({ tour: false, name: false });

    // A refetch landing meanwhile replaces the server copy, not the pending changes.
    queryClient.setQueryData(KEY, { tour: false, name: false });
    expect(writer.pending(queryClient)).toHaveLength(2);

    calls[0]?.refuse("the store is read-only");
    expect(await tourDone).toBe("refused");
    await flush();

    // Only the refused change falls back; the newer one still shows and has now left, laid over
    // the server's document, not over the refused optimistic value.
    expect(writer.pending(queryClient)).toEqual([{ name: true }]);
    expect(queryClient.getQueryData(KEY)).toEqual({ tour: false, name: false });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.server).toEqual({ tour: false, name: false });
    expect(calls[1]?.change).toEqual({ name: true });
    expect(invalidations).toBe(0);

    calls[1]?.answer({ tour: false, name: true });
    await nameDone;
    await flush();
    expect(writer.pending(queryClient)).toEqual([]);
    expect(queryClient.getQueryData(KEY)).toEqual({ tour: false, name: true });
    // Read again once, after the last write to the document settled.
    expect(invalidations).toBe(1);
  });

  it("sends the second change over what the server answered to the first", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(KEY, { tour: false, name: false });
    const writer = fieldWriter<Switches>((_server, saved) => saved);
    const { calls, send } = controlledSend();
    const options = writer.options({
      queryClient,
      documentKey: KEY,
      mutationKey: ["settings", "put"],
      send,
    });
    const first = new MutationObserver(queryClient, options).mutate({ tour: true });
    const second = new MutationObserver(queryClient, options).mutate({ name: true });
    await flush();
    calls[0]?.answer({ tour: true, name: false });
    await first;
    await flush();
    expect(calls[1]?.server).toEqual({ tour: true, name: false });
    calls[1]?.answer({ tour: true, name: true });
    await second;
    expect(queryClient.getQueryData(KEY)).toEqual({ tour: true, name: true });
  });
});
