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

test("the Caddyfile routes everything to web, unbuffered", () => {
  const caddyfile = readFileSync(path.join(directory, "Caddyfile"), "utf8");
  // One upstream, the web tier. Never the API (3101), the session channel (3106) or Sealant (4000).
  assert.deepEqual(caddyfile.match(/^\t*reverse_proxy\s+\S+/gm), ["\treverse_proxy mend:3105"]);
  for (const port of ["3101", "3106", "4000", "3900", "5432"])
    assert.ok(!caddyfile.includes(port), port);
  assert.match(caddyfile, /flush_interval -1/);
});

/**
 * The edge as a packaged install runs it, on plain HTTP: the repository's Caddyfile, with the
 * t3code gateway's site (`Caddyfile.t3`) mounted where it imports sites from, in front of a Caddy
 * stub of Mend's web tier and the gateway. The stub answers 404 for `X-Stub: 404`, cuts a 200
 * short for `X-Stub: abort`, and otherwise echoes what reached it.
 */
const startEdge = async (t) => {
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
      maxBuffer: 16 * 1024 * 1024,
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
          const remaining = (await docker("volume", "ls", "--format", "{{.Name}}")).stdout.split(
            "\n",
          );
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
    [
      ":3105, :3120 {",
      "\t@missing header X-Stub 404",
      "\thandle @missing {",
      '\t\trespond "Not Found" 404',
      "\t}",
      "\t@cut header X-Stub abort",
      "\thandle @cut {",
      "\t\theader Content-Length 100",
      '\t\trespond "cut short" 200',
      "\t}",
      "\thandle {",
      "\t\theader Set-Cookie SYN_RESPONSE_COOKIE",
      '\t\trespond "{http.request.uri}|{http.request.header.Referer}|{http.request.header.Authorization}|{http.request.header.Cookie}" 200',
      "\t}",
      "}",
      "",
    ].join("\n"),
  );
  // What the stub reloads to stop answering on 3105 and 3120: the edge's next dial is refused.
  const idle = path.join(scratch, "idle.Caddyfile");
  writeFileSync(idle, ":9999 {\n\trespond 204\n}\n");
  const { T3_GATEWAY_CADDYFILE } = await import("../apps/cli/src/server-edge.ts");
  const gatewaySite = path.join(scratch, "Caddyfile.t3");
  writeFileSync(gatewaySite, T3_GATEWAY_CADDYFILE);
  const create = async (name, mounts, extra) => {
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
        ...mounts.flatMap(([source, target]) => [
          "--mount",
          `type=bind,source=${source},target=${target},readonly`,
        ]),
        image,
      )
    ).stdout.trim();
    containers.push(container);
    const inspected = JSON.parse((await docker("inspect", container)).stdout)[0].Mounts;
    // Only implicit image volumes can exist: this fixture supplies read-only bind mounts.
    for (const mount of inspected) if (mount.Type === "volume") volumes.add(mount.Name);
    await docker("start", container);
    return container;
  };
  const stub = await create(
    "upstream",
    [
      [upstream, "/etc/caddy/Caddyfile"],
      [idle, "/etc/caddy/idle.Caddyfile"],
    ],
    ["--network-alias", "mend"],
  );
  // HTTP on owned loopback ports exercises the edge's logging without ACME or public DNS.
  const edge = await create(
    "edge",
    [
      [path.join(directory, "Caddyfile"), "/etc/caddy/Caddyfile"],
      [gatewaySite, "/etc/caddy/sites/t3code-gateway.caddy"],
    ],
    [
      "-e",
      "MEND_EDGE_HOST=http://:8080",
      "-e",
      "MEND_T3_GATEWAY_EDGE_HOST=http://:8081",
      "-p",
      "127.0.0.1::8080",
      "-p",
      "127.0.0.1::8081",
    ],
  );
  const published = JSON.parse((await docker("inspect", edge)).stdout)[0].NetworkSettings.Ports;
  const ports = {
    mend: Number(published["8080/tcp"][0].HostPort),
    gateway: Number(published["8081/tcp"][0].HostPort),
  };
  // Resolves once the response closes; `complete` is false for one cut short.
  const request = (port, target, headers = {}) =>
    new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: target, headers }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("error", () => {});
        response.on("close", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body,
            complete: response.complete,
          }),
        );
      });
      req.setTimeout(5000, () => req.destroy(new Error("owned Caddy request timed out")));
      req.on("error", (error) => resolve({ status: undefined, error }));
      req.end();
    });
  for (const port of Object.values(ports)) {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      ready = (await request(port, "/ready", { Host: "ready.invalid" })).status === 200;
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, "owned Caddy and its upstream must become ready");
  }
  const logs = async () => {
    const result = await docker("logs", edge);
    const text = result.stdout + result.stderr;
    return {
      text,
      entries: text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  };
  return {
    ports,
    request,
    logs,
    refuseDials: () =>
      docker("exec", stub, "caddy", "reload", "--config", "/etc/caddy/idle.Caddyfile"),
  };
};

