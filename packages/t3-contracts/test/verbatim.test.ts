import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The copy is t3code's, byte for byte, at the pinned tag. A failure here means a vendored file was
// edited, added or removed by hand; run `pnpm --filter @mend/t3-contracts sync --tag <tag>` instead.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface PinnedFile {
  readonly upstream: string;
  readonly blob: string;
  readonly sha256: string;
}

interface Pin {
  readonly repository: string;
  readonly tag: string;
  readonly commit: string;
  readonly files: Readonly<Record<string, PinnedFile>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readPin = (): Pin => {
  const raw: unknown = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "t3code.pin.json"), "utf8"),
  );
  if (!isRecord(raw) || !isRecord(raw.files)) throw new Error("t3code.pin.json has no files");
  const files: Record<string, PinnedFile> = {};
  for (const [local, entry] of Object.entries(raw.files)) {
    if (
      !isRecord(entry) ||
      typeof entry.upstream !== "string" ||
      typeof entry.blob !== "string" ||
      typeof entry.sha256 !== "string"
    ) {
      throw new Error(`t3code.pin.json: ${local} is not a pinned file`);
    }
    files[local] = { upstream: entry.upstream, blob: entry.blob, sha256: entry.sha256 };
  }
  const { repository, tag, commit } = raw;
  if (typeof repository !== "string" || typeof tag !== "string" || typeof commit !== "string") {
    throw new Error("t3code.pin.json needs repository, tag and commit");
  }
  return { repository, tag, commit, files };
};

const listFiles = (relativeDir: string): ReadonlyArray<string> =>
  fs
    .readdirSync(path.join(packageRoot, relativeDir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(packageRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    );

const gitBlobId = (bytes: Buffer): string =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

const pin = readPin();

describe("vendored t3code contracts", () => {
  it("records a nightly tag and its full commit", () => {
    expect(pin.repository).toBe("https://github.com/pingdotgg/t3code.git");
    expect(pin.tag).toMatch(/^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/);
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("holds exactly the pinned files, with nothing added or missing", () => {
    const onDisk = [...listFiles("src"), ...listFiles("shared"), "LICENSE"].toSorted();
    expect(onDisk).toEqual(Object.keys(pin.files).toSorted());
  });

  it("copies t3code's contracts source whole: every file of packages/contracts/src", () => {
    const upstream = Object.values(pin.files).map((file) => file.upstream);
    const contracts = upstream.filter((file) => file.startsWith("packages/contracts/src/"));
    expect(contracts.length).toBe(listFiles("src").length);
    expect(upstream).toContain("packages/shared/src/keybindings.ts");
    expect(upstream).toContain("LICENSE");
  });

  it.each(Object.entries(pin.files))("%s matches the pin byte for byte", (local, pinned) => {
    const bytes = fs.readFileSync(path.join(packageRoot, local));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(pinned.sha256);
    expect(gitBlobId(bytes)).toBe(pinned.blob);
  });
});
