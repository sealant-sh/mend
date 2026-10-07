import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { preparePilotHome } from "./pilot-home.mjs";

test("pilot gets only its login in a private disposable native home", async () => {
  const home = await mkdtemp(join(tmpdir(), "desktop-home-test-"));
  try {
    for (const [harness, folder, filename, key] of [
      ["codex", ".codex", "auth.json", "CODEX_HOME"],
      ["claude", ".claude", ".credentials.json", "CLAUDE_CONFIG_DIR"],
    ]) {
      await mkdir(join(home, folder));
      await writeFile(join(home, folder, filename), "test login");
      await writeFile(join(home, folder, "settings.json"), "parent settings");
      const pilot = await preparePilotHome(harness, { HOME: home });
      const target = pilot.env[key];
      assert.equal(await readFile(join(target, filename), "utf8"), "test login");
      assert.equal((await stat(join(target, filename))).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(target))).mode & 0o777, 0o700);
      await assert.rejects(stat(join(target, "settings.json")), { code: "ENOENT" });
      await pilot.close();
      await assert.rejects(stat(target), { code: "ENOENT" });
      assert.equal(await readFile(join(home, folder, filename), "utf8"), "test login");
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
