import { SessionId, SessionProcessId } from "@mend/domain";
import { AgentTurn, Session, SessionProcess } from "@mend/domain/workbench";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids, makeSession } from "../../test/support/tenancy-harness.ts";

/** Shared control (docs/adr/0003, "Sessions and shared control") over the two-organization world. */
describe("shared control", () => {
  let api: TenancyApi;
  const sharedA = ids("shared-a");
  const toggle = `/api/sessions/${sharedA.session}/shared-control`;
  const turns = `/api/sessions/${sharedA.session}/turns`;
  const followUp = {
    reviewSliceId: "slice-1",
    checkpointAId: "checkpoint-a",
    checkpointBId: "checkpoint-b",
    diffDigest: "0".repeat(64),
    commentIds: [],
    instruction: "Address the comments.",
    idempotencyKey: "follow-up-1",
  };

  beforeAll(async () => {
    api = await createTenancyApi();
  });
  afterAll(async () => {
    await api.dispose();
  });
  beforeEach(() => {
    api.world.calls.splice(0, api.world.calls.length);
  });

  it("only the owner turns it on; a teammate is refused before anything moves", async () => {
    const carol = await api.request("carol", "PUT", toggle, { enabled: true });
    const bob = await api.request("bob", "PUT", toggle, { enabled: true });
    expect({ carol: carol.status, bob: bob.status, calls: api.world.calls }).toEqual({
      carol: 403,
      bob: 404,
      calls: [],
    });
  });

  it("once the owner shares, a teammate steers; once it is off again, they are refused", async () => {
    const refusedBefore = await api.request("carol", "POST", turns, { input: "Continue" });
    expect(refusedBefore.status).toBe(403);

    const on = await api.request("alice", "PUT", toggle, { enabled: true });
    expect(on.status).toBe(200);
    expect(api.world.calls).toEqual([
      "sessions.setSharedControl",
      "controlEvents.record",
      "audit.record",
    ]);

    api.world.calls.splice(0, api.world.calls.length);
    const steered = await api.request("carol", "POST", turns, { input: "Continue" });
    expect(steered.status).not.toBe(403);
    expect(api.world.calls.length).toBeGreaterThan(0);

    // Shared control lends steering, not the session: deleting, renaming and handing off stay
    // the owner's. So does anything that runs on the workspace's login outside a turn: a shell,
    // a command, a terminal launch (docs/adr/0013).
    api.world.calls.splice(0, api.world.calls.length);
    const session = `/api/sessions/${sharedA.session}`;
    const ownerOnly = [
      await api.request("carol", "DELETE", session),
      await api.request("carol", "POST", `${session}/label`, { label: "mine now" }),
      await api.request("carol", "POST", `${session}/handoff`, { to: "pty" }),
      await api.request("carol", "POST", `${session}/shell`),
      await api.request("carol", "POST", `${session}/services/run`, {
        argv: ["sh", "-c", "claude -p 'refactor X'"],
        port: 3000,
        name: null,
      }),
      await api.request("carol", "POST", `${session}/services/recipe`, { name: "web" }),
      await api.request("carol", "POST", `${session}/launch`, { argv: ["codex", "exec", "go"] }),
      await api.request("carol", "POST", `${session}/launch`, { mode: "pty", prompt: "go" }),
    ];
    expect({
      statuses: ownerOnly.map((response) => response.status),
      calls: api.world.calls,
    }).toEqual({ statuses: [403, 403, 403, 403, 403, 403, 403, 403], calls: [] });
    const refusal: unknown = await (await api.request("carol", "POST", `${session}/shell`)).json();
    expect(refusal).toMatchObject({
      message: "only the session owner can do this, even while control is shared",
    });
    const commandRefusal: unknown = await (
      await api.request("carol", "POST", `${session}/services/recipe`, { name: "web" })
    ).json();
    expect(commandRefusal).toMatchObject({
      message:
        "only the session owner runs commands in its workspace, even while control is shared",
    });

    // The session is a conversation: a steerer's image, resume and follow-up go past
    // authorization. Storing an image types nothing; the terminal route drops a paste.
    api.world.calls.splice(0, api.world.calls.length);
    const conversation = [
      await api.request("carol", "POST", `${session}/images`, { contentsBase64: "iVBORw0KGgo=" }),
      await api.request("carol", "POST", `${session}/resume`, { harness: null }),
      await api.request("carol", "POST", `${session}/follow-up/deliver`, followUp),
    ];
    expect(conversation.map((response) => response.status)).not.toContain(403);
    expect(api.world.calls).toEqual([
      "engine.storePastedImage",
      "engine.resumeSession",
      "followUpDelivery.deliver",
    ]);

    // A steerer still attaches the owner's shell to read it; the route drops their keys (tty.test.ts).
    api.world.calls.splice(0, api.world.calls.length);
    await api.rawRequest("carol", `/api/tty?process=${sharedA.process}`);
    expect(api.world.calls).toContain("sealant.getWorkspace");

    // The owner still opens one: past authorization to the engine.
    api.world.calls.splice(0, api.world.calls.length);
    await api.request("alice", "POST", `${session}/shell`);
    expect(api.world.calls).toContain("engine.openShell");

    const off = await api.request("alice", "PUT", toggle, { enabled: false });
    expect(off.status).toBe(200);
    api.world.calls.splice(0, api.world.calls.length);
    const refusedAfter = await api.request("carol", "POST", turns, { input: "Continue" });
    expect({ status: refusedAfter.status, calls: api.world.calls }).toEqual({
      status: 403,
      calls: [],
    });
  });

  it("in a terminal session, a steerer's words never start the terminal", async () => {
    // Alice's settled Claude terminal session, shared: a follow-up, resume or launch would
    // start the TUI with Carol's words on Alice's login (docs/adr/0013).
    const terminal = SessionId.make("session-shared-a-terminal");
    const shell = api.world.processes.get(sharedA.process);
    if (shell === undefined) throw new Error("the harness has no shell process");
    const world = await createTenancyApi(
      {},
      {
        sessions: [
          new Session({
            ...makeSession(terminal, sharedA.project, sharedA.worktree, "alice"),
            harness: "claude",
            sharedControlEnabledByUserId: "alice",
            sharedControlEnabledAt: new Date(),
          }),
        ],
        processes: [
          new SessionProcess({
            ...shell,
            id: SessionProcessId.make("process-shared-a-terminal"),
            sessionId: terminal,
            kind: "agent-pty",
            harness: "claude",
            label: "claude",
            argv: ["claude"],
          }),
        ],
      },
    );
    try {
      const session = `/api/sessions/${terminal}`;
      const refused = [
        await world.request("carol", "POST", `${session}/follow-up/deliver`, followUp),
        await world.request("carol", "POST", `${session}/resume`, { harness: null }),
        await world.request("carol", "POST", `${session}/launch`, { prompt: "refactor X" }),
      ];
      expect({
        statuses: refused.map((response) => response.status),
        calls: world.world.calls,
      }).toEqual({ statuses: [403, 403, 403], calls: [] });
      expect(await refused[0]?.json()).toMatchObject({
        message:
          "only the session owner starts its agent in a terminal, even while control is shared; the owner can continue it as a conversation",
      });

      // She still steers it as a conversation, and the owner still sends it back.
      await world.request("carol", "POST", `${session}/launch`, { mode: "protocol", prompt: "go" });
      expect(world.world.calls).not.toEqual([]);
      world.world.calls.splice(0, world.world.calls.length);
      await world.request("alice", "POST", `${session}/follow-up/deliver`, followUp);
      expect(world.world.calls).toEqual(["followUpDelivery.deliver"]);
    } finally {
      await world.dispose();
    }
  });

  it("a steerer attaches an image to a conversation's turn", async () => {
    // Alice's session is a conversation: the phone's composer stores Carol's screenshot here,
    // then names its path in her turn. Storing it types nothing (docs/adr/0013).
    const world = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            storePastedImage: () =>
              Effect.succeed({
                path: "/tmp/mend-paste/shot.png",
                mediaType: "image/png",
                bytes: 8,
              }),
          },
        },
      },
    );
    try {
      const shared = await world.request("alice", "PUT", toggle, { enabled: true });
      expect(shared.status).toBe(200);
      const uploaded = await world.request(
        "carol",
        "POST",
        `/api/sessions/${sharedA.session}/images`,
        {
          contentsBase64: "iVBORw0KGgo=",
        },
      );
      expect({ status: uploaded.status, body: await uploaded.json() }).toEqual({
        status: 200,
        body: { path: "/tmp/mend-paste/shot.png", mediaType: "image/png", bytes: 8 },
      });
    } finally {
      await world.dispose();
    }
  });

  it("opencode is one person's: shared control is refused for it, and nothing moves", async () => {
    const opencode = SessionId.make("session-shared-a-opencode");
    const world = await createTenancyApi(
      {},
      {
        sessions: [
          new Session({
            ...makeSession(opencode, sharedA.project, sharedA.worktree, "alice"),
            harness: "opencode",
          }),
        ],
      },
    );
    try {
      const refused = await world.request(
        "alice",
        "PUT",
        `/api/sessions/${opencode}/shared-control`,
        {
          enabled: true,
        },
      );
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        message:
          "opencode sessions are one person's. Shared control is not available for them; start your own session in this worktree.",
      });
      expect(world.world.calls).toEqual([]);
    } finally {
      await world.dispose();
    }
  });

  it("an opencode session whose shared control was on before this release takes its owner's turns only, with the flag off (review of mend#572, P3-4)", async () => {
    const opencode = SessionId.make("session-shared-a-opencode");
    const world = await createTenancyApi(
      {},
      {
        sessions: [
          new Session({
            ...makeSession(opencode, sharedA.project, sharedA.worktree, "alice"),
            harness: "opencode",
            sharedControlEnabledAt: new Date(),
            sharedControlEverAt: new Date(),
          }),
        ],
      },
    );
    try {
      const refused = await world.request("carol", "POST", `/api/sessions/${opencode}/turns`, {
        input: "Continue",
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        message:
          "opencode sessions are one person's. Shared control is not available for them; start your own session in this worktree.",
      });
      expect(world.world.calls.filter((call) => call.startsWith("engine."))).toEqual([]);
      // The owner's own turn is sent as ever.
      world.world.calls.splice(0, world.world.calls.length);
      const owners = await world.request("alice", "POST", `/api/sessions/${opencode}/turns`, {
        input: "Continue",
      });
      expect(owners.status).not.toBe(403);
      expect(world.world.calls).toContain("engine.submitTurn");
    } finally {
      await world.dispose();
    }
  });

  it("turning it off cancels the turns other people queued (docs/adr/0016, decision 6)", async () => {
    const world = await createTenancyApi();
    try {
      await world.request("alice", "PUT", toggle, { enabled: true });
      world.world.calls.splice(0, world.world.calls.length);
      const off = await world.request("alice", "PUT", toggle, { enabled: false });
      expect(off.status).toBe(200);
      expect(world.world.calls).toContain("engine.cancelSteeredTurns");
    } finally {
      await world.dispose();
    }
  });

  it("a waiting turn is withdrawn by its sender or the owner, and nobody else", async () => {
    const world = await createTenancyApi();
    try {
      await world.request("alice", "PUT", toggle, { enabled: true });
      // Dave's turn waits on alice's session; Carol steers too, but it is not hers to withdraw.
      const running = world.world.turns.get(sharedA.turn);
      if (running === undefined) throw new Error("no fixture turn");
      world.world.turns.set(
        sharedA.turn,
        new AgentTurn({ ...running, author: "dave", status: "queued", providerTurnId: null }),
      );
      const interrupt = `/api/turns/${sharedA.turn}/interrupt`;
      world.world.calls.splice(0, world.world.calls.length);
      const carols = await world.request("carol", "POST", interrupt);
      expect(carols.status).toBe(403);
      expect(world.world.calls.filter((call) => call.startsWith("engine."))).toEqual([]);
      // The owner withdraws it.
      const alices = await world.request("alice", "POST", interrupt);
      expect(alices.status).not.toBe(403);
      expect(world.world.calls).toContain("engine.interruptTurn");
    } finally {
      await world.dispose();
    }
  });
});
