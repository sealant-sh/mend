import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Owned interoperability fixtures only. MinIO deliberately omits prefix multipart listing.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = "RELEASE.2025-09-07T16-13-09Z";
const assets = {
  x64: {
    name: "linux-amd64",
    sha256: "7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f",
  },
  arm64: {
    name: "linux-arm64",
    sha256: "5c83cd2cf151717ba0243f73e1c7802ff36e272b67144bdd7f1f7d684fd6f03d",
  },
};
const alpine =
  "alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8";
const execute = promisify(execFile);

async function main() {
  const scratch = await mkdtemp(path.join(tmpdir(), "mend-s3-contract-"));
  const owner = `mend-s3-contract-${randomUUID()}`;
  const resources = [];
  const abort = new AbortController();
  let child;
  let stopping;
  const signalFailures = [];
  const stopChild = () => {
    if (stopping !== undefined || child?.pid === undefined) return;
    const group = child.pid;
    const signalGroup = (signal) => {
      try {
        process.kill(-group, signal);
      } catch (error) {
        if (error.code !== "ESRCH") signalFailures.push(error);
      }
    };
    signalGroup("SIGTERM");
    // A wrapper's close event alone does not mean its descendants stopped. Keep the owned
    // process group identity until the escalation completes, before removing the backend.
    stopping = new Promise((resolve) =>
      setTimeout(() => {
        signalGroup("SIGKILL");
        resolve();
      }, 2000),
    );
  };
  const interrupt = () => {
    abort.abort();
    stopChild();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const docker = (...args) =>
    execute("docker", args, {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        DOCKER_CONFIG: path.join(scratch, "docker-config"),
      },
    });
  let originalFailure;
  try {
    assert.notEqual(process.platform, "win32", "the fixture runner requires POSIX process groups");
    const garage = (await readFile(path.join(root, "deploy/docker/compose.v2.yaml"), "utf8")).match(
      /^\s+image: (dxflrs\/garage:\S+)$/m,
    )?.[1];
    assert.ok(garage, "compose must declare its Garage image");
    const asset = assets[process.arch];
    assert.ok(asset, "the strict fixture supports x64 and arm64 hosts");
    await docker("info");
    for (const image of [garage, alpine]) await docker("pull", image);
    const response = await fetch(
      `https://github.com/minio/minio/releases/download/${release}/minio.${asset.name}.${release}`,
      {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
      },
    );
    assert.ok(response.ok, "pinned official MinIO binary must download");
    const binary = new Uint8Array(await response.arrayBuffer());
    assert.equal(
      createHash("sha256").update(binary).digest("hex"),
      asset.sha256,
      "MinIO binary SHA256 must match its official release asset",
    );
    const binaryPath = path.join(scratch, "minio");
    await writeFile(binaryPath, binary);
    await chmod(binaryPath, 0o755);
    for (const backend of ["garage", "minio"]) {
      abort.signal.throwIfAborted();
      const resource = { name: `${owner}-${backend}`, id: null, volumes: [] };
      resources.push(resource);
      const bucket = `contract-${randomBytes(8).toString("hex")}`;
      const accessKey =
        backend === "garage" ? `GK${randomBytes(12).toString("hex")}` : "mend-test-user";
      const secretKey = randomBytes(32).toString("hex");
      let args;
      let port;
      if (backend === "garage") {
        const config = path.join(scratch, "garage.toml");
        await writeFile(
          config,
          `metadata_dir="/var/lib/garage/meta"\ndata_dir="/var/lib/garage/data"\ndb_engine="sqlite"\nreplication_factor=1\nrpc_bind_addr="[::]:3901"\nrpc_public_addr="127.0.0.1:3901"\nrpc_secret="${randomBytes(32).toString("hex")}"\n[s3_api]\ns3_region="garage"\napi_bind_addr="[::]:3900"\nroot_domain=".s3.garage.localhost"\n`,
        );
        port = 3900;
        args = [
          "--mount",
          `type=bind,source=${config},target=/etc/garage.toml,readonly`,
          "--mount",
          "type=volume,target=/var/lib/garage",
          garage,
        ];
      } else {
        port = 9000;
        args = [
          "--mount",
          `type=bind,source=${binaryPath},target=/minio,readonly`,
          "--mount",
          "type=volume,target=/data",
          "-e",
          `MINIO_ROOT_USER=${accessKey}`,
          "-e",
          `MINIO_ROOT_PASSWORD=${secretKey}`,
          "-e",
          "MINIO_BROWSER=off",
          "-e",
          "MINIO_UPDATE=off",
          "--entrypoint",
          "/minio",
          alpine,
          "server",
          "/data",
          "--address",
          ":9000",
        ];
      }
      abort.signal.throwIfAborted();
      resource.id = (
        await docker(
          "create",
          "--pull=never",
          "--name",
          resource.name,
          "--label",
          `mend.audit=${owner}`,
          "-p",
          `127.0.0.1::${port}`,
          ...args,
        )
      ).stdout.trim();
      const created = JSON.parse((await docker("inspect", resource.id)).stdout)[0];
      resource.volumes = created.Mounts.filter((mount) => mount.Type === "volume").map(
        (mount) => mount.Name,
      );
      abort.signal.throwIfAborted();
      await docker("start", resource.id);
      const started = JSON.parse((await docker("inspect", resource.id)).stdout)[0];
      const endpoint = `http://127.0.0.1:${started.NetworkSettings.Ports[`${port}/tcp`][0].HostPort}`;
      const env = {
        PATH: process.env.PATH,
        HOME: scratch,
        TMPDIR: scratch,
        CI: process.env.CI ?? "",
        AWS_ACCESS_KEY_ID: accessKey,
        AWS_SECRET_ACCESS_KEY: secretKey,
        AWS_EC2_METADATA_DISABLED: "true",
        MEND_TEST_S3_URL: `s3://${bucket}?endpoint=${endpoint}&region=${backend === "garage" ? "garage" : "us-east-1"}`,
        MEND_TEST_S3_REQUIRED: "1",
        MEND_TEST_S3_WRITE_ONCE: backend === "minio" ? "1" : "0",
        MEND_TEST_S3_MULTIPART_LISTING: backend === "minio" ? "exact-key" : "prefix",
        TEST_S3_ENDPOINT: endpoint,
        TEST_S3_BUCKET: bucket,
      };
      if (backend === "garage") {
        let node;
        const deadline = Date.now() + 30_000;
        for (let attempt = 0; attempt < 100 && Date.now() < deadline; attempt++) {
          abort.signal.throwIfAborted();
          try {
            node = (
              await docker("exec", resource.id, "/garage", "-c", "/etc/garage.toml", "status")
            ).stdout.match(/^([0-9a-f]{16})\s/m)?.[1];
            if (Date.now() >= deadline) {
              node = undefined;
              break;
            }
            if (node !== undefined) break;
          } catch {
            /* Startup only; bounded exhaustion fails below. */
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(node, "owned Garage node must become ready");
        for (const command of [
          ["layout", "assign", "-z", "test", "-c", "1GB", node],
          ["layout", "apply", "--version", "1"],
          ["bucket", "create", bucket],
          ["key", "import", "--yes", "-n", "test", accessKey, secretKey],
          ["bucket", "allow", "--read", "--write", "--owner", bucket, "--key", "test"],
        ]) {
          abort.signal.throwIfAborted();
          await docker("exec", resource.id, "/garage", "-c", "/etc/garage.toml", ...command);
        }
      } else {
        const bootstrap =
          'import {S3Client,CreateBucketCommand} from "@aws-sdk/client-s3"; const client = new S3Client({endpoint:process.env.TEST_S3_ENDPOINT,region:"us-east-1",forcePathStyle:true,credentials:{accessKeyId:process.env.AWS_ACCESS_KEY_ID,secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY}}); try { await client.send(new CreateBucketCommand({Bucket:process.env.TEST_S3_BUCKET})); } finally { client.destroy(); }';
        let ready = false;
        const deadline = Date.now() + 30_000;
        for (let attempt = 0; attempt < 100 && Date.now() < deadline; attempt++) {
          abort.signal.throwIfAborted();
          try {
            await execute(process.execPath, ["--input-type=module", "-e", bootstrap], {
              cwd: path.join(root, "packages/store"),
              env,
              timeout: 30_000,
              signal: abort.signal,
            });
            ready = Date.now() < deadline;
            break;
          } catch {
            /* Startup only; bounded exhaustion fails below. */
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(ready, "owned MinIO must become ready and create its bucket");
      }
      console.log(
        `S3 contract: ${backend}, ${env.MEND_TEST_S3_MULTIPART_LISTING} multipart listing`,
      );
      const report = path.join(scratch, `${backend}-report.json`);
      abort.signal.throwIfAborted();
      let suiteTimedOut = false;
      const code = await new Promise((resolve, reject) => {
        child = spawn(
          "pnpm",
          [
            "exec",
            "vitest",
            "run",
            "test/blob-store.test.ts",
            "-t",
            "BlobStore \\(s3\\)",
            "--reporter=default",
            "--reporter=json",
            `--outputFile.json=${report}`,
          ],
          { cwd: path.join(root, "packages/store"), env, stdio: "inherit", detached: true },
        );
        const suiteTimeout = setTimeout(() => {
          suiteTimedOut = true;
          stopChild();
        }, 120_000);
        const settled = () => {
          clearTimeout(suiteTimeout);
          stopping = undefined;
          child = undefined;
        };
        child.once("error", (error) => {
          settled();
          reject(error);
        });
        child.once("close", async (status) => {
          await stopping;
          settled();
          resolve(status);
        });
      });
      assert.ok(!suiteTimedOut, `${backend} S3 suite must finish within two minutes`);
      abort.signal.throwIfAborted();
      assert.equal(code, 0, `${backend} S3 contract must pass`);
      const result = JSON.parse(await readFile(report, "utf8"));
      const assertions = result.testResults
        .flatMap((file) => file.assertionResults)
        .filter((entry) => entry.ancestorTitles.includes("BlobStore (s3)"));
      assert.ok(assertions.length > 0, "required S3 suite must contain actual cases");
      assert.ok(
        assertions.every((entry) => entry.status === "passed"),
        "every S3 case must execute and pass without skips",
      );
      console.log(`Observed ${assertions.length} executed S3 cases on ${backend}.`);
    }
  } catch (error) {
    originalFailure = error;
  }
  const failures = [...signalFailures];
  for (const resource of resources.toReversed()) {
    try {
      if (resource.id === null) {
        try {
          const found = JSON.parse((await docker("inspect", resource.name)).stdout)[0];
          assert.equal(found.Config.Labels["mend.audit"], owner);
          resource.id = found.Id;
          resource.volumes = found.Mounts.filter((mount) => mount.Type === "volume").map(
            (mount) => mount.Name,
          );
        } catch (error) {
          if (!error.stderr?.toLowerCase().includes("no such object")) throw error;
        }
      }
      if (resource.id !== null) await docker("rm", "-f", "-v", resource.id);
      const remaining = (await docker("volume", "ls", "--format", "{{.Name}}")).stdout.split("\n");
      for (const volume of resource.volumes)
        assert.ok(!remaining.includes(volume), `owned volume ${volume} must be removed`);
      console.log(
        `Removed owned ${resource.name}: ${resource.id}, volumes ${resource.volumes.join(", ")}`,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await rm(scratch, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  if (failures.length > 0) {
    const cleanupFailure = new AggregateError(
      originalFailure === undefined ? failures : [originalFailure, ...failures],
      "S3 fixture cleanup failed",
      { cause: originalFailure ?? failures[0] },
    );
    throw cleanupFailure;
  }
  if (originalFailure !== undefined) throw originalFailure;
  abort.signal.throwIfAborted();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
