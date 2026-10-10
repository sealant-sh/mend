import * as fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MIRRORS,
  dockerMirrorTraffic,
  duBytes,
  isDockerHubCredential,
  mirrorImagesOf,
  mirrorsEnvLines,
  mirrorServices,
  NPM_MIRROR_CONF,
  npmMirrorTraffic,
  observedDockerMirrorLine,
  observedNpmMirrorLine,
  parseMirrorSize,
  renderMirrorsOverlay,
} from "./server-mirrors.ts";

describe("the mirrors overlay", () => {
  it("is the repository's compose.mirrors.yaml for the default, byte for byte", () => {
    expect(renderMirrorsOverlay(DEFAULT_MIRRORS)).toBe(
      fs.readFileSync(
        new URL("../../../deploy/docker/compose.mirrors.yaml", import.meta.url),
        "utf8",
      ),
    );
    expect(NPM_MIRROR_CONF).toBe(
      fs.readFileSync(new URL("../../../deploy/docker/npm-mirror.conf", import.meta.url), "utf8"),
    );
  });

  it("hands Mend the addresses of what runs, and only that", () => {
    const npmOnly = renderMirrorsOverlay({ npm: { maxSize: "20g" }, docker: null }) ?? "";
    expect(npmOnly).toContain("MEND_NPM_MIRROR_URL: http://npm-mirror:4873/");
    expect(npmOnly).not.toContain("SEALANT_DOCKER_REGISTRY_MIRRORS");
    expect(npmOnly).not.toContain("docker-mirror:");
    const dockerOnly = renderMirrorsOverlay({ npm: null, docker: {} }) ?? "";
    expect(dockerOnly).toContain("SEALANT_DOCKER_REGISTRY_MIRRORS: http://docker-mirror:5000");
    expect(dockerOnly).toContain("SEALANT_DOCKER_REGISTRY_MIRROR_CONTAINER: mend-docker-mirror");
    expect(dockerOnly).toContain("container_name: mend-docker-mirror");
    expect(dockerOnly).not.toContain("npm-mirror");
    expect(renderMirrorsOverlay({ npm: null, docker: null })).toBeUndefined();
    expect(renderMirrorsOverlay(undefined)).toBeUndefined();
  });

  it("publishes no port and keeps the registry's metrics on its loopback", () => {
    const overlay = renderMirrorsOverlay(DEFAULT_MIRRORS) ?? "";
    expect(overlay).not.toMatch(/^\s+ports:/m);
    expect(overlay).toContain("REGISTRY_HTTP_DEBUG_ADDR: 127.0.0.1:5001");
  });

  it("gives the Docker Hub login to the Docker mirror alone, by reference to server.env", () => {
    const anonymous = renderMirrorsOverlay(DEFAULT_MIRRORS) ?? "";
    expect(anonymous).not.toContain("REGISTRY_PROXY_USERNAME");
    const login = renderMirrorsOverlay({ npm: null, docker: { upstreamUser: "mendbot" } }) ?? "";
    const dockerMirror = login.slice(login.indexOf("\n  docker-mirror:"));
    const mend = login.slice(0, login.indexOf("\n  docker-mirror:"));
    expect(dockerMirror).toContain("REGISTRY_PROXY_PASSWORD: ${MEND_DOCKER_HUB_TOKEN:?");
    expect(mend).not.toContain("MEND_DOCKER_HUB");
    expect(login).not.toContain("mendbot");
    expect(
      mirrorsEnvLines({ npm: null, docker: { upstreamUser: "mendbot" } }, "dckr_pat_x"),
    ).toEqual(["MEND_DOCKER_HUB_USERNAME=mendbot", "MEND_DOCKER_HUB_TOKEN=dckr_pat_x"]);
    expect(mirrorsEnvLines(DEFAULT_MIRRORS, undefined)).toEqual(["MEND_NPM_MIRROR_MAX_SIZE=10g"]);
  });

  it("names its images and services", () => {
    expect(mirrorImagesOf(renderMirrorsOverlay(DEFAULT_MIRRORS) ?? "")).toEqual([
      "nginx:1.29-alpine",
      "registry:3.1",
    ]);
    expect(mirrorServices(DEFAULT_MIRRORS)).toEqual(["npm-mirror", "docker-mirror"]);
    expect(mirrorServices({ npm: null, docker: {} })).toEqual(["docker-mirror"]);
    expect(mirrorServices(undefined)).toEqual([]);
  });
});

describe("the npm mirror's nginx configuration", () => {
  it("caches GET and HEAD only, forwards no credential, and serves stale when the registry fails", () => {
    expect(NPM_MIRROR_CONF).toContain("max_size=${NPM_MIRROR_MAX_SIZE}");
    expect(NPM_MIRROR_CONF).toContain('proxy_set_header Authorization "";');
    expect(NPM_MIRROR_CONF).toContain('proxy_set_header Cookie "";');
    expect(NPM_MIRROR_CONF).toContain("proxy_ssl_verify on;");
    expect(NPM_MIRROR_CONF).toContain("proxy_cache_use_stale error timeout");
    expect(NPM_MIRROR_CONF.match(/limit_except GET HEAD \{ deny all; \}/g)).toHaveLength(2);
    // nginx's own variables are left for nginx: the template substitutes only defined env names.
    expect(NPM_MIRROR_CONF).toContain("$upstream_cache_status");
  });
});

