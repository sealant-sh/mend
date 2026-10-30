import { AgentTurnId } from "@mend/domain";
import {
  AgentTurn,
  TURN_DELIVERY_UNCONFIRMED,
  TurnSteerQueueReason,
  type AgentTurnSteerDelivery,
} from "@mend/domain/workbench";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { findCommand, renderCommand, renderManPage } from "./help.ts";
import {
  encodeReceipt,
  messageKey,
  messageSessionId,
  messageTurn,
  steerReceipt,
  turnReceipt,
} from "./message-test-fixtures.ts";
import {
  messageCommand,
  parseMessageArguments,
  type MessageBoundary,
  type MessageServer,
} from "./message.ts";
import { MendRequestError } from "./server-request.ts";

const command = (
  raw: unknown = encodeReceipt(turnReceipt()),
  overrides: Partial<MessageBoundary & MessageServer> = {},
) => {
  const calls: Array<{ route: string; body: unknown }> = [];
  const resolved: Array<string> = [];
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];
  let keys = 0;
  let stdinReads = 0;
  const server: MessageServer = {
    resolveSession:
      overrides.resolveSession ??
      (async (word) => {
        resolved.push(word);
        return { id: messageSessionId };
      }),
    post:
      overrides.post ??
      (async (route, body) => {
        calls.push({ route, body });
        return raw;
      }),
  };
  const boundary: MessageBoundary = {
    connect: () => server,
    readStdin: async () => {
      stdinReads++;
      return messageTurn.input;
    },
    uuid: () => {
      keys++;
      return messageKey;
    },
    stdout: (text) => {
      stdout.push(text);
    },
    stderr: (text) => {
      stderr.push(text);
    },
    ...(overrides.connect === undefined ? {} : { connect: overrides.connect }),
    ...(overrides.readStdin === undefined ? {} : { readStdin: overrides.readStdin }),
  };
  return {
    run: (args: ReadonlyArray<string>) => messageCommand(args, boundary),
    calls,
    resolved,
    stdout,
    stderr,
    keys: () => keys,
    stdinReads: () => stdinReads,
  };
};

