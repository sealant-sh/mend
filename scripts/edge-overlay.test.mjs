import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The packaged install's TLS edge (deploy/docker/compose.edge.yaml + Caddyfile; ADR 0004 "The
// access model"). Needs `docker compose` on PATH; skipped without it.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "deploy/docker");
const composeAvailable =
  spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
const skip = composeAvailable ? false : "docker compose is not on PATH";

const REQUIRED = [
  "MEND_POSTGRES_ADMIN_PASSWORD",
  "MEND_DB_PASSWORD",
  "SEALANT_DB_PASSWORD",
  "BETTER_AUTH_SECRET",
  "WORKSPACE_SSH_GATEWAY_TOKEN",
  "SEALANT_SERVICE_KEY",
  "SEALANT_CREDENTIALS_KEY",
  "MEND_GARAGE_RPC_SECRET",
  "MEND_GARAGE_ADMIN_TOKEN",
  "MEND_GARAGE_KEY_ID",
  "MEND_GARAGE_KEY_SECRET",
];

const render = (extra = {}) => {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-directory",
      directory,
      "-f",
      path.join(directory, "compose.v2.yaml"),
      "-f",
      path.join(directory, "compose.edge.yaml"),
      "config",
      "--format",
      "json",
    ],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MEND_VERSION: "0.0.0",
        APP_URL: "https://mend.example.com",
        MEND_EDGE_HOST: "mend.example.com",
        ...Object.fromEntries(REQUIRED.map((name) => [name, "synthetic"])),
        ...extra,
      },
    },
  );
  return result;
};

test("the edge is the only thing published beyond loopback, on 80 and 443", { skip }, () => {
  const result = render();
  assert.equal(result.status, 0, result.stderr);
  const compose = JSON.parse(result.stdout);
  const published = Object.entries(compose.services).flatMap(([name, service]) =>
    (service.ports ?? []).map((port) => ({
      name,
      host: port.host_ip ?? "0.0.0.0",
      published: String(port.published),
    })),
  );
  const beyondLoopback = published.filter((port) => port.host !== "127.0.0.1");
  assert.deepEqual(
    [...new Set(beyondLoopback.map((port) => `${port.name}:${port.published}`))].toSorted(),
    ["edge:443", "edge:80"],
  );
  // Mend's own port stays on loopback: the way in from outside is through TLS.
  assert.ok(published.some((port) => port.name === "mend" && port.host === "127.0.0.1"));
});

test("the edge shares a network with Mend and with nothing else", { skip }, () => {
  const compose = JSON.parse(render().stdout);
  assert.deepEqual(Object.keys(compose.services.edge.networks), ["edge"]);
  assert.deepEqual(Object.keys(compose.services.mend.networks).toSorted(), ["default", "edge"]);
  for (const name of ["postgres", "garage"]) {
    assert.ok(
      !Object.keys(compose.services[name].networks ?? { default: null }).includes("edge"),
      name,
    );
  }
});

test(
  "Mend trusts exactly the edge's network as a proxy hop, and declares what the overlay states",
  { skip },
  () => {
    const compose = JSON.parse(render().stdout);
    const subnet = compose.networks.edge.ipam.config[0].subnet;
    const env = compose.services.mend.environment;
    assert.equal(env.MEND_TRUSTED_PROXIES, subnet);
    assert.notEqual(subnet.split("/")[1], "0");
    assert.equal(env.MEND_EXPOSURE, "private");
    assert.equal(env.MEND_EXECUTOR_NETWORK, "private");
    assert.equal(render({ MEND_EXPOSURE: "public" }).status, 0);
    assert.equal(
      JSON.parse(render({ MEND_EXPOSURE: "public" }).stdout).services.mend.environment
        .MEND_EXPOSURE,
      "public",
    );
  },
);

test("the overlay refuses to render without the certificate's host", { skip }, () => {
  const result = render({ MEND_EDGE_HOST: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MEND_EDGE_HOST/);
});

test("the edge drops privileges it does not need", { skip }, () => {
  const edge = JSON.parse(render().stdout).services.edge;
  assert.deepEqual(edge.cap_drop, ["ALL"]);
  assert.deepEqual(edge.cap_add, ["NET_BIND_SERVICE"]);
  assert.deepEqual(edge.security_opt, ["no-new-privileges:true"]);
});

test("the Caddyfile routes everything to web and keeps credentials out of its log", () => {
  const caddyfile = readFileSync(path.join(directory, "Caddyfile"), "utf8");
  // One upstream, the web tier. Never the API (3101), the session channel (3106) or Sealant (4000).
  assert.deepEqual(caddyfile.match(/reverse_proxy\s+\S+/g), ["reverse_proxy mend:3105"]);
  for (const port of ["3101", "3106", "4000", "3900", "5432"])
    assert.ok(!caddyfile.includes(port), port);
  for (const parameter of ["ticket", "token", "code"]) {
    assert.match(caddyfile, new RegExp(`replace ${parameter} REDACTED`));
  }
  assert.match(caddyfile, /flush_interval -1/);
});
