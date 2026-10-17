// The republish block's publishing and its reads of the registry: what it publishes under next and
// latest, the integrity it reads back, a version already published, the channel that never moves
// back, and a registry that fails or serves a large package document.

import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMIT,
  goodEntries,
  manifest,
  NAME,
  publish,
  registry,
  seeded,
  sha512,
  tarGz,
} from "./republish.helpers.mjs";

test("the run's normalized tarball is published under next as it is, and its integrity read back", async (t) => {
  const stub = await registry(t, seeded());
  const { status, output, bytes } = await publish(
    t,
    stub,
    goodEntries("0.39.0-next.9"),
    "0.39.0-next.9",
  );
  assert.equal(status, 0, output);
  assert.equal(stub.log.length, 1);
  assert.deepEqual(stub.log[0].distTags, { next: "0.39.0-next.9" });
  // Not repacked: the registry received the bytes the manifest recorded.
  assert.deepEqual(stub.log[0].bytes, bytes);
  assert.equal(stub.log[0].manifest.dist.integrity, `sha512-${sha512(bytes).toString("base64")}`);
  assert.match(output, /published with the integrity this run accepted/);
  assert.equal(stub.packages.get(NAME)["dist-tags"].latest, "0.38.1");
});

test("a registry serving another integrity after the publish is an incident, and the channel's dist-tag has moved", async (t) => {
  // What next-channel.md's incident steps undo: the job fails, but npm publish --tag already moved
  // the channel's dist-tag to the incident version.
  const stub = await registry(t, seeded(), { forgeIntegrity: true });
  const result = await publish(t, stub, goodEntries("0.39.0-next.9"), "0.39.0-next.9");
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /::error::INCIDENT: .*Do not republish: deprecate/);
  assert.equal(stub.log.length, 1);
  assert.equal(stub.packages.get(NAME)["dist-tags"].next, "0.39.0-next.9");
  assert.equal(stub.packages.get(NAME)["dist-tags"].latest, "0.38.1");
  // A stable release: latest itself now names the incident version.
  const mend = "@sealant/mend";
  const stable = await registry(
    t,
    { [mend]: { name: mend, versions: { "0.38.1": {} }, "dist-tags": { latest: "0.38.1" } } },
    { forgeIntegrity: true },
  );
  const entries = [
    ["package/package.json", manifest("0.39.0", {}, mend)],
    ["package/dist/index.js", ""],
  ];
  const released = await publish(t, stable, entries, "0.39.0", "latest", { name: mend });
  assert.notEqual(released.status, 0, released.output);
  assert.match(released.output, /::error::INCIDENT/);
  assert.equal(stable.packages.get(mend)["dist-tags"].latest, "0.39.0");
});

test("next never moves back: an older version than the current next is refused", async (t) => {
  const stub = await registry(
    t,
    seeded(
      { "0.39.0-next.12": { gitHead: "later" } },
      { latest: "0.38.1", next: "0.39.0-next.12" },
    ),
  );
  const { status, output } = await publish(
    t,
    stub,
    goodEntries("0.39.0-next.11"),
    "0.39.0-next.11",
  );
  assert.notEqual(status, 0, output);
  assert.equal(stub.log.length, 0);
  assert.match(output, /next is already 0\.39\.0-next\.12/);
});

test("a version already published from this commit is done once its integrity checks; from another, refused", async (t) => {
  const integrity = `sha512-${sha512(tarGz(goodEntries("0.39.0-next.9"))).toString("base64")}`;
  const stub = await registry(
    t,
    seeded({ "0.39.0-next.9": { gitHead: COMMIT, dist: { integrity } } }),
  );
  assert.equal((await publish(t, stub, goodEntries("0.39.0-next.9"), "0.39.0-next.9")).status, 0);
  assert.equal(stub.log.length, 0);
  // A re-run over a version the registry serves with other bytes is the incident, not "done".
  const forged = await registry(
    t,
    seeded({ "0.39.0-next.9": { gitHead: COMMIT, dist: { integrity: "sha512-other" } } }),
  );
  const incident = await publish(t, forged, goodEntries("0.39.0-next.9"), "0.39.0-next.9");
  assert.notEqual(incident.status, 0);
  assert.match(incident.output, /::error::INCIDENT/);
  const other = await registry(t, seeded({ "0.39.0-next.9": { gitHead: "elsewhere" } }));
  const refused = await publish(t, other, goodEntries("0.39.0-next.9"), "0.39.0-next.9");
  assert.notEqual(refused.status, 0);
  assert.match(refused.output, /published from elsewhere/);
});

test("a package document over 256 KB is read, not passed as an argument", async (t) => {
  // Linux caps one argument at 128 KB (MAX_ARG_STRLEN): @sealant/mend's document passed it at
  // v0.36.0-next.601, and the job died with "Argument list too long" (run 37342721738).
  const padding = "x".repeat(200);
  const versions = Object.fromEntries(
    Array.from({ length: 1500 }, (_, i) => [`0.0.${i}`, { gitHead: "older", readme: padding }]),
  );
  const distTags = Object.fromEntries(
    Array.from({ length: 8000 }, (_, i) => [`channel-${i}`, `0.0.${i % 1500}`]),
  );
  const large = () =>
    seeded(
      { ...versions, "0.39.0-next.8": { gitHead: "older" } },
      { ...distTags, latest: "0.38.1", next: "0.39.0-next.8" },
    );
  const stub = await registry(t, large());
  assert.ok(JSON.stringify(stub.packages.get(NAME)).length > 256 * 1024);
  assert.ok(JSON.stringify(stub.packages.get(NAME)["dist-tags"]).length > 128 * 1024);
  const { status, output } = await publish(t, stub, goodEntries("0.39.0-next.9"), "0.39.0-next.9");
  assert.equal(status, 0, output);
  assert.equal(stub.log.length, 1);
  assert.deepEqual(stub.log[0].distTags, { next: "0.39.0-next.9" });
  // The same document read back: published from this commit is done; next never moves back.
  assert.equal((await publish(t, stub, goodEntries("0.39.0-next.9"), "0.39.0-next.9")).status, 0);
  assert.equal(stub.log.length, 1);
  const older = await publish(
    t,
    await registry(t, large()),
    goodEntries("0.39.0-next.7"),
    "0.39.0-next.7",
  );
  assert.notEqual(older.status, 0, older.output);
  assert.match(older.output, /next is already 0\.39\.0-next\.8/);
});

test("a registry failure stops the job instead of being read as nothing published", async (t) => {
  const stub = await registry(t, {});
  const { status, output } = await publish(t, stub, goodEntries("0.39.0-next.9"), "0.39.0-next.9");
  assert.notEqual(status, 0);
  assert.match(output, /answered 404/);
  assert.equal(stub.log.length, 0);
});

test("a stable release publishes under latest with the same checks", async (t) => {
  const mend = "@sealant/mend";
  const seed = {
    [mend]: { name: mend, versions: { "0.38.1": {} }, "dist-tags": { latest: "0.38.1" } },
  };
  const entries = [
    ["package/package.json", manifest("0.39.0", {}, mend)],
    ["package/dist/index.js", ""],
  ];
  const stub = await registry(t, seed);
  const result = await publish(t, stub, entries, "0.39.0", "latest", { name: mend });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(stub.log[0].distTags, { latest: "0.39.0" });
  const next = [
    ["package/package.json", manifest("0.39.0-next.9", {}, mend)],
    ["package/dist/index.js", ""],
  ];
  const refused = await publish(t, await registry(t, seed), next, "0.39.0-next.9", "latest", {
    name: mend,
  });
  assert.notEqual(refused.status, 0);
});
