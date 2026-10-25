import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
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

const MEND_HOST = "mend.internal";
const GATEWAY_HOST = "t3.mend.internal";

/**
 * The edge as a packaged install runs it: the repository's Caddyfile, with the t3code gateway's
 * site (`Caddyfile.t3`) mounted where it imports sites from, both sites as hostnames on Caddy's
 * one HTTPS listener and its port-80 redirect. A `.internal` name gets its certificate from
 * Caddy's own CA, so automatic HTTPS runs without ACME or public DNS. Behind it, a Caddy stub of
 * Mend's web tier and the gateway answers 404 for `X-Stub: 404`, cuts a 200 short for
 * `X-Stub: abort`, redirects to the request's own URL with userinfo for `X-Stub: redirect`, and
 * otherwise echoes what reached it.
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
  const image = edgeImage();
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
      "\t@redirect header X-Stub redirect",
      "\thandle @redirect {",
      '\t\tredir "https://SYNLOC_USER:SYNLOC_PASSWORD@{http.request.host}{http.request.uri}" 302',
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
  const edge = await create(
    "edge",
    [
      [path.join(directory, "Caddyfile"), "/etc/caddy/Caddyfile"],
      [gatewaySite, "/etc/caddy/sites/t3code-gateway.caddy"],
    ],
    [
      "-e",
      `MEND_EDGE_HOST=${MEND_HOST}`,
      "-e",
      `MEND_T3_GATEWAY_EDGE_HOST=${GATEWAY_HOST}`,
      "-p",
      "127.0.0.1::80",
      "-p",
      "127.0.0.1::443",
    ],
  );
  const published = JSON.parse((await docker("inspect", edge)).stdout)[0].NetworkSettings.Ports;
  const ports = {
    http: Number(published["80/tcp"][0].HostPort),
    https: Number(published["443/tcp"][0].HostPort),
  };
  let ca;
  // Resolves once the response closes; `complete` is false for one cut short. The Host header is
  // sent as given; SNI is the name a client would derive from it.
  const request = ({ scheme = "https", host, target, method = "GET", headers = {} }) =>
    new Promise((resolve) => {
      const done = (response, body = "") =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body,
          complete: response.complete,
        });
      const req = (scheme === "https" ? https : http).request(
        {
          host: "127.0.0.1",
          port: ports[scheme],
          method,
          path: target,
          agent: false,
          headers: { ...headers, Host: host },
          ...(scheme === "https"
            ? {
                ca,
                servername: host
                  .replace(/(:\d+)?$/, "")
                  .replace(/\.$/, "")
                  .toLowerCase(),
              }
            : {}),
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => (body += chunk));
          response.on("error", () => {});
          response.on("close", () => done(response, body));
        },
      );
      req.on("connect", (response, socket) => {
        socket.destroy();
        done(response);
      });
      req.setTimeout(5000, () => req.destroy(new Error("owned Caddy request timed out")));
      req.on("error", (error) => resolve({ status: undefined, error }));
      req.end();
    });
  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt++) {
    if (ca === undefined) {
      try {
        ca = (await docker("exec", edge, "cat", "/data/caddy/pki/authorities/local/root.crt"))
          .stdout;
      } catch {}
    }
    if (ca !== undefined) {
      const answers = await Promise.all(
        [MEND_HOST, GATEWAY_HOST].map((host) => request({ host, target: "/ready" })),
      );
      ready = answers.every((answer) => answer.status === 200);
    }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, "owned Caddy, its certificates and its upstream must become ready");
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

const edgeImage = () => {
  const image = readFileSync(path.join(directory, "compose.edge.yaml"), "utf8").match(
    /^\s+image: (caddy:\S+)$/m,
  )?.[1];
  assert.ok(image, "the edge overlay must declare its Caddy image");
  return image;
};

const urlOf = (uri) => new URL(uri.startsWith("/") ? `http://edge.invalid${uri}` : uri);
const hostOf = (entry) => entry.request?.host?.replace(/:\d+$/, "");
const isMendLine = (entry) =>
  entry.logger === "http.log.access.mend" || entry.logger === "http.log.error.mend";

test(
  "actual Caddy runs the edge's Caddyfile with and without the gateway's site, and only Mend's named log keeps a uri",
  { timeout: 60_000 },
  async (t) => {
    if (skipCaddy(t)) return;
    const image = edgeImage();
    const scratch = mkdtempSync(path.join(tmpdir(), "mend-caddy-adapt-"));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const { T3_GATEWAY_CADDYFILE } = await import("../apps/cli/src/server-edge.ts");
    writeFileSync(path.join(scratch, "Caddyfile.t3"), T3_GATEWAY_CADDYFILE);
    const caddy = (command, withGateway) => {
      const result = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--pull=never",
          "--network",
          "none",
          "-e",
          "MEND_EDGE_HOST=mend.example.com",
          "-e",
          "MEND_T3_GATEWAY_EDGE_HOST=t3.mend.example.com",
          "--mount",
          `type=bind,source=${path.join(directory, "Caddyfile")},target=/etc/caddy/Caddyfile,readonly`,
          ...(withGateway
            ? [
                "--mount",
                `type=bind,source=${path.join(scratch, "Caddyfile.t3")},target=/etc/caddy/sites/t3code-gateway.caddy,readonly`,
              ]
            : []),
          image,
          "caddy",
          command,
          "--config",
          "/etc/caddy/Caddyfile",
          "--adapter",
          "caddyfile",
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, `caddy ${command} (gateway ${withGateway}): ${result.stderr}`);
      return result.stdout;
    };
    for (const withGateway of [false, true]) {
      caddy("validate", withGateway);
      const config = JSON.parse(caddy("adapt", withGateway));
      const servers = Object.values(config.apps.http.servers);
      const filter = (field) =>
        field === undefined
          ? "kept"
          : [field.filter, field.regexp, field.value].filter(Boolean).join(" ");
      const logs = Object.fromEntries(
        Object.entries(config.logging.logs).map(([name, log]) => [
          name,
          {
            include: log.include?.toSorted() ?? "everything not named elsewhere",
            uri: filter(log.encoder?.fields?.["request>uri"]),
            location: filter(log.encoder?.fields?.["resp_headers>Location"]),
            referer: filter(log.encoder?.fields?.["request>headers>Referer"]),
          },
        ]),
      );
      const uriFree = { uri: "replace REDACTED", location: "delete", referer: "delete" };
      // Mend's log keeps a path: one regexp, for the uri and for a Location alike.
      const pathOnly = logs.mend?.uri.startsWith("regexp ") ? logs.mend.uri : "regexp";
      assert.deepEqual(
        {
          names: Object.assign({}, ...servers.map((server) => server.logs.logger_names)),
          logs,
        },
        {
          names: {
            "mend.example.com": ["mend"],
            ...(withGateway ? { "t3.mend.example.com": ["t3code-gateway"] } : {}),
          },
          logs: {
            default: { include: "everything not named elsewhere", ...uriFree },
            mend: {
              include: ["http.log.access.mend", "http.log.error.mend"],
              uri: pathOnly,
              location: pathOnly,
              referer: "delete",
            },
            ...(withGateway
              ? { "t3code-gateway": { include: ["http.log.access.t3code-gateway"], ...uriFree } }
              : {}),
          },
        },
        `gateway ${withGateway}`,
      );
    }
  },
);

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
      { name: "mend", host: MEND_HOST },
      { name: "gateway", host: GATEWAY_HOST },
    ];
    const headers = {
      Referer: "https://SYN_REF_USER:SYN_REF_PASSWORD@example.invalid/path?ticket=SYN_REFERER",
      Authorization: "Bearer SYN_AUTHORIZATION",
      Cookie: "session=SYN_COOKIE",
    };
    for (const site of sites) {
      for (const [index, { target }] of casesFor(site.host).entries()) {
        const response = await edge.request({
          host: site.host,
          target,
          headers: { ...headers, "X-Case": `${site.name}-${index}` },
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
    const caseOf = (entry) => entry.request?.headers?.["X-Case"]?.[0];
    const accessOf = (logs, site) =>
      logs.entries.filter(
        (entry) =>
          entry.logger?.startsWith("http.log.access.") &&
          caseOf(entry)?.startsWith(`${site.name}-`),
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
        assert.equal(hostOf(entry), site.host);
        assert.ok(!Object.hasOwn(entry.request.headers, "Referer"));
        assert.deepEqual(entry.request.headers.Authorization, ["REDACTED"]);
        assert.deepEqual(entry.request.headers.Cookie, ["REDACTED"]);
        assert.deepEqual(entry.resp_headers["Set-Cookie"], ["REDACTED"]);
      }
      if (site.name === "gateway") {
        assert.deepEqual([...new Set(access.map((entry) => entry.request.uri))], ["REDACTED"]);
        continue;
      }
      for (const [index, { target, userinfo }] of cases.entries()) {
        const sent = urlOf(target);
        const matches = access.filter((entry) => caseOf(entry) === `${site.name}-${index}`);
        assert.equal(matches.length, 1, target);
        const logged = urlOf(matches[0].request.uri);
        assert.equal(logged.pathname, sent.pathname, target);
        assert.equal(logged.hostname, sent.hostname);
        assert.equal(logged.username, userinfo ? "REDACTED" : "");
        assert.equal(logged.password, "");
        assert.equal(logged.search, sent.search === "" ? "" : "?REDACTED", target);
      }
    }
    assert.doesNotMatch(logs.text, /SYN_|SYN%5F|hello%20world|a%40b/);
  },
);

const ASSET_TOKEN = "ast_SYNASSETTOKENxSYNASSETTOKENxSYNASSETTOKENxx";
const SECRET = /SYNQ|SYNU|SYNLOC|SYNASSETTOKEN|private-(name|dir)|private%2dname/i;

/** Every line that holds a secret, as `host logger uri-or-msg`. */
const leaksIn = (logs) =>
  [
    ...new Set(
      logs.text
        .split("\n")
        .filter((line) => SECRET.test(line))
        .map((line) => JSON.parse(line))
        .map(
          (entry) =>
            `${entry.request?.host} ${entry.logger} ${entry.request?.uri ?? entry.msg} ${entry.resp_headers?.Location ?? ""}`,
        ),
    ),
  ].toSorted();

