import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { runCommandTestFixtures } from "./run-command-test-fixtures.ts";

const {
  spawning,
  compileCache,
  project,
  session,
  json,
  bodyOf,
  startFake,
  entrypoint,
  cliEnv,
  runCli,
} = runCommandTestFixtures();

afterAll(() => fs.rmSync(compileCache, { recursive: true, force: true }));

describe("--json and --wait", spawning, () => {
  it("mend projects --json prints JSON, not the table", async () => {
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/projects") json(response, [project]);
      else if (route === "GET /api/sessions") json(response, [session]);
      else response.writeHead(404).end();
    });
    try {
      const result = await runCli(fake.url, ["projects", "--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        version: 1,
        projects: [
          {
            id: project.id,
            name: project.name,
            originUrl: project.originUrl,
            defaultBranch: "main",
            storePath: project.storePath,
            liveSessions: 1,
            current: false,
          },
        ],
      });
    } finally {
      await fake.close();
    }
  });

  it("never prints the credentials of a project's origin, in JSON or in the table", async () => {
    const leaky = {
      ...project,
      originUrl: "https://oauth2:s3cret-token@github.com/acme/fixture.git",
    };
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/projects") json(response, [leaky]);
      else if (route === "GET /api/sessions") json(response, []);
      else response.writeHead(404).end();
    });
    try {
      const asJson = await runCli(fake.url, ["projects", "--json"]);
      expect(asJson.code, asJson.stderr).toBe(0);
      expect(asJson.stdout).not.toContain("s3cret-token");
      expect(JSON.parse(asJson.stdout).projects[0].originUrl).toBe(
        "https://github.com/acme/fixture.git",
      );
      const table = await runCli(fake.url, ["projects"]);
      expect(table.stdout + table.stderr).not.toContain("s3cret-token");
    } finally {
      await fake.close();
    }
  });

  it("never prints a token that follows a literal @ in an origin's password", async () => {
    const leaky = {
      ...project,
      originUrl: "https://oauth2:p@s3cret-token@github.com/acme/fixture.git",
    };
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/projects") json(response, [leaky]);
      else if (route === "GET /api/sessions") json(response, []);
      else response.writeHead(404).end();
    });
    try {
      const result = await runCli(fake.url, ["projects", "--json"]);
      expect(result.stdout + result.stderr).not.toContain("s3cret-token");
      expect(JSON.parse(result.stdout).projects[0].originUrl).toBe(
        "https://github.com/acme/fixture.git",
      );
    } finally {
      await fake.close();
    }
  });

  it("keeps an ssh origin's user and takes out only its password", async () => {
    const origins = [
      "ssh://git:s3cret-token@github.com/acme/fixture.git",
      "ssh://git:p@s3cret-token@[::1]:2222/acme/fixture.git",
    ];
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/projects") {
        json(
          response,
          origins.map((originUrl, index) => ({ ...project, id: `p${index}`, originUrl })),
        );
      } else if (route === "GET /api/sessions") json(response, []);
      else response.writeHead(404).end();
    });
    try {
      const result = await runCli(fake.url, ["projects", "--json"]);
      expect(result.stdout + result.stderr).not.toContain("s3cret-token");
      expect(
        JSON.parse(result.stdout).projects.map((row: { originUrl: string }) => row.originUrl),
      ).toEqual(["ssh://git@github.com/acme/fixture.git", "ssh://git@[::1]:2222/acme/fixture.git"]);
    } finally {
      await fake.close();
    }
  });

  it("mend connect --from-stdin says the account without credentials in what the server returned", async () => {
    const fake = await startFake((route, request, response) => {
      if (route === "POST /api/me/sealant/accounts") {
        void bodyOf(request).then(() =>
          json(response, {
            id: "account-1",
            provider: "github",
            name: "github",
            kind: "token",
            status: "active",
            metadata: { login: "https://oauth2:s3cret-token@github.com/acme" },
            connectedAt: new Date(0).toISOString(),
            lastUsedAt: null,
          }),
        );
      } else response.writeHead(404).end();
    });
    try {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", entrypoint, "connect", "github", "--from-stdin"],
        { env: cliEnv(fake.url), stdio: ["pipe", "pipe", "pipe"], cwd: os.tmpdir() },
      );
      // stdin is the credential, given and closed: nothing else reads it.
      child.stdin.end("ghp_synthetic_token_for_tests\n");
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      const [code] = await once(child, "close");
      expect(code, output).toBe(0);
      expect(output).toContain("https://github.com/acme");
      expect(output).not.toContain("s3cret-token");
    } finally {
      await fake.close();
    }
  });

  it.each(["neither", "root", "preferred", "both"])(
    "service init respects %s configuration files",
    async (existing) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-service-location-"));
      try {
        fs.writeFileSync(
          path.join(root, "package.json"),
          JSON.stringify({ name: "fixture", scripts: { dev: "vite --port 3000" } }),
        );
        const preferred = path.join(root, ".mend", "mend.toml");
        const legacy = path.join(root, "mend.toml");
        if (existing === "preferred" || existing === "both") {
          fs.mkdirSync(path.dirname(preferred));
          fs.writeFileSync(preferred, "# preferred\n");
        }
        if (existing === "root" || existing === "both") fs.writeFileSync(legacy, "# legacy\n");
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", entrypoint, "service", "init", "--yes"],
          {
            env: cliEnv("http://127.0.0.1:9"),
            stdio: ["ignore", "pipe", "pipe"],
            cwd: root,
          },
        );
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        const [code] = await once(child, "close");
        if (existing === "neither") {
          expect(code, output).toBe(0);
          expect(fs.readFileSync(preferred, "utf8")).toContain("[service.web]");
          expect(fs.existsSync(legacy)).toBe(false);
        } else {
          expect(code, output).not.toBe(0);
          expect(output).toContain(`${existing === "root" ? legacy : preferred} already exists`);
          if (existing === "root") expect(fs.existsSync(preferred)).toBe(false);
          else expect(fs.readFileSync(preferred, "utf8")).toBe("# preferred\n");
          if (existing !== "preferred") expect(fs.readFileSync(legacy, "utf8")).toBe("# legacy\n");
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("mend service init shows a proposal without the credentials of URLs in package scripts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-service-init-"));
    try {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "fixture",
          scripts: {
            dev: "vite --port 3000 --proxy https://oauth2:s3cret-token@github.com/acme/repo.git",
          },
        }),
      );
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", entrypoint, "service", "init"],
        { env: cliEnv("http://127.0.0.1:9"), stdio: ["ignore", "pipe", "pipe"], cwd: root },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      await once(child, "close");
      expect(output).toContain("--port 3000");
      expect(output).toContain("https://github.com/acme/repo.git");
      expect(output).not.toContain("s3cret-token");
      expect(fs.existsSync(path.join(root, ".mend", "mend.toml"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
