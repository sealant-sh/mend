import type { IncomingMessage } from "node:http";

import { defaultWorkspaceImage } from "@mend/domain";
import { describe, expect, it } from "vitest";

import { mainTestFixtures } from "./main-test-fixtures.ts";

const { startCli, startFakeMend, json, spawning, project, session } = mainTestFixtures();
const worktree = { id: "wt", name: "work" };
const selectors = ["--project-id", project.id, "--worktree-id", worktree.id];
const bodyOf = async (request: IncomingMessage): Promise<unknown> => {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return JSON.parse(body);
};

describe("agent project image settings", spawning, () => {
  it("reads the inherited effective image without writing, then preserves every other setting when enabling Screen", async () => {
    const image = {
      ...defaultWorkspaceImage,
      os: "ubuntu",
      packages: ["jq", "git"],
      shell: "bash",
      services: { docker: false },
      screen: false,
    };
    const writes: Array<unknown> = [];
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/projects") json(response, [{ ...project, workspaceImage: null }]);
      else if (request.url === "/api/organization/settings")
        json(response, { effective: { workspaceImage: image } });
      else if (
        request.method === "PUT" &&
        request.url === `/api/projects/${project.id}/workspace-image`
      ) {
        void bodyOf(request).then((body) => {
          writes.push(body);
          return json(response, {
            saved: true,
            project: { ...project, workspaceImage: { ...image, screen: true } },
            resolutions: [],
          });
        });
      } else response.writeHead(404).end();
    });
    try {
      const read = startCli(fake.url, ["projects", "image", project.name, "--json"]);
      expect(await read.exited, read.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(read.stdout())).toMatchObject({
        v: 1,
        status: "done",
        data: { source: "organization", image },
      });
      expect(writes).toEqual([]);
      const save = startCli(fake.url, [
        "projects",
        "image",
        project.id,
        "--screen",
        "on",
        "--json",
      ]);
      expect(await save.exited, save.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(save.stdout())).toMatchObject({
        v: 1,
        status: "done",
        data: {
          saved: true,
          image: { ...image, screen: true },
          next: expect.stringContaining("new session"),
        },
      });
      expect(writes).toEqual([{ workspaceImage: { ...image, screen: true } }]);
      expect(read.stderr() + save.stderr()).toBe("");
    } finally {
      await fake.close();
    }
  });

  it("refuses a custom image without writing or changing it", async () => {
    let writes = 0;
    const fake = await startFakeMend((request, response) => {
      if (request.method === "PUT") writes++;
      if (request.url === "/api/projects")
        json(response, [
          {
            ...project,
            workspaceImage: {
              mode: "custom",
              baseImage: "ubuntu:24.04",
              packages: ["jq"],
              setupCommands: [],
              services: { docker: false },
            },
          },
        ]);
      else response.writeHead(404).end();
    });
    try {
      const cli = startCli(fake.url, ["projects", "image", project.id, "--screen", "on", "--json"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 4 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "not_ready",
        error: { code: "screen_image_unsupported", fix: expect.stringContaining("family") },
      });
      expect(writes).toBe(0);
      expect(cli.stderr()).toBe("");
    } finally {
      await fake.close();
    }
  });

  it("reports unresolved image packages as not ready, rather than claiming the setting was saved", async () => {
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/projects")
        json(response, [{ ...project, workspaceImage: defaultWorkspaceImage }]);
      else
        json(response, {
          saved: false,
          project: null,
          resolutions: [{ input: "missing-package", status: "not-found" }],
        });
    });
    try {
      const cli = startCli(fake.url, ["projects", "image", project.id, "--screen", "on", "--json"]);
      expect(await cli.exited).toEqual({ kind: "exit", code: 4 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "not_ready",
        data: { saved: false },
      });
      expect(cli.stderr()).toBe("");
    } finally {
      await fake.close();
    }
  });
});

