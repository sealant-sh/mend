import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

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

export function minioFixture({
  arch = process.arch,
  cacheRoot = path.join(homedir(), ".cache", "mend", "s3-contract"),
} = {}) {
  const asset = assets[arch];
  assert.ok(asset, "the strict fixture supports x64 and arm64 hosts");
  const key = `minio-${asset.name}-${release}-${asset.sha256}`;
  return {
    key,
    path: path.join(cacheRoot, key, "minio"),
    sha256: asset.sha256,
    url: `https://github.com/minio/minio/releases/download/${release}/minio.${asset.name}.${release}`,
  };
}

export async function prepareMinio(fixture, signal = new AbortController().signal) {
  signal.throwIfAborted();
  let binary;
  try {
    binary = await readFile(fixture.path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const verify = () =>
    assert.equal(
      createHash("sha256").update(binary).digest("hex"),
      fixture.sha256,
      `MinIO fixture checksum mismatch at ${fixture.path}; refusing to run an unverified binary`,
    );
  if (binary !== undefined) {
    verify();
    await chmod(fixture.path, 0o755);
    console.log(`Reusing checksum-verified MinIO fixture: ${fixture.path}`);
    return fixture.path;
  }
  try {
    const response = await fetch(fixture.url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    binary = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(
      `MinIO fixture download outage: the cache is cold and ${fixture.url} could not be downloaded. S3 contract tests have not run. Retry when downloads recover.`,
      { cause: error },
    );
  }
  verify();
  await mkdir(path.dirname(fixture.path), { recursive: true });
  // Publish only a complete, verified binary, so interrupted downloads cannot poison the cache.
  const scratch = await mkdtemp(path.join(path.dirname(fixture.path), ".download-"));
  try {
    const temporary = path.join(scratch, "minio");
    await writeFile(temporary, binary, { mode: 0o755 });
    await rename(temporary, fixture.path);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(`Cached checksum-verified MinIO fixture: ${fixture.path}`);
  return fixture.path;
}

if (import.meta.main) {
  const fixture = minioFixture();
  console.log(`key=${fixture.key}\npath=${fixture.path}`);
}