const skipCaddy = (t) => {
  if (process.env.MEND_TEST_SKIP_CADDY !== "1") return false;
  assert.ok(!process.env.CI, "CI must execute the actual Caddy access-log regression");
  t.skip("explicit local opt-out: MEND_TEST_SKIP_CADDY=1");
  return true;
};

const urlOf = (uri) => new URL(uri.startsWith("/") ? `http://edge.invalid${uri}` : uri);

test(
  "actual Caddy access logs keep Mend's paths without their queries, hold no uri for the t3code gateway, and redact credential headers, while forwarding everything",
  { timeout: 60_000 },
  async (t) => {
    if (skipCaddy(t)) return;
    const edge = await startEdge(t);
    const credentials = (suffix) =>
      ["ticket", "token", "code", "wsTicket"].map((name) => `${name}=SYN_${suffix}`).join("&");
    const casesFor = (host) => [
      { target: "/ordinary" },
      { target: "/ordinary-query?visible=SYN_VISIBLE" },
      { target: `/named?${credentials(1)}&visible=SYN_ORDINARY` },
      { target: "/encoded?%74icket=SYN%5FENCODED&visible=hello%20world" },
      { target: `http://${host}/absolute?${credentials(4)}` },
      { target: `http://${host}/path@ordinary?visible=a%40b` },
      // HTTP treats this as an ordinary path, not as an absolute-form URL authority.
      { target: "//ordinary:label@path/nested?visible=SYN_PLAIN" },
      {
        target: `http://SYN_USER:SYN_PASSWORD@${host}/userinfo?${credentials(5)}`,
        userinfo: true,
      },
      {
        target: `https://SYN%5FUSER%40NAME:SYN%5FPASSWORD%3AEXTRA@${host}/encoded-userinfo?${credentials(6)}`,
        userinfo: true,
      },
      {
        target: `HTTP://SYN_USER_ONLY@${host}/user-only?${credentials(7)}`,
        userinfo: true,
      },
      {
        target: `http://:SYN_PASSWORD_ONLY@${host}/password-only?${credentials(8)}`,
        userinfo: true,
      },
      {
        target: `ftp://SYN_FTP_USER:SYN_FTP_PASSWORD@${host}/ftp-userinfo?${credentials(9)}`,
        userinfo: true,
      },
      {
        target: `custom+audit.v1-test://SYN_CUSTOM_USER:SYN_CUSTOM_PASSWORD@${host}/custom-userinfo?${credentials(10)}`,
        userinfo: true,
      },
    ];
    const sites = [
      { name: "mend", host: "mend.invalid", port: edge.ports.mend },
      { name: "gateway", host: "t3.invalid", port: edge.ports.gateway },
    ];
    const headers = {
      Referer: "https://SYN_REF_USER:SYN_REF_PASSWORD@example.invalid/path?ticket=SYN_REFERER",
      Authorization: "Bearer SYN_AUTHORIZATION",
      Cookie: "session=SYN_COOKIE",
    };
    for (const site of sites) {
      for (const { target } of casesFor(site.host)) {
        const response = await edge.request(site.port, target, {
          ...headers,
          Host: site.host,
        });
        const uri = urlOf(target);
        assert.equal(response.status, 200);
        assert.equal(
          response.body,
          `${uri.pathname}${uri.search}|${headers.Referer}|${headers.Authorization}|${headers.Cookie}`,
        );
        assert.deepEqual(response.headers["set-cookie"], ["SYN_RESPONSE_COOKIE"]);
      }
    }
    const accessOf = (logs, site) =>
      logs.entries.filter(
        (entry) => entry.logger?.startsWith("http.log.access.") && entry.request.host === site.host,
      );
    let logs;
    for (let attempt = 0; attempt < 100; attempt++) {
      logs = await edge.logs();
      if (sites.every((site) => accessOf(logs, site).length >= casesFor(site.host).length)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const site of sites) {
      const access = accessOf(logs, site);
      const cases = casesFor(site.host);
      assert.equal(access.length, cases.length, `every ${site.name} request emits an access log`);
      for (const entry of access) {
        assert.equal(entry.status, 200);
        assert.equal(entry.request.method, "GET");
        assert.ok(!Object.hasOwn(entry.request.headers, "Referer"));
        assert.deepEqual(entry.request.headers.Authorization, ["REDACTED"]);
        assert.deepEqual(entry.request.headers.Cookie, ["REDACTED"]);
        assert.deepEqual(entry.resp_headers["Set-Cookie"], ["REDACTED"]);
      }
      if (site.name === "gateway") {
        assert.deepEqual([...new Set(access.map((entry) => entry.request.uri))], ["REDACTED"]);
        continue;
      }
      for (const { target, userinfo } of cases) {
        const sent = urlOf(target);
        const matches = access.filter(
          (entry) => urlOf(entry.request.uri).pathname === sent.pathname,
        );
        assert.equal(matches.length, 1, sent.pathname);
        const logged = urlOf(matches[0].request.uri);
        assert.equal(logged.hostname, sent.hostname);
        assert.equal(logged.username, userinfo ? "REDACTED" : "");
        assert.equal(logged.password, "");
        assert.equal(logged.search, sent.search === "" ? "" : "?REDACTED", target);
      }
    }
    assert.doesNotMatch(logs.text, /SYN_|SYN%5F|hello%20world|a%40b/);
  },
);

test(
  "actual Caddy logs no asset token, file name or query value from either site, for a 200, a 404, a response cut short and a failed dial, in any spelling",
  { timeout: 120_000 },
  async (t) => {
    if (skipCaddy(t)) return;
    const edge = await startEdge(t);
    const token = "ast_SYNASSETTOKENxSYNASSETTOKENxSYNASSETTOKENxx";
    const rest = token.slice("ast_".length);
    // Query values: a raw-like file read, the sockets' tickets, pairing's code. Each spelling
    // cleans to a route of its own, or to none.
    const queries = [
      "/api/worktrees/w1/raw?path=private-dir%2Fprivate-name.png&within=private-dir",
      "/api/worktrees/w1/r%61w?path=private-name.png",
      "/API/worktrees/w1/RAW?path=private-name.png",
      "/api//worktrees/w1/raw/?path=private-name.png",
      "/api/worktrees/w1/raw;v=1?path=private-name.png",
      "/api/worktrees/x/%2e%2e/w1/raw?path=private-name.png",
      "/api/worktrees/w1/../../../raw?path=private-name.png",
      "/api/sessions/s1/tty?ticket=SYNQ_TICKET&visible=SYNQ_VISIBLE",
      "/api/pair?%63ode=SYNQ_CODE",
      "/?wsTicket=SYNQ_WSTICKET&token=SYNQ_TOKEN",
      "/api/projects?raw=SYNQ_RAW#SYNQ_FRAGMENT",
    ];
    // A t3code asset URL: its path is the token and the file name.
    const assets = [
      `/api/assets/${token}/private-name.png`,
      `/api/assets/${token}/private-name.png?v=SYNQ_ASSET`,
      `/api/assets/%61st_${rest}/private-name.png`,
      `/api/assets/%41ST_${rest}/private-name.png`,
      `/api/%61ssets/${token}/private-name.png`,
      `/api//assets/${token}/private-name.png`,
      `/API/ASSETS/${token}/private-name.png`,
      `/api/x/../assets/%61st_${rest}/private-name.png`,
      `/api/x/%2e%2e/assets/%61%73%74%5f${rest}/private%2dname%2epng`,
      `/api/assets/%61st_${rest}/private-name.png/`,
      `/api/assets/%61st_${rest}/private-name.png;v=1`,
      `/api/assets;%76=1/%61st_${rest}/private-name.png`,
      `/api/assets/%61st_${rest}/%2e%2e/private-name.png`,
      `/api/assets/%61st_${rest}/..%2fprivate-name.png`,
      `/api/assets/%61st_${rest}/%2e%2e/%2e%2e/private-name.png`,
      `/api/assets/%61st_${rest}/../../private-name.png`,
      `/api/assets/${token}/../../../../private-name.png`,
      `/api/assets/%61st_${rest}/%2E%2E/%2E%2E/%2E%2E/projects/private-name.png`,
    ];
    const kept = ["/api/projects", "/api/worktrees/w1/contents?path=SYNQ_README"];
    const sites = [
      {
        name: "mend",
        host: "mend.invalid",
        port: edge.ports.mend,
        targets: [...queries, ...kept],
      },
      {
        name: "gateway",
        host: "t3.invalid",
        port: edge.ports.gateway,
        targets: [...queries, ...assets],
      },
    ];
    const send = async (mode) => {
      for (const site of sites) {
        for (const target of site.targets) {
          const response = await edge.request(site.port, target, {
            Host: site.host,
            ...(mode === "dial" ? {} : { "X-Stub": mode }),
          });
          const expected = { ok: 200, 404: 404, abort: 200, dial: 502 }[mode];
          assert.equal(response.status, expected, `${site.name} ${mode} ${target}`);
          assert.equal(response.complete, mode !== "abort", `${site.name} ${mode} ${target}`);
        }
      }
    };
    for (const mode of ["ok", "404", "abort"]) await send(mode);
    await edge.refuseDials();
    await send("dial");
    const requests = sites.reduce((sum, site) => sum + site.targets.length, 0);
    const of = (site) => logs.entries.filter((entry) => entry.request?.host === site.host);
    let logs;
    for (let attempt = 0; attempt < 100; attempt++) {
      logs = await edge.logs();
      const access = sites.flatMap(of).filter((e) => e.logger.startsWith("http.log.access."));
      if (access.length >= 4 * requests) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const site of sites) {
      const lines = of(site);
      const count = (predicate) => lines.filter(predicate).length;
      const n = site.targets.length;
      // Each mode reached the log: the matrix below is about lines Caddy really wrote.
      assert.deepEqual(
        {
          ok: count((e) => e.logger.startsWith("http.log.access.") && e.status === 200),
          missing: count((e) => e.logger.startsWith("http.log.access.") && e.status === 404),
          cut: count((e) => e.msg === "aborting with incomplete response"),
          dial: count((e) => e.logger.startsWith("http.log.error.") && e.status === 502),
        },
        { ok: 2 * n, missing: n, cut: n, dial: n },
        site.name,
      );
    }
    const secret = /SYNQ|SYNASSETTOKEN|private-(name|dir)|private%2dname/i;
    const leaks = logs.text
      .split("\n")
      .filter((line) => secret.test(line))
      .map((line) => JSON.parse(line))
      .map((entry) => `${entry.request?.host} ${entry.logger} ${entry.request?.uri ?? entry.msg}`);
    assert.deepEqual([...new Set(leaks)], []);
    const [mend, gateway] = sites;
    assert.deepEqual([...new Set(of(gateway).map((entry) => entry.request.uri))], ["REDACTED"]);
    for (const entry of of(mend)) {
      assert.match(entry.request.uri, /^[^?#]*([?#]REDACTED)?$/, entry.logger);
    }
    // Mend's paths stay in its access lines and in Caddy's own error lines.
    const logged = (predicate) =>
      new Set(
        of(mend)
          .filter(predicate)
          .map((entry) => entry.request.uri),
      );
    for (const uri of ["/api/projects", "/api/worktrees/w1/contents?REDACTED"]) {
      assert.ok(logged((e) => e.logger.startsWith("http.log.access.")).has(uri), uri);
      assert.ok(logged((e) => e.logger.startsWith("http.log.error.")).has(uri), uri);
    }
  },
);

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