describe("mend message arguments", () => {
  it.each([
    [],
    ["session"],
    ["session", ""],
    ["session", " \n\t"],
    ["", "text"],
    ["session", "first", "second"],
    ["session", "--unknown"],
    ["session", "text", "--queue=false"],
    ["session", "text", "--json=true"],
    ["session", "--queue", "false", "text"],
    ["session", "text", "--queue", "--queue"],
  ])("refuses %j before resolving, allocating a key, or posting", async (...args) => {
    const world = command();
    expect(await world.run(args)).toBe(1);
    expect(world.calls).toEqual([]);
    expect(world.resolved).toEqual([]);
    expect(world.keys()).toBe(0);
    expect(world.stdout).toEqual([]);
    expect(world.stderr).toHaveLength(1);
  });

  it("preserves arbitrary nonblank input as one positional, including flags after --", () => {
    fc.assert(
      fc.property(
        fc.string().filter((value) => /\S/.test(value)),
        (text) => {
          expect(parseMessageArguments(["session", "--", text])).toEqual({
            _tag: "Valid",
            value: { session: "session", text, queue: false, json: false },
          });
        },
      ),
    );
  });

  it("posts one frozen body, with a key, and prints the server sentence", async () => {
    const world = command();
    expect(await world.run(["1234", messageTurn.input])).toBe(0);
    expect(world.resolved).toEqual(["1234"]);
    expect(world.calls).toEqual([
      {
        route: "/sessions/session-1234/messages",
        body: { input: messageTurn.input, clientMessageId: messageKey },
      },
    ]);
    expect(world.keys()).toBe(1);
    expect(world.stdinReads()).toBe(0);
    expect(world.stdout.join("")).toBe(
      "sent as your next turn · you asked for a new turn · session session- · turn turn-123\n",
    );
    expect(world.stderr).toEqual([]);
  });

  it("reads stdin exactly once and sends explicit queue intent", async () => {
    const world = command();
    expect(await world.run(["worktree", "--queue", "-", "--json"])).toBe(0);
    expect(world.stdinReads()).toBe(1);
    expect(world.calls).toEqual([
      {
        route: "/sessions/session-1234/messages",
        body: { input: messageTurn.input, clientMessageId: messageKey, queue: true },
      },
    ]);
    expect(world.stdout).toHaveLength(1);
    expect(JSON.parse(world.stdout.join(""))).toEqual({
      version: 1,
      result: encodeReceipt(turnReceipt()),
    });
  });

  it.each(["", " \n\t"])("refuses empty stdin %j before sending", async (input) => {
    const world = command(undefined, { readStdin: async () => input });
    expect(await world.run(["session", "-", "--json"])).toBe(1);
    expect(world.calls).toEqual([]);
    expect(world.keys()).toBe(0);
    expect(JSON.parse(world.stdout.join(""))).toMatchObject({
      version: 1,
      error: { tag: "InvalidMessageArguments", clientMessageId: null },
    });
  });

  it("refuses a repeated --json as one JSON error without the words", async () => {
    const world = command();
    expect(await world.run(["session", "--json", "private words", "--json"])).toBe(1);
    expect(world.calls).toEqual([]);
    expect(world.resolved).toEqual([]);
    expect(world.stdout.join("")).not.toContain("private words");
    expect(JSON.parse(world.stdout.join(""))).toMatchObject({
      version: 1,
      error: { tag: "InvalidMessageArguments", clientMessageId: null },
    });
  });

  it("does not echo invalid options or mistake literal --json for the output flag", async () => {
    const bad = command();
    expect(await bad.run(["s", "--private-words", "--json"])).toBe(1);
    expect(bad.stdout.join("")).not.toContain("--private-words");
    expect(JSON.parse(bad.stdout.join(""))).toMatchObject({
      version: 1,
      error: { tag: "InvalidMessageArguments" },
    });
    const literal = command();
    expect(await literal.run(["s", "--", "--json"])).toBe(0);
    expect(literal.calls[0]?.body).toMatchObject({ input: "--json" });
    expect(literal.stdout.join("")).toContain("sent as your next turn");
  });

  it("publishes the flags, stdin, exits, and literal text in help and the manual", () => {
    const doc = findCommand(["message"]);
    expect(doc).not.toBeNull();
    if (doc === null) return;
    for (const page of [renderCommand(doc, 120), renderManPage(doc, "0.0.0")]) {
      expect(page).toContain("stdin");
      expect(page).toContain("Exit 0");
      expect(page).toContain("request key");
      expect(page).toContain("resume it first");
    }
  });
});

const deliveries: ReadonlyArray<readonly [AgentTurnSteerDelivery, 0 | 1 | 2, string]> = [
  [{ _tag: "Accepted", evidence: "provider-acknowledged" }, 0, "sent · the agent acknowledged it"],
  [{ _tag: "Accepted", evidence: "transport-written" }, 0, "sent · written to the agent"],
  [{ _tag: "Sending" }, 2, "sending"],
  [{ _tag: "Unknown", reason: "restart" }, 2, "delivery not confirmed · Mend will not resend"],
  [{ _tag: "NotSent", reason: "turn-ended" }, 1, "not sent · the running turn ended"],
  ...TurnSteerQueueReason.literals.map((reason): readonly [AgentTurnSteerDelivery, 0, string] => [
    { _tag: "Queued", reason, turnId: AgentTurnId.make("carried-turn") },
    0,
    "sent as your next turn",
  ]),
];

