// scripts/ghcr-staging-cleanup.mjs, run as ghcr-staging-cleanup.yml runs it, against a stub of
// GitHub's packages API on 127.0.0.1.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { classify } from "./ghcr-staging-cleanup.mjs";

const script = fileURLToPath(new URL("./ghcr-staging-cleanup.mjs", import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const version = (id, tags, days) => ({
  id,
  name: `sha256:${String(id).repeat(64).slice(0, 64)}`,
  created_at: ago(days + 1),
  updated_at: ago(days),
  metadata: { package_type: "container", container: { tags } },
});
const MEND = [
  version(101, ["staging-38923041738-1", "0.37.0"], 30),
  version(102, ["staging-38900000000-1"], 30),
  version(103, ["staging-38990000000-1"], 3),
  version(104, [], 30),
  version(105, ["staging-38800000000-2", "latest"], 30),
  version(106, ["0.0.0-dev.sha0123456789ab"], 30),
];

/**
 * The packages API for sealant-sh: mend's versions over two pages; `fail` answers an error, and
 * `retag` gives a version other tags from the listing on, as a finalize would.
 */
const packagesApi = async (t, { fail = {}, retag = {} } = {}) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://stub");
    requests.push({
      method: request.method,
      path: url.pathname,
      auth: request.headers.authorization,
    });
    const key = `${request.method} ${url.pathname}`;
    if (fail[key] !== undefined) {
      response.writeHead(fail[key], { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Must have admin rights to Repository." }));
      return;
    }
    const list = /^\/orgs\/sealant-sh\/packages\/container\/([\w-]+)\/versions$/.exec(url.pathname);
    if (request.method === "GET" && list !== null) {
      const all = list[1] === "mend" ? MEND : [];
      const page = Number(url.searchParams.get("page") ?? "1");
      const headers = { "content-type": "application/json" };
      if (list[1] === "mend" && page === 1)
        headers.link = `<http://${request.headers.host}${url.pathname}?per_page=100&page=2>; rel="next"`;
      response.writeHead(200, headers);
      response.end(JSON.stringify(list[1] === "mend" ? all.slice((page - 1) * 3, page * 3) : all));
      return;
    }
    const one = /^\/orgs\/sealant-sh\/packages\/container\/mend\/versions\/(\d+)$/.exec(
      url.pathname,
    );
    if (request.method === "GET" && one !== null) {
      const found = MEND.find((entry) => entry.id === Number(one[1]));
      const tags = retag[found.id];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          tags === undefined
            ? found
            : { ...found, updated_at: new Date().toISOString(), metadata: { container: { tags } } },
        ),
      );
      return;
    }
    if (
      request.method === "DELETE" &&
      /^\/orgs\/sealant-sh\/packages\/container\/[\w-]+\/versions\/\d+$/.test(url.pathname)
    ) {
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
};

const cleanup = async (api, args = []) => {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, GITHUB_API_URL: api.url, GITHUB_TOKEN: "test-token" },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const status = await new Promise((resolve) => child.on("close", resolve));
  return { status, output, deletes: api.requests.filter(({ method }) => method === "DELETE") };
};

test("only a version whose every tag is a staging tag, 14 days unchanged, is a candidate", () => {
  const now = Date.now();
  assert.deepEqual(
    MEND.map((entry) => [entry.id, classify(entry, now).candidate]),
    [
      [101, false],
      [102, true],
      [103, false],
      [104, false],
      [105, false],
      [106, false],
    ],
  );
  assert.match(classify(MEND[0], now).reason, /carries staging-38923041738-1, 0\.37\.0/);
  assert.match(classify(MEND[2], now).reason, /staging only, 3 days old \(< 14\)/);
  assert.match(classify(MEND[3], now).reason, /untagged/);
  assert.match(classify(MEND[4], now).reason, /carries .*latest/);
  // Age is updated_at's, which moves when tags change: a version created long ago but retagged
  // recently is young.
  assert.equal(
    classify({ ...MEND[1], created_at: ago(90), updated_at: ago(2) }, now).candidate,
    false,
  );
  assert.throws(() => classify({ ...MEND[1], updated_at: undefined }, now), /no updated_at/);
});

test("a dry run lists candidates and what it keeps, with reasons, and deletes nothing", async (t) => {
  const api = await packagesApi(t);
  const result = await cleanup(api);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.deletes, []);
  assert.match(
    result.output,
    /^CANDIDATE mend 102 \[staging-38900000000-1\]: staging only, 30 days old$/m,
  );
  for (const id of [101, 103, 104, 105, 106])
    assert.match(result.output, new RegExp(`^KEEP mend ${id} `, "m"));
  // Every package is read, mend over both pages, with the workflow token.
  const lists = api.requests.filter(
    ({ method, path: where }) => method === "GET" && where.endsWith("/versions"),
  );
  assert.deepEqual(
    lists.map(({ path: where }) => where.split("/")[5]),
    ["mend", "mend", "mend-api", "mend-web"],
  );
  assert.ok(lists.every(({ auth }) => auth === "Bearer test-token"));
});

