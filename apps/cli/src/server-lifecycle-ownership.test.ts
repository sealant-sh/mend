import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SERVER_VOLUME_OWNER_LABEL } from "./server-docker-volumes.ts";
import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverProcessDeadlines } from "./server-runtime.ts";
import { serverCommand } from "./server-setup.ts";

const { cleanups, fixture } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// Each operation spawns real processes; full lifecycle sequences need more time on CI.
describe("server lifecycle", { timeout: 30_000 }, () => {
  it.each(["start", "restart", "stop", "status", "logs", "upgrade"])(
    "verifies ownership under lock before lifecycle Compose (%s)",
    async (command) => {
      const f = await fixture();
      expect(await f.setup()).toEqual({ _tag: "ok" });
      const file = path.join(f.root, "docker-protocol.json");
      const saved: { volumes: Array<[string, Record<string, string>]> } = JSON.parse(
        fs.readFileSync(file, "utf8"),
      );
      for (const [name, labels] of saved.volumes) {
        if (name === "mend-control") labels[SERVER_VOLUME_OWNER_LABEL] = "foreign-identity";
      }
      fs.writeFileSync(file, JSON.stringify(saved));
      const count = f.calls().length;
      const before = f.files();
      const result = await serverCommand(
        command === "upgrade"
          ? [command, "--version", "0.24.0", "--assets-dir", f.assets, "--offline"]
          : [command],
        f.runtime,
      );
      expect(result).toMatchObject({
        _tag: "error",
        message: expect.stringContaining("ownership"),
      });
      expect(
        f
          .calls()
          .slice(count)
          .every(
            (call) =>
              call.locked &&
              call.args[2] === "volume" &&
              ["ls", "inspect"].includes(call.args[3] ?? ""),
          ),
      ).toBe(true);
      expect(f.files()).toEqual(before);
      expect(f.state().appRunning).toBe(true);
      saved.volumes = saved.volumes.filter(([name]) => name !== "mend-control");
      fs.writeFileSync(file, JSON.stringify(saved));
      expect((await serverCommand([command], f.runtime))._tag).toBe("error");
      expect(
        f
          .calls()
          .slice(count)
          .some((call) => call.args[3] === "create" || call.directory !== null),
      ).toBe(false);
    },
  );

  it("status and logs allocate nothing; start and restart draw no randomness and forward deadlines", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const count = f.calls().length;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(await serverCommand(["logs"], f.runtime)).toEqual({ _tag: "ok" });
    expect(
      f
        .calls()
        .slice(count)
        .every(
          (call) =>
            call.locked &&
            (call.args[2] === "volume" ||
              ["ps", "logs"].includes(call.command[0] ?? "") ||
              // The mirrors are read, never changed: their volume's size and the registry's counters.
              (call.command[0] === "exec" &&
                (call.command.some((arg) => arg.startsWith("du -sk ")) ||
                  call.command.includes("wget"))) ||
              (call.args[2] === "container" && call.args[3] === "inspect")),
        ),
    ).toBe(true);
    for (const command of ["start", "restart"])
      expect(await serverCommand([command], f.runtime)).toEqual({ _tag: "ok" });
    // No registry probe any more: nothing is imported, pushed, pulled or removed on start.
    expect(
      f.runCalls.some((call) => ["import", "push", "pull", "rm"].includes(call.args[3] ?? "")),
    ).toBe(false);
    const starts = f.runCalls.filter((call) => call.args.includes("up"));
    expect(
      starts.every(
        (call) =>
          call.options?.timeoutMs === serverProcessDeadlines.startup &&
          call.args.includes("--wait-timeout"),
      ),
    ).toBe(true);
  });

  it("status and start refuse a health version different from the saved pin without rewriting it", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const old = f.active();
    f.update({ healthVersion: "0.99.0" });
    expect((await serverCommand(["status"], f.runtime))._tag).toBe("error");
    expect((await serverCommand(["start"], f.runtime))._tag).toBe("error");
    expect(f.active()).toBe(old);
  });
});
