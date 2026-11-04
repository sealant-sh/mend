import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  existsSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { mainTestFixtures } from "./main-test-fixtures.ts";

const { json, spawning, startCli, startFakeMend } = mainTestFixtures();
const scratch = mkdtempSync(join(tmpdir(), "mend-observation-test-"));
afterAll(() => {
  readdirSync(scratch);
  rmSync(scratch, { recursive: true });
});
const id = "11111111-1111-4111-8111-111111111111";
const detail = { session: { id, worktreeId: "worktree" }, change: { id: "change" } };
const png = Buffer.from("89504e470d0a1a0a01020304", "hex");
const artifact = {
  artifact: {
    id: "proof",
    changeId: "change",
    sessionId: id,
    worktreeId: "worktree",
    turnId: null,
    title: "Observed login",
    caption: "At the login page",
    source: { _tag: "Unknown", reason: "No checkpoint recorded" },
    observedFrom: "2026-11-04T00:00:00Z",
    observedTo: "2026-11-04T00:00:00Z",
    launch: null,
    differences: [],
    capture: {
      _tag: "Screenshot",
      media: {
        mimeType: "image/png",
        bytes: png.length,
        sha256: createHash("sha256").update(png).digest("hex"),
        blobKey: "never-print-blob-key",
      },
    },
  },
  label: "Screenshot",
  mediaPath: "/proof-artifacts/proof/media",
};

describe("observations from a shell without a terminal", spawning, () => {
  it.each([
    ["preview"],
    ["screen", "look"],
    ["proof", "list"],
    ["proof", "get"],
    ["resource", "start"],
  ])("names missing input for %j", async (...words) => {
    const cli = startCli("http://127.0.0.1:1", [...words, "--json"]);
    expect(await cli.exited, cli.stderr() + cli.stdout()).toEqual({ kind: "exit", code: 2 });
    expect(JSON.parse(cli.stdout())).toMatchObject({
      v: 1,
      status: "usage",
      error: { code: "needs_input", fix: expect.any(String) },
    });
  });

  it("returns a stable browser link without minting tickets or exposing preview credentials", async () => {
    const calls: string[] = [];
    const fake = await startFakeMend(
      (req, res) => {
        calls.push(`${req.method} ${req.url}`);
        if (req.url?.endsWith("/previews"))
          return json(res, {
            starting: false,
            routing: "ready",
            unprepared: null,
            previews: [
              {
                preview: { id: "preview", label: "web", serviceName: "web", state: "kept" },
                status: "Ready",
                binding: { _tag: "Bound", serviceId: "svc", attemptId: "attempt" },
                open: { url: "https://credential.invalid/?ticket=never-print-ticket" },
              },
            ],
          });
        json(res, detail);
      },
      "end",
      false,
    );
    try {
      const cli = startCli(fake.url, ["preview", id, "--json"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        data: { url: `${fake.url}/sessions/${id}/preview`, previews: [{ id: "preview" }] },
      });
      expect(cli.stdout()).not.toContain("never-print");
      expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it("saves a fresh PNG and its provenance without any screen control request", async () => {
    const calls: string[] = [];
    const fake = await startFakeMend((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      if (!req.url?.endsWith("/look")) return json(res, detail);
      res.writeHead(200, {
        "content-type": "image/png",
        "x-mend-screen-id": "screen",
        "x-mend-observed-at": "2026-11-04T00:00:00Z",
      });
      res.write(png.subarray(0, 4));
      res.end(png.subarray(4));
    });
    try {
      const out = join(scratch, "screen.png");
      const cli = startCli(fake.url, ["screen", "look", id, "--out", out, "--json"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        data: { out, screenId: "screen", observedAt: "2026-11-04T00:00:00Z", bytes: png.length },
      });
      expect(readFileSync(out)).toEqual(png);
      expect(statSync(out).mode & 0o777).toBe(0o600);
      expect(calls).toEqual([`GET /api/sessions/${id}`, `GET /api/sessions/${id}/screen/look`]);
    } finally {
      await fake.close();
    }
  });

  it("lists unknown proof provenance and verifies downloaded bytes without disclosing storage keys", async () => {
    const fake = await startFakeMend((req, res) => {
      if (req.url?.endsWith("/media")) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(png);
        return;
      }
      if (req.url === "/api/proof-artifacts/proof") return json(res, artifact);
      if (req.url?.endsWith("/proof-artifacts")) return json(res, [artifact]);
      json(res, detail);
    });
    try {
      const list = startCli(fake.url, ["proof", "list", id, "--json"]);
      expect(await list.exited, list.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(list.stdout())).toMatchObject({
        v: 1,
        data: { artifacts: [{ source: { kind: "unknown", reason: "No checkpoint recorded" } }] },
      });
      const out = join(scratch, "proof.png");
      const get = startCli(fake.url, ["proof", "get", "proof", "--out", out, "--json"]);
      expect(await get.exited, get.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(readFileSync(out)).toEqual(png);
      expect(list.stdout() + get.stdout()).not.toContain("never-print");
    } finally {
      await fake.close();
    }
  });

  it.each(["digest", "timeout", "exists"])(
    "handles %s without leaving a partial or overwriting a file",
    async (kind) => {
      const out = join(scratch, `${kind}.png`);
      if (kind === "exists") writeFileSync(out, "keep my file");
      const fake = await startFakeMend((req, res) => {
        if (req.url?.endsWith("/media")) {
          res.writeHead(200, { "content-type": "image/png" });
          if (kind === "timeout") {
            res.write(png.subarray(0, 4));
            return;
          }
          res.end(Buffer.from("bad digest"));
          return;
        }
        json(res, artifact);
      });
      try {
        const cli = startCli(fake.url, [
          "proof",
          "get",
          "proof",
          "--out",
          out,
          "--timeout",
          "1s",
          "--json",
        ]);
        expect(await cli.exited, cli.stderr()).toEqual({
          kind: "exit",
          code: kind === "timeout" ? 124 : kind === "exists" ? 2 : 1,
        });
        expect(JSON.parse(cli.stdout())).toMatchObject({
          v: 1,
          error: {
            code:
              kind === "timeout"
                ? "timeout"
                : kind === "exists"
                  ? "output_unavailable"
                  : "media_incomplete",
            fix: expect.any(String),
          },
        });
        if (kind === "exists") expect(readFileSync(out, "utf8")).toBe("keep my file");
        else expect(existsSync(out)).toBe(false);
      } finally {
        await fake.close();
      }
    },
  );

  it("waits by reading resource state and never repeats start", async () => {
    let starts = 0;
    const fake = await startFakeMend((req, res) => {
      if (req.method === "POST") {
        starts += 1;
        return json(res, {
          kind: "started",
          instance: "starting",
          statusLine: "Starting",
          message: "Requested",
        });
      }
      if (req.url === "/api/projects") return json(res, [{ id: "project", name: "fixture" }]);
      json(res, {
        settings: [
          { spec: { name: "db" }, level: "project", instance: "running", statusLine: "Running" },
        ],
      });
    });
    try {
      const cli = startCli(fake.url, [
        "resource",
        "start",
        "db",
        "--project",
        "--project-id",
        "project",
        "--worktree-id",
        "worktree",
        "--wait",
        "--timeout",
        "5s",
        "--json",
      ]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(cli.stdout())).toMatchObject({ v: 1, data: { instance: "running" } });
      expect(starts).toBe(1);
    } finally {
      await fake.close();
    }
  });
});
