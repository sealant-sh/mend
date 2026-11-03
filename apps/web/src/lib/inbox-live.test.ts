// @vitest-environment jsdom
import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { serialize } from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeInboxPatcher, rowsAbout, withRow } from "./inbox-live.ts";
import { makeTrpcProxy } from "./trpc.ts";

/** A row with only what the patcher reads; the rest of the DTO never matters here. */
const row = (
  id: string,
  status: string,
  extra: { changeId?: string; worktreeId?: string } = {},
) => ({
  session: { id, status, worktreeId: extra.worktreeId ?? `wt-${id}`, projectId: "p" },
  projectName: "billing",
  title: id,
  annotation: extra.changeId === undefined ? null : { changeId: extra.changeId },
  ask: null,
});
type Row = ReturnType<typeof row>;

/** What the server answers for one row read, in order; each answer resolves when released. */
let answers: Array<{
  readonly id: string;
  readonly body: unknown;
  readonly release: Promise<void>;
}>;
let urls: Array<string>;

const answerRow = (id: string, body: Row | "not found", release = Promise.resolve()) =>
  answers.push({ id, body, release });

beforeEach(() => {
  answers = [];
  urls = [];
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    const next = answers.shift();
    if (next === undefined) throw new Error(`unexpected read ${url}`);
    await next.release;
    const body =
      next.body === "not found"
        ? [
            {
              error: serialize({
                message: "not found",
                code: -32004,
                data: { code: "NOT_FOUND", httpStatus: 404 },
              }),
            },
          ]
        : [{ result: { data: serialize(next.body) } }];
    return Response.json(body, { status: next.body === "not found" ? 404 : 200 });
  });
});

afterEach(() => vi.unstubAllGlobals());

const world = (rows: ReadonlyArray<Row>) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const trpc = makeTrpcProxy(queryClient);
  // The key without its data tag: these rows carry only what the patcher reads.
  const key: QueryKey = [...trpc.sessions.inbox.queryKey()];
  queryClient.setQueryData(key, rows);
  const patch = makeInboxPatcher(queryClient, trpc);
  const list = () => queryClient.getQueryData<ReadonlyArray<Row>>(key);
  const state = () => queryClient.getQueryState(key);
  return { patch, list, state };
};

const settled = () => vi.waitFor(() => expect(answers).toEqual([]));

describe("the inbox kept live from the event stream", () => {
  it("re-reads only the row a session event names and patches it in place", async () => {
    const { patch, list, state } = world([row("a", "running"), row("b", "completed")]);
    answerRow("a", row("a", "waiting"));
    patch({ type: "session", sessionId: "a", projectId: "p" });
    await settled();
    await vi.waitFor(() =>
      expect(list()?.find((each) => each.session.id === "a")?.session.status).toBe("waiting"),
    );
    expect(
      list()
        ?.map((each) => each.session.id)
        .toSorted(),
    ).toEqual(["a", "b"]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("sessions.inboxRow");
    expect(state()?.isInvalidated).toBe(false);
  });

  it("takes out a row the server no longer lists", async () => {
    const { patch, list } = world([row("a", "completed"), row("b", "completed")]);
    answerRow("a", "not found");
    patch({ type: "session", sessionId: "a", projectId: "p" });
    await settled();
    await vi.waitFor(() => expect(list()?.map((each) => each.session.id)).toEqual(["b"]));
  });

  it("reads once more when the row moves again during its read, and ends on the newest state", async () => {
    const { patch, list } = world([row("a", "running")]);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    answerRow("a", row("a", "waiting"), held);
    answerRow("a", row("a", "completed"));
    patch({ type: "session", sessionId: "a", projectId: "p" });
    patch({ type: "session", sessionId: "a", projectId: "p" });
    release?.();
    await settled();
    await vi.waitFor(() => expect(list()?.[0]?.session.status).toBe("completed"));
    expect(urls).toHaveLength(2);
  });

  it("reads the whole list again for an event that names no row", async () => {
    const { patch, state } = world([row("a", "running")]);
    patch({ type: "project", projectId: "p" });
    expect(state()?.isInvalidated).toBe(true);
  });

  it("finds the rows of a change or a worktree an event names", () => {
    const rows = [
      row("a", "completed", { changeId: "c1" }),
      row("b", "running", { worktreeId: "w" }),
    ];
    expect(rowsAbout({ type: "review-comment", changeId: "c1" }, rows)).toEqual(["a"]);
    expect(rowsAbout({ type: "worktree", worktreeId: "w" }, rows)).toEqual(["b"]);
    expect(withRow(rows, "a", null).map((each) => each.session.id)).toEqual(["b"]);
  });
});
