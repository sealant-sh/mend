/**
 * The package and image mirrors of a packaged install: a read-through cache of the public npm
 * registry and a pull-through cache of Docker Hub, beside Mend on the Compose network. Sessions
 * install packages and pull images through them, so a new worktree stops downloading every
 * tarball and every image layer from the internet.
 *
 * Both live in the server config and render into the generation like the edge (server-edge.ts):
 * `compose.mirrors.yaml` names the services and hands Mend their addresses, `npm-mirror.conf` is
 * the npm mirror's nginx configuration, and `server.env` carries the values. Neither publishes a
 * port on the host: workspaces reach them on the Compose network, and the Docker mirror is
 * connected to each workspace's own Docker network by Sealant
 * (`SEALANT_DOCKER_REGISTRY_MIRROR_CONTAINER`).
 *
 * Neither decides what is installed. The package manager checks every tarball against its
 * lockfile's integrity hash, and Docker checks every layer against its digest. When a mirror is
 * down, installs and pulls go to the upstream registry instead.
 */

/** The npm mirror's image: nginx's `proxy_cache`, bounded by `max_size`, least recently used out. */
export const NPM_MIRROR_IMAGE = "nginx:1.29-alpine";
/** The Docker mirror's image: the reference registry (distribution) in proxy mode. */
export const DOCKER_MIRROR_IMAGE = "registry:3.1";
export const MIRRORS_COMPOSE_FILE = "compose.mirrors.yaml";
export const NPM_MIRROR_CONF_NAME = "npm-mirror.conf";
/** Where sessions reach the npm mirror: the Compose service name and nginx's port. */
export const NPM_MIRROR_URL = "http://npm-mirror:4873/";
/** Where each workspace's Docker daemon reaches the Docker mirror. */
export const DOCKER_MIRROR_URL = "http://docker-mirror:5000";
/** The Docker mirror's fixed container name, which Sealant connects to each workspace network. */
export const DOCKER_MIRROR_CONTAINER = "mend-docker-mirror";
/** The npm mirror's default size cap, in nginx's units. */
export const DEFAULT_NPM_MIRROR_MAX_SIZE = "10g";
/** How long the Docker mirror keeps a layer or manifest after it fetched it. */
export const DOCKER_MIRROR_TTL = "168h";

/** Which mirrors an install runs. `null` is a mirror turned off. */
export interface ServerMirrors {
  readonly npm: { readonly maxSize: string } | null;
  /** `upstreamUser`: the Docker Hub account the mirror pulls as; absent, it pulls anonymously. */
  readonly docker: { readonly upstreamUser?: string } | null;
}

/** On by default: what a new install runs, and what an install from before the mirrors gains. */
export const DEFAULT_MIRRORS: ServerMirrors = {
  npm: { maxSize: DEFAULT_NPM_MIRROR_MAX_SIZE },
  docker: {},
};

/** A size nginx reads for `max_size`: a whole number of mebibytes or gibibytes, at least 1g. */
export const parseMirrorSize = (value: string): string | null => {
  const match = /^([1-9]\d{0,5})([mMgG])$/.exec(value.trim());
  if (match === null) return null;
  const [, amount = "", unit = ""] = match;
  const size = `${amount}${unit.toLowerCase()}`;
  return mirrorSizeBytes(size) >= 1024 ** 3 ? size : null;
};

/** Bytes in a size `parseMirrorSize` returned. */
export const mirrorSizeBytes = (size: string): number => {
  const amount = Number(size.slice(0, -1));
  return size.endsWith("g") ? amount * 1024 ** 3 : amount * 1024 ** 2;
};

/** Docker Hub user names and access tokens as Compose reads them from `server.env` unquoted. */
const CREDENTIAL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
export const isDockerHubCredential = (value: string): boolean => CREDENTIAL.test(value);

/** Whether a config runs either mirror. */
export const runsMirrors = (mirrors: ServerMirrors | undefined): mirrors is ServerMirrors =>
  mirrors !== undefined && (mirrors.npm !== null || mirrors.docker !== null);

