import * as fs from "node:fs";
import { type IncomingMessage } from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { mainTestFixtures } from "./main-test-fixtures.ts";

const { project, json, spawning, startCli, startFakeMend, git } = mainTestFixtures();

/** Read a request's JSON body, then answer it with `reply`. */
const withBody = (request: IncomingMessage, reply: (body: unknown) => void): void => {
  void (async () => {
    const chunks: Array<Buffer> = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    reply(text === "" ? null : JSON.parse(text));
  })();
};

describe("flags a command does not declare", spawning, () => {
  const adopted = { ...project, name: "web", originUrl: "git@example.invalid:acme/web.git" };

  const scratch = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-cli-flags-"));
    const home = path.join(root, "home");
    const skill = path.join(home, ".agents", "skills", "hello");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(home, ".zshrc"), "export X=1\n");
    fs.writeFileSync(
      path.join(skill, "SKILL.md"),
      "---\nname: hello\ndescription: says hello\n---\nSay hello.\n",
    );
    const checkout = path.join(root, "web");
    fs.mkdirSync(checkout);
    git(checkout, ["init", "-q"]);
    git(checkout, ["remote", "add", "origin", adopted.originUrl]);
    return {
      root,
      checkout,
      env: { HOME: home, XDG_CONFIG_HOME: path.join(root, "config"), MEND_TOKEN: "test-token" },
    };
  };

  const recording = async () => {
    const requests: Array<{ readonly route: string; readonly body: unknown }> = [];
    const fake = await startFakeMend((request, response) => {
      const route = `${request.method ?? "GET"} ${request.url ?? ""}`;
      withBody(request, (body) => {
        requests.push({ route, body });
        if (route === "GET /api/projects") json(response, [adopted]);
        else if (route === "POST /api/dotfiles/snapshot") {
          json(response, {
            repository: null,
            snapshot: { files: [{ path: ".zshrc", bytes: 1 }], source: "x", sha: "0123456789ab" },
          });
        } else if (route === "POST /api/skills/sync") {
          json(response, { created: ["hello"], updated: [], unchanged: [], removed: [] });
        } else response.writeHead(404).end();
      });
    });
    return { fake, requests };
  };

  it.each([
    { args: ["sync", "--dry-run", ".zshrc"], refused: "--dry-run" },
    { args: ["sync", "--all", "--dry-run"], refused: "--dry-run" },
    { args: ["sync", "--all", "--", "--dry-run"], refused: "--" },
  ])("mend dotfiles $args uploads nothing", async ({ args, refused }) => {
    const { fake, requests } = await recording();
    const home = scratch();
    const cli = startCli(fake.url, ["dotfiles", ...args], home.env, home.checkout);
    try {
      expect(await cli.exited).toEqual({ kind: "exit", code: 1 });
      expect(cli.stderr()).toContain(`unknown flag ${refused}`);
      expect(requests).toEqual([]);
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
      fs.rmSync(home.root, { recursive: true, force: true });
    }
  });

  it("mend skills push --project --prune pushes to the cwd's project", async () => {
    const { fake, requests } = await recording();
    const home = scratch();
    const cli = startCli(
      fake.url,
      ["skills", "push", "--project", "--prune"],
      home.env,
      home.checkout,
    );
    try {
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(requests.map((r) => r.route)).toEqual(["GET /api/projects", "POST /api/skills/sync"]);
      expect(requests[1]?.body).toMatchObject({
        scope: "project",
        projectId: adopted.id,
        prune: true,
        skills: [{ name: "hello", description: "says hello" }],
      });
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
      fs.rmSync(home.root, { recursive: true, force: true });
    }
  });
});

describe("server setup remote endpoint flags", spawning, () => {
  it.each([
    [
      "enables both endpoints with explicit loopback ports",
      [
        "--session-endpoint-url",
        "https://mend.example.com:8443",
        "--blob-store-public-url",
        "https://mend.example.com:10000",
        "--session-endpoint-port",
        "13106",
        "--blob-store-port",
        "13900",
      ],
    ],
    ["removes the endpoints", ["--no-remote-endpoints"]],
  ])("%s through the CLI entry point", async (_name, flags) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-cli-remote-endpoints-"));
    const recorded = path.join(root, "docker-args.json");
    fs.writeFileSync(
      path.join(root, "docker"),
      `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(process.argv.slice(2)));
process.stderr.write("endpoint flag test stopped before Docker\\n");
process.exitCode = 1;
`,
      { mode: 0o755 },
    );
    const cli = startCli("http://127.0.0.1:9", ["server", "setup", "--yes", ...flags], {
      PATH: root,
    });
    try {
      expect(await cli.exited).toEqual({ kind: "exit", code: 1 });
      await cli.closed;
      expect(cli.stderr()).toContain(
        "Docker contexts are unavailable: endpoint flag test stopped before Docker",
      );
      expect(JSON.parse(fs.readFileSync(recorded, "utf8"))).toEqual([
        "context",
        "ls",
        "--format",
        "{{json .}}",
      ]);
    } finally {
      cli.child.kill("SIGKILL");
      await cli.closed;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
