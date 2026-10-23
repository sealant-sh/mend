import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MendClient } from "../client.js";
import { ConnectionStore } from "../config.js";
import { secretWriteOf } from "../credentials.js";
import { EventEmitter } from "../test-vscode.js";
import { MendTtyTerminal } from "../tty-terminal.js";
import type { SessionProcess } from "../types.js";
import { pasteIntoAgent } from "./agent-paste.js";
import { boundConnection } from "./binding.js";
import { ReviewClient } from "./review-client.js";
import { ReviewMemory } from "./review-memory.js";
import { ReviewStore } from "./review-store.js";
import {
  comment,
  FakeMend,
  keptIn,
  PINNED,
  PROJECT,
  SETTLE,
  sendComposed,
  session,
  storage,
} from "./test-fixtures.js";

const setting = vi.hoisted(() => ({
  url: "http://mend",
  changed: new Set<(event: { affectsConfiguration(section: string): boolean }) => void>(),
}));

const typed = vi.hoisted((): Array<string> => []);

vi.mock("vscode", async () => {
  const vscode = await import("../test-vscode.js");
  return {
    ...vscode,
    workspace: {
      ...vscode.workspace,
      getConfiguration: () => ({ get: () => setting.url }),
      onDidChangeConfiguration: (
        listener: (event: { affectsConfiguration(section: string): boolean }) => void,
      ) => {
        setting.changed.add(listener);
        return { dispose: () => setting.changed.delete(listener) };
      },
    },
  };
});

vi.mock("../tty-attachment.js", () => ({
  TtyAttachment: class {
    isOpen(): boolean {
      return true;
    }
    isClosed(): boolean {
      return false;
    }
    input(bytes: string): void {
      typed.push(bytes);
    }
    start(): void {}
    close(): void {}
    resize(): void {}
  },
}));

const MEND = "http://mend";
const OTHER = "http://other";

const CLAUDE: SessionProcess = {
  id: "agent-1",
  kind: "agent-pty",
  harness: "claude",
  status: "running",
  exitedAt: null,
  providerSessionId: null,
  label: "claude",
  waiting: null,
  runsAs: null,
};

const connectElsewhere = (): void => {
  setting.url = OTHER;
  for (const listener of setting.changed)
    listener({ affectsConfiguration: (section) => "mend.serverUrl".startsWith(section) });
};