/**
 * The `KEY=value` lines the mirrors add to `server.env`: the npm mirror's size cap, and the Docker
 * Hub login when the operator gave one. The token is the only secret, and only the Docker mirror's
 * container receives it.
 */
export const mirrorsEnvLines = (
  mirrors: ServerMirrors | undefined,
  dockerHubToken: string | undefined,
): ReadonlyArray<string> => [
  ...(mirrors === undefined || mirrors.npm === null
    ? []
    : [`MEND_NPM_MIRROR_MAX_SIZE=${mirrors.npm.maxSize}`]),
  ...(mirrors?.docker?.upstreamUser === undefined || dockerHubToken === undefined
    ? []
    : [
        `MEND_DOCKER_HUB_USERNAME=${mirrors.docker.upstreamUser}`,
        `MEND_DOCKER_HUB_TOKEN=${dockerHubToken}`,
      ]),
];

/** Bounded container logs: the npm mirror logs a line per request, and its log is what status reads. */
const LOGGING = [
  "    logging:",
  "      driver: json-file",
  "      options:",
  '        max-size: "20m"',
  '        max-file: "5"',
];

const npmMirrorService = (): ReadonlyArray<string> => [
  "  # Read-through cache of registry.npmjs.org (npm-mirror.conf). Size-capped; the least recently",
  "  # used tarballs go first. GET and HEAD only, no credential forwarded.",
  "  npm-mirror:",
  `    image: ${NPM_MIRROR_IMAGE}`,
  "    hostname: npm-mirror",
  "    restart: unless-stopped",
  "    environment:",
  '      NGINX_ENTRYPOINT_LOCAL_RESOLVERS: "1"',
  '      NGINX_ENTRYPOINT_QUIET_LOGS: "1"',
  "      NPM_MIRROR_MAX_SIZE: ${MEND_NPM_MIRROR_MAX_SIZE:?set MEND_NPM_MIRROR_MAX_SIZE in server.env}",
  "    volumes:",
  `      - ./${NPM_MIRROR_CONF_NAME}:/etc/nginx/templates/default.conf.template:ro`,
  "      - mend-npm-mirror:/var/cache/npm-mirror",
  ...LOGGING,
];

const dockerMirrorService = (mirrors: ServerMirrors): ReadonlyArray<string> => [
  "  # Pull-through cache of Docker Hub. Each layer and manifest is kept for seven days after it",
  "  # was fetched. The metrics listener stays on the container's loopback.",
  "  docker-mirror:",
  `    image: ${DOCKER_MIRROR_IMAGE}`,
  `    container_name: ${DOCKER_MIRROR_CONTAINER}`,
  "    hostname: docker-mirror",
  "    restart: unless-stopped",
  "    environment:",
  "      REGISTRY_PROXY_REMOTEURL: https://registry-1.docker.io",
  `      REGISTRY_PROXY_TTL: ${DOCKER_MIRROR_TTL}`,
  "      REGISTRY_LOG_LEVEL: warn",
  '      REGISTRY_LOG_ACCESSLOG_DISABLED: "true"',
  "      REGISTRY_HTTP_DEBUG_ADDR: 127.0.0.1:5001",
  '      REGISTRY_HTTP_DEBUG_PROMETHEUS_ENABLED: "true"',
  ...(mirrors.docker?.upstreamUser === undefined
    ? []
    : [
        "      REGISTRY_PROXY_USERNAME: ${MEND_DOCKER_HUB_USERNAME:?set MEND_DOCKER_HUB_USERNAME in server.env}",
        "      REGISTRY_PROXY_PASSWORD: ${MEND_DOCKER_HUB_TOKEN:?set MEND_DOCKER_HUB_TOKEN in server.env}",
      ]),
  "    volumes:",
  "      - mend-docker-mirror:/var/lib/registry",
  ...LOGGING,
];

/**
 * `compose.mirrors.yaml`: the mirrors this install runs, and the addresses Mend hands sessions.
 * Absent when both are off, and the install renders as it did before the mirrors existed.
 */
