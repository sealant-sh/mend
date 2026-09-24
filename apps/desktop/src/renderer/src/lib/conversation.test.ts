import { buildAgentConversation } from "@mend/agent-conversation";
import { composeProtocolArgv, ProtocolHarnessUnsupportedError } from "@mend/domain/workbench";
import { QueryObserver } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";

import {
  agentRunsAsConversation,
  createSession,
  handoffSession,
  interruptAgentTurn,
  respondAgentRequest,
  resumeSession,
  type SessionControlEventDto,
  type SessionProcessDto,
} from "#/lib/api";
import { HARNESSES } from "#/lib/app-settings";
import {
  CONVERSATION_HARNESSES,
  conversationQuery,
  interruptersByTurn,
  readConversation,
  refreshConversation,
  turnAuthorLine,
  turnEndWord,
} from "#/lib/conversation";
import {
  bridgeFixture,
  itemFixture,
  processFixture,
  requestFixture,
  turnFixture,
} from "#/lib/fixtures";
import { queryClient } from "#/lib/queries";

import type { ApiRequest, ApiResponse } from "../../../shared/bridge";

const serve = (answer: (input: ApiRequest) => unknown) => {
  const requests: Array<ApiRequest> = [];
  Object.defineProperty(window, "mend", {
    configurable: true,
    value: bridgeFixture(async (input): Promise<ApiResponse> => {
      requests.push(input);
      return { status: 200, ok: true, body: answer(input) };
    }),
  });
  return requests;
};

const controlEvent = (patch: Partial<SessionControlEventDto>): SessionControlEventDto => ({
  id: "event-1",
  sessionId: "session-1",
  actorUserId: "user-2",
  kind: "interrupt",
  refId: "turn-1",
  createdAt: "2026-08-20T00:00:00.000Z",
  ...patch,
});

describe("reading a conversation", () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, "mend");
  });

  it("reads items on from the held cursor and replaces a grown item in place", async () => {
    const grown = itemFixture({ id: "item-2", seq: 4, status: "in-progress", text: "half" });
    const previous = {
      turns: [turnFixture()],
      items: [itemFixture({ seq: 1 }), grown],
      requests: [],
    };
    const requests = serve((input) => {
      if (input.path.startsWith("/api/sessions/session-1/items")) {
        return [{ ...grown, seq: 5, status: "completed", text: "whole" }];
      }
      if (input.path === "/api/sessions/session-1/turns") return [turnFixture()];
      if (input.path === "/api/sessions/session-1/requests") return [requestFixture()];
      return null;
    });

    const next = await readConversation("session-1", previous);

    expect(requests.map((request) => request.path)).toEqual([
      "/api/sessions/session-1/turns",
      "/api/sessions/session-1/items?after=4&limit=500",
      "/api/sessions/session-1/requests",
    ]);
    expect(next.items.map((item) => [item.id, item.text])).toEqual([
      ["item-1", "Done."],
      ["item-2", "whole"],
    ]);
    expect(buildAgentConversation(next).map((entry) => entry.key)).toEqual([
      "turn:turn-1",
      "item:item-1",
      "item:item-2",
      "request:request-1",
    ]);
  });

  it("starts from the beginning when nothing is held", async () => {
    const requests = serve(() => []);
    await readConversation("session-1", undefined);
    expect(requests[1]?.path).toBe("/api/sessions/session-1/items?after=0&limit=500");
  });
});

type ProcessKind = SessionProcessDto["kind"];

/** A turn on the conversation's own process, sent by `author`. */
const by = (author: string | null) => turnFixture({ author, processId: "process-1" });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("stream pointers", () => {
  it("keeps reading while pointers arrive faster than a read completes", async () => {
    // The server grows one item per delta and answers each read after 30 ms; a pointer lands
    // every 10 ms, as a streaming agent sends them.
    let text = "a";
    Object.defineProperty(window, "mend", {
      configurable: true,
      value: bridgeFixture(async (input): Promise<ApiResponse> => {
        await wait(30);
        let body: unknown = [];
        if (input.path.includes("/items")) body = [itemFixture({ seq: text.length, text })];
        if (input.path.endsWith("/turns")) body = [turnFixture()];
        return { status: 200, ok: true, body };
      }),
    });
    const observer = new QueryObserver(queryClient, conversationQuery("session-burst", false));
    const seen: Array<number> = [];
    const off = observer.subscribe((result) => {
      const length = result.data?.items[0]?.text?.length;
      if (length !== undefined && seen.at(-1) !== length) seen.push(length);
    });
    await wait(60);
    for (let pointer = 0; pointer < 30; pointer += 1) {
      text += "b";
      refreshConversation("session-burst");
      await wait(10);
    }
    const duringBurst = seen.length;
    await wait(200);
    off();
    queryClient.removeQueries({ queryKey: ["session", "session-burst"] });

    expect(duringBurst).toBeGreaterThan(3);
    expect(seen.at(-1)).toBe(text.length);
  });
});

