import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Redacted } from "effect";
import { expect, it } from "vitest";

import { fileLoadSource, localDumpPlan } from "./resource-load.ts";

it("keeps the local pg_dump password out of argv, labels and inspectable output", () => {
  const password = "cli-load-private-password";
  const plan = localDumpPlan(`postgresql://alice:${password}@staging:5432/app`);
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  expect(Redacted.value(plan.password)).toBe(password);
  expect(plan.argv).toEqual([
    "--format=custom",
    "--no-owner",
    "--no-acl",
    "--dbname=postgresql://alice@staging:5432/app",
  ]);
  expect(JSON.stringify(plan)).not.toContain(password);
  expect(plan.label).toBe("staging:5432/app");
});
it("detects plain and custom files with exact upload totals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mend-resource-load-test-"));
  try {
    await writeFile(join(dir, "plain.sql"), "select 1;");
    await writeFile(join(dir, "custom.dump"), "PGDMPdata");
    expect(await fileLoadSource(join(dir, "plain.sql"))).toEqual({
      label: "plain.sql",
      bytesTotal: 9,
      format: "plain",
    });
    expect(await fileLoadSource(join(dir, "custom.dump"))).toEqual({
      label: "custom.dump",
      bytesTotal: 9,
      format: "custom",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
