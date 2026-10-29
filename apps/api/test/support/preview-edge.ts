import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as https from "node:https";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** `--network host`: Docker bridges are unreliable on the machines these run on. */

export type EdgeKind = "caddy" | "nginx";

export type ErrorLogLevel = "notice" | "error" | "crit";

export interface EdgeOptions {
  readonly upstreamPort: number;
  readonly domain: string;
  readonly logged?: { readonly errorLevel: ErrorLogLevel };
}

export interface RunningEdge {
  readonly httpsPort: number;
  readonly container: string;
  readonly image: string;
  readonly version: string;
  readonly ca: string | null;
  readonly logs: () => Promise<string>;
  readonly stop: () => Promise<void>;
}

export const EDGE_IMAGES: Record<EdgeKind, string> = {
  caddy: "caddy:2.10-alpine",
  nginx: "nginx:1.29-alpine",
};

export const EDGE_LABEL = "mend-preview-test";
const RUN_ID = randomUUID();

const FIXTURES = fileURLToPath(new URL("../fixtures/preview/", import.meta.url));
const PACKAGED_CADDYFILE = fileURLToPath(
  new URL("../../../../deploy/docker/Caddyfile", import.meta.url),
);
const SETUP_EDGE = new URL("../../../cli/src/server-edge.ts", import.meta.url).href;
const PACKAGED_EDGE = new URL("../../../cli/test-fixtures/packaged-edge.ts", import.meta.url).href;

const docker = async (args: ReadonlyArray<string>) => (await run("docker", [...args])).stdout;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close(() => {
        if (port === null) reject(new Error("no port"));
        else resolve(port);
      });
    });
  });

const rendered = async (template: string, values: Record<string, string | number>) => {
  let text = await readFile(join(FIXTURES, template), "utf8");
  for (const [name, value] of Object.entries(values)) {
    text = text.replaceAll(`@@${name}@@`, String(value));
  }
  const missing = /@@[A-Z_]+@@/.exec(text);
  if (missing !== null) throw new Error(`${template}: ${missing[0]} has no value`);
  return text;
};

const answers = (port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const request = https.get(
      { host: "127.0.0.1", port, servername: host, headers: { host }, rejectUnauthorized: false },
      (response) => {
        response.resume();
        resolve(true);
      },
    );
    request.setTimeout(2_000, () => request.destroy());
    request.on("error", () => resolve(false));
  });

const until = async (ready: () => Promise<boolean>, what: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const imageDigest = async (image: string) =>
  (await docker(["image", "inspect", "--format", "{{index .RepoDigests 0}}", image])).trim();

interface EdgeLaunch {
  readonly mounts: ReadonlyArray<string>;
  readonly env: ReadonlyArray<string>;
  readonly privileges: ReadonlyArray<string>;
  readonly version: ReadonlyArray<string>;
  readonly caFile: string | null;
}

const wildcardCertificate = async (dir: string, domain: string) => {
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    `/CN=*.${domain}`,
    "-addext",
    `subjectAltName=DNS:*.${domain},DNS:${domain}`,
    "-keyout",
    join(dir, "edge.key"),
    "-out",
    join(dir, "edge.crt"),
  ]);
};

/** The packaged edge's privileges, and its key copy, from the CLI's fixture (packaged-edge.ts). */
const packagedEdge = async (key: string, copy: string) => {
  const fixture: unknown = await import(PACKAGED_EDGE);
  if (typeof fixture !== "object" || fixture === null) throw new Error("no packaged-edge fixture");
  const args = "packagedEdgeArgs" in fixture ? fixture.packagedEdgeArgs : undefined;
  const copyKey = "copyPreviewKey" in fixture ? fixture.copyPreviewKey : undefined;
  if (typeof args !== "function" || typeof copyKey !== "function")
    throw new Error(`${PACKAGED_EDGE} exports no packagedEdgeArgs or copyPreviewKey`);
  const privileges: unknown = args();
  if (!Array.isArray(privileges) || !privileges.every((arg) => typeof arg === "string"))
    throw new Error("packagedEdgeArgs returned no argument list");
  copyKey(key, copy);
  return privileges.filter((arg): arg is string => typeof arg === "string");
};

const setupPreviewSite = async (): Promise<string> => {
  const edge: unknown = await import(SETUP_EDGE);
  const site =
    typeof edge === "object" && edge !== null && "PREVIEW_CADDYFILE" in edge
      ? edge.PREVIEW_CADDYFILE
      : undefined;
  if (typeof site !== "string") throw new Error(`${SETUP_EDGE} exports no PREVIEW_CADDYFILE`);
  return site;
};

