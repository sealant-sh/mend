// doctor.mjs keeps what each stack service ran: images.json in its --out, one entry per service the
// stack's report names. A fake `mend` prints the report; the web is a loopback server.
//
//   node --test .claude/skills/verify/scripts/doctor.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));

const ran = [
  {
    service: "mend",
    container: "mend-mend-1",
    image: "ghcr.io/sealant-sh/mend:1.2.3-verify.tabc",
    id: "sha256:m",
    repoDigests: [],
  },
  {
    service: "postgres",
    container: "mend-postgres-1",
    image: "postgres:17-alpine",
    id: "sha256:p",
    repoDigests: ["postgres@sha256:pulled"],
  },
  {
    service: "garage",
    container: "mend-garage-1",
    image: "dxflrs/garage:v2.4.1",
    id: "sha256:g",
    repoDigests: [],
  },
  {
    service: "sealantd",
    container: null,
    image: "mend-verify/sealantd:abc",
    id: "sha256:d",
    repoDigests: [],
  },
  {
    service: "fixture",
    container: null,
    image: "node:26-bookworm",
    id: "sha256:n",
    repoDigests: [],
  },
  { service: "guard", container: null, image: "busybox:1.37@sha256:b", id: null, repoDigests: [] },
];

test("doctor writes images.json naming every service the report names, with its image id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-doctor-"));
  const bin = join(dir, "bin");
  const out = join(dir, "doctor");
  mkdirSync(bin);
  const web = createServer((req, res) =>
    res.end(JSON.stringify({ status: "ok", version: "1.2.3-verify.tabc" })),
  );
  await new Promise((done) => web.listen(0, "127.0.0.1", done));
  const { port } = web.address();
  const report = {
    url: `http://127.0.0.1:${port}`,
    readyAt: "2026-10-17T00:00:00Z",
    images: { version: "1.2.3-verify.tabc" },
    check: { status: "completed" },
    ran,
  };
  writeFileSync(join(dir, "report.json"), JSON.stringify(report));
  writeFileSync(
    join(bin, "mend"),
    `#!/bin/sh\ncat "${join(dir, "report.json")}"\necho\necho "verify-doctor inner-cli-exit 0"\necho "verify-doctor sealantd 0.0.0"\n`,
    { mode: 0o755 },
  );
  const identity = spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
    encoding: "utf8",
  }).stdout.trim();
  writeFileSync(
    join(dir, "tunnel.json"),
    JSON.stringify({ pid: process.pid, identity, port, service: "st-verify-test" }),
  );
  try {
    const status = await new Promise((done) => {
      const child = spawn(
        process.execPath,
        [
          join(scripts, "doctor.mjs"),
          ...["--worktree", "st-verify-test", "--web", `http://127.0.0.1:${port}`],
          ...["--out", out, "--tunnel", join(dir, "tunnel.json")],
        ],
        { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "ignore" },
      );
      child.on("exit", done);
    });
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(out, "images.json"), "utf8")), ran);
    const doctor = readFileSync(join(out, "doctor.txt"), "utf8");
    for (const item of ran)
      assert.match(
        doctor,
        new RegExp(
          `image · ${item.service} · ${item.image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
      );
    assert.match(
      doctor,
      /image · postgres · postgres:17-alpine · sha256:p · postgres@sha256:pulled/,
    );
    assert.match(
      doctor,
      /image · garage · dxflrs\/garage:v2\.4\.1 · sha256:g · no repo digest \(loaded\)/,
    );
  } finally {
    web.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