export const renderMirrorsOverlay = (mirrors: ServerMirrors | undefined): string | undefined => {
  if (!runsMirrors(mirrors)) return undefined;
  return [
    "# Written by mend server setup: the package and image mirrors this install runs, on the Compose",
    "# network only (no host port). Values come from server.env. Sessions install npm packages and",
    "# pull Docker Hub images through them; a mirror that is down sends them to the registry itself.",
    "services:",
    "  mend:",
    "    environment:",
    ...(mirrors.npm === null ? [] : [`      MEND_NPM_MIRROR_URL: ${NPM_MIRROR_URL}`]),
    ...(mirrors.docker === null
      ? []
      : [
          `      SEALANT_DOCKER_REGISTRY_MIRRORS: ${DOCKER_MIRROR_URL}`,
          `      SEALANT_DOCKER_REGISTRY_MIRROR_CONTAINER: ${DOCKER_MIRROR_CONTAINER}`,
        ]),
    "",
    ...(mirrors.npm === null ? [] : [...npmMirrorService(), ""]),
    ...(mirrors.docker === null ? [] : [...dockerMirrorService(mirrors), ""]),
    "volumes:",
    ...(mirrors.npm === null ? [] : ["  mend-npm-mirror:"]),
    ...(mirrors.docker === null ? [] : ["  mend-docker-mirror:"]),
    "",
  ].join("\n");
};

/** The Compose services a config's mirrors run, by name. */
export const mirrorServices = (mirrors: ServerMirrors | undefined): ReadonlyArray<string> => [
  ...(mirrors === undefined || mirrors.npm === null ? [] : ["npm-mirror"]),
  ...(mirrors === undefined || mirrors.docker === null ? [] : ["docker-mirror"]),
];