const secretStorage = () => {
  const kept = new Map<string, string>();
  const changed = new EventEmitter<{ readonly key: string }>();
  const signedIn = secretWriteOf(
    { kind: "signedIn", url: MEND, token: "dana-token", deviceId: null, email: "dana@mend" },
    "write-1",
  );
  kept.set(signedIn.key, signedIn.value);
  let held: { readonly entered: () => void; readonly released: Promise<void> } | null = null;
  return {
    get: async (key: string): Promise<string | undefined> => {
      const value = kept.get(key);
      const hold = held;
      held = null;
      if (hold !== null) {
        hold.entered();
        await hold.released;
      }
      return value;
    },
    store: async (key: string, value: string): Promise<void> => {
      kept.set(key, value);
      changed.fire({ key });
    },
    onDidChange: changed.event,
    holdNext(): { readonly out: Promise<void>; readonly release: () => void } {
      const out = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      held = { entered: out.resolve, released: released.promise };
      return { out: out.promise, release: released.resolve };
    },
  };
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let asked: Array<string> = [];

const mendServers = vi.fn<typeof fetch>(async (input, init) => {
  const url = String(input);
  asked.push(`${init?.method ?? "GET"} ${url}`);
  const token = new Headers(init?.headers).get("authorization");
  if (!url.startsWith(`${MEND}/api/`) || token !== "Bearer dana-token")
    return json(401, { message: "Signed out — sign in again." });
  const path = url.slice(`${MEND}/api`.length);
  if (path === "/organization") return json(200, { userId: "dana" });
  if (path === "/organization/members") return json(200, [{ userId: "dana", name: "Dana" }]);
  if (path === "/sessions/s1")
    return json(200, {
      session: { ...session("s1"), ownerUserId: "dana" },
      processes: [CLAUDE],
      currentAgent: CLAUDE,
      change: { id: "change-1" },
    });
  if (path.startsWith("/projects/")) return json(200, { project: PROJECT, sessions: [] });
  if (path === "/sessions/s1/follow-up/deliver")
    return json(200, { idempotencyKey: "key-1", status: "pending", deliveryError: null });
  if (path.startsWith("/changes/change-1/"))
    return json(200, comment({ id: "c1", state: "dismissed" }));
  return json(404, { message: `no route ${path}` });
});

let home = "";
const xdg = process.env["XDG_CONFIG_HOME"];

const withoutCliSignIn = async (): Promise<void> => {
  home = await mkdtemp(join(tmpdir(), "mend-send-connection-"));
  await mkdir(join(home, "mend"));
  process.env["XDG_CONFIG_HOME"] = home;
};

beforeEach(async () => {
  await withoutCliSignIn();
  setting.url = MEND;
  typed.length = 0;
  asked = [];
  vi.stubGlobal("fetch", mendServers);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (xdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = xdg;
  await rm(home, { recursive: true, force: true });
});

const memento = () => {
  const saved = new Map<string, unknown>();
  return {
    get: (key: string) => saved.get(key),
    update: async (key: string, value: unknown) => {
      saved.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
};

const sendToClaude = async (meanwhile: (connections: ConnectionStore) => Promise<void>) => {
  const secrets = secretStorage();
  const connections = new ConnectionStore({ secrets });
  const client = new MendClient(connections);
  const terminal = new MendTtyTerminal({
    connection: () => client.connection(),
    address: { process: "agent-1" },
    banner: "",
    liveness: async () => "live",
  });
  const mend = new FakeMend();
  mend.answer = "pending";
  mend.serverComments = [comment({ id: "c1" })];
  const directory = await storage();
  const store = new ReviewStore(
    client,
    mend,
    new ReviewMemory(memento()),
    keptIn(directory),
    (sessionId, processId, text, reads, bound) =>
      pasteIntoAgent<string>(
        {
          detail: (id) => reads.sessionDetail(id),
          bound,
          answer: async () => undefined,
          activeTab: () => "claude's tab",
          processOf: () => "agent-1",
          paste: (_tab, pasted, ready, current) =>
            terminal.paste(
              pasted,
              async () => {
                const answered = await ready();
                await meanwhile(connections);
                return answered;
              },
              current,
            ),
          sleep: async () => undefined,
        },
        sessionId,
        processId,
        text,
      ),
  );
  store.follow(PROJECT, session("s1"));
  await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
  const composed = store.compose();
  if (composed === null) throw new Error("nothing composed");
  expect(await sendComposed(store, composed, composed.text)).toEqual({ sent: true });
  const phases = async () =>
    (await keptIn(directory).read({ url: MEND, viewer: "dana", sessionId: "s1" })).review.sends.map(
      ({ phase }) => phase,
    );
  return { store, phases };
};

describe("Dana changes mend.serverUrl while the paste asks Mend whether claude still runs", () => {
  it("types nothing into the old server's claude, and the review reads stopped because VS Code connected elsewhere", async () => {
    const { store, phases } = await sendToClaude(async () => connectElsewhere());
    await vi.waitFor(
      async () =>
        expect(await phases()).toEqual([
          expect.objectContaining({
            kind: "in-terminal",
            paste: { kind: "failed", mayHaveLanded: false, stopped: { kind: "switched" } },
          }),
        ]),
      SETTLE,
    );
    expect(typed).toEqual([]);
    store.dispose();
  }, 15_000);
});

describe("Dana signs out while the paste asks Mend whether claude still runs", () => {
  it("types nothing into claude's terminal, and the review reads stopped because VS Code signed out", async () => {
    const { store, phases } = await sendToClaude(async (connections) => {
      await connections.signOut(MEND);
    });
    await vi.waitFor(
      async () =>
        expect(await phases()).toEqual([
          expect.objectContaining({
            kind: "in-terminal",
            paste: { kind: "failed", mayHaveLanded: false, stopped: { kind: "signed-out" } },
          }),
        ]),
      SETTLE,
    );
    expect(typed).toEqual([]);
    store.dispose();
  }, 15_000);
});

describe("Dana changes mend.serverUrl while a send's write reads her sign-in", () => {
  const WRITES = [
    {
      write: "the follow-up",
      send: (client: ReviewClient) =>
        client.deliver("s1", {
          reviewSliceId: PINNED.id,
          checkpointAId: PINNED.base.id,
          checkpointBId: PINNED.head.id,
          diffDigest: "digest",
          commentIds: ["c1"],
          instruction: "Address each comment.",
          idempotencyKey: "key-1",
        }),
    },
    {
      write: "a comment",
      send: (client: ReviewClient) =>
        client.postComment(
          "change-1",
          PINNED.id,
          {
            oldPath: null,
            newPath: "src/auth/limit.ts",
            side: "new",
            startLine: 12,
            endLine: 12,
            hunkContextHash: null,
          },
          "Use the shared limiter",
        ),
    },
    {
      write: "a draft's dismissal",
      send: (client: ReviewClient) => client.setCommentState("change-1", "c1", "dismissed"),
    },
  ];

  it.each(WRITES)(
    "sends $write to neither server, and refuses it because VS Code connected elsewhere",
    async ({ send }) => {
      const secrets = secretStorage();
      const connections = new ConnectionStore({ secrets });
      const sessions = new MendClient(connections);
      const client = new ReviewClient(
        async () => {
          throw new Error("every write here is bound to the send");
        },
        () => undefined,
      ).pinned(() => boundConnection(sessions, { url: MEND, viewer: "dana" }));
      const hold = secrets.holdNext();
      const writing = send(client);
      await hold.out;
      connectElsewhere();
      hold.release();
      await expect(writing).rejects.toMatchObject({ why: "switched" });
      expect(asked.filter((request) => request.startsWith("POST"))).toEqual([]);
    },
  );
});
