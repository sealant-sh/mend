// The npm job's stable floor: the "Publish to npm" step as written, over this run's artifacts, against
// the stub npm registry, a stub GitHub API for the latest release, and a stand-in docker for each
// ghcr :latest.

import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMIT,
  manifest,
  MEND,
  mendEntries,
  mendSeed,
  OWNER,
  publish,
  publishStep,
  registry,
  sha512,
  tarGz,
} from "./republish.helpers.mjs";

const integrityOf = (entries) => `sha512-${sha512(tarGz(entries)).toString("base64")}`;

const latestLabels = (version) =>
  Object.fromEntries(
    ["mend", "mend-api", "mend-web"].map((image) => [`ghcr.io/${OWNER}/${image}:latest`, version]),
  );

test("stable npm: above the floor the run's tarball publishes; below it nothing does", async (t) => {
  const lower = await registry(t, mendSeed());
  const published = await publishStep(t, lower, {
    version: "0.40.0",
    github: { latest: "v0.39.0" },
    labels: latestLabels("0.39.0"),
  });
  assert.equal(published.status, 0, published.output);
  assert.match(published.output, /Stable floor: 0\.39\.0 .*0\.40\.0 may publish/);
  assert.equal(lower.log.length, 1);
  assert.deepEqual(lower.log[0].distTags, { latest: "0.40.0" });
  // Each marker alone above the version refuses before npm publishes anything.
  for (const [marker, markers, named] of [
    [
      "npm latest",
      { github: {}, labels: {}, distTags: { latest: "0.41.0" } },
      /npm:@sealant\/mend@latest/,
    ],
    ["GitHub's latest release", { github: { latest: "v0.41.0" } }, /github:sealant-sh\/Mend/],
    ["a ghcr :latest", { labels: latestLabels("0.41.0") }, /ghcr\.io\/sealant-ci\/mend:latest/],
  ]) {
    const stub = await registry(t, mendSeed({}, markers.distTags ?? { latest: "0.39.0" }));
    const refused = await publishStep(t, stub, { version: "0.40.0", ...markers });
    assert.equal(refused.status, 1, marker);
    assert.match(refused.output, /0\.40\.0 is below the stable floor/, marker);
    assert.match(refused.output, named, marker);
    assert.match(
      refused.output,
      /a backport such as 0\.35\.2 after 0\.36\.0 is refused on purpose/,
    );
    assert.equal(stub.log.length, 0, marker);
  }
});

test("stable npm at the floor publishes nothing and only verifies the accepted tarball", async (t) => {
  const accepted = { gitHead: COMMIT, dist: { integrity: integrityOf(mendEntries("0.40.0")) } };
  const retried = await registry(t, mendSeed({ "0.40.0": accepted }, { latest: "0.40.0" }));
  const retry = await publishStep(t, retried, {
    version: "0.40.0",
    github: { latest: "v0.39.0" },
    labels: latestLabels("0.39.0"),
  });
  assert.equal(retry.status, 0, retry.output);
  assert.match(retry.output, /0\.40\.0 may retry/);
  assert.match(retry.output, /a same-version retry publishes nothing/);
  assert.match(retry.output, /published with the integrity this run accepted/);
  assert.equal(retried.log.length, 0);
  assert.equal(retried.packages.get(MEND)["dist-tags"].latest, "0.40.0");
  // Other bytes under that version are the incident; a version npm does not hold at all means a
  // marker was moved by hand.
  const forged = await registry(
    t,
    mendSeed(
      { "0.40.0": { gitHead: COMMIT, dist: { integrity: "sha512-other" } } },
      { latest: "0.40.0" },
    ),
  );
  const incident = await publishStep(t, forged, { version: "0.40.0" });
  assert.equal(incident.status, 1);
  assert.match(incident.output, /::error::INCIDENT/);
  assert.equal(forged.log.length, 0);
  const handMoved = await registry(t, mendSeed());
  const moved = await publishStep(t, handMoved, {
    version: "0.40.0",
    labels: latestLabels("0.40.0"),
  });
  assert.equal(moved.status, 1);
  assert.match(moved.output, /is the stable floor, but npm does not hold it/);
  assert.equal(handMoved.log.length, 0);
  assert.equal(handMoved.packages.get(MEND)["dist-tags"].latest, "0.39.0");
});

