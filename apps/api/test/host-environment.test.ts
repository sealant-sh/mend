import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanHostEnvironment } from "../src/services/host-environment.ts";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })),
  );
});

describe("scanHostEnvironment", () => {
  it("suggests known tools and config paths while omitting private names and contents", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mend-host-scan-"));
    cleanups.push(home);
    const bin = path.join(home, ".local", "bin");
    await fs.mkdir(path.join(home, ".config", "gh"), { recursive: true });
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "lazygit"), "#!/bin/sh\n", { mode: 0o755 });
    await fs.writeFile(path.join(bin, "docker"), "#!/bin/sh\n", { mode: 0o755 });
    await fs.writeFile(path.join(bin, "private-company-tool"), "secret", { mode: 0o755 });
    await fs.writeFile(path.join(home, ".config", "gh", "config.yml"), "oauth_token: secret");
    await fs.writeFile(path.join(home, "private-notes.txt"), "secret");

    const result = await scanHostEnvironment({ homeDirectory: home, pathDirectories: [] });

    expect(result.tools).toEqual([
      { executable: "docker", kind: "service", id: "docker" },
      { executable: "lazygit", kind: "package", id: "lazygit" },
    ]);
    expect(result.configs).toEqual([{ label: "GitHub CLI", path: "~/.config/gh/config.yml" }]);
    expect(JSON.stringify(result)).not.toContain("private-company-tool");
    expect(JSON.stringify(result)).not.toContain("private-notes");
    expect(JSON.stringify(result)).not.toContain("oauth_token");
    expect(JSON.stringify(result)).not.toContain(home);
  });
});