describe("parseMirrorSize", () => {
  it.each([
    ["10g", "10g"],
    ["20G", "20g"],
    ["1536m", "1536m"],
    ["1024m", "1024m"],
  ])("reads %s", (input, expected) => {
    expect(parseMirrorSize(input)).toBe(expected);
  });

  it.each(["0g", "512m", "10", "10gb", "1.5g", "-1g", "g", "10 g"])("refuses %s", (input) => {
    expect(parseMirrorSize(input)).toBeNull();
  });
});

describe("isDockerHubCredential", () => {
  it("takes what Compose reads unquoted, and nothing it would interpolate or split", () => {
    expect(isDockerHubCredential("mendbot")).toBe(true);
    expect(isDockerHubCredential("dckr_pat_AbC-12.x")).toBe(true);
    for (const value of ["", "a b", "a$b", "a\nb", "a=b", "'a'", "-a"])
      expect(isDockerHubCredential(value)).toBe(false);
  });
});

describe("what status observes", () => {
  it("counts tarball requests by where nginx answered them from", () => {
    const log = [
      '{"time":"t","method":"GET","uri":"/a/-/a-1.0.0.tgz","status":200,"cache":"HIT","bytes":1}',
      '{"time":"t","method":"GET","uri":"/@s/b/-/b-1.0.0.tgz","status":200,"cache":"MISS","bytes":1}',
      '{"time":"t","method":"GET","uri":"/c/-/c-1.0.0.tgz","status":200,"cache":"STALE","bytes":1}',
      '{"time":"t","method":"GET","uri":"/c","status":200,"cache":"HIT","bytes":1}',
      "2026/10/10 08:00:00 [warn] an error line",
      "",
    ].join("\n");
    expect(npmMirrorTraffic(log)).toEqual({ tarballs: 3, fromCache: 2, fromRegistry: 1 });
  });

  it("reads the registry's proxy counters, and nothing when they are absent", () => {
    const metrics = [
      "# HELP registry_proxy_hits_total The number of total proxy request hits",
      'registry_proxy_hits_total{type="blob"} 7',
      'registry_proxy_hits_total{type="manifest"} 4',
      'registry_proxy_misses_total{type="blob"} 3',
      'registry_proxy_misses_total{type="manifest"} 2',
    ].join("\n");
    expect(dockerMirrorTraffic(metrics)).toEqual({
      blobs: { hits: 7, misses: 3 },
      manifests: { hits: 4, misses: 2 },
    });
    expect(dockerMirrorTraffic("go_goroutines 12")).toBeNull();
  });

  it("reads du's KiB", () => {
    expect(duBytes("2048\t/var/cache/npm-mirror\n")).toBe(2 * 1024 * 1024);
    expect(duBytes("")).toBeNull();
    expect(duBytes("du: cannot access")).toBeNull();
  });

  it("says what was observed, never a verdict", () => {
    expect(
      observedNpmMirrorLine(DEFAULT_MIRRORS, {
        running: true,
        size: 743 * 1024 * 1024,
        traffic: { tarballs: 4010, fromCache: 2006, fromRegistry: 2004 },
      }),
    ).toBe(
      "npm mirror · running · 743 MiB cached of 10 GiB · last 24 h: 4010 tarball requests · 2006 served from the cache (50%) · 2004 fetched from registry.npmjs.org · observed",
    );
    expect(observedNpmMirrorLine(DEFAULT_MIRRORS, { running: false, size: 0, traffic: "" })).toBe(
      "npm mirror · container not running · sessions install from registry.npmjs.org directly",
    );
    expect(
      observedNpmMirrorLine({ npm: null, docker: {} }, { running: false, size: 0, traffic: "" }),
    ).toBe("npm mirror · off on this install · mend server setup --npm-mirror turns it on");
    expect(
      observedDockerMirrorLine(DEFAULT_MIRRORS, {
        running: true,
        size: 120 * 1024 * 1024,
        traffic: { blobs: { hits: 6, misses: 2 }, manifests: { hits: 3, misses: 3 } },
        startedAt: "2026-10-10T08:00:00Z",
      }),
    ).toBe(
      "docker mirror · running · 120 MiB cached · layers evicted 7 days after each fetch · since 2026-10-10T08:00:00Z: layers 8 requested · 6 from the cache (75%) · manifests 6 · 3 from the cache · pulls from Docker Hub anonymously · observed",
    );
    expect(
      observedDockerMirrorLine(
        { npm: null, docker: { upstreamUser: "mendbot" } },
        { running: true, size: "du failed", traffic: "exec failed", startedAt: null },
      ),
    ).toBe(
      "docker mirror · running · size not read: du failed · traffic not read: exec failed · pulls from Docker Hub as mendbot, with a token the operator declared Public Repo Read-only · every session can pull whatever that token can read · observed",
    );
  });
});
