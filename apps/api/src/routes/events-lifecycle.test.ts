import { afterEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

/**
 * The event stream's lifecycle through the real `/api/events` route (docs/adr/0004, "Event stream
 * lifecycle"; the closing note of the public exposure findings).
 *
 * Every stream used to call `sql.listen` itself, and the shared connection's per-stream UNLISTEN
 * meant one closing browser silenced the rest. Streams now subscribe to one application-owned
 * fan-out. These tests hold that in place from the outside: whatever streams open, close, are
 * revoked or are refused, the one listen stream behind the bus is started once and never ended,
 * and nothing a stream held outlives it.
 */
let api: TenancyApi | null = null;
afterEach(async () => {
  await api?.dispose();
  api = null;
});

const sharedA = ids("shared-a");
const sessionEvent = {
  type: "session",
  sessionId: sharedA.session,
  projectId: sharedA.project,
} as const;
/**
 * A frame that is coming: waited for generously, since it returns the moment the frame arrives and
 * only a machine under load ever gets near the deadline.
 */
const arrives = (stream: { readonly next: (timeoutMs?: number) => Promise<string | null> }) =>
  stream.next(5_000);

/** How long a test that expects silence listens for. */
const SILENCE_MS = 150;

/** Wait until the server has seen what the client did, up to a deadline: no fixed sleeps. */
const eventually = async (what: string, holds: () => Promise<boolean>) => {
  const deadline = Date.now() + 5_000;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error(`never observed: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const openStreams = (on: TenancyApi, user: "alice" | "bob" | "carol") =>
  on.openConnections(user, "event-stream");

describe("the event stream lifecycle", () => {
  it("one stream torn down with an event undelivered leaves the others receiving, and the listen untouched", async () => {
    const world = await createTenancyApi();
    api = world;
    const carol = await api.events("carol");
    const alice = await api.events("alice");
    const second = await api.events("carol");
    expect(api.listen).toEqual({ starts: 1, ends: 0 });

    await api.notify(sessionEvent);
    expect(await arrives(carol)).toContain(sharedA.session);
    // Torn down with an event published and not read by it. Whether the server was part-way
    // through writing that frame cannot be told from outside the process.
    await api.notify(sessionEvent);
    await carol.close();
    await eventually(
      "carol's first stream released",
      async () => (await openStreams(world, "carol")) === 1,
    );

    expect(await arrives(alice)).toContain(sharedA.session);
    expect(await arrives(alice)).toContain(sharedA.session);
    expect(await arrives(second)).toContain(sharedA.session);
    // Events published after the teardown still arrive.
    await api.notify(sessionEvent);
    expect(await arrives(alice)).toContain(sharedA.session);
    expect(await arrives(second)).toContain(sharedA.session);

    expect(api.listen).toEqual({ starts: 1, ends: 0 });
    expect(await api.openConnections("carol", "event-stream")).toBe(1);
    await alice.close();
    await second.close();
  });

  it("many streams opening and closing never restart or end the listen", async () => {
    const world = await createTenancyApi();
    api = world;
    for (let round = 0; round < 5; round += 1) {
      const streams = await Promise.all([
        api.events("carol"),
        api.events("alice"),
        api.events("bob"),
      ]);
      await api.notify(sessionEvent);
      await Promise.all(streams.map((stream) => stream.close()));
    }
    for (const user of ["carol", "alice", "bob"] as const) {
      await eventually(
        `${user}'s streams released`,
        async () => (await openStreams(world, user)) === 0,
      );
    }
    expect(api.listen).toEqual({ starts: 1, ends: 0 });
  });

  it("a stream closed the way removal closes it releases what it held, and other accounts' streams go on", async () => {
    // `closeConnectionsOf` is the registry call member removal makes (`connections.closeForUser`).
    // Removal itself, with its revocations, is member-removal.test.ts's.
    const world = await createTenancyApi();
    api = world;
    const carol = await api.events("carol");
    const alice = await api.events("alice");
    expect(await api.openConnections("carol", "event-stream")).toBe(1);

    expect(await api.closeConnectionsOf("carol")).toBe(1);
    await eventually(
      "carol's stream released",
      async () => (await openStreams(world, "carol")) === 0,
    );
    // The revoked stream ends: nothing more arrives on it.
    await api.notify(sessionEvent);
    expect(await carol.next(SILENCE_MS)).toBeNull();

    expect(await arrives(alice)).toContain(sharedA.session);
    expect(api.listen).toEqual({ starts: 1, ends: 0 });
    await carol.close();
    await alice.close();
  });

  it("a stream refused over the account's budget holds nothing and disturbs nothing", async () => {
    api = await createTenancyApi({ accountEventStreams: 1 });
    const open = await api.events("carol");
    const refused = await api.events("carol");
    expect(refused.status).toBe(429);
    expect(await api.openConnections("carol", "event-stream")).toBe(1);

    await api.notify(sessionEvent);
    expect(await arrives(open)).toContain(sharedA.session);
    expect(await refused.next(SILENCE_MS)).toBeNull();
    expect(api.listen).toEqual({ starts: 1, ends: 0 });
    await refused.close();
    await open.close();
  });

  it("an unauthenticated request subscribes to nothing", async () => {
    api = await createTenancyApi();
    const carol = await api.events("carol");
    const anonymous = await api.events(null);
    expect(anonymous.status).toBe(401);
    await api.notify(sessionEvent);
    expect(await arrives(carol)).toContain(sharedA.session);
    expect(api.listen).toEqual({ starts: 1, ends: 0 });
    await carol.close();
  });
});
