import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { OPEN_INTENT_TTL_MS, OpenIntents } from "./open-intent.js";

const directory = () => mkdtemp(join(tmpdir(), "mend-intents-"));

describe("OpenIntents", () => {
  it("takes an Open's session once, for its own workspace, and not once it is stale", async () => {
    let clock = 0;
    const intents = new OpenIntents(await directory(), () => clock);
    await intents.write({ workspaceId: "w1", sessionId: "older" });
    expect(await intents.take("another-workspace")).toBeNull();
    expect(await intents.take("w1")).toBe("older");
    expect(await intents.take("w1")).toBeNull();
    await intents.write({ workspaceId: "w1", sessionId: "older" });
    clock = OPEN_INTENT_TTL_MS;
    expect(await intents.take("w1")).toBeNull();
  });

  it("keeps every window's intent when windows write for different workspaces at once", async () => {
    const shared = await directory();
    const windows = Array.from({ length: 8 }, () => new OpenIntents(shared));
    await Promise.all(
      windows.map((window, index) =>
        window.write({ workspaceId: `w${index}`, sessionId: `s${index}` }),
      ),
    );
    const destination = new OpenIntents(shared);
    expect(await Promise.all(windows.map((_, index) => destination.take(`w${index}`)))).toEqual(
      windows.map((_, index) => `s${index}`),
    );
  });

  it("never brings back an intent a window took, whatever another window writes after", async () => {
    const shared = await directory();
    const first = new OpenIntents(shared);
    const second = new OpenIntents(shared);
    const destination = new OpenIntents(shared);
    await first.write({ workspaceId: "w1", sessionId: "a" });
    expect(await destination.take("w1")).toBe("a");
    await second.write({ workspaceId: "w2", sessionId: "b" });
    await first.write({ workspaceId: "w3", sessionId: "c" });
    const reloaded = new OpenIntents(shared);
    expect(await reloaded.take("w1")).toBeNull();
    expect(await reloaded.take("w2")).toBe("b");
  });

  it("loses no newer intent to a take racing its write: one take or the next returns it", async () => {
    const shared = await directory();
    const opener = new OpenIntents(shared);
    const destination = new OpenIntents(shared);
    for (let round = 0; round < 50; round += 1) {
      await opener.write({ workspaceId: "w", sessionId: "old" });
      const [taken] = await Promise.all([
        destination.take("w"),
        opener.write({ workspaceId: "w", sessionId: "new" }),
      ]);
      const next = await destination.take("w");
      expect([taken, next]).toContainEqual("new");
      expect(await destination.take("w")).toBeNull();
    }
    expect(await readdir(shared)).toEqual([]);
  });
});
