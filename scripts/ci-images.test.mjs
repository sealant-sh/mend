import assert from "node:assert/strict";
import test from "node:test";

import { CI_IMAGES, ghcrRepository, pullImage, sourcesOf, splitName } from "./ci-images.mjs";

const silent = (t) => t.mock.method(console, "log", () => {});

test("every image is pinned by an index digest", () => {
  for (const [name, { digest }] of Object.entries(CI_IMAGES)) {
    assert.match(digest, /^sha256:[0-9a-f]{64}$/, name);
    assert.ok(splitName(name).tag, name);
  }
});

test("an official image comes from its GHCR copy, then ECR Public, then mirror.gcr.io", () => {
  const digest = CI_IMAGES["postgres:17"].digest;
  assert.deepEqual(sourcesOf("postgres:17"), [
    {
      registry: "ghcr",
      reference: `ghcr.io/sealant-sh/ci-mirror-postgres:17@${digest}`,
    },
    {
      registry: "ecr",
      reference: `public.ecr.aws/docker/library/postgres:17@${digest}`,
    },
    {
      registry: "gcr",
      reference: `mirror.gcr.io/library/postgres:17@${digest}`,
    },
  ]);
});

test("a name with an owner keeps it, with / as - in the copy's package", () => {
  assert.equal(
    ghcrRepository("dxflrs/garage:v2.4.1"),
    "ghcr.io/sealant-sh/ci-mirror-dxflrs-garage",
  );
  assert.deepEqual(splitName("dxflrs/garage:v2.4.1"), {
    repository: "dxflrs/garage",
    tag: "v2.4.1",
  });
});

test("an unknown image is refused by name", async () => {
  await assert.rejects(pullImage("nope:1"), /nope:1 is not in CI_IMAGES/);
});

/** A fake `docker` answering pulls from a script: reference → list of exit outcomes, in order. */
const fakeDocker = (script) => {
  const calls = [];
  const docker = async (_command, args) => {
    calls.push(args.join(" "));
    if (args[0] === "tag") return { status: 0, stdout: "", stderr: "" };
    const outcomes = script[args.at(-1)] ?? [];
    const outcome = outcomes.shift() ?? "error: nothing scripted";
    return outcome === "ok"
      ? { status: 0, stdout: "", stderr: "" }
      : { status: 1, stdout: "", stderr: outcome };
  };
  return { calls, docker };
};

test("a copy that is not on GHCR yet falls through at once, and the image is tagged", async (t) => {
  silent(t);
  const [ghcr, ecr] = sourcesOf("postgres:17");
  const { calls, docker } = fakeDocker({
    [ghcr.reference]: ["Error response from daemon: denied"],
    [ecr.reference]: ["ok"],
  });
  assert.equal(await pullImage("postgres:17", { docker, waits: [0, 0, 0] }), ecr.reference);
  assert.deepEqual(calls, [
    `pull -q ${ghcr.reference}`,
    `pull -q ${ecr.reference}`,
    `tag ${ecr.reference} postgres:17`,
  ]);
});

test("a refused pull is tried three times per source before the next", async (t) => {
  silent(t);
  const [ghcr, ecr, gcr] = sourcesOf("postgres:17");
  const limited = "toomanyrequests: Data limit exceeded";
  const { calls, docker } = fakeDocker({
    [ghcr.reference]: ["unexpected EOF", "unexpected EOF", "unexpected EOF"],
    [ecr.reference]: [limited, limited, limited],
    [gcr.reference]: [limited, "ok"],
  });
  assert.equal(await pullImage("postgres:17", { docker, waits: [0, 0, 0] }), gcr.reference);
  assert.equal(calls.filter((call) => call.startsWith("pull")).length, 8);
});

test("when no source serves the image every failure is named", async (t) => {
  silent(t);
  const { docker } = fakeDocker({});
  await assert.rejects(
    pullImage("postgres:17", { docker, waits: [0, 0, 0] }),
    (error) =>
      /could not be pulled from any source/.test(error.message) &&
      error.message.split("\n").length === 1 + 3 + 3 + 3,
  );
});
