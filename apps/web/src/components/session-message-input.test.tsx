// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpLink } from "@trpc/client";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import superjson, { parse, serialize } from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TRPCProvider } from "#/lib/trpc";
import { useViewerState } from "#/lib/viewer";
import type { AppRouter } from "#/server/routers/index";

import {
  followOtherTabs,
  forgetSignedInPerson,
  SessionMessageInput,
} from "./session-message-input.tsx";

const sessionId = "8b1c3a52-7e0f-4c1e-9a6d-2f4b5c6d7e8f";
const alice = "user-alice";
const bob = "user-bob";

interface Sent {
  readonly id: string;
  readonly input: string;
  readonly clientMessageId: string;
  readonly expectedUserId: string;
}

type Reply =
  | { readonly receipt: unknown }
  | {
      readonly refusal: {
        readonly status: number;
        readonly code: string;
        readonly tag: string | null;
      };
    }
  | { readonly hold: Promise<Reply> }
  | { readonly lost: true }
  | { readonly edge: number };

const turnReceipt = (explanation: string, status = "queued", startedAt: Date | null = null) => ({
  _tag: "Turn",
  messageId: "5f0c9a1e-1b2c-4d3e-8f4a-5b6c7d8e9f00",
  turn: { id: "turn-1", sessionId, status, startedAt },
  explanation,
});

const steerReceipt = (delivery: unknown, explanation: string) => ({
  _tag: "Steer",
  messageId: "5f0c9a1e-1b2c-4d3e-8f4a-5b6c7d8e9f00",
  steer: { id: "steer-1", sessionId, turnId: "turn-1", delivery },
  explanation,
});

const TRPC_CODES: Record<string, number> = {
  CONFLICT: -32009,
  FORBIDDEN: -32003,
  INTERNAL_SERVER_ERROR: -32603,
};

const AMBIGUOUS = "Several of your turns are running in this session. Send as a new turn instead.";
const NOT_STEERABLE = "Only the session's owner steers it.";
const KEY_CONFLICT = "This message key was already used for another request.";
const NOT_DONE = "Mend could not do that. Try again; the server log has the detail.";
const UNCONFIRMED = "Message outcome not confirmed · check the session before sending again";
const AUTHOR_CHANGED = "another account is signed in now · this message was not sent";

const WORDS: Record<string, string> = {
  MessageTargetAmbiguous: AMBIGUOUS,
  SessionNotSteerable: NOT_STEERABLE,
  MessageKeyConflict: KEY_CONFLICT,
  MessageAuthorChanged: AUTHOR_CHANGED,
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let host: HTMLDivElement;
let root: Root;
let sent: Array<Sent>;
let replies: Array<Reply>;
let principal: string | null;
let identityLost: boolean;
let identityReads: Array<string | null>;
let identityHold: Promise<Response> | null;

const answer = async (reply: Reply | undefined): Promise<Response> => {
  if (reply === undefined) throw new Error("No reply queued");
  if ("hold" in reply) return answer(await reply.hold);
  if ("lost" in reply) throw new TypeError("Failed to fetch");
  if ("edge" in reply)
    return new Response("<html><body>502 Bad Gateway</body></html>", {
      status: reply.edge,
      headers: { "content-type": "text/html" },
    });
  if ("receipt" in reply) return Response.json({ result: { data: serialize(reply.receipt) } });
  const { status, code, tag } = reply.refusal;
  return Response.json(
    {
      error: serialize({
        message: tag === null ? NOT_DONE : WORDS[tag],
        code: TRPC_CODES[code],
        data: { code, httpStatus: status, tag },
      }),
    },
    { status },
  );
};

const identity = (): Response => {
  identityReads.push(principal);
  if (identityLost) throw new TypeError("Failed to fetch");
  if (principal === null)
    return Response.json(
      {
        error: serialize({
          message: "Sign in to continue.",
          code: -32001,
          data: { code: "UNAUTHORIZED", httpStatus: 401 },
        }),
      },
      { status: 401 },
    );
  return Response.json({
    result: {
      data: serialize({ userId: principal, organization: { id: "org-test" }, role: "member" }),
    },
  });
};

const trpcClient = () =>
  createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: "http://mend.test/trpc",
        transformer: superjson,
        fetch: async (url, init) => {
          if (String(url).includes("/organization.current")) return identityHold ?? identity();
          sent.push(parse<Sent>(String(init?.body)));
          return answer(replies.shift());
        },
      }),
    ],
  });

