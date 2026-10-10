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
/** How long after a fetch the Docker mirror deletes a layer's data (manifests and tags stay). */
export const DOCKER_MIRROR_TTL = "168h";
/** The Docker mirror's default byte cap: over it, its guard clears the cache. */
export const DEFAULT_DOCKER_MIRROR_MAX_SIZE = "20g";
/**
 * The free space both mirrors leave on the disk they live on. nginx evicts least recently used
 * tarballs to keep it (`min_free`); below it, the Docker mirror's guard clears its cache and pauses
 * the registry, so session daemons pull from Docker Hub until there is room again.
 */
export const MIRROR_MIN_FREE = "5g";
export const DOCKER_MIRROR_GUARD_NAME = "docker-mirror-guard.sh";

/** Which mirrors an install runs. `null` is a mirror turned off. */
export interface ServerMirrors {
  readonly npm: { readonly maxSize: string } | null;
  /**
   * `maxSize`: the byte cap the guard keeps the cache under. `upstreamUser`: the Docker Hub account
   * the mirror pulls as; absent, it pulls anonymously. The mirror has no login of its own, so every
   * session that reaches it can pull whatever this account's token can read: a login exists only
   * with `upstreamPublicOnly`, the operator's statement (`--docker-hub-public-only`) that its token
   * is scoped Public Repo Read-only. Mend cannot check a token's scope.
   */
  readonly docker: DockerMirror | null;
}

export type DockerMirror =
  | { readonly maxSize: string }
  | {
      readonly maxSize: string;
      readonly upstreamUser: string;
      readonly upstreamPublicOnly: true;
    };

/** The account a Docker mirror pulls as, when it has a login. */
export const dockerMirrorLogin = (docker: DockerMirror | null): string | undefined =>
  docker !== null && "upstreamUser" in docker ? docker.upstreamUser : undefined;