test("with --delete, exactly the candidate is deleted", async (t) => {
  const api = await packagesApi(t);
  const result = await cleanup(api, ["--delete"]);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(
    result.deletes.map(({ path: where }) => where),
    ["/orgs/sealant-sh/packages/container/mend/versions/102"],
  );
  assert.match(result.output, /^DELETED mend 102 /m);
});

test("a candidate finalized between the listing and its delete is kept", async (t) => {
  // The audit's race: finalize-images adds 1.2.3 to a staging index the listing saw as staging only.
  const api = await packagesApi(t, { retag: { 102: ["staging-38900000000-1", "1.2.3"] } });
  const result = await cleanup(api, ["--delete"]);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.deletes, []);
  assert.match(
    result.output,
    /^SKIP mend 102 \[staging-38900000000-1, 1\.2\.3\]: no longer a candidate, carries /m,
  );
  // The read before the delete is of that version.
  assert.ok(
    api.requests.some(
      ({ method, path: where }) =>
        method === "GET" && where === "/orgs/sealant-sh/packages/container/mend/versions/102",
    ),
  );
  // A dry run never reads it again: it deletes nothing to protect.
  const listed = await packagesApi(t);
  await cleanup(listed);
  assert.ok(listed.requests.every(({ path: where }) => where.endsWith("/versions")));
});

test("a 403 on a delete, or any list error, fails loudly", async (t) => {
  const refused = await packagesApi(t, {
    fail: { "DELETE /orgs/sealant-sh/packages/container/mend/versions/102": 403 },
  });
  const denied = await cleanup(refused, ["--delete"]);
  assert.equal(denied.status, 1);
  assert.match(denied.output, /::error::DELETE .*answered 403: .*may not administer this package/);
  for (const [key, status] of [
    ["GET /orgs/sealant-sh/packages/container/mend-api/versions", 500],
    ["GET /orgs/sealant-sh/packages/container/mend/versions", 403],
  ]) {
    const api = await packagesApi(t, { fail: { [key]: status } });
    const result = await cleanup(api, ["--delete"]);
    assert.equal(result.status, 1, key);
    assert.match(result.output, new RegExp(`::error::GET .*answered ${status}`), key);
  }
  // A list failure after mend's pages stops the run; nothing after it is read or deleted.
  const late = await packagesApi(t, {
    fail: { "GET /orgs/sealant-sh/packages/container/mend-web/versions": 502 },
  });
  assert.equal((await cleanup(late)).status, 1);
});

test("the workflow lists only, unless dispatched with dry_run false, and its schedule is off", (t) => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ghcr-staging-cleanup.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.type, "boolean");
  assert.deepEqual(workflow.permissions, { contents: "read", packages: "write" });
  assert.deepEqual(workflow.jobs.cleanup.permissions, { contents: "read", packages: "write" });
  assert.equal(workflow.jobs.cleanup["runs-on"], "ubuntu-24.04");
  // Serialized with finalize-images, npm and promote-images for the whole list-and-delete.
  const release = parse(
    readFileSync(new URL("../.github/workflows/release-cli.yml", import.meta.url), "utf8"),
  );
  const channel = { group: "mend-release-channel", "cancel-in-progress": false, queue: "max" };
  assert.deepEqual(workflow.jobs.cleanup.concurrency, channel);
  for (const name of ["finalize-images", "npm", "promote-images"])
    assert.deepEqual(release.jobs[name].concurrency, channel, name);
  const step = workflow.jobs.cleanup.steps.at(-1);
  const directory = mkdtempSync(path.join(tmpdir(), "cleanup-step-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = path.join(directory, "calls");
  writeFileSync(
    path.join(directory, "node"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >>${JSON.stringify(calls)}\n`,
    {
      mode: 0o755,
    },
  );
  const argv = (DRY_RUN) => {
    writeFileSync(calls, "");
    const status = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", step.run], {
      env: { PATH: `${directory}:/usr/bin:/bin`, DRY_RUN },
    }).status;
    assert.equal(status, 0);
    return readFileSync(calls, "utf8").trim();
  };
  assert.equal(argv("true"), "scripts/ghcr-staging-cleanup.mjs");
  assert.equal(argv(""), "scripts/ghcr-staging-cleanup.mjs");
  assert.equal(argv("false"), "scripts/ghcr-staging-cleanup.mjs --delete");
});