const render = async (userId = alice) => {
  principal = userId;
  const queryClient = new QueryClient();
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={trpcClient()} queryClient={queryClient}>
          <SessionMessageInput sessionId={sessionId} />
        </TRPCProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
};

const remount = async (userId = alice) => {
  act(() => root.unmount());
  root = createRoot(host);
  await render(userId);
};

const hold = () => {
  const held: { resolve: (reply: Reply) => void } = { resolve: () => undefined };
  replies.push({
    hold: new Promise((resolve) => {
      held.resolve = resolve;
    }),
  });
  return held;
};

const settle = async () => {
  for (let tick = 0; tick < 5; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const textarea = () => {
  const found = document.querySelector("textarea");
  if (found === null) throw new Error("No message input");
  return found;
};
const sendButton = () => {
  const found = Array.from(document.querySelectorAll("button")).find(
    (item) => item.type === "submit",
  );
  if (found === undefined) throw new Error("No Send button");
  return found;
};
const type = async (text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea(),
      text,
    );
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const send = async () => {
  await act(async () => sendButton().click());
  await settle();
};
const status = () => document.querySelector('[role="status"]')?.textContent ?? null;
const alert = () => document.querySelector('[role="alert"]')?.textContent ?? null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  sent = [];
  replies = [];
  principal = alice;
  identityLost = false;
  identityReads = [];
  identityHold = null;
  sessionStorage.clear();
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe("SessionMessageInput", () => {
  it("sends the words with a key and no queue, then shows Mend's sentence as it is", async () => {
    await render();
    replies.push({ receipt: turnReceipt("sent · the agent acknowledged it") });
    await type("also check the migrations");
    await send();

    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0] ?? {}).toSorted()).toEqual([
      "clientMessageId",
      "expectedUserId",
      "id",
      "input",
    ]);
    expect(sent[0]).toMatchObject({
      id: sessionId,
      input: "also check the migrations",
      expectedUserId: alice,
    });
    expect(status()).toBe("sent · the agent acknowledged it");
    expect(textarea().value).toBe("");
    expect(alert()).toBeNull();
  });

  it("keeps the draft and shows the server's words when the target is ambiguous", async () => {
    await render();
    replies.push({ refusal: { status: 409, code: "CONFLICT", tag: "MessageTargetAmbiguous" } });
    await type("stop after the tests");
    await send();

    expect(alert()).toBe(AMBIGUOUS);
    expect(textarea().value).toBe("stop after the tests");
    expect(sendButton().disabled).toBe(false);
  });

  it("keeps the draft and shows the server's words when the session refuses the sender", async () => {
    await render();
    replies.push({ refusal: { status: 403, code: "FORBIDDEN", tag: "SessionNotSteerable" } });
    await type("rename the flag");
    await send();

    expect(alert()).toBe(NOT_STEERABLE);
    expect(textarea().value).toBe("rename the flag");
  });

  it("re-sends a refused draft under the same key, and new words under a new one", async () => {
    await render();
    replies.push(
      { refusal: { status: 409, code: "CONFLICT", tag: "MessageTargetAmbiguous" } },
      { receipt: turnReceipt("sent as your next turn · you had no running turn in this session") },
      { receipt: turnReceipt("sent · written to the agent") },
    );
    await type("run the linter");
    await send();
    await send();
    await type("then the formatter");
    await send();

    const [refused, retried, next] = sent;
    expect(retried?.clientMessageId).toBe(refused?.clientMessageId);
    expect(retried?.input).toBe("run the linter");
    expect(next?.clientMessageId).not.toBe(retried?.clientMessageId);
    expect(next?.input).toBe("then the formatter");
    expect(status()).toBe("sent · written to the agent");
  });

  it("makes a UUID v4 key where only crypto.getRandomValues exists, as on plain http", async () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    await render();
    replies.push({ receipt: turnReceipt("sent · written to the agent") });
    await type("check the lockfile");
    await send();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.clientMessageId).toMatch(UUID_V4);
    expect(status()).toBe("sent · written to the agent");
  });

  it("says so when the browser cannot make a key, and keeps the words", async () => {
    vi.stubGlobal("crypto", {});
    await render();
    await type("check the lockfile");
    await send();

    expect(sent).toHaveLength(0);
    expect(alert()).not.toBeNull();
    expect(textarea().value).toBe("check the lockfile");
  });

  it("brings the draft and its key back when the input mounts again for the session", async () => {
    await render();
    replies.push({ lost: true }, { receipt: turnReceipt("sent · written to the agent") });
    await type("run the linter");
    await send();
    await remount();

    expect(textarea().value).toBe("run the linter");
    await send();
    expect(sent[1]?.clientMessageId).toBe(sent[0]?.clientMessageId);
    expect(sent[1]?.input).toBe("run the linter");
  });

  it("keeps an unsent draft across a remount", async () => {
    await render();
    await type("half a thought");
    await remount();

    expect(textarea().value).toBe("half a thought");
  });

  it("keeps the key through an edit after a lost answer", async () => {
    await render();
    replies.push({ lost: true }, { receipt: turnReceipt("sent · written to the agent") });
    await type("run the linter");
    await send();
    await type("run the linterx");
    await type("run the linter");
    await send();

    expect(sent[1]?.clientMessageId).toBe(sent[0]?.clientMessageId);
  });

  it("starts a new key after the server says the key was used for other words", async () => {
    await render();
    replies.push(
      { lost: true },
      { refusal: { status: 409, code: "CONFLICT", tag: "MessageKeyConflict" } },
      { receipt: turnReceipt("sent · written to the agent") },
    );
    await type("run the linter");
    await send();
    await type("run the linter on apps/web");
    await send();
    expect(alert()).toBe(KEY_CONFLICT);
    expect(textarea().value).toBe("run the linter on apps/web");
    await send();

    expect(sent[1]?.clientMessageId).toBe(sent[0]?.clientMessageId);
    expect(sent[2]?.clientMessageId).not.toBe(sent[1]?.clientMessageId);
    expect(sent[2]?.clientMessageId).toMatch(UUID_V4);
  });

  it("clears the draft and its key after a receipt, here and on the next mount", async () => {
    await render();
    replies.push(
      { receipt: turnReceipt("sent · written to the agent") },
      { receipt: turnReceipt("sent · written to the agent") },
    );
    await type("run the linter");
    await send();
    await remount();

    expect(textarea().value).toBe("");
    await type("run the linter");
    await send();
    expect(sent[1]?.clientMessageId).not.toBe(sent[0]?.clientMessageId);
  });

  it.each<[string, Reply]>([
    ["a failed fetch", { lost: true }],
    ["a 5xx", { refusal: { status: 500, code: "INTERNAL_SERVER_ERROR", tag: null } }],
    ["an edge's HTML page", { edge: 502 }],
  ])("reads %s as not confirmed, and keeps the draft and its key", async (_, reply) => {
    await render();
    replies.push(reply, { receipt: turnReceipt("sent · written to the agent") });
    await type("run the linter");
    await send();

    expect(alert()).toBe(UNCONFIRMED);
    expect(textarea().value).toBe("run the linter");
    await send();
    expect(sent[1]?.clientMessageId).toBe(sent[0]?.clientMessageId);
  });

  it.each([
    [{ _tag: "Unknown", reason: "uncertain" }, "delivery not confirmed · Mend will not resend"],
    [{ _tag: "Sending" }, "sending"],
  ])("keeps the draft and its key when delivery is %o", async (delivery, explanation) => {
    await render();
    replies.push(
      { receipt: steerReceipt(delivery, explanation) },
      { receipt: steerReceipt(delivery, explanation) },
    );
    await type("run the linter");
    await send();

    expect(status()).toBe(explanation);
    expect(textarea().value).toBe("run the linter");
    await send();
    expect(sent[1]?.clientMessageId).toBe(sent[0]?.clientMessageId);
  });

  it("keeps words Mend did not send, and shows why", async () => {
    await render();
    replies.push({
      receipt: turnReceipt("not sent · the turn failed before it started", "failed"),
    });
    await type("try the other branch");
    await send();

    expect(status()).toBe("not sent · the turn failed before it started");
    expect(textarea().value).toBe("try the other branch");
  });

  it("disables Send only while the message is on its way", async () => {
    await render();
    const held = hold();
    expect(sendButton().disabled).toBe(false);
    await type("one more thing");
    await send();
    expect(sendButton().disabled).toBe(true);

    held.resolve({
      receipt: turnReceipt("sent · the agent acknowledged it", "running", new Date()),
    });
    await settle();
    expect(sendButton().disabled).toBe(false);
    expect(status()).toBe("sent · the agent acknowledged it");
  });

  it.each<[string, Reply]>([
    ["a receipt", { receipt: turnReceipt("sent · written to the agent") }],
    ["a not-sent receipt", { receipt: turnReceipt("not sent · the turn failed", "failed") }],
    ["a key conflict", { refusal: { status: 409, code: "CONFLICT", tag: "MessageKeyConflict" } }],
  ])(
    "keeps words typed after a remount when %s answers the earlier send, under a new key",
    async (_, reply) => {
      await render();
      const held = hold();
      await type("first message");
      await send();
      await remount();
      await type("newer unsent words");
      held.resolve(reply);
      await settle();
      await remount();

      expect(textarea().value).toBe("newer unsent words");
      replies.push({ receipt: turnReceipt("sent · written to the agent") });
      await send();
      expect(sent[1]?.input).toBe("newer unsent words");
      expect(sent[1]?.clientMessageId).not.toBe(sent[0]?.clientMessageId);
      expect(sent[1]?.clientMessageId).toMatch(UUID_V4);
    },
  );

  it.each([
    [{ _tag: "Unknown", reason: "uncertain" }, "delivery not confirmed · Mend will not resend"],
    [{ _tag: "Sending" }, "sending"],
  ])(
    "keeps the key through an edit and its undoing when delivery is %o, answered late",
    async (delivery, explanation) => {
      await render();
      const held = hold();
      await type("run the linter");
      await send();
      await remount();
      await type("run the linterx");
      held.resolve({ receipt: steerReceipt(delivery, explanation) });
      await settle();
      await remount();

      expect(textarea().value).toBe("run the linterx");
      await type("run the linter");
      replies.push({ receipt: steerReceipt(delivery, explanation) });
      await send();
      expect(sent[1]?.input).toBe("run the linter");
      expect(sent[1]?.clientMessageId).toBe(sent[0]?.clientMessageId);
    },
  );

  it("shows a draft only to the account that wrote it", async () => {
    await render(alice);
    await type("Alice private unsent draft");
    await remount(bob);

    expect(textarea().value).toBe("");
    await remount(alice);
    expect(textarea().value).toBe("Alice private unsent draft");
  });

  it("forgets every message draft at sign-out, and nothing else in the tab", async () => {
    sessionStorage.setItem("mend.other", "kept");
    await render(alice);
    await type("Alice private unsent draft");
    act(() => root.unmount());
    forgetSignedInPerson(new QueryClient());
    root = createRoot(host);
    await render(alice);

    expect(textarea().value).toBe("");
    expect(sessionStorage.getItem("mend.other")).toBe("kept");
  });
});