/** On by default: what a new install runs, and what an install from before the mirrors gains. */
export const DEFAULT_MIRRORS: ServerMirrors = {
  npm: { maxSize: DEFAULT_NPM_MIRROR_MAX_SIZE },
  docker: { maxSize: DEFAULT_DOCKER_MIRROR_MAX_SIZE },
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
 * The `KEY=value` lines the mirrors add to `server.env`: each mirror's size cap, and the Docker Hub
 * login when the operator gave one. The token is the only secret, and only the Docker mirror's
 * container receives it.
 */
export const mirrorsEnvLines = (
  mirrors: ServerMirrors | undefined,
  dockerHubToken: string | undefined,
): ReadonlyArray<string> => {
  const user = dockerMirrorLogin(mirrors?.docker ?? null);
  return [
    ...(mirrors === undefined || mirrors.npm === null
      ? []
      : [`MEND_NPM_MIRROR_MAX_SIZE=${mirrors.npm.maxSize}`]),
    ...(mirrors === undefined || mirrors.docker === null
      ? []
      : [`MEND_DOCKER_MIRROR_MAX_SIZE=${mirrors.docker.maxSize}`]),
    ...(user === undefined || dockerHubToken === undefined
      ? []
      : [`MEND_DOCKER_HUB_USERNAME=${user}`, `MEND_DOCKER_HUB_TOKEN=${dockerHubToken}`]),
  ];
};

/** Bounded container logs: the npm mirror logs a line per request, and its log is what status reads. */
const LOGGING = [
  "    logging:",
  "      driver: json-file",
  "      options:",
  '        max-size: "20m"',
  '        max-file: "5"',
];

const npmMirrorService = (): ReadonlyArray<string> => [
  "  # Read-through cache of registry.npmjs.org (npm-mirror.conf). Size-capped, and it leaves",
  `  # ${MIRROR_MIN_FREE} free on its disk; the least recently used tarballs go first. No credential sent.`,
  "  npm-mirror:",
  `    image: ${NPM_MIRROR_IMAGE}`,
  "    hostname: npm-mirror",
  "    restart: unless-stopped",
  "    environment:",
  '      NGINX_ENTRYPOINT_LOCAL_RESOLVERS: "1"',
  '      NGINX_ENTRYPOINT_QUIET_LOGS: "1"',
  "      NPM_MIRROR_MAX_SIZE: ${MEND_NPM_MIRROR_MAX_SIZE:?set MEND_NPM_MIRROR_MAX_SIZE in server.env}",
  `      NPM_MIRROR_MIN_FREE: ${MIRROR_MIN_FREE}`,
  "    volumes:",
  `      - ./${NPM_MIRROR_CONF_NAME}:/etc/nginx/templates/default.conf.template:ro`,
  "      - mend-npm-mirror:/var/cache/npm-mirror",
  ...LOGGING,
];

const dockerMirrorService = (mirrors: ServerMirrors): ReadonlyArray<string> => [
  "  # Pull-through cache of Docker Hub, run by its guard (docker-mirror-guard.sh): the cache stays",
  `  # under its cap and leaves ${MIRROR_MIN_FREE} free on its disk. Layer data is deleted seven days after a`,
  "  # fetch. The metrics listener stays on the container's loopback.",
  "  docker-mirror:",
  `    image: ${DOCKER_MIRROR_IMAGE}`,
  `    container_name: ${DOCKER_MIRROR_CONTAINER}`,
  "    hostname: docker-mirror",
  "    restart: unless-stopped",
  "    init: true",
  `    entrypoint: ["/bin/sh", "/mend/${DOCKER_MIRROR_GUARD_NAME}"]`,
  "    environment:",
  "      DOCKER_MIRROR_MAX_SIZE:",
  "        ${MEND_DOCKER_MIRROR_MAX_SIZE:?set MEND_DOCKER_MIRROR_MAX_SIZE in server.env}",
  `      DOCKER_MIRROR_MIN_FREE: ${MIRROR_MIN_FREE}`,
  "      REGISTRY_PROXY_REMOTEURL: https://registry-1.docker.io",
  `      REGISTRY_PROXY_TTL: ${DOCKER_MIRROR_TTL}`,
  "      REGISTRY_LOG_LEVEL: warn",
  '      REGISTRY_LOG_ACCESSLOG_DISABLED: "true"',
  "      REGISTRY_HTTP_DEBUG_ADDR: 127.0.0.1:5001",
  '      REGISTRY_HTTP_DEBUG_PROMETHEUS_ENABLED: "true"',
  ...(dockerMirrorLogin(mirrors.docker) === undefined
    ? []
    : [
        "      # A token the operator declared Public Repo Read-only: every session can pull what it reads.",
        "      REGISTRY_PROXY_USERNAME: ${MEND_DOCKER_HUB_USERNAME:?set MEND_DOCKER_HUB_USERNAME in server.env}",
        "      REGISTRY_PROXY_PASSWORD: ${MEND_DOCKER_HUB_TOKEN:?set MEND_DOCKER_HUB_TOKEN in server.env}",
      ]),
  "    volumes:",
  `      - ./${DOCKER_MIRROR_GUARD_NAME}:/mend/${DOCKER_MIRROR_GUARD_NAME}:ro`,
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
                 max_size=\${NPM_MIRROR_MAX_SIZE} min_free=\${NPM_MIRROR_MIN_FREE}
                 inactive=90d use_temp_path=off;

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
    # The key is the whole request, query included: a search for one package never answers another.
    location / {
        limit_except GET HEAD { deny all; }
        proxy_cache npm;
        proxy_cache_key $request_uri|$npm_document;
        proxy_cache_valid 200 5m;
        proxy_cache_valid 404 1m;
        proxy_cache_revalidate on;
        proxy_pass https://$npm_registry;
    }
}
`;

/**
 * `docker-mirror-guard.sh`: the Docker mirror's entrypoint. It runs the registry and keeps its cache
 * under `DOCKER_MIRROR_MAX_SIZE` and the disk above `DOCKER_MIRROR_MIN_FREE`, checked every 30 s, and
 * writes its state where `mend server status` reads it (`running`, or `paused <free MiB> <floor MiB>`).
 */
export const DOCKER_MIRROR_GUARD = `#!/bin/sh
# Mend's Docker mirror guard (written by mend server setup): runs the registry, and keeps its cache
# under a byte cap and the disk it lives on above a floor. Over the cap, the cache is cleared and
# fills again from Docker Hub. Below the floor, the cache is cleared and the registry stays stopped
# until there is room again; meanwhile session Docker daemons pull from Docker Hub directly. The
# registry has no size cap of its own, and its seven-day expiry deletes layer data only.
set -u
root=/var/lib/registry
state=/tmp/mend-mirror-guard
size_mb() {
  case "$1" in
    *g) echo $((\${1%g} * 1024)) ;;
    *m) echo "\${1%m}" ;;
    *) echo "mend docker mirror guard: cannot read size $1" >&2 && exit 64 ;;
  esac
}
cap=$(size_mb "\${DOCKER_MIRROR_MAX_SIZE:?}") || exit 64
floor=$(size_mb "\${DOCKER_MIRROR_MIN_FREE:?}") || exit 64
interval=\${DOCKER_MIRROR_GUARD_INTERVAL:-30}
pid=
stop_registry() {
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
  fi
  pid=
}
clear_cache() { rm -rf "$root/docker" "$root/scheduler-state.json"; }
trap 'stop_registry; exit 0' TERM INT
while :; do
  free=$(df -Pm "$root" | awk 'NR == 2 { print $4 }')
  if [ "$free" -lt "$floor" ]; then
    if [ -n "$pid" ]; then
      stop_registry
      clear_cache
      echo "mend docker mirror guard: \${free} MiB free on its disk, below \${floor} MiB: cache cleared, registry paused" >&2
    fi
    echo "paused \${free} \${floor}" >"$state"
  else
    used=$(du -sm "$root" | cut -f1)
    if [ "$used" -gt "$cap" ]; then
      stop_registry
      clear_cache
      echo "mend docker mirror guard: cache \${used} MiB, over its \${cap} MiB cap: cleared" >&2
    fi
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
      registry serve /etc/distribution/config.yml &
      pid=$!
    fi
    echo "running" >"$state"
  fi
  sleep "$interval" &
  wait $!