test("stable npm fails, publishing nothing, on an unreadable or malformed marker", async (t) => {
  for (const [label, markers, problem] of [
    ["GitHub answers 502", { github: { status: 502 } }, /GitHub answered 502/],
    [
      "a :latest unreadable",
      { labels: latestLabels("0.39.0"), unreadable: ["ghcr.io/sealant-ci/mend-web:latest"] },
      /Could not read ghcr\.io\/sealant-ci\/mend-web:latest/,
    ],
    ["a label not X.Y.Z", { labels: latestLabels("0.40") }, /carries no single plain X\.Y\.Z/],
  ]) {
    const stub = await registry(t, mendSeed());
    const result = await publishStep(t, stub, { version: "0.40.0", ...markers });
    assert.equal(result.status, 1, label);
    assert.match(result.output, problem, label);
    assert.equal(stub.log.length, 0, label);
  }
});

test("a next build reads no floor and publishes under next as before", async (t) => {
  const stub = await registry(t, mendSeed({}, { latest: "0.39.0", next: "0.40.0-next.3" }));
  const result = await publishStep(t, stub, {
    version: "0.40.0-next.4",
    github: { latest: "v9.9.9" },
    labels: latestLabels("9.9.9"),
  });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.github, []);
  assert.deepEqual(result.docker, []);
  assert.deepEqual(stub.log[0].distTags, { next: "0.40.0-next.4" });
});

test("stable npm fails, publishing nothing, on a present marker that is malformed", async (t) => {
  for (const [label, { image, github, distTags }, problem] of [
    [
      "a label with trailing text",
      { image: "0.39.0 invalid" },
      /mend:latest carries no single plain/,
    ],
    ["a GitHub tag of only v", { github: "v" }, /tagged "v", not vX\.Y\.Z/],
    ["a GitHub tag that is not a string", { github: 5 }, /tagged 5, not vX\.Y\.Z/],
    ["npm latest null", { distTags: { latest: null } }, /latest is null, not a plain/],
    ["npm latest empty", { distTags: { latest: "" } }, /latest is "", not a plain/],
    ["npm latest not a string", { distTags: { latest: 39 } }, /latest is 39, not a plain/],
    ["npm dist-tags a list", { distTags: [] }, /dist-tags is not a JSON object/],
    ["npm dist-tags not an object", { distTags: "0.39.0" }, /dist-tags is not a JSON object/],
    // Past 9 digits a part could overflow Bash's 64-bit arithmetic: refused as not plain.
    [
      "a part past 64 bits",
      { image: "9223372036854775808.0.0" },
      /mend:latest carries no single plain/,
    ],
  ]) {
    const stub = await registry(t, mendSeed({}, distTags ?? { latest: "0.39.0" }));
    const labels = latestLabels("0.39.0");
    if (image !== undefined) labels[`ghcr.io/${OWNER}/mend:latest`] = image;
    const result = await publishStep(t, stub, {
      version: "0.40.0",
      github: { latest: github ?? "v0.39.0" },
      labels,
    });
    assert.equal(result.status, 1, label);
    assert.match(result.output, problem, label);
    assert.equal(stub.log.length, 0, label);
  }
  // The largest part accepted compares as a number, above the release.
  const stub = await registry(t, mendSeed());
  const top = await publishStep(t, stub, {
    version: "0.40.0",
    github: { latest: "v999999999.0.0" },
    labels: latestLabels("0.39.0"),
  });
  assert.equal(top.status, 1);
  assert.match(top.output, /below the stable floor 999999999\.0\.0/);
  assert.equal(stub.log.length, 0);
});

test("a dry-run version is refused by the publisher on either channel", async (t) => {
  // A dry run never reaches the npm job (a tag push only); were it to, its version is no release.
  for (const [version, channel] of [
    ["0.36.0-next.988.dryrun.38931186422.1", "next"],
    ["0.36.0-next.988.dryrun.38931186422.1", "latest"],
    ["0.0.0-dryrun.38931186422.1", "next"],
  ]) {
    const stub = await registry(t, {
      "@sealant/mend": { name: "@sealant/mend", versions: {}, "dist-tags": { latest: "0.35.1" } },
    });
    const result = await publish(
      t,
      stub,
      [
        ["package/package.json", manifest(version, {}, "@sealant/mend")],
        ["package/dist/index.js", ""],
      ],
      version,
      channel,
      { name: "@sealant/mend" },
    );
    assert.notEqual(result.status, 0, `${version} ${channel}`);
    assert.match(result.output, new RegExp(`is not a ${channel} version`), `${version} ${channel}`);
    assert.equal(stub.log.length, 0);
  }
});
