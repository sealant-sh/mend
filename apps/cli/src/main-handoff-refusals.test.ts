import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import type { ServerResponse } from "node:http";
import * as path from "node:path";

import { fingerprint, type HandoffWorld } from "@mend/local-git/testing";
import { describe, expect, it } from "vitest";

import { formatBytes } from "./landing.ts";
import {
  FILE_BYTES,
  mainHandoffFixtures,
  newsroom,
  OLD_SERVER,
  ORIGIN,
  project,
} from "./test/main-handoff-fixtures.ts";

const { handoffServer, json, run, spawning, startCli, waitFor, world } = mainHandoffFixtures();

const json413 = (budget: string, limit: number) => (response: ServerResponse) => {
  response.writeHead(413, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      _tag: "BudgetExceeded",
      budget,
      limit,
      retryAfterSeconds: null,
      message: "Request body too large",
    }),
  );
};

/**
 * A `git` first on PATH whose `bundle create` touches `bundling`, then waits for `release` before
 * it runs `then` and falls through to the real git. Ctrl-C sent before the release lands while the
 * handoff bundles.
 */
const holdBundleCreate = (w: HandoffWorld, then: string) => {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const shims = fs.mkdtempSync(path.join(w.root, "shims-"));
  const bundling = path.join(w.root, "bundling");
  const release = path.join(w.root, "release");
  fs.writeFileSync(
    path.join(shims, "git"),
    `#!/bin/sh\ncase " $* " in *" bundle create "*) : > '${bundling}'; while [ ! -e '${release}' ]; do sleep 0.05; done;${then} esac\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  return { path: `${shims}:${process.env["PATH"] ?? ""}`, bundling, release };
};

describe("mend handoff", spawning, () => {
  it("says something in front of the server refused the bundle on a 413 that is not Mend's", async () => {
    const w = world();
    const dana = newsroom(w);
    const server = await handoffServer({
      answer: (response) => {
        response.writeHead(413, { "content-type": "text/html" });
        response.end("<html><body>413 Request Entity Too Large</body></html>");
      },
    });
    const result = await run(server, [], dana);
    const size = server.bodies[0]?.length ?? 0;
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `mend: handoff not sent · something in front of the Mend server refused the ${formatBytes(size).replace(".0 ", " ")} bundle (${size} bytes) with HTTP 413 · its body limit is below the bundle · nothing was created\n`,
    );
  }, 30_000);

  it("refuses a TMPDIR inside the checkout, its git dir included, before writing anything", async () => {
    const w = world();
    const dana = newsroom(w);
    for (const inside of [path.join(dana, "tmp-here"), path.join(dana, ".git", "tmp-here")]) {
      fs.mkdirSync(inside, { recursive: true });
      const before = fingerprint(dana);
      const server = await handoffServer();
      const result = await run(server, [], dana, { TMPDIR: inside });
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(
        `mend: TMPDIR is ${inside}, inside this checkout, and a handoff writes nothing there · set TMPDIR elsewhere, then hand off again · nothing was created\n`,
      );
      expect(fingerprint(dana)).toEqual(before);
      expect(server.routes.filter((route) => route.startsWith("POST"))).toEqual([]);
    }
  }, 30_000);

  it("tells an old server by its bare 404, before building anything", async () => {
    const w = world();
    const dana = newsroom(w);
    const server = await handoffServer({ terms: (response) => response.writeHead(404).end() });
    const result = await run(server, [], dana);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(OLD_SERVER);
    expect(result.stdout).not.toContain("bundling");
    expect(server.routes.filter((route) => route.startsWith("POST"))).toEqual([]);
  }, 30_000);

  it("reads a 413 on the body budget as an old server, and on the bundle budget as too large", async () => {
    const w = world();
    const dana = newsroom(w);
    const bodyBudget = await handoffServer({ answer: json413("bodyBytes", 1024 * 1024) });
    const old = await run(bodyBudget, [], dana);
    expect(old.code).toBe(1);
    expect(old.stderr).toBe(OLD_SERVER);
    const bundleBudget = await handoffServer({ answer: json413("bundleBytes", 1024) });
    const large = await run(bundleBudget, [], dana);
    const size = bundleBudget.bodies[0]?.length ?? 0;
    expect(large.code).toBe(1);
    expect(large.stderr).toBe(
      `mend: handoff not sent · the bundle is ${formatBytes(size).replace(".0 ", " ")} (${size} bytes) · the server's limit is 1 KiB (MEND_BUDGET_BUNDLE_BYTES) · nothing was created\n`,
    );
  }, 30_000);

  it("refuses a bundle over the server's terms before uploading it", async () => {
    const w = world();
    const dana = newsroom(w);
    const server = await handoffServer({
      terms: (response) => json(response, { bundleBytes: 100, fileBytes: FILE_BYTES }),
    });
    const tmp = fs.mkdtempSync(path.join(w.root, "tmp-"));
    const result = await run(server, [], dana, { TMPDIR: tmp });
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      /^mend: handoff not sent · the bundle is .+ \(\d+ bytes\) · the server's limit is 100 bytes \(MEND_BUDGET_BUNDLE_BYTES\) · nothing was created\n$/u,
    );
    expect(server.routes.filter((route) => route.startsWith("POST"))).toEqual([]);
  }, 30_000);

  it("prints the server's words when it refuses the handoff", async () => {
    const w = world();
    const dana = newsroom(w);
    const message =
      "this project's store is co-located with the server, which takes no handoffs · nothing was created";
    const server = await handoffServer({
      terms: (response) => {
        response.writeHead(422, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ _tag: "HandoffRefused", reason: "store-co-located", message }),
        );
      },
    });
    const result = await run(server, [], dana);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`mend: ${message}\n`);
  }, 30_000);

  it("refuses a foreign origin, by directory name and by --project alike", async () => {
    const w = world();
    const fork = newsroom(w, "newsroom-api", "https://github.com/someone/newsroom-api-fork.git");
    const refusal = `mend: this checkout's origin is https://github.com/someone/newsroom-api-fork.git · newsroom-api's is ${ORIGIN} · nothing was created\n`;
    for (const args of [[], ["--project", "newsroom-api"]]) {
      const server = await handoffServer();
      const result = await run(server, args, fork);
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(refusal);
      expect(server.routes).toEqual(["GET /api/projects"]);
    }
  }, 30_000);

  it("takes an origin as the project's only with the same port, and path case only on GitHub", async () => {
    const w = world();
    const cases: ReadonlyArray<readonly [string, string, "same" | "foreign"]> = [
      [
        "ssh://git@git.example.com:2222/acme/newsroom-api.git",
        "git@git.example.com:acme/newsroom-api.git",
        "foreign",
      ],
      [
        "https://git.example.com:8443/acme/newsroom-api.git",
        "https://git.example.com/acme/newsroom-api.git",
        "foreign",
      ],
      [
        "ssh://git@github.com:22/acme/newsroom-api.git",
        "git@github.com:acme/newsroom-api.git",
        "same",
      ],
      [
        "https://github.com/team/newsroom-api.git",
        "https://github.com/Team/Newsroom-API.git",
        "same",
      ],
      [
        "https://git.example.com/team/newsroom-api.git",
        "https://git.example.com/Team/Newsroom-API.git",
        "foreign",
      ],
    ];
    for (const [projectOrigin, checkoutOrigin, verdict] of cases) {
      const checkout = newsroom(
        w,
        `origin-${cases.findIndex(([p]) => p === projectOrigin)}`,
        checkoutOrigin,
      );
      const server = await handoffServer({ projects: [{ ...project, originUrl: projectOrigin }] });
      const result = await run(server, ["--project", "newsroom-api"], checkout);
      if (verdict === "same") {
        expect(result.code, `${checkoutOrigin}: ${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("✓ handed off as fix-login");
      } else {
        expect(result.stderr).toBe(
          `mend: this checkout's origin is ${checkoutOrigin} · newsroom-api's is ${projectOrigin} · nothing was created\n`,
        );
        expect(server.routes).toEqual(["GET /api/projects"]);
      }
    }
  }, 60_000);

  it("removes its copy of the work from TMPDIR when Ctrl-C lands while it bundles", async () => {
    const w = world();
    const dana = newsroom(w);
    const held = holdBundleCreate(w, "");
    const tmp = fs.mkdtempSync(path.join(w.root, "tmp-"));
    const server = await handoffServer();
    const cli = startCli(server.server.url, ["handoff"], { TMPDIR: tmp, PATH: held.path }, dana);
    try {
      await waitFor(() => fs.existsSync(held.bundling));
      expect(fs.readdirSync(tmp)).not.toEqual([]);
      cli.child.kill("SIGINT");
    } finally {
      fs.writeFileSync(held.release, "");
    }
    const { code } = await cli.exited;
    await server.server.close();
    expect(code, cli.stderr()).toBe(130);
    expect(cli.stderr()).toBe("mend: interrupted · nothing was created\n");
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(server.routes.filter((route) => route.startsWith("POST"))).toEqual([]);
  }, 30_000);

  it("says Ctrl-C was pressed, and removes its copy, when the snapshot fails another way meanwhile", async () => {
    const w = world();
    const dana = newsroom(w);
    // A bundle create that makes no bundle: reading it then fails, and that is not a refusal.
    const held = holdBundleCreate(w, " exit 0;");
    const tmp = fs.mkdtempSync(path.join(w.root, "tmp-"));
    const server = await handoffServer();
    const cli = startCli(server.server.url, ["handoff"], { TMPDIR: tmp, PATH: held.path }, dana);
    try {
      await waitFor(() => fs.existsSync(held.bundling));
      cli.child.kill("SIGINT");
    } finally {
      fs.writeFileSync(held.release, "");
    }
    const { code } = await cli.exited;
    await server.server.close();
    expect(code, cli.stderr()).toBe(130);
    expect(cli.stderr()).toBe("mend: interrupted · nothing was created\n");
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(server.routes.filter((route) => route.startsWith("POST"))).toEqual([]);
  }, 30_000);
});