describe("mend message receipts", () => {
  for (const [delivery, code, words] of deliveries)
    it(`prints ${JSON.stringify(delivery)} with exit ${code} and one encoded JSON receipt`, async () => {
      const receipt = steerReceipt(delivery);
      for (const json of [false, true]) {
        const world = command(encodeReceipt(receipt));
        expect(await world.run(["s", "words", ...(json ? ["--json"] : [])])).toBe(code);
        expect(world.calls).toHaveLength(1);
        expect(world.stdout).toHaveLength(1);
        if (json) {
          expect(JSON.parse(world.stdout.join(""))).toEqual({
            version: 1,
            ...(code === 2 ? { clientMessageId: messageKey } : {}),
            result: encodeReceipt(receipt),
          });
          expect(world.stderr).toEqual([]);
        } else {
          expect(world.stdout.join("")).toContain(words);
          expect(world.stdout.join("")).toContain("steer d662262a");
          if (code === 2) expect(world.stderr.join("")).toContain(messageKey);
          else expect(world.stderr).toEqual([]);
        }
      }
    });

  it.each([
    ["queued", 0],
    ["running", 0],
    ["completed", 0],
    ["failed", 1],
    ["cancelled", 1],
    ["interrupted", 1],
  ] as const)("prints a turn observed %s with exit %s", async (status, code) => {
    const world = command(encodeReceipt(turnReceipt(status)));
    expect(await world.run(["s", "words"])).toBe(code);
    expect(world.stdout.join("")).toContain(turnReceipt(status).explanation);
    const json = command(encodeReceipt(turnReceipt(status)));
    expect(await json.run(["s", "words", "--json"])).toBe(code);
    expect(JSON.parse(json.stdout.join(""))).toEqual({
      version: 1,
      result: encodeReceipt(turnReceipt(status)),
    });
  });

  it("prints a turn whose delivery was never confirmed with exit 2 and the request key", async () => {
    const receipt = turnReceipt("failed", {
      startedAt: new Date(0),
      endedAt: new Date(0),
      error: TURN_DELIVERY_UNCONFIRMED,
    });
    const world = command(encodeReceipt(receipt));
    expect(await world.run(["s", "words"])).toBe(2);
    expect(world.stdout.join("")).toContain("delivery not confirmed · Mend will not resend");
    expect(world.stderr.join("")).toContain(messageKey);
    const json = command(encodeReceipt(receipt));
    expect(await json.run(["s", "words", "--json"])).toBe(2);
    expect(JSON.parse(json.stdout.join(""))).toEqual({
      version: 1,
      clientMessageId: messageKey,
      result: encodeReceipt(receipt),
    });
  });
});

describe("mend message failures", () => {
  it.each([null, {}, { _tag: "Future" }, { _tag: "Turn", turn: { status: "completed" } }])(
    "treats unusable receipt %j as uncertain without another POST",
    async (raw) => {
      const world = command(raw);
      expect(await world.run(["s", "private words", "--json"])).toBe(2);
      expect(world.calls).toHaveLength(1);
      expect(JSON.parse(world.stdout.join(""))).toMatchObject({
        version: 1,
        error: { tag: "MessageOutcomeUnconfirmed", clientMessageId: messageKey },
      });
      expect(world.stdout.join("")).not.toContain("private words");
    },
  );

  it.each([
    new MendRequestError("timeout", "payload"),
    new MendRequestError("dropped", "payload"),
    new MendRequestError("http", "payload", 500),
    new MendRequestError("http", "payload", 502),
    new MendRequestError("http", "payload", 504),
    new Error("invalid JSON with private words"),
  ])("never retries an unanswered POST: %j", async (error) => {
    let sends = 0;
    const world = command(undefined, {
      post: async () => {
        sends++;
        throw error;
      },
    });
    expect(await world.run(["s", "private words"])).toBe(2);
    expect(sends).toBe(1);
    expect(world.stdout).toEqual([]);
    expect(world.stderr.join("")).toContain(messageKey);
    expect(world.stderr.join("")).toContain("check the session before sending again");
    expect(world.stderr.join("")).not.toContain("private words");
  });

  it.each([400, 403, 404, 405, 408, 409, 413, 415, 422, 429, 499])(
    "reports pre-admission HTTP %s as exit 1 in JSON",
    async (status) => {
      const world = command(undefined, {
        post: async () => {
          throw new MendRequestError(
            "http",
            "refused private words at https://user:password@example.invalid",
            status,
            { call: "POST messages", tag: "FutureRefusal" },
          );
        },
      });
      expect(await world.run(["s", "private words", "--json"])).toBe(1);
      const text = world.stdout.join("");
      expect(JSON.parse(text)).toMatchObject({
        version: 1,
        error: { tag: "FutureRefusal", clientMessageId: messageKey },
      });
      expect(text).not.toContain("private words");
      expect(text).not.toContain("password");
      expect(world.stderr).toEqual([]);
    },
  );

  it("keeps the resolver's ambiguity refusal and does not POST", async () => {
    const world = command(undefined, {
      resolveSession: async () => {
        throw new Error("several sessions match; use a longer prefix");
      },
    });
    expect(await world.run(["s", "words"])).toBe(1);
    expect(world.calls).toEqual([]);
    expect(world.stderr.join("")).toContain("several sessions match");
  });

  it("tells a stopped or terminal-mode session to resume it first", async () => {
    const world = command(undefined, {
      post: async () => {
        throw new MendRequestError(
          "http",
          "This session has no live conversation; resume it first.",
          409,
          { call: "POST messages", tag: "ProtocolSessionNotLive" },
        );
      },
    });
    expect(await world.run(["s", "words"])).toBe(1);
    expect(world.stderr.join("")).toContain("resume it first");
  });
});