done
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

/**
 * The shell a status read runs in a mirror's container: its cache's KiB, the KiB free on the disk it
 * lives on, and the Docker mirror guard's state when there is one, one per line.
 */
export const mirrorDiskProbe = (directory: string): string =>
  `du -sk ${directory} | cut -f1; df -Pk ${directory} | awk 'NR == 2 { print $4 }'; cat /tmp/mend-mirror-guard 2>/dev/null || true`;

/** What a mirror's disk looks like, as `mirrorDiskProbe` printed it. */
export interface MirrorDisk {
  readonly used: number;
  readonly free: number;
  /** The Docker mirror's guard: running, or paused for want of free space; null when none. */
  readonly guard:
    | { readonly state: "running" }
    | { readonly state: "paused"; readonly freeMiB: number; readonly floorMiB: number }
    | null;
}

export const mirrorDiskOf = (stdout: string): MirrorDisk | null => {
  const [used, free, guard = ""] = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim());
  const usedKiB = Number(used);
  const freeKiB = Number(free);
  if (used === undefined || free === undefined || used === "" || free === "") return null;
  if (!Number.isFinite(usedKiB) || !Number.isFinite(freeKiB)) return null;
  const paused = /^paused (\d+) (\d+)$/.exec(guard);
  return {
    used: usedKiB * 1024,
    free: freeKiB * 1024,
    guard:
      paused?.[1] !== undefined && paused[2] !== undefined
        ? { state: "paused", freeMiB: Number(paused[1]), floorMiB: Number(paused[2]) }
        : guard === "running"
          ? { state: "running" }
          : null,
  };
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

/** One look at a mirror: whether it runs, its disk, and what its traffic shows. */
export interface MirrorObservation {
  readonly running: boolean;
  /** Its cache and the disk under it, or why they were not read. */
  readonly disk: MirrorDisk | string;
}

const diskWords = (disk: MirrorDisk | string, cap: string): string =>
  typeof disk === "string"
    ? `size not read: ${disk} · cap ${formatBytes(mirrorSizeBytes(cap))}`
    : `${formatBytes(disk.used)} cached of ${formatBytes(mirrorSizeBytes(cap))} · ${formatBytes(disk.free)} free on its disk`;

export const observedNpmMirrorLine = (
  mirrors: ServerMirrors,
  observed: MirrorObservation & { readonly traffic: NpmMirrorTraffic | string },
): string => {
  if (mirrors.npm === null)
    return "npm mirror · off on this install · mend server setup --npm-mirror turns it on";
  if (!observed.running)
    return "npm mirror · container not running · sessions install from registry.npmjs.org directly";
  const { traffic } = observed;
  const seen =
    typeof traffic === "string"
      ? `traffic not read: ${traffic}`
      : traffic.tarballs === 0
        ? "no tarball requests in its log for the last 24 h"
        : `last 24 h: ${traffic.tarballs} tarball requests · ${traffic.fromCache} served from the cache${percent(traffic.fromCache, traffic.tarballs)} · ${traffic.fromRegistry} fetched from registry.npmjs.org`;
  return [
    "npm mirror · running",
    diskWords(observed.disk, mirrors.npm.maxSize),
    seen,
    "observed",
  ].join(" · ");
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
  const { disk, traffic } = observed;
  if (typeof disk !== "string" && disk.guard?.state === "paused")
    return [
      "docker mirror · paused by its disk guard",
      `${formatBytes(disk.guard.freeMiB * 1024 ** 2)} free on its disk, below ${formatBytes(disk.guard.floorMiB * 1024 ** 2)}`,
      "cache cleared · session Docker daemons pull from Docker Hub directly until there is room",
      "observed",
    ].join(" · ");
  const since = observed.startedAt === null ? "since it started" : `since ${observed.startedAt}`;
  const seen =
    typeof traffic === "string"
      ? `traffic not read: ${traffic}`
      : `${since}: layers ${traffic.blobs.hits + traffic.blobs.misses} requested · ${traffic.blobs.hits} from the cache${percent(traffic.blobs.hits, traffic.blobs.hits + traffic.blobs.misses)} · manifests ${traffic.manifests.hits + traffic.manifests.misses} · ${traffic.manifests.hits} from the cache`;
  const user = dockerMirrorLogin(mirrors.docker);
  const login =
    user === undefined
      ? "pulls from Docker Hub anonymously"
      : `pulls from Docker Hub as ${user}, with a token the operator declared Public Repo Read-only · every session can pull whatever that token can read`;
  return [
    "docker mirror · running",
    diskWords(disk, mirrors.docker.maxSize),
    "layers evicted 7 days after each fetch",
    seen,
    login,
    "observed",
  ].join(" · ");
};
