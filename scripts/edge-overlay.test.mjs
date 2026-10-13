import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// The packaged install's TLS edge (deploy/docker/compose.edge.yaml + Caddyfile; ADR 0004).
// Rendering checks skip without Docker Compose. Runtime checks require local Docker and the
// overlay's declared Caddy image; MEND_TEST_SKIP_CADDY=1 opts out locally, never in CI.
// Load that image with docker pull, then run node --test scripts/edge-overlay.test.mjs.

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

const render = (extra = {}, overlays = []) => {
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
      ...overlays.flatMap((overlay) => ["-f", overlay]),
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

test("the Caddyfile routes everything to web and declares named query credential filters", () => {
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

for (const site of [
  {
    name: "Mend",
    hostVariable: "MEND_EDGE_HOST",
    port: 3105,
    credentials: ["ticket", "token", "code"],
  },
  {
    name: "t3code",
    hostVariable: "MEND_T3_GATEWAY_EDGE_HOST",
    port: 3120,
    credentials: ["wsTicket", "token"],
  },
]) {
  test(
    `actual ${site.name} Caddy access logs redact URL credentials and headers while forwarding them`,
    { timeout: 60_000 },
    async (t) => {
      if (process.env.MEND_TEST_SKIP_CADDY === "1") {
        assert.ok(!process.env.CI, "CI must execute the actual Caddy access-log regression");
        t.skip("explicit local opt-out: MEND_TEST_SKIP_CADDY=1");
        return;
      }
      const scratch = mkdtempSync(path.join(tmpdir(), "mend-caddy-logs-"));
      const owner = `mend-caddy-logs-${randomUUID()}`;
      const containers = [];
      const volumes = new Set();
      let network;
      const execute = promisify(execFile);
      const docker = async (...args) =>
        execute("docker", args, {
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
          env: {
            PATH: process.env.PATH,
            HOME: scratch,
            DOCKER_CONFIG: path.join(scratch, "docker-config"),
          },
        });
      t.after(async () => {
        const failures = [];
        try {
          for (const container of containers.toReversed()) {
            try {
              await docker("rm", "-f", "-v", container);
            } catch (error) {
              failures.push(error);
            }
          }
          if (volumes.size > 0) {
            try {
              const remaining = (
                await docker("volume", "ls", "--format", "{{.Name}}")
              ).stdout.split("\n");
              for (const volume of volumes) {
                assert.ok(!remaining.includes(volume), `owned volume ${volume} must be removed`);
              }
            } catch (error) {
              failures.push(error);
            }
          }
          if (network !== undefined) {
            try {
              await docker("network", "rm", network);
            } catch (error) {
              failures.push(error);
            }
          }
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
        if (failures.length > 0) throw new AggregateError(failures, "owned Caddy cleanup failed");
        t.diagnostic(
          `removed owned containers ${containers.join(", ")}; anonymous volumes: ${[...volumes].join(", ") || "none"}`,
        );
      });
      const image = readFileSync(path.join(directory, "compose.edge.yaml"), "utf8").match(
        /^\s+image: (caddy:\S+)$/m,
      )?.[1];
      assert.ok(image, "the edge overlay must declare its Caddy image");
      await docker("info");
      // CI installs the declared image first. Never silently skip an unavailable daemon or image.
      await docker("image", "inspect", image);
      network = (
        await docker("network", "create", "--label", `mend.audit=${owner}`, owner)
      ).stdout.trim();
      const upstream = path.join(scratch, "upstream.Caddyfile");
      writeFileSync(
        upstream,
        `:${site.port} {\n respond "{http.request.uri}|{http.request.header.Referer}|{http.request.header.Authorization}|{http.request.header.Cookie}" 200\n header Set-Cookie SYN_RESPONSE_COOKIE\n}\n`,
      );
      const create = async (name, config, extra) => {
        const container = (
          await docker(
            "create",
            "--pull=never",
            "--name",
            `${owner}-${name}`,
            "--label",
            `mend.audit=${owner}`,
            "--network",
            network,
            ...extra,
            "--mount",
            `type=bind,source=${config},target=/etc/caddy/Caddyfile,readonly`,
            image,
          )
        ).stdout.trim();
        containers.push(container);
        const mounts = JSON.parse((await docker("inspect", container)).stdout)[0].Mounts;
        // Only implicit image volumes can exist: this fixture supplies one read-only bind mount.
        for (const mount of mounts) if (mount.Type === "volume") volumes.add(mount.Name);
        t.diagnostic(
          `owned container mounts: ${JSON.stringify(mounts.map(({ Type, Destination, Name }) => ({ Type, Destination, Name })))}`,
        );
        await docker("start", container);
        return container;
      };
      await create("upstream", upstream, ["--network-alias", "mend"]);
      // HTTP on an owned loopback port exercises the unchanged filter without ACME or public DNS.
      let config = path.join(directory, "Caddyfile");
      if (site.name === "t3code") {
        const { T3_GATEWAY_CADDYFILE } = await import("../apps/cli/src/server-edge.ts");
        config = path.join(scratch, "gateway.Caddyfile");
        writeFileSync(config, T3_GATEWAY_CADDYFILE);
      }
      const edge = await create("edge", config, [
        "-e",
        `${site.hostVariable}=http://:8080`,
        "-p",
        "127.0.0.1::8080",
      ]);
      const inspect = JSON.parse((await docker("inspect", edge)).stdout)[0];
      const port = Number(inspect.NetworkSettings.Ports["8080/tcp"][0].HostPort);
      const headers = {
        Host: "edge.invalid",
        Referer: "https://SYN_REF_USER:SYN_REF_PASSWORD@example.invalid/path?ticket=SYN_REFERER",
        Authorization: "Bearer SYN_AUTHORIZATION",
        Cookie: "session=SYN_COOKIE",
      };
      const request = (target, extraHeaders = {}) =>
        new Promise((resolve, reject) => {
          const req = http.request(
            { host: "127.0.0.1", port, path: target, headers: extraHeaders },
            (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk) => (body += chunk));
              response.on("end", () =>
                resolve({ status: response.statusCode, headers: response.headers, body }),
              );
              response.on("error", reject);
            },
          );
          req.setTimeout(1000, () => req.destroy(new Error("owned Caddy request timed out")));
          req.on("error", reject);
          req.end();
        });
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          if ((await request("/ready")).status === 200) {
            ready = true;
            break;
          }
        } catch {
          // Readiness connection failures are retried; exhausting this bounded loop fails the test.
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(ready, "owned Caddy and its upstream must become ready");
      const credentialQuery = (suffix, { encoded = false, repeated = false } = {}) =>
        site.credentials
          .flatMap((name) => {
            const key = encoded ? `%${name.charCodeAt(0).toString(16)}${name.slice(1)}` : name;
            const value = `SYN_${name.toUpperCase()}_${suffix}`;
            const pair = `${key}=${encoded ? value.replaceAll("_", "%5F") : value}`;
            return repeated ? [pair, `${key}=SYN_SECOND_${name.toUpperCase()}_${suffix}`] : [pair];
          })
          .join("&");
      const redactedQuery = (repeated = false) =>
        site.credentials.flatMap((key) =>
          repeated
            ? [
                [key, "REDACTED"],
                [key, "REDACTED"],
              ]
            : [[key, "REDACTED"]],
        );
      const cases = [
        { target: "/ordinary?visible=plain", query: [["visible", "plain"]] },
        {
          target: `/named?${credentialQuery(1)}&visible=ordinary`,
          query: [...redactedQuery(), ["visible", "ordinary"]],
        },
        {
          target: `/encoded?${credentialQuery(2, { encoded: true })}&visible=hello%20world`,
          query: [...redactedQuery(), ["visible", "hello world"]],
        },
        {
          target: `/repeated?${credentialQuery(3, { repeated: true })}`,
          query: redactedQuery(true),
        },
        { target: `http://edge.invalid/absolute?${credentialQuery(4)}`, query: redactedQuery() },
        { target: "http://edge.invalid/path@ordinary?visible=a%40b", query: [["visible", "a@b"]] },
        {
          // HTTP treats this as an ordinary path, not as an absolute-form URL authority.
          target: "//ordinary:label@path/nested?visible=plain",
          query: [["visible", "plain"]],
        },
        {
          target: `http://SYN_USER:SYN_PASSWORD@edge.invalid/userinfo?${credentialQuery(5)}`,
          query: redactedQuery(),
          userinfo: true,
        },
        {
          target: `https://SYN%5FUSER%40NAME:SYN%5FPASSWORD%3AEXTRA@edge.invalid/encoded-userinfo?${credentialQuery(6)}`,
          query: redactedQuery(),
          userinfo: true,
        },
        {
          target: `HTTP://SYN_USER_ONLY@edge.invalid/user-only?${credentialQuery(7)}`,
          query: redactedQuery(),
          userinfo: true,
        },
        {
          target: `http://:SYN_PASSWORD_ONLY@edge.invalid/password-only?${credentialQuery(8)}`,
          query: redactedQuery(),
          userinfo: true,
        },
        {
          target: `ftp://SYN_FTP_USER:SYN_FTP_PASSWORD@edge.invalid/ftp-userinfo?${credentialQuery(9)}`,
          query: redactedQuery(),
          userinfo: true,
        },
        {
          target: `custom+audit.v1-test://SYN_CUSTOM_USER:SYN_CUSTOM_PASSWORD@edge.invalid/custom-userinfo?${credentialQuery(10)}`,
          query: redactedQuery(),
          userinfo: true,
        },
      ];
      const urlOf = (uri) => new URL(uri.startsWith("/") ? `http://edge.invalid${uri}` : uri);
      for (const { target } of cases) {
        const response = await request(target, headers);
        const uri = urlOf(target);
        assert.equal(response.status, 200);
        assert.equal(
          response.body,
          `${uri.pathname}${uri.search}|${headers.Referer}|${headers.Authorization}|${headers.Cookie}`,
        );
        assert.deepEqual(response.headers["set-cookie"], ["SYN_RESPONSE_COOKIE"]);
      }
      let logs;
      let entries = [];
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await docker("logs", edge);
        logs = result.stdout + result.stderr;
        entries = logs
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.logger?.startsWith("http.log.access."));
        if (entries.length >= cases.length + 1) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(
        entries.length,
        cases.length + 1,
        "every successful request must emit an access log",
      );
      for (const { target, query, userinfo } of cases) {
        const pathname = urlOf(target).pathname;
        const matches = entries.filter((entry) => urlOf(entry.request.uri).pathname === pathname);
        assert.equal(matches.length, 1, pathname);
        const entry = matches[0];
        assert.equal(entry.status, 200);
        assert.equal(entry.request.method, "GET");
        const logged = urlOf(entry.request.uri);
        assert.equal(logged.hostname, "edge.invalid");
        assert.equal(logged.username, userinfo ? "REDACTED" : "");
        assert.equal(logged.password, "");
        assert.deepEqual(
          [...logged.searchParams].toSorted(([a], [b]) => a.localeCompare(b)),
          query.toSorted(([a], [b]) => a.localeCompare(b)),
        );
        assert.ok(!Object.hasOwn(entry.request.headers, "Referer"));
        assert.deepEqual(entry.request.headers.Authorization, ["REDACTED"]);
        assert.deepEqual(entry.request.headers.Cookie, ["REDACTED"]);
        assert.deepEqual(entry.resp_headers["Set-Cookie"], ["REDACTED"]);
      }
      assert.doesNotMatch(logs, /SYN_|SYN%5F/);
    },
  );
}

test(
  "the t3code gateway behind the edge: its port stays on loopback, and the edge mounts its site only when it serves it",
  { skip },
  async () => {
    const { renderT3GatewayOverlay, t3GatewayEnvLines } =
      await import("../apps/cli/src/server-edge.ts");
    const overlayOf = (posture) => {
      const file = path.join(
        mkdtempSync(path.join(tmpdir(), "mend-t3-overlay-")),
        "compose.t3.yaml",
      );
      writeFileSync(file, renderT3GatewayOverlay(posture));
      const env = Object.fromEntries(
        t3GatewayEnvLines(posture).map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
      );
      return { file, env };
    };
    const edge = {
      bind: "127.0.0.1",
      appUrl: "https://mend.example.com",
      edgeHost: "mend.example.com",
      exposure: "public",
      t3GatewayPort: 3120,
    };
    for (const posture of [edge, { ...edge, t3GatewayOrigin: "t3.mend.example.com" }]) {
      const { file, env } = overlayOf(posture);
      const result = render({ MEND_PORT: "3105", ...env }, [file]);
      assert.equal(result.status, 0, result.stderr);
      const compose = JSON.parse(result.stdout);
      const gateway = compose.services.mend.ports.filter((port) => port.target === 3120);
      assert.deepEqual(
        gateway.map((port) => `${port.host_ip}:${port.published}`),
        ["127.0.0.1:3120"],
      );
      assert.equal(compose.services.mend.environment.MEND_T3_GATEWAY_PUBLISHED, "127.0.0.1:3120");
      // The edge's own Caddyfile stays mounted; the gateway's site joins it only when served.
      const targets = compose.services.edge.volumes.map((volume) => volume.target);
      assert.ok(targets.includes("/etc/caddy/Caddyfile"));
      assert.equal(
        targets.includes("/etc/caddy/sites/t3code-gateway.caddy"),
        posture.t3GatewayOrigin !== undefined,
      );
      assert.equal(
        compose.services.edge.environment.MEND_T3_GATEWAY_EDGE_HOST,
        posture.t3GatewayOrigin,
      );
      assert.equal(
        compose.services.mend.environment.MEND_T3_GATEWAY_URL,
        posture.t3GatewayOrigin === undefined
          ? "http://127.0.0.1:3120"
          : "https://t3.mend.example.com",
      );
    }
  },
);