/** The images a mirrors overlay pins, in the order it names them. */
export const mirrorImagesOf = (overlay: string): ReadonlyArray<string> =>
  [...overlay.matchAll(/^ {4}image:[ \t]*((?:nginx|registry):[^\s#]+)[ \t]*$/gm)]
    .map((match) => match[1])
    .filter((image) => image !== undefined);

/**
 * `npm-mirror.conf`: nginx's configuration for the npm mirror, an envsubst template (the nginx
 * image substitutes only the variables its environment defines: the size cap and the resolvers).
 */
export const NPM_MIRROR_CONF = `# Mend's npm mirror: a read-through cache of the public npm registry (registry.npmjs.org) for the
# workspaces on this host. nginx keeps what it fetched and serves it again. The package manager
# checks every tarball against its lockfile's integrity hash, so the cache never decides what is
# installed. Nothing is published through it, and no credential is sent upstream. When the
# registry fails, a copy already held is served instead.
proxy_cache_path /var/cache/npm-mirror levels=2:2 keys_zone=npm:64m
                 max_size=\${NPM_MIRROR_MAX_SIZE} inactive=90d use_temp_path=off;

# Abbreviated metadata (what installs ask for) and full metadata are different documents.
map $http_accept $npm_document {
    "~application/vnd\\.npm\\.install-v1\\+json" abbreviated;
    default full;
}

# One JSON line per request: \`mend server status\` reads the cache field of the tarball lines.
log_format npm_mirror escape=json
    '{"time":"$time_iso8601","method":"$request_method","uri":"$uri","status":$status,'
    '"cache":"$upstream_cache_status","bytes":$body_bytes_sent}';

server {
    listen 4873;
    access_log /dev/stdout npm_mirror;
    error_log /dev/stderr warn;
    client_max_body_size 8m;

    resolver \${NGINX_LOCAL_RESOLVERS} valid=60s ipv6=off;
    resolver_timeout 5s;
    set $npm_registry registry.npmjs.org;

    proxy_http_version 1.1;
    proxy_set_header Host registry.npmjs.org;
    proxy_set_header Connection "";
    # Never forward a credential: the mirror serves the public registry, the same to everyone.
    proxy_set_header Authorization "";
    proxy_set_header Cookie "";
    # Uncompressed from upstream, so one cached copy serves every client; gzip below compresses it.
    proxy_set_header Accept-Encoding "";
    proxy_ssl_server_name on;
    proxy_ssl_name registry.npmjs.org;
    proxy_ssl_verify on;
    proxy_ssl_verify_depth 4;
    proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
    proxy_connect_timeout 10s;
    proxy_read_timeout 60s;
    proxy_ignore_headers Cache-Control Expires Set-Cookie Vary;
    proxy_hide_header Set-Cookie;
    proxy_cache_lock on;
    proxy_cache_lock_timeout 120s;
    proxy_cache_use_stale error timeout invalid_header updating http_500 http_502 http_503 http_504 http_429;
    proxy_cache_background_update on;
    add_header X-Mend-Mirror $upstream_cache_status always;

    gzip on;
    gzip_proxied any;
    gzip_types application/json application/vnd.npm.install-v1+json;

    # Answered here, so a client can tell the mirror is up without asking the registry.
    location = /-/ping {
        default_type application/json;
        return 200 '{}';
    }

    # Tarballs never change once published: kept until the cache needs the room.
    location ~ ^/(?:@[^/]+/)?[^/]+/-/[^/]+\\.tgz$ {
        limit_except GET HEAD { deny all; }
        proxy_cache npm;
        proxy_cache_key $uri;
        proxy_cache_valid 200 365d;
        proxy_pass https://$npm_registry;
    }

    # Audit reports go to the registry as they are, never cached.
    location /-/npm/v1/security/ {
        limit_except POST { deny all; }
        proxy_pass https://$npm_registry;
    }

    # Metadata: fresh for five minutes, then revalidated; served stale while the registry fails.
    location / {
        limit_except GET HEAD { deny all; }
        proxy_cache npm;
        proxy_cache_key $uri|$npm_document;
        proxy_cache_valid 200 5m;
        proxy_cache_valid 404 1m;
        proxy_cache_revalidate on;
        proxy_pass https://$npm_registry;
    }
}
`;

// ── what `mend server status` says ─────────────────────────────────────────

/** Bytes as people read them, in binary units. */
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
};

const percent = (part: number, whole: number): string =>
  whole === 0 ? "" : ` (${Math.round((part / whole) * 100)}%)`;

/** `du -sk` output: the first field, in KiB, as bytes; null when it is not a number. */
export const duBytes = (stdout: string): number | null => {
  const kib = Number(stdout.trim().split(/\s+/)[0]);
  return stdout.trim() === "" || !Number.isFinite(kib) ? null : kib * 1024;
};

/** What nginx's cache status field says about where a response came from. */
const FROM_CACHE = new Set(["HIT", "STALE", "UPDATING", "REVALIDATED"]);
const FROM_UPSTREAM = new Set(["MISS", "EXPIRED", "BYPASS"]);

export interface NpmMirrorTraffic {
  readonly tarballs: number;
  readonly fromCache: number;
  readonly fromRegistry: number;
}

/** The tarball requests in the npm mirror's log lines, by where each answer came from. */
export const npmMirrorTraffic = (log: string): NpmMirrorTraffic => {
  let tarballs = 0;
  let fromCache = 0;
  let fromRegistry = 0;
  for (const line of log.split("\n")) {
    const start = line.indexOf("{");
    if (start < 0) continue;
    let fields: unknown;
    try {
      fields = JSON.parse(line.slice(start));
    } catch {
      continue;
    }
    if (typeof fields !== "object" || fields === null) continue;
    const entry = new Map(Object.entries(fields));
    const uri = entry.get("uri");
    const cache = entry.get("cache");
    if (typeof uri !== "string" || !uri.endsWith(".tgz") || typeof cache !== "string") continue;
    tarballs += 1;
    if (FROM_CACHE.has(cache)) fromCache += 1;
    else if (FROM_UPSTREAM.has(cache)) fromRegistry += 1;
  }
  return { tarballs, fromCache, fromRegistry };
};

export interface DockerMirrorTraffic {
  readonly blobs: { readonly hits: number; readonly misses: number };
  readonly manifests: { readonly hits: number; readonly misses: number };
}

/** The registry's proxy counters from its Prometheus metrics; null when they are not there. */
export const dockerMirrorTraffic = (metrics: string): DockerMirrorTraffic | null => {
  const counter = (name: string, type: string): number | null => {
    const match = new RegExp(`^registry_proxy_${name}_total\\{type="${type}"\\} (\\d+)`, "m").exec(
      metrics,
    );
    return match?.[1] === undefined ? null : Number(match[1]);
  };
  const values = [
    counter("hits", "blob"),
    counter("misses", "blob"),
    counter("hits", "manifest"),
    counter("misses", "manifest"),
  ];
  const [blobHits, blobMisses, manifestHits, manifestMisses] = values;
  if (
    blobHits === undefined ||
    blobHits === null ||
    blobMisses === undefined ||
    blobMisses === null ||
    manifestHits === undefined ||
    manifestHits === null ||
    manifestMisses === undefined ||
    manifestMisses === null
  ) {
    return null;
  }
  return {
    blobs: { hits: blobHits, misses: blobMisses },
    manifests: { hits: manifestHits, misses: manifestMisses },
  };
};

/** One look at a mirror: whether it runs, what it holds, and what its traffic shows. */
export interface MirrorObservation {
  readonly running: boolean;
  /** Bytes on its volume, or why that was not read. */
  readonly size: number | string;
}

export const observedNpmMirrorLine = (
  mirrors: ServerMirrors,
  observed: MirrorObservation & { readonly traffic: NpmMirrorTraffic | string },
): string => {
  if (mirrors.npm === null)
    return "npm mirror · off on this install · mend server setup --npm-mirror turns it on";
  if (!observed.running)
    return "npm mirror · container not running · sessions install from registry.npmjs.org directly";
  const cap = formatBytes(mirrorSizeBytes(mirrors.npm.maxSize));
  const size =
    typeof observed.size === "number"
      ? `${formatBytes(observed.size)} cached of ${cap}`
      : `size not read: ${observed.size} · cap ${cap}`;
  const { traffic } = observed;
  const seen =
    typeof traffic === "string"
      ? `traffic not read: ${traffic}`
      : traffic.tarballs === 0
        ? "no tarball requests in its log for the last 24 h"
        : `last 24 h: ${traffic.tarballs} tarball requests · ${traffic.fromCache} served from the cache${percent(traffic.fromCache, traffic.tarballs)} · ${traffic.fromRegistry} fetched from registry.npmjs.org`;
  return ["npm mirror · running", size, seen, "observed"].join(" · ");
};

export const observedDockerMirrorLine = (
  mirrors: ServerMirrors,
  observed: MirrorObservation & {
    readonly traffic: DockerMirrorTraffic | string;
    readonly startedAt: string | null;
  },
): string => {
  if (mirrors.docker === null)
    return "docker mirror · off on this install · mend server setup --docker-mirror turns it on";
  if (!observed.running)
    return "docker mirror · container not running · session Docker daemons pull from Docker Hub directly";
  const size =
    typeof observed.size === "number"
      ? `${formatBytes(observed.size)} cached · kept 7 days after each fetch`
      : `size not read: ${observed.size}`;
  const { traffic } = observed;
  const since = observed.startedAt === null ? "since it started" : `since ${observed.startedAt}`;
  const seen =
    typeof traffic === "string"
      ? `traffic not read: ${traffic}`
      : `${since}: layers ${traffic.blobs.hits + traffic.blobs.misses} requested · ${traffic.blobs.hits} from the cache${percent(traffic.blobs.hits, traffic.blobs.hits + traffic.blobs.misses)} · manifests ${traffic.manifests.hits + traffic.manifests.misses} · ${traffic.manifests.hits} from the cache`;
  const login =
    mirrors.docker.upstreamUser === undefined
      ? "pulls from Docker Hub anonymously"
      : `pulls from Docker Hub as ${mirrors.docker.upstreamUser}`;
  return ["docker mirror · running", size, seen, login, "observed"].join(" · ");
};
