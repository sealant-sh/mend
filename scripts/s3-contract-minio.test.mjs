import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse } from "yaml";

import { minioFixture, prepareMinio } from "./s3-contract-minio.mjs";

const execute = promisify(execFile);
const binary = Buffer.from("owned MinIO download fixture");
const fixture = async (t) => {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), "mend-minio-cache-"));
  t.after(() => rm(cacheRoot, { recursive: true, force: true }));
  return {
    ...minioFixture({ cacheRoot }),
    sha256: createHash("sha256").update(binary).digest("hex"),
  };
};

test("a verified download persists and a warm cache works during a download outage", async (t) => {
  const cached = await fixture(t);
  const download = t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, cached.url);
    return new Response(binary);
  });
  assert.equal(await prepareMinio(cached), cached.path);
  assert.equal(download.mock.callCount(), 1);
  assert.deepEqual(await readFile(cached.path), binary);
  assert.equal((await stat(cached.path)).mode & 0o777, 0o755);

  // A restored cache may have lost its executable bit. Verify it and restore permissions offline.
  await chmod(cached.path, 0o644);
  download.mock.mockImplementation(async () => {
    throw new Error("GitHub download outage");
  });
  assert.equal(await prepareMinio(cached), cached.path);
  assert.equal(download.mock.callCount(), 1, "a cache hit never contacts the download service");
  assert.equal((await stat(cached.path)).mode & 0o777, 0o755);
});

test("a corrupt cached binary is refused without being run or replaced by a download", async (t) => {
  const cached = await fixture(t);
  await mkdir(path.dirname(cached.path), { recursive: true });
  await writeFile(cached.path, "corrupted cached binary", { mode: 0o644 });
  const download = t.mock.method(globalThis, "fetch", async () => new Response(binary));
  await assert.rejects(prepareMinio(cached), /MinIO fixture checksum mismatch/);
  assert.equal(download.mock.callCount(), 0);
  assert.equal((await stat(cached.path)).mode & 0o777, 0o644);
});

test("a download with the wrong checksum never enters the cache", async (t) => {
  const cached = await fixture(t);
  t.mock.method(globalThis, "fetch", async () => new Response("corrupted download"));
  await assert.rejects(prepareMinio(cached), /MinIO fixture checksum mismatch/);
  await assert.rejects(readFile(cached.path), { code: "ENOENT" });
});

for (const failure of ["connection", "body", "timeout"]) {
  test(`a cold-cache ${failure} failure is a download outage and leaves no binary`, async (t) => {
    const cached = await fixture(t);
    const cause = new Error(`${failure} failed`);
    t.mock.method(globalThis, "fetch", async () => {
      if (failure === "body") return { ok: true, arrayBuffer: async () => Promise.reject(cause) };
      if (failure === "timeout") throw new DOMException("Download timed out", "TimeoutError");
      throw cause;
    });
    await assert.rejects(prepareMinio(cached), (error) => {
      assert.match(error.message, /MinIO fixture download outage/);
      assert.match(error.message, /cache is cold/);
      assert.match(error.message, /S3 contract tests have not run/);
      if (failure === "timeout") assert.equal(error.cause.name, "TimeoutError");
      else assert.equal(error.cause, cause);
      return true;
    });
    await assert.rejects(readFile(cached.path), { code: "ENOENT" });
  });
}

test("caller cancellation retains its abort reason", async (t) => {
  const cached = await fixture(t);
  const abort = new AbortController();
  const reason = new Error("fixture runner interrupted");
  t.mock.method(globalThis, "fetch", async () => {
    abort.abort(reason);
    throw reason;
  });
  await assert.rejects(prepareMinio(cached, abort.signal), (error) => error === reason);
  await assert.rejects(readFile(cached.path), { code: "ENOENT" });
});

test("CI metadata keys the binary by the pinned release, architecture and checksum", async () => {
  for (const arch of ["x64", "arm64"]) {
    const cached = minioFixture({ arch });
    const release = cached.url.split("/").at(-2);
    const platform = arch === "x64" ? "linux-amd64" : "linux-arm64";
    assert.equal(cached.key, `minio-${platform}-${release}-${cached.sha256}`);
    assert.equal(path.basename(path.dirname(cached.path)), cached.key);
    assert.match(cached.sha256, /^[a-f0-9]{64}$/);
  }
  assert.notEqual(minioFixture({ arch: "x64" }).key, minioFixture({ arch: "arm64" }).key);
  assert.throws(() => minioFixture({ arch: "unsupported" }), /supports x64 and arm64/);
  const info = await execute(process.execPath, [
    fileURLToPath(new URL("s3-contract-minio.mjs", import.meta.url)),
  ]);
  const cached = minioFixture();
  assert.equal(info.stdout, `key=${cached.key}\npath=${cached.path}\n`);
});

test("both CI workflows restore the exact pinned cache before running the live S3 contracts", async () => {
  for (const name of ["ci", "ci-measure"]) {
    const workflow = parse(
      await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"),
    );
    const { steps } = workflow.jobs["test-clients-a"];
    const info = steps.findIndex((step) => step.id === "minio");
    const cache = steps.findIndex((step) => step.uses?.startsWith("actions/cache@"));
    const contract = steps.findIndex((step) => step.run === "pnpm run test:s3-contract");
    assert.ok(info >= 0 && info < cache && cache < contract, name);
    assert.equal(steps[info].run, 'node scripts/s3-contract-minio.mjs >> "$GITHUB_OUTPUT"');
    assert.equal(steps[cache].with.path, "${{ steps.minio.outputs.path }}");
    assert.equal(steps[cache].with.key, "${{ steps.minio.outputs.key }}");
    assert.equal(steps[cache].with["restore-keys"], undefined);
    assert.match(steps[cache].uses, /@[a-f0-9]{40}$/);
    assert.ok(steps.some((step) => step.run?.includes("scripts/s3-contract-minio.test.mjs")));
  }
});

test("the runner reports a cold-cache HTTP failure as a download outage", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "mend-minio-outage-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const docker = path.join(scratch, "docker");
  await writeFile(docker, "#!/bin/sh\nexit 0\n");
  await chmod(docker, 0o755);
  const preload = path.join(scratch, "outage.mjs");
  await writeFile(
    preload,
    'globalThis.fetch = async () => new Response("Download outage", { status: 503 });\n',
  );
  await assert.rejects(
    execute(
      process.execPath,
      ["--import", preload, fileURLToPath(new URL("test-s3-contract.mjs", import.meta.url))],
      {
        env: {
          ...process.env,
          HOME: scratch,
          PATH: `${scratch}${path.delimiter}${process.env.PATH}`,
        },
        timeout: 10_000,
      },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /MinIO fixture download outage/);
      assert.match(error.stderr, /cache is cold/);
      assert.match(error.stderr, /S3 contract tests have not run/);
      assert.match(error.stderr, /HTTP 503/);
      return true;
    },
  );
});