describe("steering calls", () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, "mend");
  });

  it("sends each action to the route and body the contract declares", async () => {
    const requests = serve(() => ({}));
    await respondAgentRequest("request-1", { decision: "accept-for-session" });
    await respondAgentRequest("request-2", { answers: { pick: ["main"] } });
    await interruptAgentTurn("turn-1");
    await resumeSession("session-1");
    await handoffSession("session-1", "protocol");
    await createSession("project-1", "codex", null, null, null, "protocol");
    await createSession("project-1", "opencode", null);
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/api/requests/request-1/respond",
        body: { decision: "accept-for-session" },
      },
      {
        method: "POST",
        path: "/api/requests/request-2/respond",
        body: { answers: { pick: ["main"] } },
      },
      { method: "POST", path: "/api/turns/turn-1/interrupt" },
      { method: "POST", path: "/api/sessions/session-1/resume", body: { harness: null } },
      { method: "POST", path: "/api/sessions/session-1/handoff", body: { to: "protocol" } },
      {
        method: "POST",
        path: "/api/projects/project-1/sessions",
        body: {
          harness: "codex",
          mode: "protocol",
          label: null,
          name: null,
          base: null,
          autoLand: null,
        },
      },
      {
        method: "POST",
        path: "/api/projects/project-1/sessions",
        body: { harness: "opencode", label: null, name: null, base: null, autoLand: null },
      },
    ]);
  });
});

describe("conversation mode", () => {
  it("follows the agent's own row, and the launch's intent only before one exists", () => {
    const protocol = processFixture({ kind: "agent-protocol", sealantSessionId: null });
    expect(agentRunsAsConversation(protocol, null)).toBe(true);
    expect(agentRunsAsConversation(processFixture(), "protocol")).toBe(false);
    expect(agentRunsAsConversation(null, "protocol")).toBe(true);
    expect(agentRunsAsConversation(null, null)).toBe(false);
  });

  it("offers a conversation for exactly the harnesses the server launches in protocol mode", () => {
    for (const harness of [...HARNESSES, "shell"]) {
      const argv = composeProtocolArgv(harness, {});
      expect([harness, CONVERSATION_HARNESSES.has(harness)]).toEqual([
        harness,
        !(argv instanceof ProtocolHarnessUnsupportedError),
      ]);
    }
  });
});

describe("turn facts", () => {
  const names = new Map([
    ["user-1", "Yiannis"],
    ["user-2", "Maya"],
  ]);

  it("names another sender, and Mend for a follow-up, but not the viewer", () => {
    const kinds = new Map<string, ProcessKind>([["process-1", "agent-protocol"]]);
    expect(turnAuthorLine(by("user-1"), "user-1", names, kinds)).toBeNull();
    expect(turnAuthorLine(by("user-2"), "user-1", names, kinds)).toBe("sent by Maya");
    expect(turnAuthorLine(by("user-3"), "user-1", names, kinds)).toBe("sent by a member");
    expect(turnAuthorLine(by(null), "user-1", names, kinds)).toBe("sent by Mend");
  });

  it("does not credit Mend with the terminal history a handoff imported", () => {
    // Backfilled turns carry no author and the terminal agent's process id.
    const kinds = new Map<string, ProcessKind>([
      ["pty-agent", "agent-pty"],
      ["protocol-agent", "agent-protocol"],
    ]);
    const imported = turnFixture({ author: null, processId: "pty-agent" });
    expect(turnAuthorLine(imported, "user-1", names, kinds)).toBe("from the terminal");
    const unknown = turnFixture({ author: null, processId: "not-listed-yet" });
    expect(turnAuthorLine(unknown, "user-1", names, kinds)).toBeNull();
  });

  it("says who interrupted a turn when the control record names them", () => {
    const interrupters = interruptersByTurn([
      controlEvent({}),
      controlEvent({ id: "event-2", kind: "stop", refId: "turn-2" }),
    ]);
    expect([...interrupters]).toEqual([["turn-1", "user-2"]]);
    const interrupted = turnFixture({ status: "interrupted" });
    expect(turnEndWord(interrupted, "user-2", "user-1", names)).toBe(
      "interrupted by Maya · observed",
    );
    expect(turnEndWord(interrupted, "user-1", "user-1", names)).toBe(
      "interrupted by you · observed",
    );
    expect(turnEndWord(interrupted, null, "user-1", names)).toBe("interrupted · observed");
    expect(turnEndWord(turnFixture(), null, "user-1", names)).toBeNull();
    expect(turnEndWord(turnFixture({ status: "running" }), null, "user-1", names)).toBeNull();
  });
});