describe("agent resource and cleanup recovery", spawning, () => {
  it("adds a declaration through the existing route with JSON flags removed from its definition parser", async () => {
    const writes: Array<unknown> = [];
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/projects") json(response, [project]);
      else if (request.url === `/api/projects/${project.id}/worktrees`)
        json(response, { worktrees: [worktree] });
      else if (request.url === `/api/projects/${project.id}/worktrees/resources`) {
        void bodyOf(request).then((body) => {
          writes.push(body);
          return json(response, {
            kind: "written",
            path: ".mend/mend.toml",
            statusLine: "@db declared; nothing started",
          });
        });
      } else response.writeHead(404).end();
    });
    try {
      const cli = startCli(fake.url, [
        "resource",
        "add",
        "db",
        "--preset",
        "postgres",
        "--version",
        "17",
        ...selectors,
        "--json",
      ]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "done",
        data: { kind: "written" },
      });
      expect(writes).toEqual([
        { worktreeId: worktree.id, definition: { name: "db", preset: "postgres", version: "17" } },
      ]);
      expect(cli.stderr()).toBe("");
    } finally {
      await fake.close();
    }
  });

  it.each(["rm", "purge"])("preserves the server's cleanup cause for projects %s", async (verb) => {
    const fake = await startFakeMend((_request, response) => {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          _tag: "RemovalRefused",
          message: "An upload may still land until 2030-01-01T00:00:00Z. Retry after then.",
        }),
      );
    });
    try {
      const cli = startCli(fake.url, [
        "projects",
        verb,
        project.id,
        ...(verb === "purge" ? ["--confirm", project.name] : []),
        "--json",
      ]);
      expect(await cli.exited).toEqual({ kind: "exit", code: 1 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "failed",
        error: {
          code: "RemovalRefused",
          message: expect.stringContaining("2030-01-01"),
          fix: expect.stringContaining("grace period"),
        },
      });
      expect(cli.stderr()).toBe("");
    } finally {
      await fake.close();
    }
  });

  it("returns usage and recovery for an unknown project rather than plain stderr", async () => {
    const fake = await startFakeMend((_request, response) => json(response, []));
    try {
      const cli = startCli(fake.url, ["resource", "list", "--project-id", "missing", "--json"]);
      expect(await cli.exited).toEqual({ kind: "exit", code: 2 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "usage",
        error: { code: "project_not_found" },
      });
      expect(cli.stderr()).toBe("");
    } finally {
      await fake.close();
    }
  });

  it("lists definitions and environment names without raw resource values, exports or command arguments", async () => {
    const secret = "fixture-resource-value-do-not-print";
    const spec = {
      name: "db",
      preset: "postgres",
      image: "postgres:17",
      command: [secret],
      env: { EXTRA: secret },
      exports: { URL: secret },
      ports: [],
      volumes: [],
      limits: {},
    };
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/projects") json(response, [project]);
      else if (request.url === `/api/projects/${project.id}/worktrees`)
        json(response, { worktrees: [worktree] });
      else if (request.url?.includes("/resources/env"))
        json(response, {
          env: { MEND_DB_PASSWORD: secret, MEND_DB_URL: secret, EXTRA: secret },
          exports: [`export EXTRA='${secret}'`],
          statusLines: [],
        });
      else
        json(response, {
          settings: [{ id: "r", spec, level: "project", statusLine: "running" }],
          file: { kind: "read", tables: [{ spec, statusLine: "declared" }] },
        });
    });
    try {
      for (const verb of ["list", "env"]) {
        const cli = startCli(fake.url, ["resource", verb, ...selectors, "--json"]);
        expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
        expect(JSON.parse(cli.stdout())).toMatchObject({
          v: 1,
          status: "done",
          data: { projectId: project.id, worktreeId: "wt" },
        });
        expect(cli.stdout()).not.toContain(secret);
        expect(cli.stderr()).toBe("");
      }
    } finally {
      await fake.close();
    }
  });

  it("stops Services through their existing route without stopping the agent", async () => {
    const writes: Array<string> = [];
    const fake = await startFakeMend((request, response) => {
      if (request.method === "POST") writes.push(request.url ?? "");
      if (request.url === "/api/projects") json(response, [project]);
      else if (request.url === `/api/projects/${project.id}?deadEnds=include`)
        json(response, { sessions: [session] });
      else if (request.url?.startsWith("/api/sessions?")) json(response, [session]);
      else if (request.url === `/api/sessions/${session.id}`) json(response, { session });
      else if (request.url === `/api/sessions/${session.id}/services/stop`)
        json(response, { stopped: 2 });
      else response.writeHead(404).end();
    });
    try {
      const cli = startCli(fake.url, ["stop", session.id, "--services", "--json"]);
      expect(await cli.exited, cli.stdout() + cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "done",
        data: { sessionId: session.id, stopped: 2 },
      });
      expect(writes).toEqual([`/api/sessions/${session.id}/services/stop`]);
      expect(cli.stderr()).toBe("");
    } finally {
      await fake.close();
    }
  });

  it("times out a live load with its accepted load id and makes no second start", async () => {
    let starts = 0;
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/projects") json(response, [project]);
      else if (request.url === `/api/projects/${project.id}/worktrees`)
        json(response, { worktrees: [worktree] });
      else {
        if (request.method === "POST") starts++;
        json(response, {
          id: "load-1",
          phase: "pulling",
          bytesDone: 0,
          bytesTotal: null,
          statusLine: "dumping source",
        });
      }
    });
    try {
      const cli = startCli(fake.url, [
        "resource",
        "load",
        "db",
        "--pull",
        "postgres://db/source",
        ...selectors,
        "--timeout",
        "1s",
        "--json",
      ]);
      expect(await cli.exited, cli.stdout() + cli.stderr()).toEqual({ kind: "exit", code: 124 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "timeout",
        data: { load: { id: "load-1" } },
      });
      expect(starts).toBe(1);
      expect(cli.stderr()).toBe("");
    } finally {
      await fake.close();
    }
  });
});