const PASSWORD = "FAKE_PASSWORD";
const refusedBy = (tag: string | null, status: number, words: string) => () =>
  Promise.reject(new MendRequestError("http", words, status, { call: "POST messages", tag }));
const errorOf = (world: ReturnType<typeof command>): { tag: string; message: string } =>
  JSON.parse(world.stdout.join("")).error;
const wordsCases = [
  "no",
  "it",
  "e",
  "first private line\nsecond private line\n",
  "https://",
  "@",
  `see https://fake:${PASSWORD}@example.invalid/repo`,
];

/** What `request` throws for a POST whose connection was refused: the fetch error rides as its cause. */
const refused = (message: string) =>
  new MendRequestError("unreachable", message, null, null, {
    cause: new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    }),
  });

describe("mend message diagnostics never carry the message words", () => {
  it.each(wordsCases)("prints a layer 3 refusal sentence whole for %j", async (input) => {
    const sentence = "This session has no live conversation; resume it first.";
    const plain = command(undefined, { post: refusedBy("ProtocolSessionNotLive", 409, sentence) });
    expect(await plain.run(["s", "--", input])).toBe(1);
    expect(plain.stderr.join("")).toBe(`${sentence} · client message ${messageKey}\n`);
    const json = command(undefined, { post: refusedBy("ProtocolSessionNotLive", 409, sentence) });
    expect(await json.run(["s", "--json", "--", input])).toBe(1);
    expect(errorOf(json)).toMatchObject({ tag: "ProtocolSessionNotLive", message: sentence });
  });

  it.each(wordsCases)(
    "prints fixed words for a refusal body that may quote the request: %j",
    async (input) => {
      for (const [tag, status] of [
        ["InvalidSessionMessage", 400],
        ["HttpApiDecodeError", 400],
        [null, 413],
        ["FutureRefusal", 409],
      ] as const) {
        const quoted = `bad body ${JSON.stringify({ input })} ${input}`;
        const control = command(undefined, { post: refusedBy(tag, status, "unrelated") });
        await control.run(["s", "--json", "--", "x"]);
        const world = command(undefined, { post: refusedBy(tag, status, quoted) });
        expect(await world.run(["s", "--json", "--", input])).toBe(1);
        expect(errorOf(world).message, `${tag} ${status}`).toBe(errorOf(control).message);
        expect(world.stdout.join("")).not.toContain("private line");
        expect(world.stdout.join("")).not.toContain(PASSWORD);
      }
    },
  );

  it.each(wordsCases)(
    "redacts credentials when the words overlap URL syntax: %j",
    async (input) => {
      const at = `https://fake:${PASSWORD}@example.invalid`;
      const failures = [
        refused(`cannot reach the Mend server at ${at} — is it running?`),
        new MendRequestError(
          "http",
          `refused at https:\x1b[0m//fake:${PASSWORD}@example.invalid`,
          403,
          {
            call: "POST messages",
            tag: "SessionNotSteerable",
          },
        ),
      ];
      for (const failure of failures) {
        const resolving = command(undefined, { resolveSession: () => Promise.reject(failure) });
        expect(await resolving.run(["s", "--json", "--", input])).toBe(1);
        expect(resolving.stdout.join("")).not.toContain(PASSWORD);
        expect(resolving.stdout.join("")).toContain("example.invalid");
        const posting = command(undefined, { post: () => Promise.reject(failure) });
        expect(await posting.run(["s", "--", input])).toBe(1);
        expect(posting.stderr.join("")).not.toContain(PASSWORD);
        expect(posting.stderr.join("")).toContain("example.invalid");
      }
    },
  );
});

