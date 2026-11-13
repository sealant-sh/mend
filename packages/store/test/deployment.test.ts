import { describe, expect, it } from "vitest";

import { resolveDeploymentConfig, resolveExecutorTransport } from "../src/deployment.ts";

describe("resolveDeploymentConfig", () => {
  it("offers the one runtime a server set up before organizations chose names, and refuses unknown choices", () => {
    for (const runtime of ["docker", "boat"] as const) {
      expect(resolveDeploymentConfig({ MEND_SESSION_RUNTIME: runtime }).sessionRuntimes).toEqual({
        offered: [runtime],
        default: runtime,
      });
    }
    expect(() => resolveDeploymentConfig({ MEND_SESSION_RUNTIME: "auto" })).toThrow(/docker.*boat/);
  });
  it("offers the listed runtimes with the default the operator names, else the first", () => {
    expect(
      resolveDeploymentConfig({ MEND_SESSION_RUNTIMES: "docker, boat" }).sessionRuntimes,
    ).toEqual({ offered: ["docker", "boat"], default: "docker" });
    expect(
      resolveDeploymentConfig({
        MEND_SESSION_RUNTIMES: "docker,boat",
        MEND_SESSION_RUNTIME: "boat",
      }).sessionRuntimes,
    ).toEqual({ offered: ["docker", "boat"], default: "boat" });
    expect(resolveDeploymentConfig({ MEND_SESSION_RUNTIMES: "boat,boat" }).sessionRuntimes).toEqual(
      { offered: ["boat"], default: "boat" },
    );
  });
  it("refuses a list it cannot read and a default the list does not offer", () => {
    expect(() => resolveDeploymentConfig({ MEND_SESSION_RUNTIMES: "docker,vm" })).toThrow(
      /MEND_SESSION_RUNTIMES/,
    );
    expect(() => resolveDeploymentConfig({ MEND_SESSION_RUNTIMES: " , " })).toThrow(
      /MEND_SESSION_RUNTIMES/,
    );
    expect(() =>
      resolveDeploymentConfig({ MEND_SESSION_RUNTIMES: "docker", MEND_SESSION_RUNTIME: "boat" }),
    ).toThrow(/does not offer/);
  });
  it("keeps sealant selection on unconfigured Kubernetes and respects explicit choices", () => {
    for (const runtime of [undefined, "", "  "]) {
      expect(
        resolveDeploymentConfig({
          MEND_DEPLOYMENT_MODE: "kubernetes",
          MEND_SESSION_RUNTIME: runtime,
        }).sessionRuntimes,
      ).toBeNull();
    }
    for (const runtime of ["docker", "boat"] as const) {
      expect(
        resolveDeploymentConfig({
          MEND_DEPLOYMENT_MODE: "kubernetes",
          MEND_SESSION_RUNTIME: runtime,
        }).sessionRuntimes,
      ).toEqual({ offered: [runtime], default: runtime });
    }
  });
  it("defaults to local with no endpoint", () => {
    expect(resolveDeploymentConfig({})).toEqual({
      mode: "local",
      sessionRuntimes: { offered: ["docker"], default: "docker" },
      sessionEndpoint: undefined,
      sessionStore: "captured",
    });
    expect(resolveDeploymentConfig({ MEND_DEPLOYMENT_MODE: "local" }).mode).toBe("local");
  });

  it("accepts an optional endpoint in local mode", () => {
    expect(
      resolveDeploymentConfig({
        MEND_SESSION_ENDPOINT_LISTEN: "0.0.0.0:3106",
        MEND_SESSION_ENDPOINT_URL: "http://mend-session.mend.svc:3106/",
      }),
    ).toEqual({
      mode: "local",
      sessionRuntimes: { offered: ["docker"], default: "docker" },
      sessionStore: "captured",
      sessionEndpoint: { listen: "0.0.0.0:3106", url: "http://mend-session.mend.svc:3106" },
    });
  });

  it("allows kubernetes mode without an endpoint (web tier; the engine enforces it) and validates the pieces", () => {
    expect(resolveDeploymentConfig({ MEND_DEPLOYMENT_MODE: "kubernetes" })).toEqual({
      mode: "kubernetes",
      sessionRuntimes: null,
      sessionEndpoint: undefined,
      sessionStore: "captured",
    });
    expect(() =>
      resolveDeploymentConfig({
        MEND_DEPLOYMENT_MODE: "kubernetes",
        MEND_SESSION_ENDPOINT_LISTEN: "nope",
      }),
    ).toThrow(/host:port/);
    expect(() =>
      resolveDeploymentConfig({
        MEND_DEPLOYMENT_MODE: "kubernetes",
        MEND_SESSION_ENDPOINT_LISTEN: "0.0.0.0:3106",
      }),
    ).toThrow(/MEND_SESSION_ENDPOINT_URL/);
    expect(() =>
      resolveDeploymentConfig({
        MEND_DEPLOYMENT_MODE: "kubernetes",
        MEND_SESSION_ENDPOINT_LISTEN: "0.0.0.0:3106",
        MEND_SESSION_ENDPOINT_URL: "ftp://x",
      }),
    ).toThrow(/http/);
    expect(() => resolveDeploymentConfig({ MEND_DEPLOYMENT_MODE: "cloud" })).toThrow(/local/);
  });

  it("requires TLS cert and key together and https when set", () => {
    const base = {
      MEND_SESSION_ENDPOINT_LISTEN: "0.0.0.0:3106",
      MEND_SESSION_ENDPOINT_URL: "https://mend:3106",
    };
    expect(() =>
      resolveDeploymentConfig({ ...base, MEND_SESSION_ENDPOINT_TLS_CERT: "/c" }),
    ).toThrow(/together/);
    expect(() =>
      resolveDeploymentConfig({
        ...base,
        MEND_SESSION_ENDPOINT_URL: "http://mend:3106",
        MEND_SESSION_ENDPOINT_TLS_CERT: "/c",
        MEND_SESSION_ENDPOINT_TLS_KEY: "/k",
      }),
    ).toThrow(/https/);
    expect(
      resolveDeploymentConfig({
        ...base,
        MEND_SESSION_ENDPOINT_TLS_CERT: "/c",
        MEND_SESSION_ENDPOINT_TLS_KEY: "/k",
      }).sessionEndpoint?.tls,
    ).toEqual({ certPath: "/c", keyPath: "/k" });
  });

  it("reads the session store kind, defaulting to captured; the deprecated colocated store is still selectable", () => {
    expect(resolveDeploymentConfig({ MEND_SESSION_STORE: "" }).sessionStore).toBe("captured");
    expect(resolveDeploymentConfig({ MEND_SESSION_STORE: "colocated" }).sessionStore).toBe(
      "colocated",
    );
    expect(
      resolveDeploymentConfig({ MEND_SESSION_STORE: "captured", MEND_DEPLOYMENT_MODE: "local" }),
    ).toEqual({
      mode: "local",
      sessionRuntimes: { offered: ["docker"], default: "docker" },
      sessionEndpoint: undefined,
      sessionStore: "captured",
    });
    expect(() => resolveDeploymentConfig({ MEND_SESSION_STORE: "remote" })).toThrow(
      /MEND_SESSION_STORE/,
    );
  });

  it("reads the executor transport statement, and only a statement", () => {
    const files: Record<string, string> = {
      "/ca/channel.pem": "-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----\n",
      "/ca/empty.pem": "",
    };
    const read = (file: string) => {
      const content = files[file];
      if (content === undefined) throw new Error(`ENOENT: ${file}`);
      return content;
    };
    expect(resolveExecutorTransport({}, read)).toEqual({
      plaintext: false,
      channelCaPem: undefined,
      objectCaPem: undefined,
    });
    expect(resolveExecutorTransport({ MEND_EXECUTOR_NETWORK: "private" }, read).plaintext).toBe(
      true,
    );
    expect(() => resolveExecutorTransport({ MEND_EXECUTOR_NETWORK: "yes" }, read)).toThrow(
      /MEND_EXECUTOR_NETWORK/,
    );
    expect(
      resolveExecutorTransport({ MEND_SESSION_ENDPOINT_CA_FILE: "/ca/channel.pem" }, read)
        .channelCaPem,
    ).toBe(files["/ca/channel.pem"]);
    expect(() =>
      resolveExecutorTransport({ MEND_BLOB_STORE_CA_FILE: "/ca/missing.pem" }, read),
    ).toThrow(/could not be read/);
    expect(() =>
      resolveExecutorTransport({ MEND_BLOB_STORE_CA_FILE: "/ca/empty.pem" }, read),
    ).toThrow(/no PEM certificate/);
  });
});
