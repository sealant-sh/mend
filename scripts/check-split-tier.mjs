#!/usr/bin/env node
/**
 * The split tiers, mend-api and mend-web, as the Helm chart runs them (image.yml's split-tier
 * smoke; docs/operations/next-channel.md, "The split tiers"). scripts/split-tier/compose.yaml
 * starts Postgres, the API and the web tier with the chart's environment; everything below goes
 * through the web tier's published port, so its /api proxy carries every request:
 *
 * - /api/health is ok and reports the exact version;
 * - /api/instance has no users; the first sign-up gets a bearer token;
 * - /api/projects answers 200 with the token and 401 without it or with a wrong one;
 * - an upgrade ticket opens /api/keys/bridge/ws through the web tier, and a frame crosses each way:
 *   an ssh-agent request from inside the API reaches the socket, and the socket's answer reaches it;
 * - after both tiers restart, health, the version and the same account's sign-in work again.
 *
 * The running containers must be the images the job pulled or loaded by digest.
 *
 * Each failure says whose it is: HARNESS FAILURE when this script or its inputs went wrong, PRODUCT
 * FAILURE when Mend's tiers did. On a failure every container's logs and the Compose state are
 * written to MEND_SPLIT_ARTIFACTS.
 *
 * Environment:
 *   MEND_SPLIT_VERSION                 the exact version both images carry
 *   MEND_SPLIT_API_IMAGE / _IMAGE_ID   the mend-api image, tagged locally, and the ID CI verified
 *   MEND_SPLIT_WEB_IMAGE / _IMAGE_ID   the same for mend-web
 *   MEND_SPLIT_ARTIFACTS               where a failure's logs go (default <tmp>/split-tier-artifacts)
 *
 * It leaves what it started in place and cleans up nothing, on success or failure: run it on a fresh
 * runner only, never on a workstation's Docker daemon.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ApiError, makeApi } from "./bench/host.mjs";
import { assertHealth, assertImagePin } from "./packaged-server-assertions.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
export const COMPOSE_FILE = join(repo, "scripts/split-tier/compose.yaml");
export const PROJECT = "mend-split-tier";
/** The web tier's published address; APP_URL stays the chart's http://localhost:3105. */
export const ORIGIN = "http://127.0.0.1:3105";
const BRIDGE_HOST = "split-tier-smoke";
const POSTGRES =
  "docker.io/library/postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24";

/** ssh-agent's REQUEST_IDENTITIES, and an IDENTITIES_ANSWER listing none: length-prefixed. */
export const AGENT_REQUEST = Buffer.from([0, 0, 0, 1, 11]);
export const AGENT_ANSWER = Buffer.from([0, 0, 0, 5, 12, 0, 0, 0, 0]);

/** The bridge's socket for one account, as @mend/store's bridgeSocketName names it. */
export const bridgeSocket = (userId) =>
  `/var/lib/mend/keys/_bridge/${createHash("sha256").update(userId).digest("hex").slice(0, 16)}.sock`;