describe("mend message outcomes", () => {
  it("exits 1 with the request's own sentence and no key when the server cannot be reached", async () => {
    const world = command(undefined, {
      post: () =>
        Promise.reject(
          refused(
            `cannot reach the Mend server at https://fake:${PASSWORD}@example.invalid — is it running?`,
          ),
        ),
    });
    expect(await world.run(["s", "words", "--json"])).toBe(1);
    expect(JSON.parse(world.stdout.join(""))).toMatchObject({
      version: 1,
      error: {
        tag: "MessageNotSent",
        clientMessageId: null,
        message: expect.stringContaining("cannot reach the Mend server at https://example.invalid"),
      },
    });
  });

  it.each([
    new MendRequestError(
      "timeout",
      "POST has had no answer — the server may still be working on it",
    ),
    new MendRequestError(
      "dropped",
      "the connection closed — the server may still be working on it",
    ),
  ])("prints the reason beside the key when the outcome is unknown: %j", async (failure) => {
    const world = command(undefined, { post: () => Promise.reject(failure) });
    expect(await world.run(["s", "words"])).toBe(2);
    expect(world.stderr.join("")).toContain("the server may still be working on it");
    expect(world.stderr.join("")).toContain(messageKey);
  });

  it("allocates no request key for a session that did not resolve", async () => {
    const world = command(undefined, {
      resolveSession: () => Promise.reject(new Error("no session or worktree matches")),
    });
    expect(await world.run(["s", "words", "--json"])).toBe(1);
    expect(world.keys()).toBe(0);
    expect(errorOf(world)).toMatchObject({ clientMessageId: null });
  });

  it("keeps the server's explanation and the receipt when this CLI cannot read it", async () => {
    const raw = { _tag: "Future", explanation: "sent · a future outcome" };
    const plain = command(raw);
    expect(await plain.run(["s", "words"])).toBe(2);
    expect(plain.stderr.join("")).toContain("sent · a future outcome");
    expect(plain.stderr.join("")).toContain(messageKey);
    const json = command(raw);
    expect(await json.run(["s", "words", "--json"])).toBe(2);
    expect(JSON.parse(json.stdout.join(""))).toMatchObject({
      version: 1,
      error: { tag: "MessageOutcomeUnconfirmed", clientMessageId: messageKey, receipt: raw },
    });
  });

  it("redacts URL credentials in a JSON receipt and sends the words unchanged", async () => {
    const input = `clone https://fake:${PASSWORD}@example.invalid/repo.git`;
    const receipt = turnReceipt();
    const world = command(
      encodeReceipt(
        receipt._tag === "Turn"
          ? { ...receipt, turn: new AgentTurn({ ...receipt.turn, input }) }
          : receipt,
      ),
    );
    expect(await world.run(["s", input, "--json"])).toBe(0);
    expect(world.calls[0]?.body).toMatchObject({ input });
    expect(world.stdout.join("")).not.toContain(PASSWORD);
    expect(JSON.parse(world.stdout.join(""))).toMatchObject({
      result: { turn: { input: "clone https://example.invalid/repo.git" } },
    });
  });
});
