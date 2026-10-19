import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
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

describe("OpenIntents' leftovers", () => {
  it("removes its temporary file when a write fails", async () => {
    const shared = await directory();
    // A directory where the intent's file goes makes the rename fail.
    await mkdir(join(shared, "w.json"));
    await writeFile(join(shared, "w.json", "keep"), "");
    await expect(
      new OpenIntents(shared).write({ workspaceId: "w", sessionId: "s" }),
    ).rejects.toThrow();
    expect((await readdir(shared)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("sweeps abandoned .tmp, .taken and untaken intents past the expiry on a take, and keeps newer ones", async () => {
    const shared = await directory();
    const stale = (Date.now() - OPEN_INTENT_TTL_MS - 60_000) / 1000;
    for (const name of ["a.json.1.tmp", "b.json.2.taken", "c.json"]) {
      await writeFile(join(shared, name), "{}");
      await utimes(join(shared, name), stale, stale);
    }
    await writeFile(join(shared, "d.json.3.tmp"), "{}");
    await new OpenIntents(shared).write({ workspaceId: "fresh", sessionId: "s" });
    expect(await new OpenIntents(shared).take("nobody")).toBeNull();
    expect((await readdir(shared)).toSorted()).toEqual(["d.json.3.tmp", "fresh.json"]);
  });
});