/** What the job hands over, checked before the first Docker call. */
export function readInputs(source) {
  const version = source.MEND_SPLIT_VERSION ?? "";
  const problems = [];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    problems.push("set MEND_SPLIT_VERSION to an exact version");
  const tier = (name, variable) => {
    const image = source[`${variable}`] ?? "";
    const id = source[`${variable}_ID`] ?? "";
    if (image !== `ghcr.io/sealant-sh/${name}:${version}`)
      problems.push(`${variable} must be ghcr.io/sealant-sh/${name}:${version}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(id)) problems.push(`${variable}_ID must be an image ID`);
    return { name, image, id };
  };
  const api = tier("mend-api", "MEND_SPLIT_API_IMAGE");
  const web = tier("mend-web", "MEND_SPLIT_WEB_IMAGE");
  return {
    problems,
    version,
    api,
    web,
    artifacts: source.MEND_SPLIT_ARTIFACTS || join(tmpdir(), "split-tier-artifacts"),
  };
}

let stage = "preflight";
let kind = "harness";
class StageFailure extends Error {}
const check = (condition, message) => {
  if (!condition) throw new StageFailure(`${stage}: ${message}`);
};
/** What follows is this script's own work, or the product's. */
const begin = (name, whose) => {
  stage = name;
  kind = whose;
};

function start(command, args, { timeout = 120_000, environment = process.env } = {}) {
  const child = spawn(command, args, {
    cwd: repo,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let error = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (error += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  const result = once(child, "close").then(([status, signal]) => {
    clearTimeout(timer);
    return { ok: status === 0, status, signal, output, error };
  });
  return { child, result };
}

async function run(command, args, options) {
  const result = await start(command, args, options).result;
  if (!result.ok)
    console.error(
      `DIAGNOSIS ${command} ${args.slice(0, 3).join(" ")}: ${result.error.slice(-2000)}`,
    );
  check(
    result.ok,
    `${command} ${args.slice(0, 3).join(" ")} failed (${result.status ?? result.signal})`,
  );
  return result.output;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what, probe, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    check(Date.now() < deadline, `timed out waiting for ${what}`);
    await pause(2000);
  }
}

async function request(route, { token, method = "GET", body, headers = {} } = {}) {
  return fetch(`${ORIGIN}/api${route}`, {
    method,
    headers: {
      ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
    redirect: "error",
  });
}

async function summary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

const portFree = (port) =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });

async function main() {
  const inputs = readInputs(process.env);
  check(inputs.problems.length === 0, inputs.problems.join("; "));
  const { version, api, web } = inputs;
  const secrets = {
    MEND_DB_PASSWORD: randomBytes(24).toString("hex"),
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    SEALANT_SERVICE_KEY: randomBytes(32).toString("hex"),
  };
  const composeEnv = {
    ...process.env,
    ...secrets,
    MEND_SPLIT_VERSION: version,
    MEND_SPLIT_API_IMAGE: api.image,
    MEND_SPLIT_WEB_IMAGE: web.image,
  };
  const compose = (args, options) =>
    run("docker", ["compose", "-p", PROJECT, "-f", COMPOSE_FILE, ...args], {
      environment: composeEnv,
      ...options,
    });
  const docker = (args, options) => run("docker", args, options);

  // Fresh runner only: nothing of an earlier run, and the web port free.
  const leftovers = await docker([
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${PROJECT}`,
  ]);
  check(leftovers.trim() === "", `containers of ${PROJECT} exist already: run on a fresh runner`);
  check(await portFree(3105), "127.0.0.1:3105 is taken: run on a fresh runner");
  const inspect = async (reference) => JSON.parse(await docker(["image", "inspect", reference]))[0];
  for (const tier of [api, web]) {
    const image = await inspect(tier.image);
    check(
      image.Id === tier.id,
      `${tier.image} is ${image.Id}, not the ${tier.id} the job verified`,
    );
  }
  await docker(["pull", POSTGRES], { timeout: 600_000 });
  await compose(["config", "--quiet"]);

  begin("the images", "product");
  for (const tier of [api, web]) {
    const image = await inspect(tier.image);
    check(
      image.Config?.Labels?.["org.opencontainers.image.version"] === version,
      `${tier.name}'s version label is not ${version}`,
    );
    check(
      image.Config?.Env?.includes(`MEND_VERSION=${version}`),
      `${tier.name} does not bake MEND_VERSION=${version}`,
    );
  }
  check((await inspect(web.image)).Config?.User === "node", "mend-web does not run as node");

  begin("starting the tiers", "product");
  const up = await start(
    "docker",
    [
      "compose",
      "-p",
      PROJECT,
      "-f",
      COMPOSE_FILE,
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "300",
    ],
    { environment: composeEnv, timeout: 420_000 },
  ).result;
  if (!up.ok) console.error(`DIAGNOSIS docker compose up: ${up.error.slice(-3000)}`);
  check(
    up.ok,
    `the tiers did not all become healthy (docker compose up ${up.status ?? up.signal})`,
  );

  // The containers that run are the images the job verified.
  const pins = async () => {
    for (const tier of [api, web]) {
      const id = (await compose(["ps", "-q", tier.name])).trim();
      check(id !== "", `${tier.name} has no container`);
      const container = JSON.parse(await docker(["inspect", id]))[0];
      try {
        assertImagePin(container, await inspect(tier.image), tier.image, version, tier.id);
      } catch (error) {
        check(false, `${tier.name}: ${error.message}`);
      }
    }
    const user = (await compose(["exec", "-T", "mend-web", "id", "-un"])).trim();
    check(user === "node", `mend-web runs as ${user}, not node`);
  };
  await pins();

  const healthy = (when) =>
    until(`health through the web tier ${when}`, async () => {
      try {
        const response = await request("/health");
        if (!response.ok) return false;
        return await response.json();
      } catch {
        return false;
      }
    });
  begin("health through the web tier", "product");
  const health = await healthy("after start");
  try {
    assertHealth(health, version);
  } catch {
    check(false, `health is ${JSON.stringify(health)}, not ok at ${version}`);
  }
  check(health.deploymentMode === "kubernetes", `deploymentMode is ${health.deploymentMode}`);
  await summary(`PASS health through mend-web: ok, ${version}, deploymentMode kubernetes`);

  begin("the first account", "product");
  const instanceBefore = await (await request("/instance")).json();
  check(instanceBefore.users === "none", `/api/instance reports users: ${instanceBefore.users}`);
  const email = `${randomUUID()}@split-tier.invalid`;
  const password = randomBytes(24).toString("hex");
  const signup = await request("/auth/sign-up/email", {
    method: "POST",
    headers: { origin: ORIGIN },
    body: { email, password, name: "Split-tier smoke" },
  });
  if (!signup.ok) console.error(`DIAGNOSIS sign-up: ${(await signup.text()).slice(0, 500)}`);
  check(signup.ok, `sign-up answered ${signup.status}`);
  const token = signup.headers.get("set-auth-token");
  check(typeof token === "string" && token.length > 0, "sign-up returned no bearer token");
  const account = await signup.json();
  check(typeof account.user?.id === "string", "sign-up returned no user");
  const instanceAfter = await (await request("/instance")).json();
  check(instanceAfter.users === "some", `/api/instance reports users: ${instanceAfter.users}`);
  await summary("PASS /api/instance had no users; the first sign-up got a bearer token");

  begin("authenticated requests", "product");
  const projects = async (bearer) => {
    const response = await request("/projects", { token: bearer });
    await response.body?.cancel();
    return response.status;
  };
  check((await projects(token)) === 200, "/api/projects with the token is not 200");
  check((await projects(undefined)) === 401, "/api/projects without a token is not 401");
  check(
    (await projects("not-a-real-token")) === 401,
    "/api/projects with a wrong token is not 401",
  );
  await summary("PASS /api/projects: 200 with the token, 401 without it or with a wrong one");

  begin("the key bridge through the web tier", "product");
  const client = makeApi({ url: ORIGIN, token });
  const ticket = await client.post("/upgrade-tickets", {
    target: "keys-bridge",
    host: BRIDGE_HOST,
  });
  check(typeof ticket?.ticket === "string", "no upgrade ticket was minted");
  const url = new URL("/api/keys/bridge/ws", ORIGIN);
  url.protocol = "ws:";
  url.searchParams.set("host", BRIDGE_HOST);
  url.searchParams.set("ticket", ticket.ticket);
  const socket = new WebSocket(url);
  const frames = [];
  socket.addEventListener("message", (event) => frames.push(String(event.data)));
  const opened = await new Promise((resolve) => {
    socket.addEventListener("open", () => resolve("open"), { once: true });
    socket.addEventListener("close", (event) => resolve(`closed (${event.code})`), { once: true });
    socket.addEventListener("error", () => resolve("an error"), { once: true });
    setTimeout(() => resolve("no answer in 30 s"), 30_000);
  });
  check(opened === "open", `the WebSocket through mend-web ended in ${opened}`);
  const status = await until(
    "the bridge to report the share",
    async () => {
      const view = await client.get("/keys/bridge");
      return view.connected ? view : false;
    },
    30_000,
  );
  check(status.clientName === BRIDGE_HOST, `the bridge names ${status.clientName}`);
  // ssh-add, inside the API, asks the bridge's socket for identities: the request must reach this
  // socket as a frame, and the answer sent back must reach ssh-add.
  const agent = start(
    "docker",
    [
      "compose",
      "-p",
      PROJECT,
      "-f",
      COMPOSE_FILE,
      "exec",
      "-T",
      "-e",
      `SSH_AUTH_SOCK=${bridgeSocket(account.user.id)}`,
      "mend-api",
      "ssh-add",
      "-l",
    ],
    { environment: composeEnv, timeout: 60_000 },
  );
  const asked = await until(
    "the agent request to arrive over the WebSocket",
    async () => {
      for (const frame of frames) {
        try {
          const parsed = JSON.parse(frame);
          if (parsed.t === "req") return parsed;
        } catch {
          check(false, `the bridge sent a frame that is not JSON: ${frame.slice(0, 200)}`);
        }
      }
      return false;
    },
    30_000,
  );
  check(
    Buffer.from(asked.payload, "base64").equals(AGENT_REQUEST),
    `the request frame carries ${asked.payload}, not REQUEST_IDENTITIES`,
  );
  socket.send(JSON.stringify({ t: "res", id: asked.id, payload: AGENT_ANSWER.toString("base64") }));
  const answered = await agent.result;
  check(
    `${answered.output}${answered.error}`.includes("The agent has no identities."),
    `ssh-add did not read the answer: ${answered.output}${answered.error}`.trim(),
  );
  socket.close();
  await summary("PASS the key bridge WebSocket through mend-web: a frame each way");

  begin("restarting both tiers", "product");
  await compose(["restart", "mend-api", "mend-web"], { timeout: 300_000 });
  const again = await healthy("after the restart");
  check(
    again.status === "ok" && again.version === version,
    `health after the restart: ${JSON.stringify(again)}`,
  );
  await pins();
  const signin = await request("/auth/sign-in/email", {
    method: "POST",
    headers: { origin: ORIGIN },
    body: { email, password },
  });
  check(signin.ok, `sign-in after the restart answered ${signin.status}`);
  const renewed = signin.headers.get("set-auth-token");
  check(
    typeof renewed === "string" && renewed.length > 0,
    "sign-in after the restart returned no token",
  );
  await signin.body?.cancel();
  check((await projects(renewed)) === 200, "/api/projects after the restart is not 200");
  await summary(
    `PASS after a restart of both tiers: health at ${version}, the same account signs in`,
  );
}