test(
  "actual Caddy logs no asset token, file name or query value from either site, for a 200, a 404, a redirect, a response cut short, a failed dial and port 80, in any spelling",
  { timeout: 180_000 },
  async (t) => {
    if (skipCaddy(t)) return;
    const edge = await startEdge(t);
    const rest = ASSET_TOKEN.slice("ast_".length);
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
      `/api/assets/${ASSET_TOKEN}/private-name.png`,
      `/api/assets/${ASSET_TOKEN}/private-name.png?v=SYNQ_ASSET`,
      `/api/assets/%61st_${rest}/private-name.png`,
      `/api/assets/%41ST_${rest}/private-name.png`,
      `/api/%61ssets/${ASSET_TOKEN}/private-name.png`,
      `/api//assets/${ASSET_TOKEN}/private-name.png`,
      `/API/ASSETS/${ASSET_TOKEN}/private-name.png`,
      `/api/x/../assets/%61st_${rest}/private-name.png`,
      `/api/x/%2e%2e/assets/%61%73%74%5f${rest}/private%2dname%2epng`,
      `/api/assets/%61st_${rest}/private-name.png/`,
      `/api/assets/%61st_${rest}/private-name.png;v=1`,
      `/api/assets;%76=1/%61st_${rest}/private-name.png`,
      `/api/assets/%61st_${rest}/%2e%2e/private-name.png`,
      `/api/assets/%61st_${rest}/..%2fprivate-name.png`,
      `/api/assets/%61st_${rest}/%2e%2e/%2e%2e/private-name.png`,
      `/api/assets/%61st_${rest}/../../private-name.png`,
      `/api/assets/${ASSET_TOKEN}/../../../../private-name.png`,
      `/api/assets/%61st_${rest}/%2E%2E/%2E%2E/%2E%2E/projects/private-name.png`,
    ];
    const kept = ["/api/projects", "/api/worktrees/w1/contents?path=SYNQ_README"];
    const sites = [
      { name: "mend", host: MEND_HOST, targets: [...queries, ...kept] },
      { name: "gateway", host: GATEWAY_HOST, targets: [...queries, ...assets] },
    ];
    const expected = {
      ok: [200, true],
      404: [404, true],
      redirect: [302, true],
      abort: [200, false],
      http: [308, true],
      dial: [502, true],
    };
    const send = async (mode) => {
      for (const site of sites) {
        for (const target of site.targets) {
          const response = await edge.request({
            scheme: mode === "http" ? "http" : "https",
            host: site.host,
            target,
            headers: mode === "dial" || mode === "http" ? {} : { "X-Stub": mode },
          });
          assert.deepEqual(
            [response.status, response.complete],
            expected[mode],
            `${site.name} ${mode} ${target}`,
          );
        }
      }
    };
    for (const mode of ["ok", "404", "redirect", "abort", "http"]) await send(mode);
    await edge.refuseDials();
    await send("dial");
    const requests = sites.reduce((sum, site) => sum + site.targets.length, 0);
    const of = (site) =>
      logs.entries.filter((entry) => hostOf(entry) === site.host && entry.request.uri !== "/ready");
    const isAccess = (entry) => entry.logger.startsWith("http.log.access");
    let logs;
    for (let attempt = 0; attempt < 100; attempt++) {
      logs = await edge.logs();
      if (sites.flatMap(of).filter(isAccess).length >= 6 * requests) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(leaksIn(logs), []);
    for (const site of sites) {
      const lines = of(site);
      const count = (predicate) => lines.filter(predicate).length;
      const n = site.targets.length;
      // Each mode reached the log: the matrix below is about lines Caddy really wrote.
      assert.deepEqual(
        {
          missing: count((e) => isAccess(e) && e.status === 404),
          redirect: count((e) => isAccess(e) && e.status === 302),
          cut: count((e) => e.msg === "aborting with incomplete response"),
          http: count((e) => isAccess(e) && e.status === 308),
          dial: count((e) => e.logger.startsWith("http.log.error") && e.status === 502),
        },
        { missing: n, redirect: n, cut: n, http: n, dial: n },
        site.name,
      );
      assert.ok(count((e) => isAccess(e) && e.status === 200) >= 2 * n, site.name);
      assert.equal(count((e) => e.resp_headers?.Location !== undefined) > 0, site.name === "mend");
    }
    const [mend, gateway] = sites;
    assert.deepEqual([...new Set(of(gateway).map((entry) => entry.request.uri))], ["REDACTED"]);
    for (const entry of of(mend)) {
      if (!isMendLine(entry)) {
        assert.equal(entry.request.uri, "REDACTED", entry.logger);
        continue;
      }
      assert.match(entry.request.uri, /^[^?#]*([?#]REDACTED)?$/, entry.logger);
      for (const location of entry.resp_headers?.Location ?? []) {
        assert.match(location, /^https:\/\/(REDACTED@)?mend\.internal\/[^?#@]*([?#]REDACTED)?$/);
      }
    }
    // Mend's paths stay in its access lines and in Caddy's error lines about its requests.
    const logged = (predicate) =>
      new Set(
        of(mend)
          .filter(predicate)
          .map((entry) => entry.request.uri),
      );
    for (const uri of ["/api/projects", "/api/worktrees/w1/contents?REDACTED"]) {
      assert.ok(logged((e) => e.logger === "http.log.access.mend").has(uri), uri);
      assert.ok(logged((e) => e.logger === "http.log.error.mend").has(uri), uri);
    }
  },
);

test(
  "actual Caddy logs no uri for a Host it does not map to a site's logger, and keeps CONNECT and opaque targets' userinfo out of Mend's lines",
  { timeout: 60_000 },
  async (t) => {
    if (skipCaddy(t)) return;
    const edge = await startEdge(t);
    const asset = `/api/assets/${ASSET_TOKEN}/private-name.png`;
    // Caddy routes a request by its Host in any case, and names its logger by the exact Host. A
    // trailing dot reaches no site at all.
    const unmapped = [
      { host: "T3.MEND.INTERNAL", target: asset },
      { host: "T3.MEND.INTERNAL", target: asset, headers: { "X-Stub": "redirect" } },
      { host: "T3.MEND.INTERNAL", target: asset, headers: { "X-Stub": "404" } },
      { host: "t3.Mend.Internal:443", target: asset },
      { host: "t3.mend.internal.", target: asset },
      { host: GATEWAY_HOST, target: `https://T3.MEND.INTERNAL${asset}` },
      { scheme: "http", host: "T3.MEND.INTERNAL", target: asset },
      { scheme: "http", host: "t3.mend.internal.", target: asset },
      { host: "MEND.INTERNAL", target: "/api/sessions/s1/tty?ticket=SYNU_TICKET" },
      { host: "mend.internal.", target: "/api/worktrees/w1/raw?path=private-name.png" },
      { scheme: "http", host: "Mend.Internal", target: "/api/pair?code=SYNU_CODE" },
    ];
    // What Mend's named log writes for a target, through Caddy's own regexp.
    const mapped = [
      ["/api/projects", "/api/projects"],
      ["/api/projects?raw=1", "/api/projects?REDACTED"],
      ["/api/projects#SYNU_FRAGMENT?raw=SYNU_RAW", "/api/projects#REDACTED"],
      ["/api/x/../../pair?code=SYNU_CODE", "/api/x/../../pair?REDACTED"],
      [
        `http://SYNU_USER:SYNU_PASSWORD@${MEND_HOST}/userinfo?ticket=SYNU_TICKET`,
        `http://REDACTED@${MEND_HOST}/userinfo?REDACTED`,
      ],
      [
        `http://${MEND_HOST}/path@ordinary?visible=a%40b`,
        `http://${MEND_HOST}/path@ordinary?REDACTED`,
      ],
      ["//ordinary:label@path/nested?visible=SYNU_PLAIN", "//ordinary:label@path/nested?REDACTED"],
      [`SYNU_USER:SYNU_PASSWORD@${MEND_HOST}:443`, `REDACTED@${MEND_HOST}:443`, "CONNECT"],
      [`http:SYNU_OPAQUE@${MEND_HOST}/opaque`, `REDACTED@${MEND_HOST}/opaque`],
    ];
    for (const [index, { scheme, host, target, headers = {} }] of unmapped.entries()) {
      const response = await edge.request({
        scheme,
        host,
        target,
        headers: { ...headers, "X-Case": `unmapped-${index}` },
      });
      assert.ok(response.status !== undefined, `${host} ${target}: ${response.error}`);
    }
    for (const [index, [target, , method]] of mapped.entries()) {
      const response = await edge.request({
        host: MEND_HOST,
        target,
        method,
        headers: { "X-Case": `mapped-${index}` },
      });
      assert.ok(response.status !== undefined, `${target}: ${response.error}`);
    }
    const caseOf = (entry) => entry.request?.headers?.["X-Case"]?.[0];
    let logs;
    for (let attempt = 0; attempt < 100; attempt++) {
      logs = await edge.logs();
      const seen = new Set(logs.entries.map(caseOf));
      if (
        unmapped.every((_, index) => seen.has(`unmapped-${index}`)) &&
        mapped.every((_, index) => seen.has(`mapped-${index}`))
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const about = (prefix, index) =>
      logs.entries.filter((entry) => caseOf(entry) === `${prefix}-${index}`);
    const label = ({ scheme = "https", host, target, headers = {} }) =>
      [scheme, host, headers["X-Stub"], target].filter(Boolean).join(" ");
    assert.deepEqual(
      {
        // Each line about such a request: not Mend's logger, no uri, no Location.
        unmapped: unmapped.map((sent, index) => [
          label(sent),
          [
            ...new Set(
              about("unmapped", index).map((entry) =>
                [
                  isMendLine(entry) ? entry.logger : "not mend's",
                  entry.request.uri,
                  entry.resp_headers?.Location ?? "no Location",
                ].join(" "),
              ),
            ),
          ],
        ]),
        mapped: mapped.map(([target], index) => [
          target,
          about("mapped", index)
            .filter((entry) => entry.logger.startsWith("http.log.access."))
            .map((entry) => entry.request.uri),
        ]),
        leaks: leaksIn(logs),
      },
      {
        unmapped: unmapped.map((sent) => [label(sent), ["not mend's REDACTED no Location"]]),
        mapped: mapped.map(([target, logged]) => [target, [logged]]),
        leaks: [],
      },
    );
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
