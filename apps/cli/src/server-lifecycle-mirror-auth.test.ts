import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand, type ServerSetupRuntime } from "./server-setup.ts";

const { cleanups, fixture } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("the mirrors", { timeout: 120_000 }, () => {
  it("keeps a Docker Hub token in server.env alone, read from standard input, across reruns and upgrades", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const token = "dckr_pat_s3cret-Token";
    const withStdin: ServerSetupRuntime = { ...f.runtime, readStdin: async () => `${token}\n` };
    expect(
      await serverCommand(
        [
          "setup",
          "--offline",
          "--docker-hub-username",
          "mendbot",
          "--docker-hub-token-stdin",
          "--docker-hub-public-only",
        ],
        withStdin,
      ),
    ).toEqual({ _tag: "ok" });
    const files = f.files();
    expect(files["server.env"]).toContain(`MEND_DOCKER_HUB_TOKEN=${token}\n`);
    expect(files["server.env"]).toContain("MEND_DOCKER_HUB_USERNAME=mendbot\n");
    for (const name of ["server.json", "compose.mirrors.yaml", "identity.env"])
      expect(files[name]).not.toContain(token);
    expect(JSON.parse(files["server.json"] ?? "{}").mirrors.docker).toEqual({
      maxSize: "20g",
      upstreamUser: "mendbot",
      upstreamPublicOnly: true,
    });
    // Never on a command line.
    expect(f.calls().some((call) => call.args.some((arg) => arg.includes(token)))).toBe(false);
    // Carried by a rerun and an upgrade, which read it back from server.env.
    expect(await serverCommand(["setup", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).toContain(`MEND_DOCKER_HUB_TOKEN=${token}\n`);
    // And gone again.
    expect(await serverCommand(["setup", "--offline", "--no-docker-hub-login"], f.runtime)).toEqual(
      { _tag: "ok" },
    );
    expect(f.files()["server.env"]).not.toContain("MEND_DOCKER_HUB");
    expect(f.files()["compose.mirrors.yaml"]).not.toContain("REGISTRY_PROXY_USERNAME");
  });

  it("caps the Docker mirror, says when its guard paused it, and never renders an undeclared login", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(["setup", "--offline", "--docker-mirror-max-size", "40G"], f.runtime),
    ).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).toContain("MEND_DOCKER_MIRROR_MAX_SIZE=40g\n");
    expect(f.files()["docker-mirror-guard.sh"]).toContain("registry serve");
    f.update({ mirrorGuard: "paused 3072 5120 none", mirrorFreeKiB: 3 * 1024 * 1024 });
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      "docker mirror · paused by its disk guard · 3.0 GiB free on its disk, below 5.0 GiB · no cache held · session Docker daemons pull from Docker Hub directly until there is room · observed",
    );
    // A saved login without the operator's public-only statement is refused, not rendered.
    const configFile = path.join(f.active(), "server.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    config.mirrors.docker = { maxSize: "40g", upstreamUser: "mendbot" };
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    const refused = await serverCommand(["status"], f.runtime);
    expect(refused._tag).toBe("error");
    expect(refused._tag === "error" ? refused.message : "").toContain(
      "the Docker mirror's login lacks upstreamPublicOnly",
    );
  });

  it.each([
    [
      ["--npm-mirror", "--no-npm-mirror"],
      "--npm-mirror and --no-npm-mirror contradict each other.",
    ],
    [["--npm-mirror-max-size", "512m"], "--npm-mirror-max-size must be"],
    [["--no-npm-mirror", "--npm-mirror-max-size", "20g"], "contradict each other"],
    [["--docker-hub-username", "mendbot"], "go together"],
    [
      ["--docker-hub-username", "mendbot", "--docker-hub-token-stdin"],
      'needs --docker-hub-public-only. The Docker mirror has no login of its own: every session that reaches it can pull whatever the token can read, private repositories included. Create a Docker Hub personal access token with the access permission "Public Repo Read-only"',
    ],
    [["--docker-hub-public-only"], "goes with --docker-hub-username"],
    [["--docker-hub-token-stdin"], "go together"],
    [
      [
        "--docker-hub-username",
        "mendbot",
        "--docker-hub-token-stdin",
        "--docker-hub-public-only",
        "--no-docker-mirror",
      ],
      "--docker-hub-username and --no-docker-mirror contradict each other.",
    ],
    [
      ["--docker-hub-username", "a b", "--docker-hub-token-stdin", "--docker-hub-public-only"],
      "is not a Docker Hub user name",
    ],
  ])("refuses %j before anything is written", async (flags, message) => {
    const f = await fixture();
    const result = await serverCommand(["setup", ...flags], f.runtime);
    expect(result._tag).toBe("error");
    expect(result._tag === "error" ? result.message : "").toContain(message);
    expect(fs.existsSync(path.join(f.configDir, "active"))).toBe(false);
  });

  it("refuses a token that is not one, without writing it", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const before = f.files()["server.env"];
    const withStdin: ServerSetupRuntime = { ...f.runtime, readStdin: async () => "two words\n" };
    const result = await serverCommand(
      [
        "setup",
        "--offline",
        "--docker-hub-username",
        "mendbot",
        "--docker-hub-token-stdin",
        "--docker-hub-public-only",
      ],
      withStdin,
    );
    expect(result._tag).toBe("error");
    expect(f.files()["server.env"]).toBe(before);
  });
});