describe("sign-out", () => {
  let queryClient: QueryClient;
  let stopFollowing: () => void;

  function ViewerMessageInput() {
    const viewer = useViewerState();
    return viewer == null ? null : <SessionMessageInput sessionId={sessionId} />;
  }

  const show = async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <TRPCProvider trpcClient={trpcClient()} queryClient={queryClient}>
            <ViewerMessageInput />
          </TRPCProvider>
        </QueryClientProvider>,
      ),
    );
    await settle();
  };

  class TabStorage {
    readonly items = new Map<string, string>();
    get length() {
      return this.items.size;
    }
    key(index: number) {
      return Array.from(this.items.keys())[index] ?? null;
    }
    getItem(item: string) {
      return this.items.get(item) ?? null;
    }
    setItem(item: string, value: string) {
      this.items.set(item, value);
    }
    removeItem(item: string) {
      this.items.delete(item);
    }
  }

  const signOutInAnotherTab = async () => {
    const otherTab = { sessionStorage: new TabStorage(), localStorage: new TabStorage() };
    const here = { sessionStorage, localStorage };
    vi.stubGlobal("sessionStorage", otherTab.sessionStorage);
    vi.stubGlobal("localStorage", otherTab.localStorage);
    forgetSignedInPerson(new QueryClient());
    vi.stubGlobal("sessionStorage", here.sessionStorage);
    vi.stubGlobal("localStorage", here.localStorage);
    principal = null;
    const [[key, newValue] = [null, null]] = otherTab.localStorage.items;
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key, newValue })));
    await settle();
  };

  const comeBack = async (event: "focus" | "visibilitychange") => {
    await act(async () =>
      event === "focus"
        ? window.dispatchEvent(new Event("focus"))
        : document.dispatchEvent(new Event("visibilitychange", { bubbles: true })),
    );
    await settle();
  };

  /** Hold reads of who is signed in until the returned release, answered as of now. */
  const holdIdentity = () => {
    const response = identity();
    let resolveHold: ((held: Response) => void) | null = null;
    identityHold = new Promise((resolve) => {
      resolveHold = resolve;
    });
    return () => {
      identityHold = null;
      resolveHold?.(response);
    };
  };

  const signOutThenIn = async (next: string) => {
    forgetSignedInPerson(queryClient);
    await act(async () => root.render(null));
    principal = next;
    await show();
  };

  beforeEach(() => {
    queryClient = new QueryClient();
    stopFollowing = followOtherTabs(queryClient);
  });

  afterEach(() => stopFollowing());

  it("reads who signed in next, so their words stay theirs when the identity refreshes", async () => {
    await show();
    await type("Alice old unsent words");
    await signOutThenIn(bob);

    expect(identityReads).toEqual([alice, bob]);
    expect(textarea().value).toBe("");
    await type("Bob new unsent words");
    await act(async () => queryClient.invalidateQueries());
    await settle();
    expect(textarea().value).toBe("Bob new unsent words");
  });

  it("never shows the next person's words to the one before", async () => {
    await show();
    await signOutThenIn(bob);
    await type("Bob new unsent words");
    await act(async () => root.render(null));
    queryClient.clear();
    principal = alice;
    await show();

    expect(textarea().value).toBe("");
  });

  it("hides the draft when another tab signs someone in, and keeps it for its own account", async () => {
    await show();
    await type("Alice private draft");
    principal = bob;
    const release = holdIdentity();
    await act(async () =>
      window.dispatchEvent(new StorageEvent("storage", { key: "mend.signedIn", newValue: "1" })),
    );

    expect(document.querySelector("textarea")?.value ?? "").toBe("");
    release();
    await settle();
    expect(document.querySelector("textarea")?.value ?? "").toBe("");
    principal = alice;
    await comeBack("focus");
    expect(textarea().value).toBe("Alice private draft");
  });

  it.each([
    ["the next person", bob],
    ["the same person", alice],
  ])(
    "takes this tab's draft with it when another tab signs out and %s signs in there",
    async (_, next) => {
      await show();
      await type("Alice private words from the first tab");
      await signOutInAnotherTab();
      principal = next;
      await comeBack("visibilitychange");

      expect(identityReads.at(-1)).toBe(next);
      expect(textarea().value).toBe("");
    },
  );

  it.each(["focus", "visibilitychange"] as const)(
    "re-reads who is signed in on %s, so a sign-in elsewhere shows the new person's own draft",
    async (event) => {
      await show();
      await type("Alice private words from the first tab");
      principal = bob;
      await comeBack(event);

      expect(identityReads).toEqual([alice, bob]);
      expect(textarea().value).toBe("");
    },
  );

  it("shows no draft and takes no words while it re-reads who is signed in", async () => {
    await show();
    await type("Alice private draft");
    principal = bob;
    const release = holdIdentity();
    await comeBack("focus");

    expect(textarea().value).toBe("");
    expect(textarea().readOnly).toBe(true);
    expect(host.textContent).toContain("checking who is signed in");
    release();
    await settle();
  });

  it("hides the draft as soon as the tab is used again, before the re-read renders", async () => {
    await show();
    await type("Alice private draft");
    principal = bob;
    const release = holdIdentity();
    await act(async () => window.dispatchEvent(new Event("focus")));

    expect(textarea().value).toBe("");
    release();
    await settle();
  });

  it("drops words typed before a re-read started on focus has rendered", async () => {
    await show();
    await type("Alice draft");
    principal = bob;
    const release = holdIdentity();
    await act(async () => window.dispatchEvent(new Event("focus")));
    await type("Bob private new words");
    release();
    await settle();
    principal = alice;
    await comeBack("focus");

    expect(textarea().value).toBe("Alice draft");
  });

  it("does not send while a re-read of who is signed in is still out", async () => {
    await show();
    await type("Alice private draft");
    const release = holdIdentity();
    await act(async () => window.dispatchEvent(new Event("focus")));
    principal = bob;
    replies.push({ receipt: turnReceipt("sent · written to the agent") });
    await send();
    release();
    await settle();

    expect(sent).toHaveLength(0);
  });

  it("shows no draft and takes no words after it could not read who is signed in", async () => {
    await show();
    await type("Alice private draft");
    principal = bob;
    identityLost = true;
    await comeBack("focus");

    expect(textarea().value).toBe("");
    expect(textarea().readOnly).toBe(true);
    expect(host.textContent).toContain("could not check who is signed in");
    identityLost = false;
    principal = alice;
    await comeBack("focus");
    expect(textarea().value).toBe("Alice private draft");
  });

  it("never stores words typed during a re-read under the account read before it", async () => {
    await show();
    await type("Alice draft");
    principal = bob;
    const release = holdIdentity();
    await comeBack("focus");
    await type("Bob private new words");
    release();
    await settle();

    expect(textarea().value).toBe("");
    principal = alice;
    await comeBack("focus");
    expect(textarea().value).toBe("Alice draft");
  });

  it("sends nothing while it re-reads who is signed in", async () => {
    await show();
    await type("Alice private draft");
    const release = holdIdentity();
    await comeBack("focus");
    principal = bob;
    replies.push({ receipt: turnReceipt("sent · written to the agent") });
    await send();
    release();
    await settle();

    expect(sent).toHaveLength(0);
  });

  it("keeps the words under their writer when the server finds another account signed in", async () => {
    await show();
    await type("Alice private words");
    principal = bob;
    replies.push({ refusal: { status: 409, code: "CONFLICT", tag: "MessageAuthorChanged" } });
    await send();

    expect(sent).toEqual([expect.objectContaining({ expectedUserId: alice })]);
    expect(alert()).toBe(AUTHOR_CHANGED);
    expect(identityReads.at(-1)).toBe(bob);
    expect(textarea().value).toBe("");
    principal = alice;
    await comeBack("focus");
    expect(textarea().value).toBe("Alice private words");
  });
});