/** Every container's logs and the Compose state, for a failure's artifacts. Never fails itself. */
async function collectArtifacts(directory) {
  try {
    await mkdir(directory, { recursive: true });
    const environment = process.env;
    const save = async (file, command, args) => {
      const result = await start(command, args, { environment }).result;
      await writeFile(join(directory, file), `${result.output}\n--- stderr ---\n${result.error}`);
    };
    await save("docker-ps.txt", "docker", [
      "ps",
      "-a",
      "--format",
      "{{.ID}} {{.Names}} {{.Image}} {{.Status}}",
    ]);
    for (const service of ["mend-api", "mend-web", "postgres", "volume-owner"])
      await save(`${service}.log`, "docker", ["logs", "--timestamps", `${PROJECT}-${service}-1`]);
    await save("compose-ps.txt", "docker", ["compose", "-p", PROJECT, "ps", "-a"]);
    console.error(`DIAGNOSIS container logs written to ${directory}`);
  } catch (error) {
    console.error(`DIAGNOSIS could not collect artifacts: ${error.message}`);
  }
}

if (process.argv[1] && (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    const whose = kind === "product" ? "PRODUCT FAILURE" : "HARNESS FAILURE";
    const message =
      error instanceof StageFailure
        ? error.message
        : error instanceof ApiError
          ? `${stage}: ${error.message}`
          : `${stage}: ${error.stack ?? error.message}`;
    console.error(`::error::${whose} in ${message}`);
    await summary(`**${whose}** in ${message}`).catch(() => {});
    await collectArtifacts(readInputs(process.env).artifacts);
    process.exit(1);
  });
}