const packagedCaddy = async (dir: string, options: EdgeOptions, httpsPort: number) => {
  const packaged = await readFile(PACKAGED_CADDYFILE, "utf8");
  const global = "{\n\tlog default {";
  if (!packaged.includes(global)) throw new Error("the packaged Caddyfile's global options moved");
  await writeFile(
    join(dir, "Caddyfile"),
    packaged.replace(
      global,
      `{\n\tadmin off\n\tskip_install_trust\n\tdefault_bind 127.0.0.1 [::1]\n\thttp_port ${await freePort()}\n\thttps_port ${httpsPort}\n\tlog default {`,
    ),
  );
  const site = await setupPreviewSite();
  const upstream = "reverse_proxy mend:3130 {";
  if (!site.includes(upstream)) throw new Error("the preview site's upstream moved");
  await writeFile(
    join(dir, "preview.caddy"),
    site.replace(upstream, `reverse_proxy 127.0.0.1:${options.upstreamPort} {`),
  );
  await wildcardCertificate(dir, options.domain);
  return {
    privileges: await packagedEdge(join(dir, "edge.key"), join(dir, "preview-key.pem")),
    mounts: [
      `${dir}/Caddyfile:/etc/caddy/Caddyfile:ro`,
      `${dir}/preview.caddy:/etc/caddy/sites/preview.caddy:ro`,
      `${dir}/edge.crt:/etc/caddy/preview/certificate.pem:ro`,
      `${dir}/preview-key.pem:/etc/caddy/preview/key.pem:ro`,
    ],
    env: ["MEND_EDGE_HOST=mend.internal", `MEND_PREVIEW_DOMAIN=${options.domain}`],
    version: ["caddy", "version"],
    caFile: join(dir, "edge.crt"),
  };
};

const prepare: Record<
  EdgeKind,
  (dir: string, options: EdgeOptions, httpsPort: number) => Promise<EdgeLaunch>
> = {
  caddy: async (dir, options, httpsPort) => {
    if (options.logged !== undefined) return packagedCaddy(dir, options, httpsPort);
    const config = await rendered("Caddyfile", {
      DOMAIN: options.domain,
      UPSTREAM_PORT: options.upstreamPort,
      HTTPS_PORT: httpsPort,
      HTTP_PORT: await freePort(),
    });
    await writeFile(join(dir, "Caddyfile"), config);
    return {
      privileges: [],
      mounts: [`${dir}/Caddyfile:/etc/caddy/Caddyfile:ro`],
      env: [],
      version: ["caddy", "version"],
      caFile: null,
    };
  },
  nginx: async (dir, options, httpsPort) => {
    const config = await rendered("nginx.conf", {
      DOMAIN: options.domain,
      UPSTREAM_PORT: options.upstreamPort,
      HTTPS_PORT: httpsPort,
      ACCESS_LOG: options.logged === undefined ? "off" : "/dev/stdout preview",
      ERROR_LEVEL: options.logged?.errorLevel ?? "notice",
    });
    await writeFile(join(dir, "nginx.conf"), config);
    await wildcardCertificate(dir, options.domain);
    return {
      privileges: [],
      mounts: [`${dir}/nginx.conf:/etc/nginx/nginx.conf:ro`, `${dir}:/etc/nginx/edge:ro`],
      env: [],
      version: ["nginx", "-v"],
      caFile: join(dir, "edge.crt"),
    };
  },
};

export const startEdge = async (kind: EdgeKind, options: EdgeOptions): Promise<RunningEdge> => {
  const dir = await mkdtemp(join(tmpdir(), `mend-preview-${kind}-`));
  const httpsPort = await freePort();
  const launch = await prepare[kind](dir, options, httpsPort).catch(async (error: unknown) => {
    await rm(dir, { recursive: true, force: true });
    throw error;
  });
  const image = EDGE_IMAGES[kind];
  const container = `mend-preview-${kind}-${randomUUID().slice(0, 8)}`;
  const stop = async () => {
    await run("docker", ["rm", "-f", container]).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await docker([
      "run",
      "-d",
      "--name",
      container,
      "--label",
      `${EDGE_LABEL}=${RUN_ID}`,
      "--network",
      "host",
      ...launch.privileges,
      ...launch.env.flatMap((variable) => ["-e", variable]),
      ...launch.mounts.flatMap((mount) => ["-v", mount]),
      image,
    ]);
    await until(
      () => answers(httpsPort, `probe.${options.domain}`),
      `${kind} on ${httpsPort}`,
      30_000,
    );
    const versioned = await run("docker", ["exec", container, ...launch.version]);
    return {
      httpsPort,
      container,
      image: await imageDigest(image),
      version: `${versioned.stdout}${versioned.stderr}`.trim(),
      ca: launch.caFile === null ? null : await readFile(launch.caFile, "utf8"),
      logs: async () => {
        const written = await run("docker", ["logs", container], { maxBuffer: 64 * 1024 * 1024 });
        return `${written.stdout}${written.stderr}`;
      },
      stop,
    };
  } catch (error) {
    const logs = await run("docker", ["logs", "--tail", "40", container]).catch(() => null);
    await stop();
    throw new Error(`${kind} did not start\n${logs === null ? "" : logs.stdout + logs.stderr}`, {
      cause: error,
    });
  }
};

export const sweepEdges = async (): Promise<void> => {
  const ids = (await docker(["ps", "-aq", "--filter", `label=${EDGE_LABEL}=${RUN_ID}`]))
    .split("\n")
    .filter((id) => id !== "");
  if (ids.length > 0) await docker(["rm", "-f", ...ids]);
};

export const edgeMemory = async (container: string): Promise<number> => {
  const usage = (await docker(["stats", "--no-stream", "--format", "{{.MemUsage}}", container]))
    .split("/")[0]
    ?.trim();
  const match = /^([\d.]+)\s*(B|KiB|MiB|GiB)$/.exec(usage ?? "");
  if (match === null) throw new Error(`unreadable docker stats: ${usage}`);
  const scale: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
  return Number(match[1]) * (scale[match[2] ?? "B"] ?? 1);
};
