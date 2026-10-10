// slots.mjs reads `mend service list` in both of its formats: `<name> <status> :<port> <id>`, and
// since mend#651 `<name> <status> :<port> service <id> · process <id>`. Each stack's build state comes
// from the logs of its Service id, never its process id. Sol round 4's 25 cases (slots-formats).
//
//   node --test .claude/skills/verify/scripts/slots.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

const slots = (lines, phases, options) => {
  const dir = mkdtempSync(join(tmpdir(), "verify-slots-"));
  mkdirSync(join(dir, "logs"));
  writeFileSync(join(dir, "list.txt"), `${lines.join("\n")}\n`);
  for (const [service, phase] of Object.entries(phases))
    writeFileSync(
      join(dir, "logs", `${service}.log`),
      `verify stack · ${phase === "built" ? "ready in 25 s" : "building"}\n`,
    );
  return spawnSync(
    process.execPath,
    [
      join(here, "slots.mjs"),
      "--list",
      join(dir, "list.txt"),
      "--logs",
      join(dir, "logs"),
      ...options,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
};

const serviceId = (i) => i.toString(16).padStart(8, "0");
const processId = (i) => (i + 256).toString(16).padStart(8, "0");

/** Five verify stacks, newest first as the server lists them, and one unrelated Service. */
const listing = (format) => [
  ...[5, 4, 3, 2, 1].map((i) => {
    const old = format === "old" || (format === "mixed" && i % 2 === 1);
    const line = old
      ? `st-verify-${i} ready :3305 ${serviceId(i)}`
      : `st-verify-${i} ready :3305 service ${serviceId(i)} · process ${processId(i)}`;
    return format === "new-colored-crlf" ? `\u001b[32m${line}\u001b[0m\r` : line;
  }),
  "unrelated ready :3306 service 00abcdef · process 00123456",
];
const built = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [serviceId(i), "built"]));
const threeBuilding = {
  ...built,
  ...Object.fromEntries([1, 2, 3].map((i) => [serviceId(i), "building"])),
};

for (const format of ["old", "new", "mixed", "new-colored-crlf"]) {
  const lines = listing(format);

  test(`${format}: the fifth built stack is over the limit, read by its Service id`, () => {
    const run = slots(lines, built, ["--mine", "st-verify-5"]);
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /5 verify stack\(s\) live, 0 building/);
    assert.match(run.stdout, /service 00000005/);
    assert.doesNotMatch(run.stdout, /service 00000105/);
    assert.match(run.stdout, /over the limit/);
  });

  test(`${format}: the fourth holds a slot, chosen by its Service id`, () => {
    const run = slots(lines, built, ["--mine", "00000004"]);
    assert.equal(run.status, 0, run.stdout);
    assert.match(run.stdout, /holds a slot/);
  });

  test(`${format}: five built leave no slot`, () => {
    const run = slots(lines, built, []);
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /no slot: 5 of 4 live/);
  });

  test(`${format}: of three building, the two oldest hold slots and the third is over`, () => {
    for (const [mine, status, words] of [
      ["st-verify-1", 0, /holds a slot/],
      ["st-verify-2", 0, /holds a slot/],
      ["st-verify-3", 1, /over the limit/],
    ]) {
      const run = slots(lines, threeBuilding, ["--mine", mine]);
      assert.equal(run.status, status, `${mine}: ${run.stdout}`);
      assert.match(run.stdout, words);
    }
  });
}

test("new: one built stack leaves a slot free", () => {
  const run = slots(
    ["stack ready :3305 service 1234abcd · process abcd1234"],
    { "1234abcd": "built" },
    [],
  );
  assert.equal(run.status, 0, run.stdout);
});
